"""Text-to-speech engines.

Engines supported:

* ``kokoro``     - offline neural TTS via the ``kokoro-onnx`` library (the same
  model behind https://github.com/nazdridoy/kokoro-tts). High quality, no
  network at synthesis time, but needs two model files (~350MB) which we
  download on first use into ``models/``. This is the default.
* ``pocket``     - Kyutai Pocket TTS (https://github.com/kyutai-labs/pocket-tts).
  CPU-friendly ~100M model with catalog voices + wav cloning (.safetensors).
* ``supertonic`` - on-device ONNX TTS (https://huggingface.co/Supertone/supertonic-3).
  Opt-in: used only when a job supplies a voice style (a Voice Builder style
  JSON or a preset name). Lets users narrate in a custom/cloned voice.
* ``gtts``       - Google Translate TTS. Tiny, online, lower quality. Fallback.

The public entry point is :func:`synthesize`, which writes an audio file to
``out_path`` and returns the engine actually used. Passing ``voice_style``
(or ``cloud_voice_id``) routes synthesis to Supertonic / Supertone cloud;
``.safetensors`` style paths or ``pocket_voice`` route to Pocket TTS;
``kokoro_voice`` selects a built-in Kokoro preset; otherwise the default
Kokoro voice from settings is used (then gTTS).
"""
from __future__ import annotations

import json
import ssl
import threading
import time
import urllib.request
from functools import lru_cache
from pathlib import Path

from ..config import get_settings
from ..logging_setup import log

# Canonical Kokoro v1.0 ONNX assets (thewh1teagle/kokoro-onnx).
_KOKORO_MODEL_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
    "model-files-v1.0/kokoro-v1.0.onnx"
)
_KOKORO_VOICES_URL = (
    "https://github.com/thewh1teagle/kokoro-onnx/releases/download/"
    "model-files-v1.0/voices-v1.0.bin"
)

# Curated Kokoro presets exposed in the UI (id must match voices-v1.0.bin keys).
KOKORO_PRESETS: list[dict] = [
    {"id": "af_heart", "label": "Heart", "gender": "female", "accent": "American",
     "vibe": "Warm · clear default", "tag": "Recommended", "hue": 262},
    {"id": "af_bella", "label": "Bella", "gender": "female", "accent": "American",
     "vibe": "Bright · expressive", "tag": "", "hue": 330},
    {"id": "af_nicole", "label": "Nicole", "gender": "female", "accent": "American",
     "vibe": "Smooth · podcast", "tag": "", "hue": 200},
    {"id": "af_sarah", "label": "Sarah", "gender": "female", "accent": "American",
     "vibe": "Soft · friendly", "tag": "", "hue": 160},
    {"id": "af_sky", "label": "Sky", "gender": "female", "accent": "American",
     "vibe": "Light · upbeat", "tag": "", "hue": 190},
    {"id": "af_jessica", "label": "Jessica", "gender": "female", "accent": "American",
     "vibe": "Crisp · present", "tag": "", "hue": 280},
    {"id": "af_nova", "label": "Nova", "gender": "female", "accent": "American",
     "vibe": "Modern · energetic", "tag": "", "hue": 45},
    {"id": "af_alloy", "label": "Alloy", "gender": "female", "accent": "American",
     "vibe": "Neutral · steady", "tag": "", "hue": 220},
    {"id": "am_michael", "label": "Michael", "gender": "male", "accent": "American",
     "vibe": "Deep · confident", "tag": "", "hue": 215},
    {"id": "am_adam", "label": "Adam", "gender": "male", "accent": "American",
     "vibe": "Clear · narration", "tag": "", "hue": 25},
    {"id": "am_fenrir", "label": "Fenrir", "gender": "male", "accent": "American",
     "vibe": "Bold · dramatic", "tag": "", "hue": 0},
    {"id": "am_liam", "label": "Liam", "gender": "male", "accent": "American",
     "vibe": "Calm · instructional", "tag": "", "hue": 140},
    {"id": "am_onyx", "label": "Onyx", "gender": "male", "accent": "American",
     "vibe": "Rich · documentary", "tag": "", "hue": 250},
    {"id": "am_echo", "label": "Echo", "gender": "male", "accent": "American",
     "vibe": "Even · explainer", "tag": "", "hue": 175},
    {"id": "bf_emma", "label": "Emma", "gender": "female", "accent": "British",
     "vibe": "Polished · BBC", "tag": "", "hue": 310},
    {"id": "bf_isabella", "label": "Isabella", "gender": "female", "accent": "British",
     "vibe": "Elegant · calm", "tag": "", "hue": 300},
    {"id": "bm_george", "label": "George", "gender": "male", "accent": "British",
     "vibe": "Authoritative", "tag": "", "hue": 30},
    {"id": "bm_lewis", "label": "Lewis", "gender": "male", "accent": "British",
     "vibe": "Measured · lecture", "tag": "", "hue": 210},
]


def _has_module(name: str) -> bool:
    import importlib.util

    return importlib.util.find_spec(name) is not None


def kokoro_models_present() -> bool:
    s = get_settings()
    return (
        s.kokoro_model_file.exists()
        and s.kokoro_model_file.stat().st_size > 1_000_000
        and s.kokoro_voices_file.exists()
        and s.kokoro_voices_file.stat().st_size > 1_000_000
    )


def kokoro_available() -> bool:
    """Kokoro can synthesize: library + onnxruntime + soundfile present.

    Model files may still need to be downloaded; that happens lazily.
    """
    return (
        _has_module("kokoro_onnx")
        and _has_module("onnxruntime")
        and _has_module("soundfile")
    )


def gtts_available() -> bool:
    return _has_module("gtts")


def supertonic_available() -> bool:
    """Supertonic 3 can synthesize: the ``supertonic`` package is installed.

    Model assets are downloaded lazily by the library on first use.
    """
    return _has_module("supertonic")


def validate_voice_style_json(data: dict) -> None:
    """Raise ``ValueError`` when ``data`` is not a Supertonic Voice Builder export."""
    if not isinstance(data, dict):
        raise ValueError("Voice style must be a JSON object.")
    try:
        from supertonic.utils import validate_voice_style_format
    except ImportError:
        required = ("style_ttl", "style_dp")
        if not all(k in data for k in required):
            raise ValueError(
                "Not a Supertonic voice-style file. Export from Voice Builder "
                f"(expected keys: {', '.join(required)})."
            )
        for key in required:
            block = data.get(key)
            if not isinstance(block, dict) or "dims" not in block or "data" not in block:
                raise ValueError(
                    f"Invalid Supertonic voice style: '{key}' must include dims and data."
                )
        return
    if not validate_voice_style_format(data):
        raise ValueError(
            "Not a Supertonic voice-style file. Export from Voice Builder "
            "(must contain style_ttl and style_dp with dims and data)."
        )


def validate_voice_style_bytes(raw: bytes) -> dict:
    """Parse and validate Supertonic voice-style JSON bytes."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"Invalid voice-style JSON: {e}") from e
    validate_voice_style_json(data)
    return data


def selected_engine(
    voice_style: str | None = None,
    cloud_voice_id: str | None = None,
    pocket_voice: str | None = None,
) -> str:
    """Resolve the effective engine name based on settings + availability.

    Local Voice Builder / optimized style JSON wins over a cloud voice id when
    both are present (attaching a JSON after a cloud clone must take effect).
    Pocket catalog ids / ``.safetensors`` (or clone wav) route to Pocket TTS.
    """
    style = (voice_style or "").strip()
    style_path = Path(style) if style else None
    has_local_json = bool(
        style_path and style_path.exists() and style_path.suffix.lower() == ".json"
    )
    if has_local_json and supertonic_available():
        return "supertonic"
    if cloud_voice_id and (get_settings().supertone_api_key or "").strip():
        return "supertone-cloud"
    pocket_hint = (pocket_voice or "").strip()
    pocket_file = bool(
        style_path
        and style_path.exists()
        and style_path.suffix.lower() in {".safetensors", ".wav", ".mp3", ".flac", ".ogg"}
    )
    if (pocket_hint or pocket_file) and pocket_available():
        return "pocket"
    if style and style_path and style_path.suffix.lower() == ".json" and supertonic_available():
        return "supertonic"
    if style and supertonic_available() and not pocket_file:
        return "supertonic"
    pref = (get_settings().tts_engine or "auto").lower()
    if pref == "pocket":
        return "pocket" if pocket_available() else (
            "kokoro" if kokoro_available() else ("gtts" if gtts_available() else "none")
        )
    if pref == "kokoro":
        return "kokoro" if kokoro_available() else ("gtts" if gtts_available() else "none")
    if pref == "gtts":
        return "gtts" if gtts_available() else ("kokoro" if kokoro_available() else "none")
    # auto
    if kokoro_available():
        return "kokoro"
    if pocket_available():
        return "pocket"
    if gtts_available():
        return "gtts"
    return "none"


def any_tts_available() -> bool:
    return selected_engine() != "none"


def list_kokoro_presets() -> list[dict]:
    """Built-in Kokoro voices for the picker (filtered to voices actually packed).

    Does **not** download weights — that happens in :func:`warmup_free_tts` /
    :func:`ensure_kokoro_models` at synthesis time. Avoids blocking ``/api/voices``.
    """
    available: set[str] | None = None
    try:
        if kokoro_available() and kokoro_models_present() and _kokoro_is_warm():
            kokoro = _load_kokoro()
            keys = getattr(kokoro, "voices", None)
            if isinstance(keys, dict):
                available = set(keys.keys())
    except Exception as e:  # noqa: BLE001
        log.bind(task="TTS").warning(f"kokoro preset probe failed: {e}")
        available = None
    out: list[dict] = []
    for p in KOKORO_PRESETS:
        if available is not None and p["id"] not in available:
            continue
        out.append(dict(p))
    if not out:
        # Still show the catalog even if models aren't downloaded yet.
        out = [dict(p) for p in KOKORO_PRESETS]
    return out


def kokoro_preset_ids() -> set[str]:
    return {p["id"] for p in KOKORO_PRESETS}


# Kyutai Pocket TTS catalog (voice names accepted by get_state_for_audio_prompt).
# Genders verified against https://kyutai.org/tts (Pocket demo labels: f/m).
# See also https://github.com/kyutai-labs/pocket-tts
POCKET_PRESETS: list[dict] = [
    # Default / recommended first
    {"id": "anna", "label": "Anna", "gender": "female", "accent": "English",
     "vibe": "Soft · steady", "tag": "Recommended", "hue": 320},
    {"id": "jane", "label": "Jane", "gender": "female", "accent": "English",
     "vibe": "Clear · conversation", "tag": "", "hue": 160},
    {"id": "azelma", "label": "Azelma", "gender": "female", "accent": "English",
     "vibe": "Bright · light", "tag": "", "hue": 340},
    {"id": "caro_davy", "label": "Caro", "gender": "female", "accent": "English",
     "vibe": "Warm · podcast", "tag": "", "hue": 25},
    {"id": "cosette", "label": "Cosette", "gender": "female", "accent": "English",
     "vibe": "Expressive", "tag": "", "hue": 280},
    {"id": "eponine", "label": "Eponine", "gender": "female", "accent": "English",
     "vibe": "Gentle", "tag": "", "hue": 300},
    {"id": "eve", "label": "Eve", "gender": "female", "accent": "English",
     "vibe": "Modern · conversation", "tag": "", "hue": 190},
    {"id": "fantine", "label": "Fantine", "gender": "female", "accent": "English",
     "vibe": "Narrative", "tag": "", "hue": 350},
    {"id": "mary", "label": "Mary", "gender": "female", "accent": "English",
     "vibe": "Calm · conversation", "tag": "", "hue": 210},
    {"id": "vera", "label": "Vera", "gender": "female", "accent": "English",
     "vibe": "Crisp · conversation", "tag": "", "hue": 45},
    # Alba is male (reading) per Kyutai — was mis-tagged female and mixed filters.
    {"id": "alba", "label": "Alba", "gender": "male", "accent": "English",
     "vibe": "Casual · reading", "tag": "", "hue": 200},
    {"id": "bill_boerst", "label": "Bill", "gender": "male", "accent": "English",
     "vibe": "Deep · reading", "tag": "", "hue": 220},
    {"id": "charles", "label": "Charles", "gender": "male", "accent": "English",
     "vibe": "Measured · conversation", "tag": "", "hue": 30},
    {"id": "george", "label": "George", "gender": "male", "accent": "English",
     "vibe": "Authoritative", "tag": "", "hue": 15},
    {"id": "jean", "label": "Jean", "gender": "male", "accent": "English",
     "vibe": "Natural · conversation", "tag": "", "hue": 140},
    {"id": "javert", "label": "Javert", "gender": "male", "accent": "English",
     "vibe": "Bold", "tag": "", "hue": 0},
    {"id": "marius", "label": "Marius", "gender": "male", "accent": "English",
     "vibe": "Warm", "tag": "", "hue": 250},
    {"id": "michael", "label": "Michael", "gender": "male", "accent": "English",
     "vibe": "Explainer · conversation", "tag": "", "hue": 175},
    {"id": "paul", "label": "Paul", "gender": "male", "accent": "English",
     "vibe": "Even · conversation", "tag": "", "hue": 200},
    {"id": "peter_yearsley", "label": "Peter", "gender": "male", "accent": "English",
     "vibe": "Lecture · reading", "tag": "", "hue": 230},
    {"id": "stuart_bell", "label": "Stuart", "gender": "male", "accent": "English",
     "vibe": "Broadcast · reading", "tag": "", "hue": 260},
    {"id": "estelle", "label": "Estelle", "gender": "female", "accent": "French",
     "vibe": "FR · clear", "tag": "FR", "hue": 310},
    {"id": "giovanni", "label": "Giovanni", "gender": "male", "accent": "Italian",
     "vibe": "IT · warm", "tag": "IT", "hue": 10},
    {"id": "lola", "label": "Lola", "gender": "female", "accent": "Spanish",
     "vibe": "ES · bright", "tag": "ES", "hue": 330},
    {"id": "juergen", "label": "Juergen", "gender": "male", "accent": "German",
     "vibe": "DE · steady", "tag": "DE", "hue": 40},
    {"id": "rafael", "label": "Rafael", "gender": "male", "accent": "Portuguese",
     "vibe": "PT · rich", "tag": "PT", "hue": 20},
]


def pocket_available() -> bool:
    """Pocket TTS can load when the ``pocket_tts`` package is installed."""
    return _has_module("pocket_tts")


def list_pocket_presets() -> list[dict]:
    return [dict(p) for p in POCKET_PRESETS]


def pocket_preset_ids() -> set[str]:
    return {p["id"] for p in POCKET_PRESETS}


def is_pocket_voice_path(path: str | Path | None) -> bool:
    if not path:
        return False
    return Path(str(path)).suffix.lower() in {".safetensors", ".wav", ".mp3", ".flac", ".ogg"}


@lru_cache(maxsize=1)
def _load_pocket_model():
    from pocket_tts import TTSModel

    s = get_settings()
    kwargs: dict = {"language": (s.pocket_tts_language or "english").strip() or "english"}
    if s.pocket_tts_temp is not None:
        kwargs["temp"] = float(s.pocket_tts_temp)
    log.bind(task="TTS").info(f"loading Pocket TTS language={kwargs['language']}")
    return TTSModel.load_model(**kwargs)


@lru_cache(maxsize=32)
def _pocket_state_for(voice_key: str):
    """Cache voice states by catalog name or absolute file path."""
    model = _load_pocket_model()
    key = (voice_key or "").strip()
    if not key:
        key = get_settings().pocket_tts_default_voice or "anna"
    return model.get_state_for_audio_prompt(key)


def export_pocket_voice(audio_path: Path, dest: Path) -> Path:
    """Clone from wav/mp3 → ``.safetensors`` for fast Pocket TTS reloads."""
    from pocket_tts import export_model_state

    if not pocket_available():
        raise RuntimeError("Pocket TTS is not installed (pip install pocket-tts).")
    audio_path = Path(audio_path)
    if not audio_path.is_file():
        raise FileNotFoundError(f"Audio not found: {audio_path}")
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    model = _load_pocket_model()
    state = model.get_state_for_audio_prompt(str(audio_path.resolve()))
    export_model_state(state, str(dest))
    # Bust cache for this path if it was previously loaded.
    try:
        _pocket_state_for.cache_clear()
    except Exception:
        pass
    log.bind(task="TTS").success(f"Pocket voice exported → {dest.name}")
    return dest


def _synthesize_pocket(
    text: str,
    out_path: Path,
    *,
    pocket_voice: str | None = None,
    voice_state_path: str | None = None,
) -> None:
    import numpy as np
    import soundfile as sf

    if not pocket_available():
        raise RuntimeError("Pocket TTS is not installed (pip install pocket-tts).")
    model = _load_pocket_model()
    key = (voice_state_path or pocket_voice or "").strip()
    if not key:
        key = get_settings().pocket_tts_default_voice or "anna"
    p = Path(key)
    if p.is_file():
        key = str(p.resolve())
    state = _pocket_state_for(key)
    audio = model.generate_audio(state, text, copy_state=True)
    arr = audio.detach().cpu().numpy() if hasattr(audio, "detach") else np.asarray(audio)
    if arr.ndim > 1:
        arr = arr.squeeze()
    out_path = Path(out_path).with_suffix(".wav")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), arr.astype(np.float32, copy=False), int(model.sample_rate))


def ensure_kokoro_models() -> None:
    """Download Kokoro model + voices files if they are not already present."""
    s = get_settings()
    targets = [
        ("model", s.kokoro_model_file, _KOKORO_MODEL_URL),
        ("voices", s.kokoro_voices_file, _KOKORO_VOICES_URL),
    ]
    ctx = ssl.create_default_context()
    for label, path, url in targets:
        if path.exists() and path.stat().st_size > 1_000_000:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".part")
        log.bind(task="TTS").info(f"downloading Kokoro {label} weights -> {path.name}")
        req = urllib.request.Request(url, headers={"User-Agent": "multimodal-studio"})
        try:
            with urllib.request.urlopen(req, context=ctx) as resp, open(tmp, "wb") as fh:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    fh.write(chunk)
            tmp.replace(path)
            mb = path.stat().st_size / 1_048_576
            log.bind(task="TTS").success(f"Kokoro {label} ready ({mb:.0f} MB)")
        except Exception as e:
            tmp.unlink(missing_ok=True)
            log.bind(task="TTS").error(f"Kokoro {label} download failed: {e}")
            raise


@lru_cache(maxsize=1)
def _load_kokoro():
    from kokoro_onnx import Kokoro

    s = get_settings()
    log.bind(task="TTS").info(
        f"loading Kokoro ONNX model={s.kokoro_model_file.name}"
    )
    return Kokoro(str(s.kokoro_model_file), str(s.kokoro_voices_file))


def _kokoro_is_warm() -> bool:
    return _load_kokoro.cache_info().currsize > 0


def _pocket_is_warm() -> bool:
    return _load_pocket_model.cache_info().currsize > 0


_warmup_lock = threading.Lock()
_warmup_state: dict = {
    "state": "idle",  # idle | running | ready | error
    "started_at": None,
    "finished_at": None,
    "engines": {},
    "error": None,
}


def free_tts_warmup_status() -> dict:
    """Snapshot of free-engine (Kokoro / Pocket) warmup for UI / capabilities."""
    with _warmup_lock:
        snap = dict(_warmup_state)
        snap["engines"] = dict(_warmup_state.get("engines") or {})
    snap["kokoro_warm"] = _kokoro_is_warm()
    snap["pocket_warm"] = _pocket_is_warm() if pocket_available() else False
    snap["kokoro_models_on_disk"] = kokoro_models_present()
    return snap


def _warmup_status_unlocked() -> dict:
    """Status snapshot without taking ``_warmup_lock`` (caller must hold it)."""
    snap = dict(_warmup_state)
    snap["engines"] = dict(_warmup_state.get("engines") or {})
    snap["kokoro_warm"] = _kokoro_is_warm()
    snap["pocket_warm"] = _pocket_is_warm() if pocket_available() else False
    snap["kokoro_models_on_disk"] = kokoro_models_present()
    return snap


def warmup_free_tts(*, force: bool = False) -> dict:
    """Download + load free TTS engines into process memory (Kokoro + Pocket).

    Safe to call repeatedly — uses ``lru_cache`` for the model objects and a
    lock so concurrent warmups do not pile up. Intended for app startup.
    """
    global _warmup_state
    with _warmup_lock:
        if _warmup_state.get("state") == "running" and not force:
            # Do not call free_tts_warmup_status() here — Lock is not re-entrant.
            return _warmup_status_unlocked()
        if (
            not force
            and _warmup_state.get("state") == "ready"
            and _kokoro_is_warm()
            and (not pocket_available() or _pocket_is_warm())
        ):
            return _warmup_status_unlocked()
        _warmup_state = {
            "state": "running",
            "started_at": time.time(),
            "finished_at": None,
            "engines": {},
            "error": None,
        }

    engines: dict[str, str] = {}
    errors: list[str] = []
    t0 = time.time()

    # --- Kokoro (disk cache models/ + in-memory ONNX) ---
    if kokoro_available():
        try:
            ensure_kokoro_models()
            _load_kokoro()
            # Touch default voice style so first synth skips blend resolve cold path.
            try:
                _resolve_voice_style(get_settings().kokoro_voice or "af_heart")
            except Exception:  # noqa: BLE001
                pass
            engines["kokoro"] = "ready"
            log.bind(task="TTS").success("Kokoro free voice model warm in memory")
        except Exception as e:  # noqa: BLE001
            engines["kokoro"] = f"error: {e}"
            errors.append(f"kokoro: {e}")
            log.bind(task="TTS").warning(f"Kokoro warmup failed: {e}")
    else:
        engines["kokoro"] = "unavailable"

    # --- Pocket (HF hub disk cache + in-memory weights + default voice state) ---
    if pocket_available():
        try:
            _load_pocket_model()
            default_voice = (get_settings().pocket_tts_default_voice or "anna").strip() or "anna"
            _pocket_state_for(default_voice)
            engines["pocket"] = "ready"
            log.bind(task="TTS").success(
                f"Pocket free voice model warm (default={default_voice})"
            )
        except Exception as e:  # noqa: BLE001
            engines["pocket"] = f"error: {e}"
            errors.append(f"pocket: {e}")
            log.bind(task="TTS").warning(f"Pocket warmup failed: {e}")
    else:
        engines["pocket"] = "unavailable"

    elapsed = time.time() - t0
    with _warmup_lock:
        _warmup_state = {
            "state": "error" if errors and not any(
                v == "ready" for v in engines.values()
            ) else ("ready" if any(v == "ready" for v in engines.values()) else "error"),
            "started_at": _warmup_state.get("started_at") or t0,
            "finished_at": time.time(),
            "engines": engines,
            "error": "; ".join(errors) if errors else None,
            "elapsed_sec": round(elapsed, 2),
        }
    log.bind(task="TTS").info(
        f"free TTS warmup done in {elapsed:.1f}s engines={engines}"
    )
    return free_tts_warmup_status()


def start_free_tts_warmup_background() -> None:
    """Daemon thread: warm free voices without blocking FastAPI startup."""
    if not get_settings().tts_warmup_on_startup:
        log.bind(task="TTS").info("TTS warmup on startup disabled")
        return
    with _warmup_lock:
        if _warmup_state.get("state") == "running":
            return

    def _run() -> None:
        try:
            warmup_free_tts()
        except Exception as e:  # noqa: BLE001
            log.bind(task="TTS").error(f"background TTS warmup crashed: {e}")

    threading.Thread(target=_run, name="tts-free-warmup", daemon=True).start()
    log.bind(task="TTS").info("free TTS warmup started in background")


def _parse_voice_spec(spec: str) -> list[tuple[str, float]]:
    """Parse a Kokoro voice spec into [(voice_name, weight), ...].

    Supports a single voice (``"af_nicole"``) or a weighted blend written as
    comma-separated ``name:weight`` pairs, e.g. ``"af_nicole:80,am_michael:20"``.
    Weights are normalized so they always sum to 1.0.
    """
    spec = (spec or "").strip()
    if not spec:
        return [("af_heart", 1.0)]
    parts = [p.strip() for p in spec.split(",") if p.strip()]
    out: list[tuple[str, float]] = []
    for p in parts:
        if ":" in p:
            name, _, w = p.partition(":")
            try:
                weight = float(w)
            except ValueError:
                weight = 1.0
        else:
            name, weight = p, 1.0
        name = name.strip()
        if name:
            out.append((name, max(0.0, weight)))
    if not out:
        return [("af_heart", 1.0)]
    total = sum(w for _, w in out) or 1.0
    return [(n, w / total) for n, w in out]


@lru_cache(maxsize=8)
def _resolve_voice_style(spec: str):
    """Return a Kokoro voice argument for ``spec``.

    A single voice returns its name (cheapest path). A blend returns a NumPy
    style embedding = weighted average of each component voice, which Kokoro
    accepts directly. Blending lets us add depth/gravel to a female narrator by
    mixing in a small fraction of a male voice (a common Kokoro technique).
    """
    pairs = _parse_voice_spec(spec)
    if len(pairs) == 1 and pairs[0][1] >= 0.999:
        return pairs[0][0]  # plain single voice name

    import numpy as np

    kokoro = _load_kokoro()
    available = set(getattr(kokoro, "voices", {}).keys())
    blended = None
    used: list[str] = []
    for name, weight in pairs:
        if available and name not in available:
            log.bind(task="TTS").warning(f"voice '{name}' not in pack; skipping")
            continue
        style = np.asarray(kokoro.get_voice_style(name), dtype=np.float32)
        blended = style * weight if blended is None else blended + style * weight
        used.append(f"{name}:{weight:.2f}")
    if blended is None:
        log.bind(task="TTS").warning("no valid blend voices; using af_heart")
        return "af_heart"
    log.bind(task="TTS").info(f"blended voice = {' + '.join(used)}")
    return blended


def _synthesize_kokoro(text: str, out_path: Path, kokoro_voice: str | None = None) -> None:
    import soundfile as sf

    ensure_kokoro_models()
    s = get_settings()
    spec = (kokoro_voice or "").strip() or s.kokoro_voice
    kokoro = _load_kokoro()
    voice = _resolve_voice_style(spec)
    samples, sample_rate = kokoro.create(
        text,
        voice=voice,
        speed=float(s.kokoro_speed),
        lang=s.kokoro_lang,
    )
    # kokoro-onnx returns a single (samples, sr) when given plain text.
    sf.write(str(out_path), samples, sample_rate)


def _synthesize_gtts(text: str, out_path: Path) -> None:
    from gtts import gTTS

    gTTS(text=text, lang="en").save(str(out_path))


@lru_cache(maxsize=1)
def _load_supertonic():
    from supertonic import TTS

    # Downloads model assets from Hugging Face on first use.
    return TTS(auto_download=True)


def _resolve_supertonic_style(style_ref: str):
    """Return a Supertonic voice style for ``style_ref``.

    ``style_ref`` may be:
    * a path to a Voice Builder style JSON (the real "clone" path), or
    * a bare preset name (e.g. ``"M1"``).

    Style JSON paths are keyed by mtime so Rebuild/attach pick up new files
    without a process restart.
    """
    tts = _load_supertonic()
    s = get_settings()
    ref = (style_ref or "").strip()
    path = Path(ref)
    if ref and path.exists() and path.suffix.lower() == ".json":
        try:
            validate_voice_style_bytes(path.read_bytes())
            mtime = path.stat().st_mtime_ns
            return _load_style_json_cached(str(path.resolve()), mtime)
        except Exception as e:
            raise RuntimeError(
                f"Supertonic style JSON load failed ({e}). "
                "Re-upload the Voice Builder export or Rebuild the clone."
            ) from e
    preset = ref or s.supertonic_default_style
    return tts.get_voice_style(preset)


@lru_cache(maxsize=16)
def _load_style_json_cached(path_str: str, mtime_ns: int):
    """Cache by absolute path + mtime so rebuilt clones are not sticky."""
    tts = _load_supertonic()
    return tts.get_voice_style_from_path(Path(path_str))


def _synthesize_supertonic(text: str, out_path: Path, style_ref: str | None) -> None:
    tts = _load_supertonic()
    s = get_settings()
    style = _resolve_supertonic_style(style_ref or s.supertonic_default_style)
    wav, _duration = tts.synthesize(text, voice_style=style, lang=s.supertonic_lang)
    tts.save_audio(wav, str(out_path))


def _chunk_text(text: str, limit: int = 300) -> list[str]:
    """Split text for Supertone cloud (300-char API limit) on sentence boundaries."""
    text = (text or "").strip()
    if not text:
        return ["."]
    if len(text) <= limit:
        return [text]
    import re

    parts = re.split(r"(?<=[.!?])\s+", text)
    chunks: list[str] = []
    cur = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        while len(part) > limit:
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(part[:limit])
            part = part[limit:]
        if not cur:
            cur = part
        elif len(cur) + 1 + len(part) <= limit:
            cur = f"{cur} {part}"
        else:
            chunks.append(cur)
            cur = part
    if cur:
        chunks.append(cur)
    return chunks or [text[:limit]]


def _synthesize_supertone_cloud(text: str, out_path: Path, cloud_voice_id: str) -> None:
    """POST /v1/text-to-speech/{voice_id} (voice_id is a path param, max 300 chars)."""
    key = (get_settings().supertone_api_key or "").strip()
    if not key:
        raise RuntimeError("SUPERTONE_API_KEY is not configured")
    vid = (cloud_voice_id or "").strip()
    if not vid:
        raise RuntimeError("cloud_voice_id is empty")
    import httpx
    import numpy as np
    import soundfile as sf

    lang = get_settings().supertonic_lang or "en"
    chunks = _chunk_text(text, 300)
    waves: list[np.ndarray] = []
    sr = 44100
    url = f"https://supertoneapi.com/v1/text-to-speech/{vid}"
    for i, chunk in enumerate(chunks):
        resp = httpx.post(
            url,
            headers={"x-sup-api-key": key, "Content-Type": "application/json"},
            json={
                "text": chunk,
                "language": lang,
                "model": "sona_speech_1",
                "output_format": "wav",
            },
            timeout=httpx.Timeout(120.0, connect=30.0),
        )
        if resp.status_code >= 400:
            detail = (resp.text or "")[:240]
            raise RuntimeError(
                f"Supertone cloud TTS HTTP {resp.status_code}: {detail or resp.reason_phrase}"
            )
        tmp = out_path.with_suffix(f".part{i}.wav")
        tmp.write_bytes(resp.content)
        try:
            data, file_sr = sf.read(str(tmp), always_2d=False)
            sr = int(file_sr)
            if getattr(data, "ndim", 1) > 1:
                data = data.mean(axis=1)
            waves.append(np.asarray(data, dtype=np.float32))
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
    if not waves:
        raise RuntimeError("Supertone cloud returned empty audio")
    if len(waves) == 1:
        sf.write(str(out_path), waves[0], sr)
    else:
        # Small silence between chunks so joins don't click.
        gap = np.zeros(int(sr * 0.08), dtype=np.float32)
        merged: list[np.ndarray] = []
        for i, w in enumerate(waves):
            merged.append(w)
            if i < len(waves) - 1:
                merged.append(gap)
        sf.write(str(out_path), np.concatenate(merged), sr)


def synthesize(
    text: str,
    out_path: Path,
    voice_style: str | None = None,
    cloud_voice_id: str | None = None,
    kokoro_voice: str | None = None,
    pocket_voice: str | None = None,
) -> str:
    """Synthesize ``text`` to ``out_path``. Returns the engine used.

    When a clone is requested (style JSON, Pocket safetensors, or cloud voice id),
    failures raise instead of silently falling back to Kokoro — otherwise the user
    thinks the clone worked while hearing the default voice.

    The output container is chosen from ``out_path``'s suffix; callers should
    pass ``.wav`` for Kokoro/Pocket/Supertonic and ``.mp3`` for gTTS (or let the
    orchestrator pick based on :func:`output_suffix`).
    """
    text = (text or "").strip() or "No narration was available for this lesson."
    style = (voice_style or "").strip()
    pocket_file = bool(
        style and Path(style).suffix.lower() in {".safetensors", ".wav", ".mp3", ".flac", ".ogg"}
    )
    if ((pocket_voice or "").strip() or pocket_file) and not pocket_available():
        raise RuntimeError("Pocket TTS is not installed (pip install pocket-tts).")
    requested_clone = bool(
        (cloud_voice_id or "").strip()
        or (style and Path(style).suffix.lower() == ".json")
        or pocket_file
        or (pocket_voice or "").strip()
    )
    engine = selected_engine(
        voice_style, cloud_voice_id=cloud_voice_id, pocket_voice=pocket_voice
    )
    s = get_settings()
    if engine == "supertone-cloud":
        try:
            _synthesize_supertone_cloud(text, out_path, cloud_voice_id or "")
            log.bind(task="TTS").info(
                f"Supertone cloud voice={cloud_voice_id} lang={s.supertonic_lang} "
                f"({len(text)} chars)"
            )
            return "supertone-cloud"
        except Exception as e:
            if requested_clone:
                raise RuntimeError(f"Supertone cloud TTS failed: {e}") from e
            log.bind(task="TTS").warning(
                f"Supertone cloud failed ({e}); falling back to default engine"
            )
            engine = selected_engine()
    if engine == "supertonic":
        try:
            _synthesize_supertonic(text, out_path, voice_style)
            log.bind(task="TTS").info(
                f"Supertonic lang={s.supertonic_lang} style={voice_style or s.supertonic_default_style} "
                f"({len(text)} chars)"
            )
            return "supertonic"
        except Exception as e:
            if requested_clone:
                raise RuntimeError(f"Supertonic clone TTS failed: {e}") from e
            log.bind(task="TTS").warning(
                f"Supertonic failed ({e}); falling back to default engine"
            )
            engine = selected_engine()  # resolve without the voice-style hint
    if engine == "pocket":
        try:
            state_path = style if pocket_file else None
            voice_used = (pocket_voice or "").strip() or (
                None if state_path else (s.pocket_tts_default_voice or "anna")
            )
            _synthesize_pocket(
                text,
                out_path,
                pocket_voice=voice_used,
                voice_state_path=state_path,
            )
            log.bind(task="TTS").info(
                f"Pocket TTS voice={state_path or voice_used} ({len(text)} chars)"
            )
            return "pocket"
        except Exception as e:
            if requested_clone:
                raise RuntimeError(f"Pocket TTS failed: {e}") from e
            log.bind(task="TTS").warning(f"Pocket TTS failed ({e}); falling back")
            engine = selected_engine()
    if engine == "kokoro":
        try:
            voice_used = (kokoro_voice or "").strip() or s.kokoro_voice
            _synthesize_kokoro(text, out_path, kokoro_voice=voice_used)
            log.bind(task="TTS").info(
                f"Kokoro voice={voice_used} speed={s.kokoro_speed} ({len(text)} chars)"
            )
            return "kokoro"
        except Exception as e:
            log.bind(task="TTS").warning(f"Kokoro failed ({e}); falling back to gTTS")
            if gtts_available():
                # Fall back to gTTS but honor mp3 extension.
                mp3 = out_path.with_suffix(".mp3")
                _synthesize_gtts(text, mp3)
                return "gtts"
            raise
    if engine == "gtts":
        log.bind(task="TTS").info(f"gTTS ({len(text)} chars)")
        _synthesize_gtts(text, out_path)
        return "gtts"
    raise RuntimeError("No TTS engine available")


def output_suffix(
    voice_style: str | None = None,
    cloud_voice_id: str | None = None,
    pocket_voice: str | None = None,
) -> str:
    """Preferred audio file extension for the resolved engine."""
    eng = selected_engine(
        voice_style, cloud_voice_id=cloud_voice_id, pocket_voice=pocket_voice
    )
    return ".wav" if eng in {"kokoro", "pocket", "supertonic", "supertone-cloud"} else ".mp3"
