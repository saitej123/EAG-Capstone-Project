"""Runtime capability detection.

The pipeline relies on several optional system tools and Python packages
(FFmpeg, Playwright, Gemini, gTTS, YouTube API). Rather than crash when one
is missing, we detect what is available and let the orchestrator skip or
degrade individual stages. The frontend surfaces this to the user.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
from dataclasses import dataclass, asdict

from .config import get_settings


def _has_module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def ffmpeg_path() -> str | None:
    """Return an FFmpeg executable path: PATH first, then imageio-ffmpeg bundle."""
    p = shutil.which("ffmpeg")
    if p:
        return p
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    return None


def _has_ffmpeg() -> bool:
    return ffmpeg_path() is not None


def _playwright_browser_ready() -> bool:
    """Playwright installed AND a Chromium browser binary is on disk.

    We deliberately avoid launching the Playwright driver here: doing so spawns
    a subprocess, which raises NotImplementedError on Windows when invoked from
    an asyncio loop that lacks subprocess support (e.g. inside the server). We
    only inspect the filesystem instead.
    """
    if not _has_module("playwright"):
        return False
    try:
        from pathlib import Path

        candidates = []
        # Default Playwright browsers cache locations per OS.
        env_path = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
        if env_path:
            candidates.append(Path(env_path))
        if os.name == "nt":
            local = os.environ.get("LOCALAPPDATA")
            if local:
                candidates.append(Path(local) / "ms-playwright")
        else:
            home = Path.home()
            candidates.append(home / ".cache" / "ms-playwright")
            candidates.append(home / "Library" / "Caches" / "ms-playwright")

        for base in candidates:
            if base.exists():
                for d in base.glob("chromium-*"):
                    # chrome.exe (win) or chrome (linux) or Chromium (mac)
                    exes = list(d.rglob("chrome.exe")) + list(d.rglob("chrome")) + \
                        list(d.rglob("Chromium"))
                    if exes:
                        return True
        return False
    except Exception:
        return False


def _ollama_reachable(base_url: str) -> bool:
    """Best-effort check that an Ollama/OpenAI-compatible server is up.

    We hit the lightweight ``/models`` endpoint with a short timeout so a down
    server degrades gracefully (the pipeline falls back to its template engine)
    instead of hanging.
    """
    import json
    import urllib.request

    url = base_url.rstrip("/") + "/models"
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            if resp.status != 200:
                return False
            json.loads(resp.read() or b"{}")
            return True
    except Exception:
        return False


def llm_available() -> bool:
    """True when the configured LLM provider is usable right now."""
    settings = get_settings()
    provider = settings.active_provider
    if provider == "gemini":
        return bool(settings.gemini_api_key) and _has_module("google.genai")
    if provider == "openai":
        return bool(settings.openai_api_key) and _has_module("openai")
    if provider == "ollama":
        return _has_module("openai") and _ollama_reachable(settings.ollama_base_url)
    return False


@dataclass
class Capabilities:
    provider: str
    llm: bool
    gemini: bool
    vlm: bool
    tts: bool
    tts_engine: str
    supertonic: bool
    ffmpeg: bool
    playwright: bool
    youtube: bool

    def dict(self) -> dict:
        return asdict(self)


# Capability detection touches the filesystem and (for Ollama) the network.
# Doing that on every pipeline stage is wasteful and adds latency under load,
# so we memoize the result for a short TTL. ``refresh=True`` forces a re-probe
# (e.g. after the user installs a missing tool).
import threading
import time as _time

_CAPS_TTL = 10.0  # seconds
_caps_cache: tuple[float, "Capabilities"] | None = None
_caps_lock = threading.Lock()


def _probe_capabilities() -> Capabilities:
    settings = get_settings()
    provider = settings.active_provider
    has_llm = llm_available()
    from .pipeline import tts

    engine = tts.selected_engine()
    return Capabilities(
        provider=provider,
        llm=has_llm,
        gemini=has_llm and provider == "gemini",
        vlm=has_llm and _has_module("fitz"),
        tts=engine != "none",
        tts_engine=engine,
        supertonic=tts.supertonic_available(),
        ffmpeg=_has_ffmpeg(),
        playwright=_playwright_browser_ready(),
        youtube=(
            _has_module("googleapiclient")
            and settings.youtube_secrets_path.exists()
        ),
    )


def detect_capabilities(refresh: bool = False) -> Capabilities:
    """Return runtime capabilities, memoized for a short TTL.

    The probe inspects the filesystem and may ping a local LLM server; caching
    keeps the per-stage cost negligible and the app responsive under load.
    """
    global _caps_cache
    now = _time.monotonic()
    with _caps_lock:
        if not refresh and _caps_cache and (now - _caps_cache[0]) < _CAPS_TTL:
            return _caps_cache[1]
    caps = _probe_capabilities()
    with _caps_lock:
        _caps_cache = (now, caps)
    return caps


def clear_capabilities_cache() -> None:
    global _caps_cache
    with _caps_lock:
        _caps_cache = None
