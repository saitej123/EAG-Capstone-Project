"""Local Supertonic voice-style extraction from a reference recording.

The bundled M1–F5 presets are only a starting point. This module:

1. Picks the closest preset by synthesizing a calibration phrase and comparing
   spectral fingerprints to the user's recording.
2. Perturbs ``style_ttl`` with coordinate search to reduce the fingerprint
   distance (gradient-free; works with the ONNX Supertonic runtime on CPU).

This is not as accurate as Supertone Voice Builder or supertonic.embed with a
GPU, but it produces a noticeably closer clone than copying a preset by pitch.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path

import numpy as np

from ..config import get_settings
from ..logging_setup import log

# Matches the opening line users read when recording a voice sample.
CALIBRATION_PHRASE = (
    "The quick brown fox jumps over the lazy dog. Every video deserves a clear, "
    "natural narration that feels warm and human."
)


def _read_mono(path: Path) -> tuple[np.ndarray, int]:
    import soundfile as sf

    samples, sr = sf.read(str(path), always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    return np.asarray(samples, dtype=np.float32), int(sr)


def _resample(samples: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return samples
    n = int(round(len(samples) * dst_sr / src_sr))
    if n < 1:
        return samples
    x_old = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
    x_new = np.linspace(0.0, 1.0, num=n, endpoint=False)
    return np.interp(x_new, x_old, samples).astype(np.float32)


def prepare_recording(path: Path, *, target_sr: int = 44100) -> Path:
    """Trim silence, normalize level, and resample for cloning."""
    samples, sr = _read_mono(path)
    samples = _resample(samples, sr, target_sr)
    sr = target_sr

    # Trim leading/trailing silence by energy threshold.
    frame = max(1, sr // 50)
    pad = max(1, sr // 20)
    energy = np.array(
        [np.sqrt(np.mean(samples[i : i + frame] ** 2) + 1e-12) for i in range(0, len(samples) - frame, frame)],
        dtype=np.float32,
    )
    if energy.size:
        thresh = max(float(np.percentile(energy, 20)) * 2.5, 0.008)
        voiced = np.where(energy >= thresh)[0]
        if voiced.size:
            start = max(0, int(voiced[0]) * frame - pad)
            end = min(len(samples), int(voiced[-1] + 1) * frame + pad)
            samples = samples[start:end]

    peak = float(np.max(np.abs(samples))) if samples.size else 0.0
    if peak > 1e-5:
        samples = (samples / peak * 0.92).astype(np.float32)

    import soundfile as sf

    tmp = path.with_suffix(".prepared.wav")
    sf.write(str(tmp), samples, sr, subtype="PCM_16")
    return tmp


def _mel_fingerprint(samples: np.ndarray, sr: int, *, n_mels: int = 40) -> np.ndarray:
    """Compact spectral fingerprint (mean log-power per mel band)."""
    x = np.asarray(samples, dtype=np.float32)
    if x.size < sr // 20:
        return np.zeros(n_mels, dtype=np.float32)
    frame = max(256, sr // 32)
    hop = max(128, frame // 2)
    bands: list[np.ndarray] = []
    for start in range(0, len(x) - frame, hop):
        chunk = x[start : start + frame]
        chunk = chunk * np.hanning(len(chunk)).astype(np.float32)
        spec = np.abs(np.fft.rfft(chunk)) ** 2
        edges = np.linspace(0, len(spec), n_mels + 1, dtype=int)
        mel = np.array([spec[edges[i] : edges[i + 1]].mean() for i in range(n_mels)], dtype=np.float32)
        bands.append(mel)
    fp = np.mean(bands, axis=0)
    fp = np.log1p(fp)
    fp -= fp.mean()
    norm = float(np.linalg.norm(fp))
    return fp / norm if norm > 1e-8 else fp


def _fingerprint_distance(a: np.ndarray, b: np.ndarray) -> float:
    n = min(a.size, b.size)
    if n == 0:
        return 1.0
    return float(np.linalg.norm(a[:n] - b[:n]))


def _style_dict_from_preset(preset_path: Path) -> dict:
    data = json.loads(preset_path.read_text(encoding="utf-8"))
    return {"style_ttl": data["style_ttl"], "style_dp": data["style_dp"]}


def _synthesize_style_dict(style_data: dict, phrase: str) -> np.ndarray:
    from . import tts as tts_mod

    tts = tts_mod._load_supertonic()
    s = get_settings()
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(style_data, fh)
        tmp = Path(fh.name)
    try:
        style = tts.get_voice_style_from_path(tmp)
        wav, _ = tts.synthesize(
            phrase,
            voice_style=style,
            lang=s.supertonic_lang,
            total_steps=4,
        )
        return np.asarray(wav, dtype=np.float32).squeeze()
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _eval_style(style_data: dict, target_fp: np.ndarray, phrase: str, sr: int) -> float:
    wav = _synthesize_style_dict(style_data, phrase)
    return _fingerprint_distance(target_fp, _mel_fingerprint(wav, sr))


def _pick_best_preset(recording: Path, phrase: str) -> tuple[dict, str, float]:
    from . import tts as tts_mod
    from supertonic.loader import list_available_voice_style_names

    tts = tts_mod._load_supertonic()
    samples, sr = _read_mono(recording)
    # Fingerprints must share sample rate with synthesized candidates.
    samples = _resample(samples, sr, int(tts.sample_rate))
    target_fp = _mel_fingerprint(samples, int(tts.sample_rate))
    presets = list_available_voice_style_names(tts.model_dir)

    best_name = get_settings().supertonic_default_style
    best_loss = float("inf")
    best_data: dict | None = None
    for name in presets:
        preset_path = tts.model_dir / "voice_styles" / f"{name}.json"
        if not preset_path.exists():
            continue
        data = _style_dict_from_preset(preset_path)
        loss = _eval_style(data, target_fp, phrase, tts.sample_rate)
        log.bind(task="voice").debug(f"preset {name} fingerprint loss={loss:.4f}")
        if loss < best_loss:
            best_loss = loss
            best_name = name
            best_data = data

    if best_data is None:
        fallback = tts.model_dir / "voice_styles" / f"{best_name}.json"
        best_data = _style_dict_from_preset(fallback)
        best_loss = _eval_style(best_data, target_fp, phrase, tts.sample_rate)

    log.bind(task="voice").info(f"closest Supertonic preset: {best_name} (loss={best_loss:.4f})")
    return best_data, best_name, best_loss


def _optimize_ttl(
    base: dict,
    recording: Path,
    phrase: str,
    *,
    steps: int,
) -> tuple[dict, float]:
    from . import tts as tts_mod

    tts = tts_mod._load_supertonic()
    samples, sr = _read_mono(recording)
    samples = _resample(samples, sr, int(tts.sample_rate))
    target_fp = _mel_fingerprint(samples, int(tts.sample_rate))

    ttl = np.array(base["style_ttl"]["data"], dtype=np.float32).reshape(base["style_ttl"]["dims"])
    dp = base["style_dp"]
    best_ttl = ttl.copy()
    best = {"style_ttl": base["style_ttl"], "style_dp": dp}
    best_loss = _eval_style(best, target_fp, phrase, tts.sample_rate)

    rng = np.random.default_rng(42)
    scale = 0.06
    for step in range(max(0, steps)):
        candidate_ttl = best_ttl + rng.normal(0.0, scale, size=best_ttl.shape).astype(np.float32)
        candidate = {
            "style_ttl": {
                "dims": base["style_ttl"]["dims"],
                "data": candidate_ttl.reshape(-1).tolist(),
                "type": "float32",
            },
            "style_dp": dp,
        }
        loss = _eval_style(candidate, target_fp, phrase, tts.sample_rate)
        if loss < best_loss:
            best_loss = loss
            best_ttl = candidate_ttl
            best = candidate
            scale = max(scale * 0.985, 0.015)
        if (step + 1) % 12 == 0:
            log.bind(task="voice").info(
                f"voice style optimize {step + 1}/{steps} best_loss={best_loss:.4f}"
            )

    return best, best_loss


def _pack_style_json(style_data: dict, *, source: str, preset: str, loss: float) -> bytes:
    payload = {
        "style_ttl": style_data["style_ttl"],
        "style_dp": style_data["style_dp"],
        "metadata": {
            "clone_source": source,
            "preset_seed": preset,
            "fingerprint_loss": round(loss, 5),
        },
    }
    return json.dumps(payload).encode("utf-8")


def optimize_from_recording(recording: Path) -> tuple[bytes, str] | None:
    """Build an optimized Supertonic style JSON. Returns (bytes, source_label)."""
    from . import tts as tts_mod

    if not tts_mod.supertonic_available():
        return None

    s = get_settings()
    if not s.voice_clone_optimize_enabled:
        return None

    prepared = prepare_recording(recording)
    try:
        base, preset_name, base_loss = _pick_best_preset(prepared, CALIBRATION_PHRASE)
        optimized, final_loss = _optimize_ttl(
            base,
            prepared,
            CALIBRATION_PHRASE,
            steps=max(8, int(s.voice_clone_optimize_steps)),
        )
        source = "optimized" if final_loss < base_loss else "preset_match"
        loss = final_loss if source == "optimized" else base_loss
        out_data = optimized if source == "optimized" else base
        log.bind(task="voice").info(
            f"local voice clone ready ({source}) preset={preset_name} loss={loss:.4f}"
        )
        return _pack_style_json(out_data, source=source, preset=preset_name, loss=loss), source
    except Exception as e:
        log.bind(task="voice").warning(f"local voice style optimization failed: {e}")
        return None
    finally:
        if prepared != recording:
            try:
                prepared.unlink(missing_ok=True)
            except OSError:
                pass
