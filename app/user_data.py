"""Per-user data: the saved voice library.

Voice cloning is applied *once at the user level* — a signed-in user clones or
uploads a voice, saves it to their library, and then any job they create can use
it. Voices are stored per-account in the shared SQLite database (metadata) plus
the underlying style JSON on disk under ``workspace/voices/{user_id}/``.

Limits: regular users may save up to ``voice_limit_user`` voices; admins up to
``voice_limit_admin`` (both configurable via ``.env``).

The style payload itself is a Supertonic voice-style JSON (exported from Voice
Builder). We keep the file on disk and reference it from the DB so synthesis can
point Supertonic at the saved style path.
"""
from __future__ import annotations

import json
import secrets
import shutil
import time
from pathlib import Path
from typing import Optional

from .config import WORKSPACE_DIR, get_settings
from .db import _connect, _lock
from .logging_setup import log

VOICES_DIR = WORKSPACE_DIR / "voices"


def _ensure_schema() -> None:
    conn = _connect()
    with _lock:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS user_voices (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                name        TEXT NOT NULL,
                kind        TEXT NOT NULL DEFAULT 'clone',
                filepath    TEXT,
                recording_path TEXT,
                cloud_voice_id TEXT,
                style_source  TEXT,
                created_at  REAL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_uservoices_user ON user_voices(user_id)"
        )
        # Migrate older DBs that lack recording_path.
        cols = {row[1] for row in conn.execute("PRAGMA table_info(user_voices)")}
        if "recording_path" not in cols:
            conn.execute("ALTER TABLE user_voices ADD COLUMN recording_path TEXT")
        if "cloud_voice_id" not in cols:
            conn.execute("ALTER TABLE user_voices ADD COLUMN cloud_voice_id TEXT")
        if "style_source" not in cols:
            conn.execute("ALTER TABLE user_voices ADD COLUMN style_source TEXT")
        conn.commit()


def voice_limit(role: str) -> int:
    s = get_settings()
    return s.voice_limit_admin if role == "admin" else s.voice_limit_user


def list_voices(user_id: str) -> list[dict]:
    _ensure_schema()
    conn = _connect()
    with _lock:
        rows = conn.execute(
            "SELECT id, name, kind, filepath, recording_path, cloud_voice_id, style_source, created_at "
            "FROM user_voices WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()
    out: list[dict] = []
    for row in rows:
        rec = dict(row)
        rec["has_style"] = bool(rec.get("filepath"))
        rec["has_recording"] = bool(rec.get("recording_path"))
        rec["has_cloud_voice"] = bool(rec.get("cloud_voice_id"))
        # Ready only when a real clone exists — not merely "can auto-build later".
        rec["ready_for_narration"] = bool(rec["has_style"] or rec["has_cloud_voice"])
        rec["can_auto_clone"] = bool(
            rec["has_recording"]
            and not rec["ready_for_narration"]
            and _auto_clone_available()
        )
        out.append(rec)
    return out


def _auto_clone_available() -> bool:
    from .pipeline.voice_style_builder import auto_clone_available

    return auto_clone_available()


def count_voices(user_id: str) -> int:
    _ensure_schema()
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT COUNT(*) c FROM user_voices WHERE user_id = ?", (user_id,)
        ).fetchone()
    return int(row["c"] if row else 0)


def get_voice(user_id: str, voice_id: str) -> Optional[dict]:
    _ensure_schema()
    conn = _connect()
    with _lock:
        row = conn.execute(
            "SELECT * FROM user_voices WHERE id = ? AND user_id = ?",
            (voice_id, user_id),
        ).fetchone()
    return dict(row) if row else None


def voice_path(user_id: str, voice_id: str) -> Optional[Path]:
    """Absolute path to the saved Supertonic style JSON for ``voice_id`` (if any)."""
    rec = get_voice(user_id, voice_id)
    if not rec or not rec.get("filepath"):
        return None
    p = Path(rec["filepath"])
    if not p.is_absolute():
        p = WORKSPACE_DIR / p
    return p if p.exists() else None


def recording_path(user_id: str, voice_id: str) -> Optional[Path]:
    """Absolute path to the saved reference recording for ``voice_id`` (if any)."""
    rec = get_voice(user_id, voice_id)
    if not rec or not rec.get("recording_path"):
        return None
    p = Path(rec["recording_path"])
    if not p.is_absolute():
        p = WORKSPACE_DIR / p
    return p if p.exists() else None


def save_voice(
    *, user_id: str, role: str, name: str, style_bytes: bytes, kind: str = "clone"
) -> dict:
    """Persist a new voice for ``user_id``. Enforces the per-role limit.

    Raises ``ValueError`` if the limit is reached or the name is empty.
    """
    _ensure_schema()
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("A voice name is required.")
    limit = voice_limit(role)
    if count_voices(user_id) >= limit:
        raise ValueError(
            f"Voice library is full ({limit} max). Delete one before adding another."
        )
    from .pipeline import tts as tts_mod

    tts_mod.validate_voice_style_bytes(style_bytes)
    vid = secrets.token_hex(8)
    user_dir = VOICES_DIR / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    dest = user_dir / f"{vid}.json"
    dest.write_bytes(style_bytes)
    rel = dest.relative_to(WORKSPACE_DIR).as_posix()
    conn = _connect()
    with _lock:
        conn.execute(
            "INSERT INTO user_voices (id, user_id, name, kind, filepath, recording_path, style_source, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (vid, user_id, name, kind, rel, None, "upload", time.time()),
        )
        conn.commit()
    log.bind(task="voice").info(f"saved voice '{name}' ({vid}) for user {user_id}")
    return {"id": vid, "name": name, "kind": kind, "created_at": time.time(), "has_style": True}


def save_voice_recording(
    *, user_id: str, role: str, name: str, audio_bytes: bytes, ext: str = ".webm"
) -> dict:
    """Save a microphone recording as a reusable voice sample.

    The recording can be previewed immediately. Attach a Supertonic Voice Builder
    JSON later (``attach_voice_style``) to enable TTS cloning across videos.
    """
    _ensure_schema()
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("A voice name is required.")
    if not audio_bytes or len(audio_bytes) < 256:
        raise ValueError("Recording is empty or too short.")
    limit = voice_limit(role)
    if count_voices(user_id) >= limit:
        raise ValueError(
            f"Voice library is full ({limit} max). Delete one before adding another."
        )

    vid = secrets.token_hex(8)
    user_dir = VOICES_DIR / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    raw_ext = (ext or ".webm").lower()
    if raw_ext not in {".webm", ".wav", ".ogg", ".mp3", ".m4a"}:
        raw_ext = ".webm"
    raw_path = user_dir / f"{vid}{raw_ext}"
    raw_path.write_bytes(audio_bytes)

    wav_path = user_dir / f"{vid}.wav"
    _convert_recording_to_wav(raw_path, wav_path)
    try:
        from .pipeline.voice_style_optimizer import prepare_recording

        prepared = prepare_recording(wav_path)
        if prepared != wav_path:
            shutil.copyfile(prepared, wav_path)
            prepared.unlink(missing_ok=True)
    except Exception as e:  # noqa: BLE001
        log.bind(task="voice").warning(f"recording prep skipped: {e}")

    rel_rec = wav_path.relative_to(WORKSPACE_DIR).as_posix()
    conn = _connect()
    with _lock:
        conn.execute(
            "INSERT INTO user_voices (id, user_id, name, kind, filepath, recording_path, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (vid, user_id, name, "recording", None, rel_rec, time.time()),
        )
        conn.commit()
    try:
        if raw_path != wav_path and raw_path.exists():
            raw_path.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
    log.bind(task="voice").info(f"saved voice recording '{name}' ({vid}) for user {user_id}")
    out = {
        "id": vid,
        "name": name,
        "kind": "recording",
        "created_at": time.time(),
        "has_style": False,
        "has_recording": True,
        "has_cloud_voice": False,
    }
    try:
        built = ensure_voice_style(user_id, vid)
        out.update(built)
    except Exception as e:  # noqa: BLE001
        log.bind(task="voice").warning(f"auto voice style build skipped: {e}")
    out["ready_for_narration"] = bool(out.get("has_style") or out.get("has_cloud_voice"))
    out["can_auto_clone"] = bool(
        out.get("has_recording")
        and not out["ready_for_narration"]
        and _auto_clone_available()
    )
    return out


def attach_voice_style(
    user_id: str,
    voice_id: str,
    style_bytes: bytes,
    *,
    style_source: str = "upload",
) -> dict:
    """Attach a Supertonic style JSON to an existing voice (e.g. after recording)."""
    _ensure_schema()
    rec = get_voice(user_id, voice_id)
    if not rec:
        raise ValueError("Voice not found.")
    from .pipeline import tts as tts_mod
    from .pipeline.voice_style_builder import style_source_from_file

    tts_mod.validate_voice_style_bytes(style_bytes)
    user_dir = VOICES_DIR / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    dest = user_dir / f"{voice_id}.json"
    dest.write_bytes(style_bytes)
    rel = dest.relative_to(WORKSPACE_DIR).as_posix()
    src = style_source or style_source_from_file(dest) or "upload"
    kind = "clone"
    conn = _connect()
    with _lock:
        # Clear cloud_voice_id so local JSON wins over a previous cloud clone.
        conn.execute(
            "UPDATE user_voices SET filepath = ?, kind = ?, style_source = ?, "
            "cloud_voice_id = NULL WHERE id = ? AND user_id = ?",
            (rel, kind, src, voice_id, user_id),
        )
        conn.commit()
    log.bind(task="voice").info(f"attached style JSON to voice {voice_id} ({src})")
    return {
        "id": voice_id,
        "name": rec["name"],
        "kind": kind,
        "has_style": True,
        "has_recording": bool(rec.get("recording_path")),
        "has_cloud_voice": False,
        "style_source": src,
        "ready_for_narration": True,
        "can_auto_clone": False,
    }


def _style_needs_rebuild(user_id: str, voice_id: str, rec: dict) -> bool:
    from .pipeline.voice_style_builder import needs_rebuild

    style_path = voice_path(user_id, voice_id)
    return needs_rebuild(style_path, rec.get("style_source"))


def ensure_voice_style(user_id: str, voice_id: str, *, force: bool = False) -> dict:
    """Build and attach a Supertonic style from the saved recording when missing."""
    _ensure_schema()
    rec = get_voice(user_id, voice_id)
    if not rec:
        raise ValueError("Voice not found.")
    # Cloud clone is ready unless Rebuild (force) asks to regenerate.
    if rec.get("cloud_voice_id") and not force:
        return {
            "id": voice_id,
            "name": rec["name"],
            "kind": "clone",
            "has_style": False,
            "has_recording": bool(rec.get("recording_path")),
            "has_cloud_voice": True,
            "style_source": rec.get("style_source") or "supertone_cloud",
            "ready_for_narration": True,
            "can_auto_clone": False,
        }
    if rec.get("filepath") and not force and not _style_needs_rebuild(user_id, voice_id, rec):
        return {
            "id": voice_id,
            "name": rec["name"],
            "kind": rec.get("kind") or "clone",
            "has_style": True,
            "has_recording": bool(rec.get("recording_path")),
            "has_cloud_voice": bool(rec.get("cloud_voice_id")),
            "style_source": rec.get("style_source") or "upload",
            "ready_for_narration": True,
            "can_auto_clone": False,
        }
    rec_path = recording_path(user_id, voice_id)
    if not rec_path:
        raise ValueError("No recording available to build a voice style from.")

    from .pipeline.voice_style_builder import build_from_recording

    built = build_from_recording(rec_path, rec.get("name") or voice_id, force=force)
    if not built:
        raise ValueError(
            "Could not build a voice style from the recording. "
            "Install Supertonic (pip install supertonic), enable "
            "VOICE_CLONE_OPTIMIZE_ENABLED, or set SUPERTONE_API_KEY."
        )

    kind, payload, style_source = built
    if kind == "json":
        attached = attach_voice_style(
            user_id,
            voice_id,
            payload,  # type: ignore[arg-type]
            style_source=style_source,
        )
        attached["ready_for_narration"] = True
        return attached

    cloud_id = str(payload)
    conn = _connect()
    with _lock:
        conn.execute(
            "UPDATE user_voices SET cloud_voice_id = ?, kind = ?, style_source = ?, filepath = NULL "
            "WHERE id = ? AND user_id = ?",
            (cloud_id, "clone", style_source, voice_id, user_id),
        )
        conn.commit()
    log.bind(task="voice").info(f"linked Supertone cloud voice {cloud_id} to {voice_id}")
    return {
        "id": voice_id,
        "name": rec["name"],
        "kind": "clone",
        "has_style": False,
        "has_recording": True,
        "has_cloud_voice": True,
        "style_source": style_source,
        "ready_for_narration": True,
        "can_auto_clone": False,
    }


def resolve_voice_for_job(user_id: str, voice_id: str, work: Path) -> dict:
    """Ensure the library voice is clone-ready and copy style refs into ``work``."""
    rec = get_voice(user_id, voice_id)
    if not rec:
        raise ValueError("Voice not found.")
    style_path = voice_path(user_id, voice_id)
    # Pocket clones already have a .safetensors style — skip Supertonic rebuild.
    if not (style_path and style_path.suffix.lower() == ".safetensors"):
        ensure_voice_style(user_id, voice_id)
        rec = get_voice(user_id, voice_id) or rec
        style_path = voice_path(user_id, voice_id)
    opts: dict = {"voice_id": voice_id}
    if style_path:
        suffix = style_path.suffix.lower() or ".json"
        dest = work / f"voice_style{suffix}"
        shutil.copyfile(style_path, dest)
        opts["voice_style_path"] = dest.name
        return opts
    if rec.get("cloud_voice_id"):
        opts["cloud_voice_id"] = rec["cloud_voice_id"]
        return opts
    raise ValueError("Voice is not ready for narration.")


def save_pocket_voice(
    *,
    user_id: str,
    role: str,
    name: str,
    style_bytes: bytes | None = None,
    audio_path: Path | None = None,
) -> dict:
    """Persist a Pocket TTS voice (``.safetensors``) for ``user_id``.

    Pass either exported ``style_bytes`` or a local ``audio_path`` to clone from.
    """
    _ensure_schema()
    name = (name or "").strip()[:60]
    if not name:
        raise ValueError("A voice name is required.")
    limit = voice_limit(role)
    if count_voices(user_id) >= limit:
        raise ValueError(
            f"Voice library is full ({limit} max). Delete one before adding another."
        )
    from .pipeline import tts as tts_mod

    if not tts_mod.pocket_available():
        raise RuntimeError("Pocket TTS is not installed (pip install pocket-tts).")

    vid = secrets.token_hex(8)
    user_dir = VOICES_DIR / user_id
    user_dir.mkdir(parents=True, exist_ok=True)
    dest = user_dir / f"{vid}.safetensors"
    rec_rel = None

    if style_bytes:
        if len(style_bytes) < 64:
            raise ValueError("Pocket voice file is empty or too short.")
        dest.write_bytes(style_bytes)
        style_source = "pocket_upload"
    elif audio_path is not None:
        audio_path = Path(audio_path)
        if not audio_path.is_file():
            raise FileNotFoundError(f"Audio not found: {audio_path}")
        # Keep a wav copy for preview / rebuild.
        wav_keep = user_dir / f"{vid}.wav"
        if audio_path.suffix.lower() == ".wav":
            if audio_path.resolve() != wav_keep.resolve():
                shutil.copyfile(audio_path, wav_keep)
        else:
            _convert_recording_to_wav(audio_path, wav_keep)
        tts_mod.export_pocket_voice(wav_keep, dest)
        rec_rel = wav_keep.relative_to(WORKSPACE_DIR).as_posix()
        style_source = "pocket_clone"
    else:
        raise ValueError("Provide a .safetensors upload or an audio file to clone.")

    rel = dest.relative_to(WORKSPACE_DIR).as_posix()
    conn = _connect()
    with _lock:
        conn.execute(
            "INSERT INTO user_voices "
            "(id, user_id, name, kind, filepath, recording_path, style_source, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (vid, user_id, name, "pocket", rel, rec_rel, style_source, time.time()),
        )
        conn.commit()
    log.bind(task="voice").info(f"saved Pocket voice '{name}' ({vid}) for user {user_id}")
    return {
        "id": vid,
        "name": name,
        "kind": "pocket",
        "created_at": time.time(),
        "has_style": True,
        "has_recording": bool(rec_rel),
        "has_cloud_voice": False,
        "style_source": style_source,
        "ready_for_narration": True,
        "can_auto_clone": False,
    }


def _convert_recording_to_wav(src: Path, dest: Path) -> None:
    """Convert browser recording to 44.1 kHz mono WAV.

    Never rename webm/ogg bytes to ``.wav`` — that breaks Supertonic cloning
    (soundfile can't decode a fake WAV).
    """
    if src.suffix.lower() == ".wav":
        if src != dest:
            dest.write_bytes(src.read_bytes())
        return
    from .capabilities import ffmpeg_path

    exe = ffmpeg_path() or "ffmpeg"
    import subprocess

    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        exe,
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "44100",
        str(dest),
    ]
    try:
        proc = subprocess.run(cmd, check=False, capture_output=True, timeout=120)
    except Exception as e:
        raise RuntimeError(
            f"Could not convert recording to WAV (ffmpeg required): {e}"
        ) from e
    if proc.returncode != 0 or not dest.exists() or dest.stat().st_size < 64:
        err = (proc.stderr or b"").decode("utf-8", errors="ignore")[-300:]
        raise RuntimeError(
            "Could not convert recording to WAV. Install ffmpeg and try again."
            + (f" ({err})" if err else "")
        )


def delete_voice(user_id: str, voice_id: str) -> bool:
    _ensure_schema()
    rec = get_voice(user_id, voice_id)
    if not rec:
        return False
    fp = rec.get("filepath")
    rp = rec.get("recording_path")
    conn = _connect()
    with _lock:
        conn.execute(
            "DELETE FROM user_voices WHERE id = ? AND user_id = ?",
            (voice_id, user_id),
        )
        conn.commit()
    for rel in (fp, rp):
        if not rel:
            continue
        try:
            p = Path(rel)
            if not p.is_absolute():
                p = WORKSPACE_DIR / p
            if p.exists():
                p.unlink()
        except Exception:  # noqa: BLE001
            pass
    # Remove any sibling artifacts (raw webm, json).
    try:
        user_dir = VOICES_DIR / user_id
        for p in user_dir.glob(f"{voice_id}.*"):
            p.unlink(missing_ok=True)
    except Exception:  # noqa: BLE001
        pass
    log.bind(task="voice").info(f"deleted voice {voice_id} for user {user_id}")
    return True
