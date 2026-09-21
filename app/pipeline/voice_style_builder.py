"""Build Supertonic voice-style JSON from a reference recording.

Voice Builder exports cannot be invented by an LLM — they are embedding
tensors (``style_ttl`` + ``style_dp``). This module tries, in order:

1. ``VOICE_STYLE_BUILDER_URL`` — POST the WAV, expect JSON back.
2. ``VOICE_STYLE_BUILDER_CMD`` — shell template with ``{input}`` / ``{output}``.
3. ``SUPERTONE_API_KEY`` — cloud voice clone (returns a cloud voice id, not JSON).
4. Local optimizer — WavLM-free spectral matching + ``style_ttl`` search.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Literal

from ..config import get_settings
from ..logging_setup import log
from . import tts as tts_mod
from .voice_style_optimizer import optimize_from_recording, prepare_recording

BuildResult = tuple[Literal["json", "cloud"], bytes | str, str]


def _validate_style_bytes(raw: bytes) -> bytes:
    tts_mod.validate_voice_style_bytes(raw)
    return raw


def _try_builder_url(recording: Path, voice_name: str) -> bytes | None:
    url = (get_settings().voice_style_builder_url or "").strip()
    if not url:
        return None
    try:
        import httpx
    except ImportError:
        log.bind(task="voice").warning("httpx missing; cannot call voice style builder URL")
        return None
    try:
        with recording.open("rb") as fh:
            resp = httpx.post(
                url,
                files={"file": (recording.name, fh, "audio/wav")},
                data={"name": voice_name},
                timeout=httpx.Timeout(300.0, connect=30.0),
            )
        resp.raise_for_status()
        raw = resp.content
        if resp.headers.get("content-type", "").startswith("application/json"):
            data = resp.json()
            if isinstance(data, dict) and "style_ttl" in data and "style_dp" in data:
                return _validate_style_bytes(json.dumps(data).encode("utf-8"))
            if isinstance(data, dict) and "style" in data:
                inner = data["style"]
                if isinstance(inner, dict):
                    return _validate_style_bytes(json.dumps(inner).encode("utf-8"))
        if raw:
            return _validate_style_bytes(raw)
    except Exception as e:
        log.bind(task="voice").warning(f"voice style builder URL failed: {e}")
    return None


def _try_builder_cmd(recording: Path, out_json: Path) -> bytes | None:
    cmd_tpl = (get_settings().voice_style_builder_cmd or "").strip()
    if not cmd_tpl:
        return None
    out_json.parent.mkdir(parents=True, exist_ok=True)
    cmd = cmd_tpl.format(input=str(recording), output=str(out_json))
    try:
        subprocess.run(
            cmd,
            shell=True,
            check=True,
            capture_output=True,
            timeout=600,
        )
        if out_json.exists() and out_json.stat().st_size > 256:
            return _validate_style_bytes(out_json.read_bytes())
    except Exception as e:
        log.bind(task="voice").warning(f"voice style builder command failed: {e}")
    return None


def _try_supertone_cloud(recording: Path, voice_name: str) -> str | None:
    key = (get_settings().supertone_api_key or "").strip()
    if not key:
        return None
    if recording.stat().st_size > 3 * 1024 * 1024:
        log.bind(task="voice").warning("recording exceeds 3 MB Supertone clone limit")
        return None
    try:
        import httpx
    except ImportError:
        return None
    try:
        with recording.open("rb") as fh:
            resp = httpx.post(
                "https://supertoneapi.com/v1/custom-voices/cloned-voice",
                headers={"x-sup-api-key": key},
                files={"files": (recording.name, fh, "audio/wav")},
                data={"name": voice_name[:100]},
                timeout=httpx.Timeout(120.0, connect=30.0),
            )
        resp.raise_for_status()
        data = resp.json()
        vid = data.get("voice_id") if isinstance(data, dict) else None
        if vid:
            log.bind(task="voice").info(f"Supertone cloud clone ready: {vid}")
            return str(vid)
    except Exception as e:
        log.bind(task="voice").warning(f"Supertone cloud clone failed: {e}")
    return None


def _read_style_source(style_bytes: bytes) -> str:
    try:
        data = json.loads(style_bytes)
        meta = data.get("metadata") if isinstance(data, dict) else None
        if isinstance(meta, dict) and meta.get("clone_source"):
            return str(meta["clone_source"])
    except Exception:
        pass
    return "unknown"


def build_from_recording(
    recording: Path,
    voice_name: str,
    *,
    scratch: Path | None = None,
    force: bool = False,
) -> BuildResult | None:
    """Return ``(kind, payload, style_source)`` when a clone is ready.

    ``force=True`` (Rebuild) prefers the local style optimizer over creating a
    new Supertone cloud voice, so Rebuild actually improves the on-device clone.
    """
    if not recording.exists():
        return None

    prepared = prepare_recording(recording)
    try:
        raw = _try_builder_url(prepared, voice_name)
        if raw:
            return ("json", raw, "voice_builder")

        tmp_out = (scratch or prepared.parent) / f".{prepared.stem}_style.json"
        raw = _try_builder_cmd(prepared, tmp_out)
        if raw:
            try:
                tmp_out.unlink(missing_ok=True)
            except OSError:
                pass
            return ("json", raw, "voice_builder_cmd")

        # On Rebuild, try local optimize first so we don't mint a new cloud id.
        if force:
            optimized = optimize_from_recording(prepared)
            if optimized:
                raw, source = optimized
                return ("json", raw, source)
            cloud_id = _try_supertone_cloud(prepared, voice_name)
            if cloud_id:
                return ("cloud", cloud_id, "supertone_cloud")
            return None

        cloud_id = _try_supertone_cloud(prepared, voice_name)
        if cloud_id:
            return ("cloud", cloud_id, "supertone_cloud")

        optimized = optimize_from_recording(prepared)
        if optimized:
            raw, source = optimized
            return ("json", raw, source)

        return None
    finally:
        if prepared != recording:
            try:
                prepared.unlink(missing_ok=True)
            except OSError:
                pass


def style_source_from_file(path: Path) -> str:
    if not path.exists():
        return ""
    try:
        return _read_style_source(path.read_bytes())
    except Exception:
        return ""


_TRUSTED_STYLE_SOURCES = {
    "upload",
    "voice_builder",
    "voice_builder_cmd",
    "optimized",
    "supertone_cloud",
}


def needs_rebuild(style_path: Path | None, db_source: str | None = None) -> bool:
    """True when an existing clone should be regenerated from the recording.

    Voice Builder uploads often lack ``metadata.clone_source`` — treat those as
    trusted so we never overwrite a hand-exported style with a weak preset match.
    """
    if db_source in _TRUSTED_STYLE_SOURCES:
        return False
    if db_source == "preset_match":
        return True
    if style_path and style_path.exists():
        src = style_source_from_file(style_path)
        if src in _TRUSTED_STYLE_SOURCES:
            return False
        if src == "preset_match":
            return True
        # Unknown metadata on a real JSON file → leave it alone.
        return False
    # No style file and no trusted source → needs a build.
    return True


def auto_clone_available() -> bool:
    """True only when at least one clone builder path can actually succeed."""
    s = get_settings()
    if (s.voice_style_builder_url or "").strip():
        return True
    if (s.voice_style_builder_cmd or "").strip():
        return True
    if (s.supertone_api_key or "").strip():
        return True
    return bool(
        tts_mod.supertonic_available() and s.voice_clone_optimize_enabled
    )
