"""FastAPI application entrypoint.

Serves the shadcn-style frontend and exposes the pipeline API:
  GET  /api/capabilities         -> which optional tools are available
  POST /api/jobs                 -> upload PDF/image, start pipeline (multipart)
  GET  /api/jobs/{id}            -> poll job snapshot
  GET  /api/jobs/{id}/stream     -> live SSE stream of job updates
  PATCH/api/jobs/{id}/content    -> edit step content (extracted_text, narration)
  POST /api/jobs/{id}/review-content -> duplicate-slide + voice-sync review
  GET  /files/{id}/{path}        -> download generated artifacts
"""
from __future__ import annotations

import asyncio
import json
import re
import shutil
import sqlite3
from pathlib import Path

from fastapi import (
    FastAPI,
    File,
    Form,
    HTTPException,
    Request,
    Response,
    UploadFile,
    WebSocket,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import auth, runner
from . import automation as auto
from . import ui_theme
from .capabilities import detect_capabilities
from .config import BASE_DIR, WORKSPACE_DIR, get_settings
from .jobs import store
from .logging_setup import log
from .orchestrator import STAGE_FUNCS, run_from_stage, run_pipeline, run_single_stage
from .video_options import (
    normalize_video_options,
    public_style_categories,
    public_video_formats,
    public_video_styles,
    public_video_themes,
    public_visual_presets,
)

app = FastAPI(title="Multimodal Studio", version="2.3.0")

STATIC_DIR = BASE_DIR / "frontend"
WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)

_JOB_ID_RE = re.compile(r"^[a-f0-9]{12}$")


def _automation_output_dir() -> Path:
    """Resolved automation output root (honors ``AUTO_OUTPUT_DIR``)."""
    return get_settings().auto_output_path


def _safe_job_dir(job_id: str) -> Path:
    """Resolve a job workspace, rejecting path traversal."""
    if not _JOB_ID_RE.match(job_id):
        raise HTTPException(400, "Invalid job id")
    from .workspace_store import resolve_job_dir

    root = WORKSPACE_DIR.resolve()
    try:
        base = resolve_job_dir(job_id, create=False).resolve()
    except Exception:
        base = (WORKSPACE_DIR / job_id).resolve()
    if not base.is_relative_to(root):
        raise HTTPException(403, "Forbidden")
    if not base.is_dir():
        raise HTTPException(404, "Job not found")
    return base


def _safe_cron_dir(folder: str) -> Path:
    """Resolve an automation output folder, rejecting path traversal."""
    if not folder or folder in (".", "..") or "/" in folder or "\\" in folder:
        raise HTTPException(400, "Invalid folder")
    root = _automation_output_dir().resolve()
    root.mkdir(parents=True, exist_ok=True)
    base = (root / folder).resolve()
    if not base.is_relative_to(root):
        raise HTTPException(403, "Forbidden")
    return base


def _prefer_cron_video(base: Path) -> Path | None:
    """Prefer long-form ``video/video.mp4`` over reel when publishing."""
    candidates = [
        base / "video" / "video.mp4",
        base / "video_video.mp4",
        base / "reel" / "video.mp4",
        base / "reel_video.mp4",
    ]
    for c in candidates:
        if c.is_file():
            return c
    videos = sorted(base.rglob("*.mp4"))
    # Prefer paths containing "/video/" or starting with video_
    videos.sort(
        key=lambda p: (
            0 if "/video/" in p.as_posix() or p.name.startswith("video_") else 1,
            p.as_posix(),
        )
    )
    return videos[0] if videos else None


def _prefer_cron_thumb(base: Path) -> Path | None:
    candidates = [
        base / "video" / "thumbnail.png",
        base / "video_thumbnail.png",
        base / "reel" / "thumbnail.png",
        base / "reel_thumbnail.png",
    ]
    for c in candidates:
        if c.is_file():
            return c
    thumbs = sorted(base.rglob("*thumb*.png"))
    return thumbs[0] if thumbs else None


def _load_cron_publish_meta(base: Path) -> dict:
    for rel in ("video/metadata.json", "video_metadata.json", "reel/metadata.json"):
        path = base / rel
        if path.is_file():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
    return {}


@app.on_event("startup")
def _hydrate_sessions() -> None:
    # Load persisted job history from SQLite so sessions survive restarts.
    store.hydrate()
    # Ensure the default admin exists so invites can be approved from day one.
    auth.seed_admin()
    # Apply admin runtime overrides (LLM provider / models / image backend).
    from . import runtime_settings as runtime_settings_mod

    runtime_settings_mod.load_on_startup()
    # Start the paper -> video automation scheduler (twice/day, off-hours).
    auto.start_scheduler()
    # Download + load free TTS (Kokoro / Pocket) in the background so the first
    # narration is not blocked on cold model load.
    from .pipeline import tts as tts_warmup

    tts_warmup.start_free_tts_warmup_background()

# Cache-busting token for static assets: prefer JS/CSS mtimes so a code edit
# invalidates browsers even without a process restart; fall back to start time.
import time as _time

def _asset_version() -> str:
    try:
        stamps = [
            (STATIC_DIR / name).stat().st_mtime_ns
            for name in (
                "app.js", "styles.css", "login.js", "slide_kit.js",
                "chitti.js", "chitti.css",
                "favicon.svg", "favicon.ico", "favicon-256.png",
            )
            if (STATIC_DIR / name).exists()
        ]
        if stamps:
            return str(max(stamps) // 1_000_000)
    except OSError:
        pass
    return str(int(_time.time()))


ASSET_VERSION = _asset_version()


@app.middleware("http")
async def _cache_headers(request: Request, call_next):
    """Keep HTML/API fresh; let versioned /static/ revalidate quickly."""
    response = await call_next(request)
    path = request.url.path or ""
    if path.startswith("/static/"):
        # Query ``?v=`` already busts; avoid long stale caches after deploys.
        response.headers.setdefault(
            "Cache-Control", "public, max-age=0, must-revalidate"
        )
    elif path in ("/", "/login") or path.startswith("/api/"):
        response.headers.setdefault(
            "Cache-Control", "no-cache, no-store, must-revalidate"
        )
    return response


ALLOWED_SUFFIXES = {
    # documents
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".txt", ".md", ".markdown",
    ".rtf", ".odt", ".html", ".htm", ".epub", ".csv", ".xlsx", ".xlsm",
    # images
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tiff", ".tif",
}

# Interview ingest / mock clip caps (bytes read into memory)
IV_INGEST_MAX_BYTES = 40 * 1024 * 1024  # 40 MB
IV_CLIP_MAX_BYTES = 80 * 1024 * 1024  # 80 MB


async def _read_upload_capped(file: UploadFile, max_bytes: int) -> bytes:
    """Read upload into memory with a hard size cap."""
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                413,
                f"File too large (max {max_bytes // (1024 * 1024)} MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


# ============================================================ authentication ==
# The whole app is gated behind a login. Cookie-based sessions are used (not
# bearer headers) so the SSE stream (EventSource) and artifact <img>/<video>
# requests are authenticated too. Only a small allowlist of paths is public.

PUBLIC_PREFIXES = (
    "/static/", "/login", "/favicon", "/api/auth/",
    "/api/ui-palette", "/api/capabilities", "/api/video-formats",
    "/api/audience",
    "/docs", "/openapi.json", "/redoc",
)
PUBLIC_EXACT = {
    "/login", "/api/ui-palette", "/api/capabilities",
    "/api/video-formats", "/api/audience",
}


def _current_user(request: Request) -> auth.User | None:
    token = request.cookies.get(auth.COOKIE_NAME)
    return auth.user_for_session(token)


def require_user(request: Request) -> auth.User:
    user = _current_user(request)
    if not user:
        raise HTTPException(401, "Authentication required")
    return user


def require_admin(request: Request) -> auth.User:
    user = require_user(request)
    if not user.is_admin:
        raise HTTPException(403, "Admin only")
    return user


def _job_for_user(request: Request, job_id: str):
    """Return a job the caller may access (owner or admin)."""
    user = require_user(request)
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if not user.is_admin and job.user_id != user.id:
        raise HTTPException(403, "Forbidden")
    return job


def _is_public(path: str) -> bool:
    if path == "/":
        return False
    if path in PUBLIC_EXACT:
        return True
    return any(path.startswith(p) for p in PUBLIC_PREFIXES)


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    """Redirect unauthenticated page loads to /login and 401 API calls."""
    path = request.url.path
    if _is_public(path):
        return await call_next(request)
    user = _current_user(request)
    if user is None:
        if path.startswith("/api/") or path.startswith("/files/"):
            return JSONResponse({"detail": "Authentication required"}, status_code=401)
        # Page navigation: send to the login screen.
        return HTMLResponse(status_code=302, headers={"Location": "/login"}, content="")
    # Stash the user for handlers that want it.
    request.state.user = user
    return await call_next(request)


def _set_session_cookie(response: Response, token: str) -> None:
    """Set the auth cookie. Non-persistent sessions expire when the browser closes."""
    kwargs: dict = {
        "key": auth.COOKIE_NAME,
        "value": token,
        "httponly": True,
        "samesite": "lax",
        "path": "/",
    }
    if get_settings().auth_session_persistent:
        kwargs["max_age"] = get_settings().auth_session_hours * 3600
    response.delete_cookie("ms_session", path="/")  # legacy persistent cookie
    response.set_cookie(**kwargs)


class LoginRequest(BaseModel):
    identifier: str
    password: str


class RegisterRequest(BaseModel):
    email: str
    username: str = ""
    password: str


class InviteRequest(BaseModel):
    email: str
    name: str = ""
    message: str = ""


@app.post("/api/auth/login")
def auth_login(req: LoginRequest, response: Response) -> dict:
    user = auth.authenticate(req.identifier, req.password)
    if not user:
        raise HTTPException(401, "Invalid credentials")
    token = auth.create_session(user.id)
    _set_session_cookie(response, token)
    log.bind(task="auth").info(f"login {user.email}")
    return {"user": user.public()}


@app.post("/api/auth/register")
def auth_register(req: RegisterRequest, response: Response) -> dict:
    """Set a password for an *approved* invite email, then sign in."""
    email = (req.email or "").strip().lower()
    if not email or not req.password:
        raise HTTPException(400, "Email and password are required")
    if len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    if auth.get_user_by_email(email):
        raise HTTPException(409, "This email is already registered — please sign in")
    if not auth.is_email_approved(email):
        raise HTTPException(
            403,
            "This email hasn't been approved yet. Submit your details for review "
            "and return once an admin approves your account.",
        )
    try:
        user = auth.create_user(email, req.username.strip() or email.split("@")[0], req.password)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "This email is already registered — please sign in")
    auth.mark_invite_registered(email)
    token = auth.create_session(user.id)
    _set_session_cookie(response, token)
    log.bind(task="auth").info(f"registered {user.email}")
    return {"user": user.public()}


@app.post("/api/auth/request-invite")
def auth_request_invite(req: InviteRequest) -> dict:
    email = (req.email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(400, "A valid email is required")
    auth.create_invite_request(email, req.name.strip(), req.message.strip())
    log.bind(task="auth").info(f"invite requested {email}")
    return {"ok": True, "message": "Submitted for review. An admin will approve your account soon."}


@app.post("/api/auth/logout")
def auth_logout(request: Request, response: Response) -> dict:
    token = request.cookies.get(auth.COOKIE_NAME)
    if token:
        auth.destroy_session(token)
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    response.delete_cookie("ms_session", path="/")  # legacy persistent cookie
    return {"ok": True}


@app.get("/api/auth/me")
def auth_me(request: Request) -> dict:
    user = _current_user(request)
    if not user:
        raise HTTPException(401, "Not signed in")
    return {"user": user.public()}


# ------------------------------------------------------------------- admin API --

@app.get("/api/admin/invites")
def admin_list_invites(request: Request) -> dict:
    require_admin(request)
    return {"invites": auth.list_invites()}


class ClearInvitesRequest(BaseModel):
    """Statuses to purge. Defaults to revoked / denied / registered."""
    statuses: list[str] | None = None


@app.post("/api/admin/invites/clear-old")
def admin_clear_old_invites(request: Request, body: ClearInvitesRequest | None = None) -> dict:
    """Remove settled invite rows (revoked, denied, registered) from the DB."""
    require_admin(request)
    statuses = (body.statuses if body else None)
    result = auth.clear_old_invites(statuses)
    log.bind(task="auth").info(
        f"admin cleared {result['deleted']} invite(s) statuses={result['statuses']}"
    )
    return {"ok": True, **result}


@app.post("/api/admin/invites/{invite_id}/decide")
def admin_decide_invite(invite_id: str, request: Request, approve: bool = True) -> dict:
    require_admin(request)
    row = auth.decide_invite(invite_id, approve)
    if not row:
        raise HTTPException(404, "Invite not found")
    return {"invite": row}


@app.delete("/api/admin/invites/{invite_id}")
def admin_delete_invite(invite_id: str, request: Request) -> dict:
    """Permanently delete one invite request from the database."""
    require_admin(request)
    if not auth.delete_invite(invite_id):
        raise HTTPException(404, "Invite not found")
    return {"ok": True, "id": invite_id}


@app.get("/api/admin/users")
def admin_list_users(request: Request) -> dict:
    require_admin(request)
    return {"users": auth.list_admin_users(), "roles": sorted(auth.VALID_ROLES)}


class AdminCreateUserRequest(BaseModel):
    email: str
    username: str = ""
    password: str
    role: str = "user"


class AdminUpdateUserRequest(BaseModel):
    role: str | None = None
    username: str | None = None


@app.post("/api/admin/users")
def admin_create_user(req: AdminCreateUserRequest, request: Request) -> dict:
    """Create a user account directly (bypasses invite review)."""
    admin = require_admin(request)
    email = (req.email or "").strip().lower()
    if "@" not in email:
        raise HTTPException(400, "A valid email is required")
    if not req.password or len(req.password) < 6:
        raise HTTPException(400, "Password must be at least 6 characters")
    role = (req.role or "user").strip().lower()
    if role not in auth.VALID_ROLES:
        raise HTTPException(400, f"Invalid role. Use: {', '.join(sorted(auth.VALID_ROLES))}")
    if auth.get_user_by_email(email):
        raise HTTPException(409, "A user with this email already exists")
    try:
        user = auth.create_user(
            email,
            req.username.strip() or email.split("@")[0],
            req.password,
            role=role,
        )
    except sqlite3.IntegrityError:
        raise HTTPException(409, "A user with this email already exists")
    auth.mark_invite_registered(email)
    log.bind(task="auth").info(f"admin {admin.email} created user {user.email} ({role})")
    return {"user": user.public()}


@app.patch("/api/admin/users/{user_id}")
def admin_update_user(user_id: str, req: AdminUpdateUserRequest, request: Request) -> dict:
    """Change a user's access level (role) or display name."""
    admin = require_admin(request)
    if user_id.startswith("invite:"):
        raise HTTPException(400, "Cannot change access until the user completes registration")
    target = auth.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    new_role = req.role.strip().lower() if req.role is not None else None
    if new_role is not None and new_role not in auth.VALID_ROLES:
        raise HTTPException(400, f"Invalid role. Use: {', '.join(sorted(auth.VALID_ROLES))}")
    # Prevent removing the last admin or demoting yourself if you're the only admin.
    if new_role == "user" and target.role == "admin":
        if auth.count_admins() <= 1:
            raise HTTPException(409, "Cannot demote the last admin account")
        if target.id == admin.id:
            raise HTTPException(409, "You cannot demote your own admin account")
    try:
        updated = auth.update_user(user_id, role=new_role, username=req.username)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not updated:
        raise HTTPException(404, "User not found")
    log.bind(task="auth").info(
        f"admin {admin.email} updated user {updated.email}"
        + (f" role={new_role}" if new_role else "")
    )
    return {"user": updated.public()}


@app.delete("/api/admin/users/{user_id}")
def admin_delete_user(user_id: str, request: Request) -> dict:
    """Remove a user account and end their sessions."""
    admin = require_admin(request)
    if user_id.startswith("invite:"):
        invite_id = user_id[7:]
        if not auth.revoke_approved_invite(invite_id):
            raise HTTPException(404, "Invite not found or already used")
        log.bind(task="auth").info(f"admin {admin.email} revoked invite {invite_id}")
        return {"ok": True}
    target = auth.get_user_by_id(user_id)
    if not target:
        raise HTTPException(404, "User not found")
    if target.id == admin.id:
        raise HTTPException(409, "You cannot delete your own account")
    if target.role == "admin" and auth.count_admins() <= 1:
        raise HTTPException(409, "Cannot delete the last admin account")
    from . import user_data

    for voice in user_data.list_voices(target.id):
        user_data.delete_voice(target.id, voice["id"])
    if not auth.delete_user(user_id):
        raise HTTPException(404, "User not found")
    log.bind(task="auth").info(f"admin {admin.email} deleted user {target.email}")
    return {"ok": True}


@app.get("/api/admin/costs")
def admin_costs(request: Request, days: int = 30, debug: bool = False) -> dict:
    """LLM / paid-API cost report for the admin dashboard."""
    require_admin(request)
    from . import costs

    return costs.report(days=max(1, min(days, 365)), debug=bool(debug))


# --------------------------------------------------------------- voice library --

@app.get("/api/voices")
def voices_list(request: Request) -> dict:
    """The signed-in user's saved voice library + built-in Kokoro / Pocket presets."""
    user = require_user(request)
    from . import user_data
    from .pipeline import tts

    default_id = (get_settings().kokoro_voice or "af_heart").strip()
    pocket_default = (get_settings().pocket_tts_default_voice or "jane").strip()
    return {
        "voices": user_data.list_voices(user.id),
        "presets": tts.list_kokoro_presets(),
        "pocket_presets": tts.list_pocket_presets(),
        "default_preset": default_id,
        "default_pocket": pocket_default,
        "kokoro_available": tts.kokoro_available(),
        "pocket_available": tts.pocket_available(),
        "tts_warmup": tts.free_tts_warmup_status(),
        "limit": user_data.voice_limit(user.role),
        "used": user_data.count_voices(user.id),
        "clone_recording_text": VOICE_CLONE_RECORDING_TEXT,
    }


@app.post("/api/voices")
async def voices_create(
    request: Request,
    name: str = Form(...),
    style: UploadFile | None = File(None),
    recording: UploadFile | None = File(None),
    engine: str = Form(""),
) -> dict:
    """Save a cloned voice (Supertonic JSON or Pocket TTS) and/or a mic recording."""
    user = require_user(request)
    from . import user_data
    from .pipeline import tts as tts_mod

    has_style = style is not None and (style.filename or "")
    has_rec = recording is not None and (recording.filename or "")
    if not has_style and not has_rec:
        raise HTTPException(400, "Upload a voice-style JSON or a microphone recording.")

    want_pocket = (engine or "").strip().lower() == "pocket"
    style_suffix = Path(style.filename or "").suffix.lower() if has_style else ""
    if style_suffix in {".safetensors", ".wav", ".mp3", ".flac", ".ogg"}:
        want_pocket = True

    if want_pocket:
        if not tts_mod.pocket_available():
            raise HTTPException(
                503,
                "Pocket TTS is not installed. Run: pip install pocket-tts",
            )
        try:
            if has_style and style_suffix == ".safetensors":
                data = await style.read()
                rec = user_data.save_pocket_voice(
                    user_id=user.id, role=user.role, name=name, style_bytes=data
                )
                return {"voice": rec}
            # Clone from recording or uploaded audio.
            import tempfile

            raw: bytes
            ext: str
            if has_rec:
                raw = await recording.read()
                ext = Path(recording.filename or "clip.webm").suffix.lower() or ".webm"
            else:
                raw = await style.read()
                ext = style_suffix or ".wav"
            with tempfile.TemporaryDirectory(prefix="pocket_clone_") as tmp:
                src = Path(tmp) / f"sample{ext}"
                src.write_bytes(raw)
                wav = Path(tmp) / "sample.wav"
                user_data._convert_recording_to_wav(src, wav)
                rec = user_data.save_pocket_voice(
                    user_id=user.id, role=user.role, name=name, audio_path=wav
                )
            return {"voice": rec}
        except (ValueError, RuntimeError, FileNotFoundError) as e:
            raise HTTPException(400, str(e)) from e

    if has_rec:
        data = await recording.read()
        ext = Path(recording.filename or "clip.webm").suffix.lower() or ".webm"
        try:
            rec = user_data.save_voice_recording(
                user_id=user.id, role=user.role, name=name, audio_bytes=data, ext=ext
            )
        except (ValueError, RuntimeError) as e:
            raise HTTPException(400, str(e)) from e
        if has_style:
            style_data = await style.read()
            try:
                tts_mod.validate_voice_style_bytes(style_data)
                attached = user_data.attach_voice_style(user.id, rec["id"], style_data)
                rec.update(attached)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
        return {"voice": rec}

    if Path(style.filename or "").suffix.lower() != ".json":
        raise HTTPException(400, "Voice style must be a Supertonic voice-style JSON file.")
    data = await style.read()
    try:
        tts_mod.validate_voice_style_bytes(data)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    try:
        rec = user_data.save_voice(
            user_id=user.id, role=user.role, name=name, style_bytes=data
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"voice": rec}


@app.post("/api/voices/{voice_id}/style")
async def voices_attach_style(
    voice_id: str,
    request: Request,
    style: UploadFile = File(...),
) -> dict:
    """Attach a Supertonic JSON to an existing recorded voice."""
    user = require_user(request)
    from . import user_data

    if Path(style.filename or "").suffix.lower() != ".json":
        raise HTTPException(400, "Voice style must be a Supertonic voice-style JSON file.")
    data = await style.read()
    try:
        rec = user_data.attach_voice_style(user.id, voice_id, data)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"voice": rec}


@app.post("/api/voices/{voice_id}/rebuild-style")
def voices_rebuild_style(voice_id: str, request: Request) -> dict:
    """Re-run local voice cloning from the saved recording."""
    user = require_user(request)
    from . import user_data

    rec = user_data.get_voice(user.id, voice_id)
    if not rec:
        raise HTTPException(404, "Voice not found")
    if not rec.get("recording_path"):
        raise HTTPException(400, "This voice has no recording to clone from.")
    try:
        rebuilt = user_data.ensure_voice_style(user.id, voice_id, force=True)
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e
    log.bind(task="voice").info(f"rebuilt voice style for {voice_id} ({rebuilt.get('style_source')})")
    return {"voice": rebuilt}


@app.get("/api/voices/{voice_id}/recording")
def voices_get_recording(voice_id: str, request: Request):
    """Download the saved reference recording for a voice."""
    user = require_user(request)
    from . import user_data

    p = user_data.recording_path(user.id, voice_id)
    if not p:
        raise HTTPException(404, "Recording not found")
    media = "audio/wav" if p.suffix.lower() == ".wav" else "audio/webm"
    return FileResponse(p, media_type=media, filename=p.name)


@app.delete("/api/voices/{voice_id}")
def voices_delete(voice_id: str, request: Request) -> dict:
    user = require_user(request)
    from . import user_data

    if not user_data.delete_voice(user.id, voice_id):
        raise HTTPException(404, "Voice not found")
    return {"ok": True}


# ----------------------------------------------------------- UI color palette --

VOICE_PREVIEW_TEXT = (
    "Hello! This is a quick sample of how this voice will sound in your video. "
    "It's warm, clear, and natural — perfect for narrating your content."
)

VOICE_CLONE_RECORDING_TEXT = (
    "The quick brown fox jumps over the lazy dog. Every video deserves a clear, "
    "natural narration that feels warm and human. Please read this paragraph at your "
    "normal speaking pace, in a quiet room, with the microphone about six inches away. "
    "Take a breath, then finish with: this is my voice for Multimodal Studio."
)


@app.get("/api/ui-palette")
def ui_palette_get(request: Request) -> dict:
    """Active app color palette (public so login matches the studio theme)."""
    return {"palette": ui_theme.get_palette()}


@app.get("/api/admin/ui-palette")
def admin_ui_palette_get(request: Request) -> dict:
    require_admin(request)
    return ui_theme.palette_response()


class UiPaletteUpdate(BaseModel):
    name: str = ""
    primary: str = ""
    primary_foreground: str = ""
    brand: str = ""
    brand_2: str = ""
    blue: str = ""
    blue_2: str = ""


@app.put("/api/admin/ui-palette")
def admin_ui_palette_put(req: UiPaletteUpdate, request: Request) -> dict:
    require_admin(request)
    palette = ui_theme.save_palette(req.model_dump())
    log.bind(task="ui").info(f"admin updated UI palette -> {palette.get('name')}")
    return {"ok": True, "palette": palette}


# -------------------------------------------------------- social credentials --

@app.get("/api/admin/social-credentials")
def admin_social_credentials_get(request: Request) -> dict:
    require_admin(request)
    from . import social_credentials as sc
    return sc.public_status()


class SocialCredUpdate(BaseModel):
    platform: str
    enabled: bool | None = None
    auto_post: bool | None = None
    fields: dict[str, str] | None = None


@app.put("/api/admin/social-credentials")
def admin_social_credentials_put(req: SocialCredUpdate, request: Request) -> dict:
    require_admin(request)
    from . import social_credentials as sc
    updates: dict = {}
    if req.enabled is not None:
        updates["enabled"] = req.enabled
    if req.auto_post is not None:
        updates["auto_post"] = req.auto_post
    if req.fields:
        updates.update(req.fields)
    try:
        return sc.update_platform(req.platform, updates)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class SocialCredClear(BaseModel):
    platform: str
    key: str


@app.post("/api/admin/social-credentials/clear")
def admin_social_credentials_clear(req: SocialCredClear, request: Request) -> dict:
    require_admin(request)
    from . import social_credentials as sc
    try:
        return sc.clear_field(req.platform, req.key)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/social/status")
def social_status(request: Request) -> dict:
    """Which platforms are ready to post (no secrets)."""
    require_user(request)
    from . import social_credentials as sc
    data = sc.public_status()
    return {
        "platforms": [
            {
                "id": p["id"],
                "label": p["label"],
                "enabled": p["enabled"],
                "auto_post": p["auto_post"],
                "ready": p["ready"],
            }
            for p in data.get("platforms", [])
        ]
    }


class SocialPostRequest(BaseModel):
    platform: str
    # video | image | carousel | auto
    mode: str = "auto"


@app.post("/api/jobs/{job_id}/social-post")
def social_post_endpoint(job_id: str, req: SocialPostRequest, request: Request) -> dict:
    """Post video / image / carousel + caption to a configured platform."""
    job = _job_for_user(request, job_id)
    from .pipeline import social_post as social_post_mod

    try:
        result = social_post_mod.post_to_platform(job, req.platform, mode=req.mode or "auto")
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    # Persist last results per platform
    prev = dict(job.content.get("social_post_results") or {})
    if isinstance(prev, list):
        prev = {r.get("platform", f"p{i}"): r for i, r in enumerate(prev)}
    prev[req.platform] = result
    store.set_content(job, "social_post_results", prev)
    if req.platform == "youtube" and result.get("result"):
        store.set_artifact(job, "youtube", result["result"])
    return result


@app.post("/api/jobs/{job_id}/social-prepare-carousel")
def social_prepare_carousel(job_id: str, request: Request) -> dict:
    """Resize slide frames to Instagram square images (downloadable)."""
    job = _job_for_user(request, job_id)
    from .pipeline import social_post as social_post_mod

    work, _, _, slides = social_post_mod._work_paths(job)
    if not slides:
        raise HTTPException(400, "No slide images available yet — finish capture first.")
    try:
        staged = social_post_mod.prepare_instagram_carousel(work, slides)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, str(e)) from e
    media = [f"/files/{job.id}/social/ig_carousel/{p.name}" for p in staged]
    store.set_content(job, "ig_carousel", media)
    return {"ok": True, "images": len(media), "media": media}


@app.post("/api/voices/preview")
async def voices_preview(
    request: Request,
    voice_id: str = Form(""),
    voice_preset: str = Form(""),
    pocket_voice: str = Form(""),
    style: UploadFile | None = File(None),
) -> FileResponse:
    """Preview a voice with fixed sample text (not from the user's document).

    Pass ``voice_preset`` (Kokoro id), ``pocket_voice`` (Pocket catalog id),
    ``voice_id`` (cloned library voice), or upload a style JSON / safetensors.
    """
    user = require_user(request)
    from . import user_data
    from .pipeline import tts
    import uuid

    style_ref: str | None = None
    cloud_voice_id: str | None = None
    kokoro_voice: str | None = None
    pocket_id: str | None = None
    vid = (voice_id or "").strip()
    preset = (voice_preset or "").strip()
    pocket = (pocket_voice or "").strip()
    preview_dir = WORKSPACE_DIR / "voice_previews"
    preview_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex[:10]

    if style and style.filename:
        data = await style.read()
        suffix = Path(style.filename or "").suffix.lower()
        if suffix == ".safetensors":
            tmp_style = preview_dir / f"preview_{user.id}_{token}.safetensors"
            tmp_style.write_bytes(data)
            style_ref = str(tmp_style)
        elif suffix in {".wav", ".mp3", ".flac", ".ogg"}:
            tmp_audio = preview_dir / f"preview_{user.id}_{token}{suffix}"
            tmp_audio.write_bytes(data)
            style_ref = str(tmp_audio)
        else:
            try:
                tts.validate_voice_style_bytes(data)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e
            tmp_style = preview_dir / f"preview_{user.id}_{token}.json"
            tmp_style.write_bytes(data)
            style_ref = str(tmp_style)
    elif vid:
        p = user_data.voice_path(user.id, vid)
        rec = user_data.get_voice(user.id, vid)
        rec_path = user_data.recording_path(user.id, vid)
        if p:
            style_ref = str(p)
        elif rec and rec.get("cloud_voice_id"):
            cloud_voice_id = str(rec["cloud_voice_id"])
        elif rec_path:
            return FileResponse(
                rec_path,
                media_type="audio/wav" if rec_path.suffix == ".wav" else "audio/webm",
                filename=f"voice-recording{rec_path.suffix}",
            )
        else:
            raise HTTPException(404, "Voice not found")
    elif pocket:
        if pocket not in tts.pocket_preset_ids():
            raise HTTPException(400, f"Unknown Pocket voice: {pocket}")
        if not tts.pocket_available():
            raise HTTPException(503, "Pocket TTS is not installed (pip install pocket-tts).")
        pocket_id = pocket
    elif preset:
        if preset not in tts.kokoro_preset_ids():
            raise HTTPException(400, f"Unknown Kokoro preset: {preset}")
        kokoro_voice = preset
    else:
        # Default built-in narrator.
        kokoro_voice = (get_settings().kokoro_voice or "af_heart").strip()

    # Cloud preview needs an API key, not the local supertonic package.
    if cloud_voice_id and not (get_settings().supertone_api_key or "").strip():
        raise HTTPException(503, "SUPERTONE_API_KEY is not configured for cloud preview")
    pocket_style = bool(
        style_ref
        and Path(style_ref).suffix.lower() in {".safetensors", ".wav", ".mp3", ".flac", ".ogg"}
    )
    if style_ref and not pocket_style and not tts.supertonic_available():
        raise HTTPException(
            503,
            "Local clone preview needs Supertonic 3 (pip install supertonic).",
        )
    if pocket_style and not tts.pocket_available():
        raise HTTPException(503, "Pocket TTS is not installed (pip install pocket-tts).")
    if (
        not cloud_voice_id
        and not style_ref
        and not pocket_id
        and not tts.any_tts_available()
    ):
        raise HTTPException(503, "No TTS engine available for preview")

    suffix = tts.output_suffix(
        style_ref, cloud_voice_id=cloud_voice_id, pocket_voice=pocket_id
    )
    out_path = preview_dir / f"preview_{user.id}_{token}{suffix}"
    try:
        tts.synthesize(
            VOICE_PREVIEW_TEXT,
            out_path,
            voice_style=style_ref,
            cloud_voice_id=cloud_voice_id,
            kokoro_voice=kokoro_voice,
            pocket_voice=pocket_id,
        )
    except Exception as e:
        raise HTTPException(500, f"Preview failed: {e}") from e

    media = "audio/wav" if suffix == ".wav" else "audio/mpeg"
    return FileResponse(out_path, media_type=media, filename=f"voice-preview{suffix}")


# ------------------------------------------------------- cron / automation API --

def _cron_folders() -> list[dict]:
    """List automation_output paper folders and their artifacts.

    Merges durable ``history.json`` rows so published runs still appear after
    a folder delete, and every live folder gets an explicit ``status``.

    Skips internal dirs (e.g. ``topics`` prep cache) that are not video runs.
    """
    out: list[dict] = []
    root = _automation_output_dir()
    seen_ids: set[str] = set()
    # Not run folders — topic prep lives under automation_output/topics/.
    skip_dirs = {"topics", "__pycache__", "tmp", "temp"}
    hist_by_id: dict[str, dict] = {}
    try:
        for row in auto.load_history(root):
            fid = str(row.get("id") or "")
            if fid:
                hist_by_id[fid] = row
    except Exception:
        hist_by_id = {}

    if root.exists():
        for folder in sorted(root.iterdir(), reverse=True):
            if not folder.is_dir():
                continue
            if folder.name.startswith(".") or folder.name.lower() in skip_dirs:
                continue
            # Require a run signal so prep/cache dirs never pollute the queue.
            has_run = any(
                (folder / name).exists()
                for name in (
                    "paper.json", "paper.pdf", "published.json",
                    "checkpoint.json", "results.json",
                )
            ) or any(folder.glob("*.pdf")) or any(folder.glob("video*.mp4")) or (folder / "video").is_dir()
            if not has_run:
                continue
            entry: dict = {"id": folder.name, "artifacts": {}, "deleted": False}
            paper_json = folder / "paper.json"
            if paper_json.exists():
                try:
                    entry["paper"] = json.loads(paper_json.read_text(encoding="utf-8"))
                except Exception:
                    entry["paper"] = {}
            else:
                entry["paper"] = {}
            # Prefer a real video title over a weak folder/paper name.
            weak = {
                "", folder.name.lower(), "topics", "paper", "untitled", "overview",
            }
            cur_title = str((entry.get("paper") or {}).get("title") or "").strip()
            if cur_title.lower() in weak:
                for meta_rel in (
                    "video/metadata.json",
                    "metadata.json",
                    "video_metadata.json",
                    "reel/metadata.json",
                ):
                    mp = folder / meta_rel
                    if not mp.is_file():
                        continue
                    try:
                        meta = json.loads(mp.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    mt = str(meta.get("title") or meta.get("slide_title") or "").strip()
                    if mt and mt.lower() not in weak:
                        entry.setdefault("paper", {})["title"] = mt
                        break
            # Resolve PDF path (named file preferred over legacy paper.pdf).
            try:
                from .automation import sources as _auto_src
                pdf_path = _auto_src.resolve_pdf_path(folder, entry.get("paper") or {})
                if pdf_path.is_file():
                    entry["artifacts"]["pdf"] = pdf_path.name
                    entry.setdefault("paper", {})["pdf_file"] = pdf_path.name
            except Exception:
                if (folder / "paper.pdf").exists():
                    entry["artifacts"]["pdf"] = "paper.pdf"
            videos: list[str] = []
            for f in folder.rglob("*"):
                if not f.is_file():
                    continue
                rel = f.relative_to(folder).as_posix()
                name = f.name.lower()
                if name.endswith((".mp4", ".mov", ".webm")):
                    videos.append(rel)
                elif name.endswith((".png", ".jpg", ".jpeg", ".webp")) and "thumb" in name:
                    entry["artifacts"].setdefault("thumbnails", []).append(rel)
                elif name in {"presentation.html"} or name.endswith("_presentation.html"):
                    entry["artifacts"].setdefault("slides", []).append(rel)
                elif name in {"post.txt", "narration.txt"}:
                    entry["artifacts"].setdefault("posts", []).append(rel)
                elif name.endswith(".json") and name not in {"paper.json", "published.json", "checkpoint.json", "results.json"}:
                    entry["artifacts"].setdefault("meta", []).append(rel)
                elif "/audio/" in rel or rel.startswith("audio/"):
                    entry["artifacts"].setdefault("audio", []).append(rel)
            videos.sort(
                key=lambda r: (
                    0 if r.startswith("video/") or r.startswith("video_") else 1,
                    r,
                )
            )
            if videos:
                entry["artifacts"]["videos"] = videos
            thumbs = entry["artifacts"].get("thumbnails") or []
            if thumbs:
                thumbs.sort(
                    key=lambda r: (
                        0 if r.startswith("video/") or r.startswith("video_") else 1,
                        r,
                    )
                )
                entry["artifacts"]["thumbnail"] = thumbs[0]
            if (folder / "post.txt").exists():
                entry["artifacts"].setdefault("posts", [])
                if "post.txt" not in entry["artifacts"]["posts"]:
                    entry["artifacts"]["posts"].insert(0, "post.txt")
            if (folder / "results.json").exists():
                entry["artifacts"]["results"] = "results.json"
            entry["published"] = (folder / "published.json").exists()
            # Incomplete = PDF present but no video yet (stopped mid-run).
            has_vid = bool(entry["artifacts"].get("videos"))
            entry["incomplete"] = bool(entry["artifacts"].get("pdf")) and not has_vid
            if entry["incomplete"]:
                ck = folder / "checkpoint.json"
                if ck.is_file():
                    try:
                        entry["checkpoint"] = json.loads(ck.read_text(encoding="utf-8"))
                    except Exception:
                        entry["checkpoint"] = {}
            if entry["published"]:
                entry["status"] = "published"
            elif has_vid:
                entry["status"] = "ready"
            elif entry["incomplete"]:
                entry["status"] = "incomplete"
            else:
                entry["status"] = "processing"
            hist = hist_by_id.get(folder.name) or {}
            entry["archived"] = bool(hist.get("archived"))
            if hist.get("youtube"):
                entry["youtube"] = hist["youtube"]
            # Archived rows live in History, not the active queue.
            if entry["archived"] and entry["status"] in {"ready", "published", "incomplete"}:
                entry["status"] = entry["status"]  # keep real status; filter uses archived flag
            seen_ids.add(folder.name)
            out.append(entry)

    # Tombstones from history (published/archived rows kept after folder delete).
    for fid, row in hist_by_id.items():
        if fid in seen_ids:
            continue
        if fid.lower() in skip_dirs:
            continue
        is_pub = bool(row.get("published") or row.get("status") == "published")
        is_arch = bool(row.get("archived"))
        if not (is_pub or is_arch):
            continue
        out.append({
            "id": fid,
            "paper": row.get("paper") or {"title": fid},
            "artifacts": {},
            "published": is_pub,
            "incomplete": False,
            "deleted": bool(row.get("deleted")),
            "archived": is_arch,
            "status": "published" if is_pub else (row.get("status") or "ready"),
            "youtube": row.get("youtube") or {},
            "history_only": True,
        })
        seen_ids.add(fid)

    # Newest-ish: prefer live folders already reverse-sorted; append tombstones last
    # then re-sort by id (date-prefixed) descending.
    out.sort(key=lambda r: str(r.get("id") or ""), reverse=True)
    return out


@app.get("/api/admin/cron")
def admin_cron_list(request: Request) -> dict:
    require_admin(request)
    return {"runs": _cron_folders()}


@app.get("/api/admin/automation")
def admin_automation_status(request: Request) -> dict:
    """Current automation run state + schedule (for the admin dashboard)."""
    require_admin(request)
    return auto.status()


@app.get("/api/admin/automation/preview")
def admin_automation_preview(request: Request) -> dict:
    """Preview which paper PDF(s) the next run would process."""
    require_admin(request)
    return auto.preview()


@app.get("/api/admin/automation/topics")
def admin_automation_topics(request: Request, refresh: bool = False) -> dict:
    """Trending AI topics for the Cron input tab (auto-refreshes after ~1h)."""
    require_admin(request)
    from .automation import topics as topics_mod

    return topics_mod.list_trending(refresh=refresh)


class TopicPrepareRequest(BaseModel):
    topic_id: str = ""
    topic: str = ""


class TopicSelectRequest(BaseModel):
    topic_id: str
    selected: bool = True
    title: str = ""
    blurb: str = ""


class TopicSearchRequest(BaseModel):
    query: str


@app.post("/api/admin/automation/topics/search")
def admin_automation_topics_search(req: TopicSearchRequest, request: Request) -> dict:
    """Search HN / AI news for a topic query; returns up to 4 scored angles."""
    require_admin(request)
    from .automation import topics as topics_mod

    try:
        return topics_mod.search_topics(req.query)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        log.bind(task="auto-topics").error(f"search failed: {e}")
        raise HTTPException(500, f"Search failed: {e}") from e


@app.post("/api/admin/automation/topics/select")
def admin_automation_topics_select(req: TopicSelectRequest, request: Request) -> dict:
    """Persist topic selection in SQLite for data-wise tracking."""
    require_admin(request)
    from .automation import topics as topics_mod

    try:
        row = topics_mod.select_topic(
            req.topic_id,
            selected=bool(req.selected),
            title=req.title,
            blurb=req.blurb,
        )
        return {"ok": True, "topic": row}
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/admin/automation/topics/prepare")
def admin_automation_topics_prepare(req: TopicPrepareRequest, request: Request) -> dict:
    """Prepare rich, citable content for a topic via Gemini Flash-Lite."""
    require_admin(request)
    from .automation import topics as topics_mod

    try:
        return topics_mod.prepare(topic_id=req.topic_id, topic=req.topic)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:
        log.bind(task="auto-topics").error(f"prepare failed: {e}")
        raise HTTPException(500, f"Prepare failed: {e}") from e


class TopicQueueRequest(BaseModel):
    topic_id: str
    video_format: str = "youtube_video"
    target_duration: int = 480
    video_theme: str = "snow"
    video_style: str = "whiteboard"
    force: bool = False


@app.post("/api/admin/automation/topics/queue")
def admin_automation_topics_queue(req: TopicQueueRequest, request: Request) -> dict:
    """Create a Studio job from prepared topic content and start rendering."""
    user = require_admin(request)
    from .automation import topics as topics_mod

    try:
        return topics_mod.queue_video_from_prep(
            req.topic_id,
            user_id=getattr(user, "id", "system") or "system",
            video_opts={
                "video_format": req.video_format,
                "target_duration": req.target_duration,
                "video_theme": req.video_theme,
                "video_style": req.video_style,
            },
            force=req.force,
        )
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except Exception as e:
        raise HTTPException(500, f"Queue failed: {e}") from e


@app.post("/api/admin/automation/trigger")
async def admin_automation_trigger(request: Request) -> dict:
    """Manually start an automation run for selected pending papers (admin).

    Requires JSON body ``{"paper_ids": ["arxiv:…", …]}``. Incomplete folders
    are not auto-started — use Resume / Complete for those.
    """
    require_admin(request)
    paper_ids: list[str] = []
    try:
        body = await request.json()
        if isinstance(body, dict) and body.get("paper_ids"):
            paper_ids = [str(x) for x in body["paper_ids"] if str(x).strip()]
    except Exception:
        paper_ids = []
    if not paper_ids:
        raise HTTPException(
            400,
            "Select one or more pending papers to run. "
            "Incomplete folders use Resume / Complete — they never auto-start.",
        )
    started = auto.trigger("manual", paper_ids=paper_ids)
    if not started:
        raise HTTPException(409, "An automation run is already in progress")
    return {"ok": True, "status": auto.status(), "selected": paper_ids}


@app.post("/api/admin/automation/resume")
def admin_automation_resume(request: Request) -> dict:
    """Continue incomplete paper folders where a previous run stopped."""
    require_admin(request)
    incomplete = auto.list_incomplete()
    if not incomplete:
        raise HTTPException(404, "Nothing to resume — no incomplete paper folders")
    started = auto.resume()
    if not started:
        raise HTTPException(409, "An automation run is already in progress")
    return {"ok": True, "resuming": incomplete, "status": auto.status()}


@app.post("/api/admin/automation/pause")
def admin_automation_pause(request: Request) -> dict:
    """Pause the active run after the current paper finishes."""
    require_admin(request)
    return auto.cancel_run()


class AutomationJobAction(BaseModel):
    folder: str = ""
    paper_id: str = ""
    # skip: mark seen so similar/same paper won't re-queue
    # delete: remove folder (optional mark_seen)
    # complete: resume just this paper
    mark_seen: bool = False
    delete_folder: bool = False


@app.post("/api/admin/automation/delete")
def admin_automation_delete(req: AutomationJobAction, request: Request) -> dict:
    """Delete an automation job folder. Use mark_seen if it should not reappear."""
    require_admin(request)
    if not req.folder and not req.paper_id:
        raise HTTPException(400, "folder or paper_id is required")
    try:
        return auto.delete_job(req.folder, paper_id=req.paper_id, mark_seen=bool(req.mark_seen))
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/admin/automation/skip")
def admin_automation_skip(req: AutomationJobAction, request: Request) -> dict:
    """Mark paper as already handled (similar/same already generated) — won't re-queue."""
    require_admin(request)
    try:
        return auto.skip_paper(
            req.paper_id,
            folder_name=req.folder,
            delete_folder=bool(req.delete_folder),
        )
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/admin/automation/complete")
def admin_automation_complete(req: AutomationJobAction, request: Request) -> dict:
    """Complete / resume one specific incomplete paper."""
    require_admin(request)
    try:
        return auto.complete_paper(paper_id=req.paper_id, folder_name=req.folder)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except RuntimeError as e:
        raise HTTPException(409, str(e)) from e


class AutomationToggle(BaseModel):
    enabled: bool


@app.post("/api/admin/automation/toggle")
def admin_automation_toggle(req: AutomationToggle, request: Request) -> dict:
    """Enable/disable the scheduled automation (manual trigger still works)."""
    require_admin(request)
    get_settings().auto_enabled = req.enabled
    log.bind(task="auto").info(f"scheduler {'enabled' if req.enabled else 'disabled'} by admin")
    return {"ok": True, "status": auto.status()}


@app.get("/api/admin/runtime-settings")
def admin_runtime_settings_get(request: Request) -> dict:
    """Current LLM / thumbnail backend selection (admin dashboard)."""
    require_admin(request)
    from . import runtime_settings as rs

    return rs.current()


class RuntimeSettingsUpdate(BaseModel):
    llm_provider: str = ""
    gemini_model: str = ""
    gemini_vision_model: str = ""
    ollama_model: str = ""
    ollama_vision_model: str = ""
    openai_model: str = ""
    openai_vision_model: str = ""
    thumbnail_backend: str = ""
    auto_video_style: str = ""
    auto_video_theme: str = ""


@app.put("/api/admin/runtime-settings")
def admin_runtime_settings_put(req: RuntimeSettingsUpdate, request: Request) -> dict:
    """Admin selects local (Ollama/Gemma), Gemini, or OpenAI for cron/jobs."""
    require_admin(request)
    from . import runtime_settings as rs

    payload = {k: v for k, v in req.model_dump().items() if str(v or "").strip()}
    try:
        snap = rs.save(payload)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    return {"ok": True, "settings": snap, "status": auto.status()}


@app.post("/api/admin/cron/{folder}/delete")
def admin_cron_delete(folder: str, request: Request, mark_seen: bool = False) -> dict:
    """Delete a cron/automation output folder from the history list."""
    require_admin(request)
    try:
        return auto.delete_job(folder, mark_seen=mark_seen)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e


@app.post("/api/admin/cron/{folder}/archive")
def admin_cron_archive(folder: str, request: Request, archived: bool = True) -> dict:
    """Move a run to History (archived) or restore it to the active filters."""
    require_admin(request)
    try:
        return auto.archive_job(folder, archived=archived)
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from e


@app.get("/api/admin/cron/{folder}/file/{path:path}")
def admin_cron_file(folder: str, path: str, request: Request):
    require_admin(request)
    root = _automation_output_dir().resolve()
    base = _safe_cron_dir(folder)
    target = (base / path).resolve()
    if not base.is_relative_to(root):
        raise HTTPException(403, "Forbidden")
    if base not in target.parents and target != base:
        raise HTTPException(403, "Forbidden")
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    return FileResponse(
        target,
        filename=target.name,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )


class PublishCronRequest(BaseModel):
    title: str = ""
    description: str = ""


@app.post("/api/admin/cron/{folder}/publish")
def admin_cron_publish(folder: str, req: PublishCronRequest, request: Request) -> dict:
    """Mark an automation run as reviewed + publish it.

    Actual YouTube upload requires client_secrets.json; when unavailable this
    records the review decision so the run is flagged as published/approved.
    Prefers long-form ``video/video.mp4`` (not the reel) and fills title /
    description from ``video/metadata.json`` when the request body is empty.
    """
    require_admin(request)
    base = _safe_cron_dir(folder)
    if not base.exists() or not base.is_dir():
        raise HTTPException(404, "Run not found")
    caps = detect_capabilities()
    meta = _load_cron_publish_meta(base)
    title = (req.title or meta.get("title") or folder).strip()
    description = (req.description or meta.get("description") or "").strip()
    tags = meta.get("tags") if isinstance(meta.get("tags"), list) else None
    record = {
        "reviewed_at": _time.time(),
        "title": title,
        "description": description,
        "tags": tags or [],
        "youtube_available": bool(caps.youtube),
    }
    yt_result = None
    if caps.youtube:
        try:
            from .pipeline import publish as _publish
            video = _prefer_cron_video(base)
            thumb = _prefer_cron_thumb(base)
            if video:
                yt_result = _publish.upload_to_youtube(
                    video_path=video,
                    title=title,
                    description=description,
                    thumbnail=thumb,
                    tags=tags,
                )
                record["youtube"] = yt_result
                record["video"] = video.relative_to(base).as_posix()
        except Exception as e:  # best-effort — never 500 the review
            record["error"] = str(e)
            log.bind(task="cron").warning(f"cron publish failed for {folder}: {e}")
    try:
        auto.mark_folder_published(base, record)
    except Exception:
        (base / "published.json").write_text(json.dumps(record, indent=2), encoding="utf-8")
    log.bind(task="cron").info(f"cron run {folder} published (youtube={bool(yt_result)})")
    return {"ok": True, "published": record}


@app.get("/api/capabilities")
def capabilities(refresh: bool = False) -> dict:
    from .pipeline import tts

    caps = detect_capabilities(refresh=refresh).dict()
    caps["runner"] = runner.stats()
    caps["kokoro"] = tts.kokoro_available()
    caps["kokoro_model"] = "kokoro-v1.0.onnx"
    caps["pocket"] = tts.pocket_available()
    caps["pocket_model"] = "kyutai/pocket-tts"
    caps["supertonic_model"] = "Supertone/supertonic-3"
    caps["tts_warmup"] = tts.free_tts_warmup_status()
    caps["voice_default_label"] = "Kokoro ONNX (af_heart)"
    caps["voice_clone_label"] = "Supertonic 3 (local style optimizer)"
    caps["voice_pocket_label"] = "Kyutai Pocket TTS"
    from .pipeline.voice_style_builder import auto_clone_available

    caps["voice_auto_clone"] = auto_clone_available()
    caps["voice_clone_optimize"] = get_settings().voice_clone_optimize_enabled
    from .pipeline import thumbnail as thumb_mod

    tb = thumb_mod.probe_backends()
    caps.update({
        "thumbnail_backend": get_settings().thumbnail_backend,
        "gemini_image_model": get_settings().gemini_image_model,
        "nano_banana": tb.get("nano_banana"),
        "nano_banana_reason": tb.get("nano_banana_reason"),
        "image_available": tb.get("any_image"),
        "slide_ai_images_default": get_settings().slide_ai_images_default,
        "scenarios": [],
    })
    return caps


class MediaTestImageRequest(BaseModel):
    prompt: str = ""
    width: int = 1280
    height: int = 720
    backend: str = "auto"  # auto | nano_banana
    scenario: str = ""
    image_b64: str = ""


@app.get("/api/media/status")
def media_status(refresh: bool = False) -> dict:
    """Nano Banana thumbnail backend status for the image lab."""
    from .pipeline import thumbnail as thumb_mod

    tb = thumb_mod.probe_backends()
    s = get_settings()
    return {
        "thumbnail_backend": s.thumbnail_backend,
        "generate_thumbnail": s.generate_thumbnail,
        "backends": tb,
        "scenarios": [],
        "models": {
            "nano_banana": s.gemini_image_model,
        },
        "slide_ai_images_default": s.slide_ai_images_default,
        "install_hint": (
            "Thumbnails: Nano Banana Pro needs GEMINI_API_KEY. "
            "Local image models are not installed right now."
        ),
    }


@app.post("/api/media/test-image")
def media_test_image(req: MediaTestImageRequest, request: Request) -> dict:
    """Generate a test thumbnail via Nano Banana — does not affect pipeline jobs."""
    import base64
    import tempfile

    require_user(request)
    from .pipeline import thumbnail as thumb_mod

    backend = (req.backend or "auto").strip().lower()
    raw_prompt = (req.prompt or "").strip()
    prompt = raw_prompt or thumb_mod.build_nano_banana_prompt(
        "Test image", "Multimodal Studio"
    )

    with tempfile.TemporaryDirectory(prefix="media_test_") as tmp:
        out = Path(tmp) / "test.png"
        path, msg = thumb_mod.generate_thumbnail(
            "Test image",
            "Multimodal Studio",
            out,
            prompt_override=prompt,
            backend_override=backend,
        )
        used = "nano_banana"
        if path is None or not path.is_file():
            return {"ok": False, "message": msg or "Image generation failed.", "backend": used}
        raw = path.read_bytes()
        return {
            "ok": True,
            "message": msg,
            "backend": used,
            "scenario": (req.scenario or "").strip() or None,
            "image_b64": base64.b64encode(raw).decode("ascii"),
            "mime": "image/png",
        }


@app.get("/api/video-formats")
def video_formats() -> dict:
    """Public catalog for the Studio pickers (formats, themes, layouts)."""
    from .video_options import PLATFORM_FORMAT_HINTS, THEME_ALIASES

    payload = {
        "formats": public_video_formats(),
        "themes": [],
        "styles": [],
        "style_categories": [],
        "visual_presets": [],
        "platform_formats": dict(PLATFORM_FORMAT_HINTS),
        "theme_aliases": dict(THEME_ALIASES),
    }
    # Formats must always ship even if a style/theme helper throws.
    try:
        payload["themes"] = public_video_themes()
        payload["styles"] = public_video_styles()
        payload["style_categories"] = public_style_categories()
        payload["visual_presets"] = public_visual_presets()
    except Exception:
        log.bind(task="video-formats").exception("style/theme catalog failed")
    return payload


@app.get("/api/audience")
def audience_catalog() -> dict:
    """Age groups, knowledge levels, and the custom prompts they load."""
    from .pipeline.audience import catalog

    return catalog()


@app.post("/api/jobs/plan")
async def plan_job_topics(
    request: Request,
    file: UploadFile,
    video_format: str = Form("youtube_video"),
    video_theme: str = Form("snow"),
    video_style: str = Form("whiteboard"),
    target_duration: int = Form(480),
    content_layout: str = Form("auto"),
) -> dict:
    """Extract a large upload and classify it into selectable video topics."""
    from . import batch_jobs
    from .video_options import normalize_video_options

    user = require_user(request)
    fname = file.filename or ""
    suffix = Path(fname).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(400, "Unsupported file for topic planning.")
    video_opts = normalize_video_options(
        video_format=video_format,
        target_duration=target_duration,
        video_theme=video_theme,
        video_style=video_style,
    )
    video_opts["content_layout"] = (content_layout or "auto").strip() or "auto"
    style_key = str(video_opts.get("video_style") or "").strip().lower()
    if style_key and style_key != "auto":
        video_opts["lock_visual_preset"] = True
    else:
        video_opts.pop("lock_visual_preset", None)
    data = await file.read()
    if not data:
        raise HTTPException(400, "Empty upload")
    try:
        result = await asyncio.to_thread(
            batch_jobs.create_plan_job,
            filename=fname,
            data=data,
            user_id=user.id,
            options=video_opts,
        )
        return result
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        log.bind(task="job").error(f"plan topics failed: {e}")
        raise HTTPException(500, f"Topic planning failed: {e}") from e


@app.get("/api/jobs/{job_id}/topics")
def get_job_topics(request: Request, job_id: str) -> dict:
    from . import batch_jobs

    user = require_user(request)
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.user_id and job.user_id != user.id and not user.is_admin:
        raise HTTPException(403, "Forbidden")
    plan = batch_jobs.get_plan(job_id)
    if not plan:
        raise HTTPException(404, "No topic plan on this job — run Plan topics first")
    return plan


@app.post("/api/jobs/{job_id}/topics")
async def reclassify_job_topics(request: Request, job_id: str) -> dict:
    from . import batch_jobs

    user = require_user(request)
    job = store.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    if job.user_id and job.user_id != user.id and not user.is_admin:
        raise HTTPException(403, "Forbidden")
    body: dict = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    try:
        return batch_jobs.reclassify_plan(
            job_id, max_topics=int(body.get("max_topics") or 80)
        )
    except FileNotFoundError:
        raise HTTPException(404, "Plan not found")
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(500, f"Reclassify failed: {e}") from e


@app.post("/api/jobs/from-plan")
async def create_jobs_from_plan(request: Request) -> dict:
    """Create one or many videos from a topic plan + selection."""
    from . import batch_jobs

    user = require_user(request)
    body: dict = {}
    try:
        body = await request.json()
    except Exception:
        body = {}
    plan_id = (body.get("plan_id") or body.get("job_id") or "").strip()
    if not plan_id:
        raise HTTPException(400, "plan_id is required")
    parent = store.get(plan_id)
    if not parent:
        raise HTTPException(404, "Plan not found")
    if parent.user_id and parent.user_id != user.id and not user.is_admin:
        raise HTTPException(403, "Forbidden")
    selected = body.get("selected_ids") or body.get("topics") or []
    if isinstance(selected, str):
        selected = [s.strip() for s in selected.split(",") if s.strip()]
    video_opts = {
        "video_format": body.get("video_format") or parent.options.get("video_format"),
        "video_theme": body.get("video_theme") or parent.options.get("video_theme"),
        "video_style": body.get("video_style") or parent.options.get("video_style"),
        "target_duration": body.get("target_duration")
        if body.get("target_duration") is not None
        else parent.options.get("target_duration"),
    }
    # Voice can be locked on the plan job (Extract stage) or sent with this request.
    for vk in ("voice_preset", "pocket_voice", "voice_id", "voice_style_path", "cloud_voice_id"):
        if body.get(vk) is not None:
            video_opts[vk] = body.get(vk)
        elif vk in (parent.options or {}):
            video_opts[vk] = parent.options[vk]
    try:
        result = await asyncio.to_thread(
            batch_jobs.create_jobs_from_plan,
            plan_id,
            user_id=user.id,
            selected_ids=list(selected),
            mode=str(body.get("mode") or "per_topic"),
            video_opts=video_opts,
            enable_web_research=bool(body.get("enable_web_research", True)),
            deep_grounding=bool(body.get("deep_grounding", True)),
            content_layout=str(
                body.get("content_layout")
                or parent.options.get("content_layout")
                or "auto"
            ),
            extra_topics=str(body.get("extra_topics") or ""),
            age_group=str(body.get("age_group") or parent.options.get("age_group") or "auto"),
            knowledge_level=str(
                body.get("knowledge_level") or parent.options.get("knowledge_level") or "auto"
            ),
            custom_prompt=str(
                body.get("custom_prompt")
                if body.get("custom_prompt") is not None
                else parent.options.get("custom_prompt") or ""
            ),
            review_notes=str(body.get("review_notes") or parent.options.get("review_notes") or ""),
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(404, str(e)) from e
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except Exception as e:  # noqa: BLE001
        log.bind(task="job").error(f"from-plan failed: {e}")
        raise HTTPException(500, f"Failed to create videos from plan: {e}") from e


@app.post("/api/jobs")
async def create_job(
    request: Request,
    file: UploadFile,
    publish: bool = Form(False),
    target_duration: int = Form(480),
    video_format: str = Form("youtube_video"),
    video_theme: str = Form("snow"),
    video_style: str = Form("whiteboard"),
    youtube_video_url: str = Form(""),
    extra_topics: str = Form(""),
    enable_web_research: str = Form("false"),
    slide_ai_images: str = Form("false"),
    voice_preset: str = Form(""),
    pocket_voice: str = Form("jane"),
    voice_id: str = Form(""),
    age_group: str = Form("auto"),
    knowledge_level: str = Form("auto"),
    custom_prompt: str = Form(""),
    review_notes: str = Form(""),
    voice_style: UploadFile | None = File(None),
) -> dict:
    fname = file.filename or ""
    suffix = Path(fname).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise HTTPException(
            400,
            "Unsupported file. Upload a document (PDF, Word, PowerPoint, TXT, "
            "Markdown, HTML, EPUB) or an image (PNG, JPG, WEBP, GIF, TIFF).",
        )

    video_opts = normalize_video_options(
        video_format=video_format,
        target_duration=target_duration,
        youtube_video_url=youtube_video_url,
        video_theme=video_theme,
        video_style=video_style,
    )
    # Lock only when the user picked an explicit style (theme alone must not
    # freeze video_style=auto).
    style_key = str(video_opts.get("video_style") or "").strip().lower()
    if style_key and style_key != "auto":
        video_opts["lock_visual_preset"] = True

    from .pipeline import tts as tts_mod

    voice_opts: dict = {}
    preset = voice_preset.strip()
    pocket = pocket_voice.strip()
    # Studio default: Pocket Jane when no other voice is chosen — only if Pocket works.
    if not pocket and not preset and not voice_id.strip() and not (
        voice_style is not None and (voice_style.filename or "")
    ):
        if tts_mod.pocket_available():
            pocket = (get_settings().pocket_tts_default_voice or "jane").strip() or "jane"
        else:
            pocket = ""
    if pocket and not tts_mod.pocket_available():
        # Don't fail the whole upload when Form default is jane but Pocket isn't installed.
        log.bind(task="job").warning(
            f"Pocket TTS unavailable; ignoring pocket_voice={pocket}"
        )
        pocket = ""
    if preset:
        if preset not in tts_mod.kokoro_preset_ids():
            raise HTTPException(400, f"Unknown Kokoro voice preset: {preset}")
        voice_opts["voice_preset"] = preset
    if pocket:
        if pocket not in tts_mod.pocket_preset_ids():
            raise HTTPException(400, f"Unknown Pocket voice: {pocket}")
        voice_opts["pocket_voice"] = pocket
        voice_opts.pop("voice_preset", None)

    # Validate optional voice inputs before creating a job record.
    if voice_style is not None and (voice_style.filename or ""):
        vs_suf = Path(voice_style.filename or "").suffix.lower()
        if vs_suf not in {".json", ".safetensors", ".wav", ".mp3"}:
            raise HTTPException(
                400,
                "Voice style must be a Supertonic JSON or Pocket .safetensors / wav.",
            )
    if voice_id.strip():
        from . import user_data

        user = require_user(request)
        rec = user_data.get_voice(user.id, voice_id.strip())
        if not rec:
            raise HTTPException(404, "Voice not found in your library")
        # Clone selection wins over a built-in preset for the same job.
        voice_opts.pop("voice_preset", None)
        voice_opts.pop("pocket_voice", None)

    user = require_user(request)
    want_slide_ai = str(slide_ai_images or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    want_web_research = str(enable_web_research or "").strip().lower() in {
        "1", "true", "yes", "on",
    }
    from .pipeline.audience import stamp_options

    job_opts = stamp_options(
        {
            "publish": publish,
            "extra_topics": (extra_topics or "").strip(),
            # Force live web research even for uploaded documents (user opt-in).
            "enable_web_research": want_web_research,
            # Experimental — stored for future slide image injection after Image lab QA.
            "slide_ai_images": want_slide_ai,
            **voice_opts,
            **video_opts,
        },
        age_group=age_group,
        knowledge_level=knowledge_level,
        custom_prompt=custom_prompt,
        review_notes=review_notes,
    )
    job = store.create(
        fname,
        options=job_opts,
        user_id=user.id,
    )
    from .workspace_store import resolve_job_dir

    work = resolve_job_dir(job.id, create=True)
    try:
        dest = work / ("input" + suffix)
        # Stream the upload to disk off the event loop so large files / many
        # concurrent uploads don't block other requests.
        data = await file.read()
        await asyncio.to_thread(dest.write_bytes, data)

        # Optional voice-style: Supertonic JSON or Pocket .safetensors / wav.
        if voice_style is not None and (voice_style.filename or ""):
            vs_suf = Path(voice_style.filename or "").suffix.lower() or ".json"
            vs_dest = work / f"voice_style{vs_suf}"
            vs_data = await voice_style.read()
            await asyncio.to_thread(vs_dest.write_bytes, vs_data)
            job.options["voice_style_path"] = vs_dest.name
        elif voice_id.strip():
            from . import user_data as ud

            try:
                resolved = ud.resolve_voice_for_job(
                    user.id, voice_id.strip(), work
                )
                job.options.update(resolved)
            except ValueError as e:
                raise HTTPException(400, str(e)) from e

        runner.submit(run_pipeline, job)
        caps = detect_capabilities()
        log.bind(task="job").info(
            f"created {job.id} [{fname}] provider={caps.provider} llm={caps.llm} "
            f"vlm={caps.vlm} tts={caps.tts_engine} fmt={video_format} target={target_duration}s"
            + (
                " voice=clone" if job.options.get("voice_style_path") or job.options.get("cloud_voice_id")
                else (
                    f" voice=pocket:{job.options.get('pocket_voice')}"
                    if job.options.get("pocket_voice")
                    else (
                        f" voice={job.options.get('voice_preset')}"
                        if job.options.get("voice_preset")
                        else ""
                    )
                )
            )
        )
        return {"id": job.id}
    except HTTPException:
        store.delete(job.id)
        shutil.rmtree(work, ignore_errors=True)
        raise
    except Exception:
        store.delete(job.id)
        shutil.rmtree(work, ignore_errors=True)
        raise


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, request: Request) -> dict:
    job = _job_for_user(request, job_id)
    return store.snapshot(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str, request: Request) -> dict:
    """Remove a session from history and delete its workspace folder."""
    job = _job_for_user(request, job_id)
    if job.busy:
        raise HTTPException(409, "Cannot delete a session while it is running")
    from .workspace_store import resolve_job_dir

    work = resolve_job_dir(job_id, create=False)
    store.delete(job_id)
    removed_local = False
    if work.is_dir():
        shutil.rmtree(work, ignore_errors=True)
        removed_local = not work.exists()
    # Legacy bare-id folder
    legacy = WORKSPACE_DIR / job_id
    if legacy.is_dir() and legacy.resolve() != work.resolve():
        shutil.rmtree(legacy, ignore_errors=True)
    return {"ok": True, "removed_local": removed_local}


@app.get("/api/sessions")
def list_sessions(request: Request) -> dict:
    """History of jobs (newest first) for the session/history tabs."""
    user = require_user(request)
    return {
        "sessions": store.list_jobs(
            user_id=user.id,
            admin=user.is_admin,
        )
    }


@app.get("/api/jobs/{job_id}/stream")
async def stream_job(job_id: str, request: Request):
    job = _job_for_user(request, job_id)

    q = store.subscribe(job_id)

    async def event_gen():
        # Send the current snapshot immediately so a late subscriber is in sync.
        yield f"data: {json.dumps(store.snapshot(job))}\n\n"
        try:
            while True:
                if await request.is_disconnected():
                    break
                try:
                    # Block in a worker thread so we don't tie up the event loop;
                    # short timeout doubles as a heartbeat + disconnect check.
                    snap = await asyncio.to_thread(q.get, True, 10)
                    yield f"data: {json.dumps(snap)}\n\n"
                except Exception:
                    yield ": ping\n\n"  # heartbeat keeps proxies/connections alive
        finally:
            store.unsubscribe(job_id, q)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


class ContentPatch(BaseModel):
    extracted_text: str | None = None
    narration: str | None = None
    extra_topics: str | None = None
    target_duration: int | None = None
    video_format: str | None = None
    video_theme: str | None = None
    video_style: str | None = None
    content_layout: str | None = None
    voice_preset: str | None = None
    pocket_voice: str | None = None
    voice_id: str | None = None
    youtube_video_url: str | None = None
    publish_title: str | None = None
    publish_description: str | None = None
    publish_tags: list[str] | None = None
    social_metadata: dict | None = None
    age_group: str | None = None
    knowledge_level: str | None = None
    custom_prompt: str | None = None
    review_notes: str | None = None


def _apply_job_voice_options(
    job,
    *,
    user,
    voice_preset: str | None = None,
    pocket_voice: str | None = None,
    voice_id: str | None = None,
) -> None:
    """Replace narration voice routing on a job (Pocket / Kokoro / clone).

    Empty strings are ignored. If every voice field is empty, this is a no-op
    so a style-only patch cannot wipe an existing ``voice_style_path``.
    """
    from . import user_data
    from .pipeline import tts as tts_mod
    from .workspace_store import resolve_job_dir

    vid = (voice_id or "").strip()
    pocket = (pocket_voice or "").strip()
    preset = (voice_preset or "").strip()
    if not vid and not pocket and not preset:
        return

    # Non-empty selection clears prior routing so engines don't conflict.
    for k in (
        "voice_preset",
        "pocket_voice",
        "voice_id",
        "voice_style_path",
        "cloud_voice_id",
    ):
        job.options.pop(k, None)

    if vid:
        work = resolve_job_dir(job.id, create=True)
        try:
            resolved = user_data.resolve_voice_for_job(user.id, vid, work)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        job.options.update(resolved)
        job.options["voice_id"] = vid
        return

    if pocket:
        if pocket not in tts_mod.pocket_preset_ids():
            raise HTTPException(400, f"Unknown Pocket voice: {pocket}")
        if not tts_mod.pocket_available():
            raise HTTPException(503, "Pocket TTS is not installed (pip install pocket-tts).")
        job.options["pocket_voice"] = pocket
        return

    if preset:
        if preset not in tts_mod.kokoro_preset_ids():
            raise HTTPException(400, f"Unknown Kokoro voice preset: {preset}")
        job.options["voice_preset"] = preset
        return


@app.patch("/api/jobs/{job_id}/content")
def patch_content(job_id: str, patch: ContentPatch, request: Request) -> dict:
    job = _job_for_user(request, job_id)
    if job.busy:
        raise HTTPException(409, "Cannot edit content while a run is in progress")
    user = require_user(request)
    if patch.extracted_text is not None:
        store.set_content(job, "extracted_text", patch.extracted_text)
    if patch.narration is not None:
        store.set_content(job, "narration", patch.narration)
    if patch.publish_title is not None:
        store.set_content(job, "publish_title", patch.publish_title.strip()[:100])
    if patch.publish_description is not None:
        store.set_content(job, "publish_description", patch.publish_description.strip())
    if patch.publish_tags is not None:
        tags = [str(t).strip().lower()[:30] for t in patch.publish_tags if str(t).strip()][:15]
        store.set_content(job, "publish_tags", tags)
    if patch.social_metadata is not None and isinstance(patch.social_metadata, dict):
        merged = dict(job.content.get("social_metadata") or {})
        merged.update(patch.social_metadata)
        store.set_content(job, "social_metadata", merged)
    if patch.extra_topics is not None:
        job.options["extra_topics"] = patch.extra_topics.strip()
        store.set_content(job, "extra_topics", patch.extra_topics.strip())
    if patch.content_layout is not None:
        layout = (patch.content_layout or "auto").strip().lower() or "auto"
        job.options["content_layout"] = layout
        store.set_content(job, "content_layout", layout)
    if (
        patch.age_group is not None
        or patch.knowledge_level is not None
        or patch.custom_prompt is not None
        or patch.review_notes is not None
    ):
        from .pipeline.audience import stamp_options

        stamped = stamp_options(
            job.options,
            age_group=patch.age_group if patch.age_group is not None else job.options.get("age_group"),
            knowledge_level=(
                patch.knowledge_level
                if patch.knowledge_level is not None
                else job.options.get("knowledge_level")
            ),
            custom_prompt=(
                patch.custom_prompt
                if patch.custom_prompt is not None
                else job.options.get("custom_prompt")
            ),
            review_notes=(
                patch.review_notes
                if patch.review_notes is not None
                else job.options.get("review_notes")
            ),
        )
        for key in (
            "age_group",
            "knowledge_level",
            "custom_prompt",
            "review_notes",
            "audience_prompt_source",
        ):
            if key in stamped:
                job.options[key] = stamped[key]
                store.set_content(job, key, stamped[key])
    voice_touched = bool(
        (patch.voice_preset or "").strip()
        or (patch.pocket_voice or "").strip()
        or (patch.voice_id or "").strip()
    )
    if voice_touched:
        _apply_job_voice_options(
            job,
            user=user,
            voice_preset=patch.voice_preset,
            pocket_voice=patch.pocket_voice,
            voice_id=patch.voice_id,
        )
        for key in (
            "voice_preset",
            "pocket_voice",
            "voice_id",
            "voice_style_path",
            "cloud_voice_id",
        ):
            if key in job.options:
                store.set_content(job, key, job.options[key])
            elif key in (job.content or {}):
                # Clear stale mirrors so SSE clients don't keep an old clone id.
                store.set_content(job, key, "")
    if patch.target_duration is not None or patch.video_format is not None or patch.youtube_video_url is not None or patch.video_theme is not None or patch.video_style is not None:
        video_opts = normalize_video_options(
            video_format=patch.video_format or job.options.get("video_format"),
            target_duration=(
                patch.target_duration
                if patch.target_duration is not None
                else job.options.get("target_duration", 0)
            ),
            youtube_video_url=(
                patch.youtube_video_url
                if patch.youtube_video_url is not None
                else job.options.get("youtube_video_url", "")
            ),
            video_theme=(
                patch.video_theme
                if patch.video_theme is not None
                else job.options.get("video_theme")
            ),
            video_style=(
                patch.video_style
                if patch.video_style is not None
                else job.options.get("video_style")
            ),
        )
        job.options.update(video_opts)
        # Lock when style is explicit; Auto style must still be resolvable.
        style_key = str(video_opts.get("video_style") or "").strip().lower()
        if patch.video_style is not None or patch.video_theme is not None:
            if style_key and style_key != "auto":
                job.options["lock_visual_preset"] = True
            else:
                job.options.pop("lock_visual_preset", None)
        # normalize_video_options does not emit Auto flags — clear leftovers so a
        # prior Auto run cannot keep the UI stuck on "Auto → …" after a manual lock.
        for stale in (
            "video_style_was_auto",
            "video_theme_was_auto",
            "video_style_reason",
            "video_theme_reason",
        ):
            if stale not in video_opts:
                job.options.pop(stale, None)
        for key, value in video_opts.items():
            store.set_content(job, key, value)
    return store.snapshot(job)


class RunRequest(BaseModel):
    stage: str
    mode: str = "single"  # "single" | "from"


@app.post("/api/jobs/{job_id}/run")
def run_stage(job_id: str, req: RunRequest, request: Request) -> dict:
    job = _job_for_user(request, job_id)
    if req.stage not in STAGE_FUNCS:
        raise HTTPException(400, f"Unknown stage: {req.stage}")
    if job.busy:
        raise HTTPException(409, "A run is already in progress for this job")
    if req.mode == "from":
        runner.submit(run_from_stage, job, req.stage)
    else:
        runner.submit(run_single_stage, job, req.stage)
    return {"ok": True}


@app.get("/api/jobs/{job_id}/script")
def get_script(job_id: str, request: Request) -> dict:
    """Per-slide narration scripts (for the in-UI voice recorder)."""
    job = _job_for_user(request, job_id)
    slides = job.content.get("slides") or []
    scripts = [
        ((s.get("narration") if isinstance(s, dict) else str(s)) or "").strip()
        for s in slides
    ]
    full = job.content.get("narration") or "\n\n".join(scripts).strip()
    return {"slides": scripts, "narration": full, "count": len(scripts)}


class ContentReviewRequest(BaseModel):
    notes: str | None = None
    narration: str | None = None


@app.post("/api/jobs/{job_id}/review-content")
def review_job_content(
    job_id: str,
    request: Request,
    body: ContentReviewRequest = ContentReviewRequest(),
) -> dict:
    """Re-check slides for duplicates and voice-sync issues (uses current edits)."""
    job = _job_for_user(request, job_id)
    from .pipeline.content_review import review_slides

    payload = body or ContentReviewRequest()
    notes = (payload.notes if payload.notes is not None else "") or str(
        job.options.get("review_notes") or ""
    )
    narr = payload.narration if payload.narration is not None else job.content.get("narration")
    review = review_slides(
        job.content.get("slides") or [],
        options=job.options,
        narration=narr or "",
        user_notes=notes,
    )
    store.set_content(job, "content_review", review)
    if payload.notes is not None:
        job.options["review_notes"] = notes.strip()[:1500]
        store.set_content(job, "review_notes", job.options["review_notes"])
    return {"ok": True, "review": review}


@app.post("/api/jobs/{job_id}/voice-recording")
async def upload_voice_recording(
    request: Request,
    job_id: str,
    slide_index: int = Form(-1),
    audio: UploadFile = File(...),
) -> dict:
    """Save a user voice recording as narration audio.

    ``slide_index >= 0`` saves the clip as that slide's narration; ``-1`` saves a
    whole-narration recording (split later is out of scope - it is used as slide 0
    when no per-slide clips exist). Files live under ``workspace/{id}/recorded/``.
    """
    job = _job_for_user(request, job_id)
    if job.busy:
        raise HTTPException(409, "Cannot upload recordings while a run is in progress")
    from .workspace_store import resolve_job_dir

    work = resolve_job_dir(job_id, create=True)
    rec_dir = work / "recorded"
    rec_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(audio.filename or "clip.webm").suffix.lower() or ".webm"
    name = f"slide_{slide_index:03d}{suffix}" if slide_index >= 0 else f"full{suffix}"
    dest = rec_dir / name
    data = await audio.read()
    await asyncio.to_thread(dest.write_bytes, data)

    recorded = dict(job.options.get("recorded_audio") or {})
    recorded[str(slide_index)] = dest.relative_to(work).as_posix()
    job.options["recorded_audio"] = recorded
    store.set_content(job, "recorded_audio", recorded)
    log.bind(task="voice").info(f"recorded clip saved for {job_id} slide={slide_index}")
    return {"ok": True, "path": dest.relative_to(work).as_posix()}


@app.post("/api/jobs/{job_id}/regenerate-metadata")
def regenerate_metadata(job_id: str, request: Request, scope: str = "all") -> dict:
    """Re-run publish_meta for title/description/tags (text only).

    Thumbnail generation is on-demand via ``/generate-thumbnail`` — never
    auto-run from this endpoint.
    """
    job = _job_for_user(request, job_id)
    if job.busy:
        raise HTTPException(409, "A run is already in progress for this job")
    if scope == "thumbnail":
        # Kept for older UI clients — route to the on-demand endpoint.
        return generate_thumbnail_api(job_id, request)
    for k in ("publish_title", "publish_description", "publish_tags"):
        store.set_content(job, k, None)
    runner.submit(run_single_stage, job, "publish_meta")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/generate-thumbnail")
def generate_thumbnail_api(job_id: str, request: Request) -> dict:
    """Generate a thumbnail on demand (Nano Banana Pro / local fallbacks)."""
    from .orchestrator import generate_job_thumbnail

    job = _job_for_user(request, job_id)
    if job.busy:
        raise HTTPException(409, "A run is already in progress for this job")
    # Clear previous so a fresh image is written.
    store.set_content(job, "thumbnail", None)
    if "thumbnail" in (job.artifacts or {}):
        arts = dict(job.artifacts)
        arts.pop("thumbnail", None)
        job.artifacts = arts
    ok, message = generate_job_thumbnail(job)
    if not ok:
        return {
            "ok": False,
            "message": message,
            "thumbnail": job.artifacts.get("thumbnail"),
        }
    return {
        "ok": True,
        "message": message,
        "thumbnail": job.artifacts.get("thumbnail"),
    }


class SocialMetaRequest(BaseModel):
    # Generate only the platforms the user selected (default: current tab).
    platforms: list[str] = ["youtube"]


@app.post("/api/jobs/{job_id}/social-metadata")
def social_metadata(job_id: str, req: SocialMetaRequest, request: Request) -> dict:
    """Generate per-platform title/description/hashtags for the selected socials.

    Merges into any existing ``social_metadata`` so regenerating one tab does
    not wipe the others. Reuses narration, slide outline, and already-generated
    platform titles as stored context.
    """
    job = _job_for_user(request, job_id)
    from . import costs
    from .pipeline import metadata as meta_gen

    title = job.content.get("publish_title") or job.content.get("title") or job.filename
    narration = job.content.get("narration") or ""
    slides = job.content.get("slides") or []
    outline_bits = []
    for s in slides[:24]:
        if not isinstance(s, dict):
            continue
        h = (s.get("heading") or "").strip()
        if h:
            outline_bits.append(f"- {h}")
    script_parts = []
    if outline_bits:
        script_parts.append("Slide outline:\n" + "\n".join(outline_bits))
    if narration:
        script_parts.append("Narration:\n" + narration)
    script = "\n\n".join(script_parts) or narration

    existing = dict(job.content.get("social_metadata") or {})
    other_bits = []
    yt_title = (job.content.get("publish_title") or "").strip()
    if yt_title and "youtube" not in (req.platforms or []):
        other_bits.append(f"youtube: {yt_title}")
    for k, v in existing.items():
        if not isinstance(v, dict):
            continue
        if k in (req.platforms or []):
            continue
        t = (v.get("title") or "").strip()
        if t:
            other_bits.append(f"{k}: {t}")
    extra = ""
    if other_bits:
        extra = (
            "Already generated for other tabs (keep tone/branding consistent; "
            "reuse facts, do not copy verbatim):\n" + "\n".join(other_bits[:12])
        )
    if job.content.get("doc_type"):
        extra = (extra + f"\nDoc type: {job.content.get('doc_type')}").strip()

    base_tags = job.content.get("publish_tags") or []
    platforms = req.platforms or []
    with costs.job_context(job.id):
        social, message = meta_gen.generate_social_metadata(
            title,
            script,
            platforms,
            base_tags,
            video_format=job.options.get("video_format"),
            extra_context=extra,
        )
    merged = dict(existing)
    merged.update(social or {})
    store.set_content(job, "social_metadata", merged)
    return {"social": merged, "message": message, "generated": list((social or {}).keys())}


@app.get("/files/{job_id}/{path:path}")
def get_file(job_id: str, path: str, request: Request):
    _job_for_user(request, job_id)
    base = _safe_job_dir(job_id)
    target = (base / path).resolve()
    if not base.is_relative_to(WORKSPACE_DIR.resolve()):
        raise HTTPException(403, "Forbidden")
    if base not in target.parents and target != base:
        raise HTTPException(403, "Forbidden")
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")

    import mimetypes

    media, _ = mimetypes.guess_type(str(target))
    if not media:
        media = "application/octet-stream"
    # HTML5 <video> needs a correct type + byte ranges to start without
    # buffering the whole file (long final.mp4 used to spin at 0:00).
    if target.suffix.lower() == ".mp4":
        media = "video/mp4"
    elif target.suffix.lower() in {".webm"}:
        media = "video/webm"
    elif target.suffix.lower() in {".mp3"}:
        media = "audio/mpeg"
    elif target.suffix.lower() in {".wav"}:
        media = "audio/wav"

    # Allow revalidation (ETag/mtime) instead of no-store so range requests can
    # resume; still bust via ?v= when the UI regenerates artifacts.
    headers = {
        "Cache-Control": "private, max-age=0, must-revalidate",
        "Accept-Ranges": "bytes",
    }
    return FileResponse(target, media_type=media, headers=headers)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    ico = STATIC_DIR / "favicon.ico"
    if ico.exists():
        return FileResponse(
            ico,
            media_type="image/x-icon",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    raise HTTPException(404, "favicon not found")


def _bust_static_html(html: str) -> str:
    """Append ASSET_VERSION to local /static asset URLs."""
    for name in (
        "styles.css", "app.js", "login.js", "slide_kit.js",
        "chitti.js", "chitti.css",
        "favicon.svg", "favicon-256.png", "favicon.ico",
    ):
        html = html.replace(f"/static/{name}", f"/static/{name}?v={ASSET_VERSION}")
    return html


@app.get("/login", response_class=HTMLResponse)
def login_page() -> HTMLResponse:
    html = _bust_static_html((STATIC_DIR / "login.html").read_text(encoding="utf-8"))
    return HTMLResponse(html, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})


@app.get("/", response_class=HTMLResponse)
def index() -> HTMLResponse:
    html = _bust_static_html((STATIC_DIR / "index.html").read_text(encoding="utf-8"))
    return HTMLResponse(
        html,
        headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
    )



@app.websocket("/ws/chitti/live")
async def chitti_live_ws(websocket: WebSocket):
    """C.H.I.T.T.I. voice — Gemini Live PCM proxy for Multimodal Studio.

    See https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
    """
    from google.genai import types

    from . import live_audio
    from .pipeline.llm_client import _gemini_client

    await websocket.accept()
    token = websocket.cookies.get(auth.COOKIE_NAME)
    user = auth.user_for_session(token)
    if not user:
        await websocket.send_json({"error": "Authentication required"})
        await websocket.close(code=1008)
        return

    product = "multimodal"
    session_id = (websocket.query_params.get("session_id") or "").strip()
    session_hint = ""

    if not live_audio.live_available():
        await websocket.send_json(
            {"error": "Gemini Live unavailable — set GEMINI_API_KEY and LLM_PROVIDER=gemini."}
        )
        await websocket.close()
        return

    system = live_audio.chitti_system_prompt(product=product, session_hint=session_hint)
    models = live_audio.live_model_candidates()
    used_model = ""
    in_bytes = 0
    out_bytes = 0
    meta_in = 0
    meta_out = 0
    user_bits: list[str] = []
    asst_bits: list[str] = []
    turn_user: list[str] = []
    turn_asst: list[str] = []
    try:
        client = _gemini_client()
        voice = live_audio.live_voice_name()
        configs = [
            live_audio.live_session_config(system, transcribe=True, affective=True),
            live_audio.live_session_config(system, transcribe=True, affective=False),
            live_audio.live_session_config(system, transcribe=False, affective=False),
        ]
        last_err: Exception | None = None
        for model in models:
            for cfg in configs:
                transcribe = "input_audio_transcription" in cfg
                try:
                    async with client.aio.live.connect(model=model, config=cfg) as session:
                        used_model = model
                        await websocket.send_json(
                            {
                                "ready": True,
                                "model": model,
                                "voice": voice,
                                "product": product,
                                "name": "C.H.I.T.T.I.",
                                "transcription": transcribe,
                            }
                        )
                        pending_tx = {"you": "", "chitti": ""}

                        async def _push_chitti(role: str, delta: str, *, finished: bool) -> None:
                            t = (delta or "").strip()
                            if not t and not finished:
                                return
                            if t:
                                pending_tx[role] = live_audio.merge_live_text(pending_tx[role], t)
                                if role == "you":
                                    user_bits.append(t)
                                    turn_user.append(t)
                                else:
                                    asst_bits.append(t)
                                    turn_asst.append(t)
                            full = pending_tx[role]
                            if not full:
                                return
                            await websocket.send_json(
                                {
                                    "type": "transcript",
                                    "role": role,
                                    "text": t,
                                    "full": full,
                                    "finished": finished,
                                }
                            )
                            if finished:
                                pending_tx[role] = ""

                        async def upstream():
                            nonlocal in_bytes
                            while True:
                                msg = await websocket.receive()
                                if msg.get("type") == "websocket.disconnect":
                                    break
                                if msg.get("bytes") is not None:
                                    chunk = msg["bytes"]
                                    in_bytes += len(chunk or b"")
                                    await session.send_realtime_input(
                                        audio=types.Blob(
                                            data=chunk,
                                            mime_type="audio/pcm;rate=16000",
                                        )
                                    )
                                elif msg.get("text"):
                                    try:
                                        payload = json.loads(msg["text"])
                                    except Exception:
                                        payload = {"text": msg["text"]}
                                    if payload.get("end"):
                                        break
                                    if payload.get("text"):
                                        await session.send_realtime_input(text=payload["text"])

                        async def downstream():
                            nonlocal out_bytes, meta_in, meta_out
                            async for response in session.receive():
                                pi, po = live_audio.pull_usage_tokens(response)
                                if pi:
                                    meta_in = max(meta_in, pi)
                                if po:
                                    meta_out = max(meta_out, po)
                                for ev in live_audio.iter_live_events(
                                    response, transcribe=transcribe, asst_role="chitti"
                                ):
                                    if ev["kind"] == "audio":
                                        data = ev["data"]
                                        out_bytes += len(data or b"")
                                        await websocket.send_bytes(data)
                                    elif ev["kind"] == "transcript":
                                        await _push_chitti(
                                            ev["role"], ev["text"], finished=bool(ev.get("finished"))
                                        )
                                    elif ev["kind"] == "turn_complete":
                                        for role in ("you", "chitti"):
                                            if pending_tx[role]:
                                                await _push_chitti(role, "", finished=True)
                                        heard = " ".join(turn_user).strip()
                                        reply = " ".join(turn_asst).strip()
                                        turn_user.clear()
                                        turn_asst.clear()
                                        await websocket.send_json(
                                            {
                                                "turn_complete": True,
                                                "ts": _time.time(),
                                                "heard": heard,
                                                "reply": reply,
                                            }
                                        )

                        up = asyncio.create_task(upstream())
                        down = asyncio.create_task(downstream())
                        _done, pending = await asyncio.wait(
                            {up, down}, return_when=asyncio.FIRST_COMPLETED
                        )
                        for t in pending:
                            t.cancel()
                    last_err = None
                    break
                except Exception as e:  # noqa: BLE001
                    last_err = e
                    log.bind(task="chitti").warning(
                        f"chitti live connect failed model={model}: {e}"
                    )
                    continue
            if last_err is None:
                break
        if last_err is not None:
            raise last_err
    except Exception as e:  # noqa: BLE001
        log.bind(task="chitti").error(f"chitti live ws failed: {e}")
        try:
            await websocket.send_json({"error": str(e)})
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        if used_model and (in_bytes or out_bytes or user_bits or asst_bits or meta_in or meta_out):
            try:
                live_audio.record_live_usage(
                    model=used_model,
                    in_bytes=in_bytes,
                    out_bytes=out_bytes,
                    in_tokens=meta_in or None,
                    out_tokens=meta_out or None,
                    user_text=" ".join(user_bits)[:4000],
                    assistant_text=" ".join(asst_bits)[:4000],
                    job_id=f"chitti:{product}:{session_id or user.id}",
                    kind="live_audio",
                )
                try:
                    await websocket.send_json(
                        {
                            "type": "usage",
                            "model": used_model,
                            "in_bytes": in_bytes,
                            "out_bytes": out_bytes,
                        }
                    )
                except Exception:
                    pass
            except Exception as e:  # noqa: BLE001
                log.bind(task="chitti").warning(f"chitti cost record soft-fail: {e}")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
