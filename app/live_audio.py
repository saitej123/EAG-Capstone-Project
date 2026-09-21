"""Gemini Live API helpers — model candidates, prompts, and cost recording.

Docs: https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
Pricing: https://ai.google.dev/gemini-api/docs/pricing (Gemini 3.1 Flash Live)
"""
from __future__ import annotations

from typing import Any

from .config import get_settings
from .logging_setup import log

_LOG = log.bind(task="live-audio")

# ~25 audio tokens / second (Google Live best-practices estimate).
AUDIO_TOKENS_PER_SEC = 25
# 16-bit PCM mono
PCM16_BYTES_PER_SEC = 16_000 * 2
PCM24_BYTES_PER_SEC = 24_000 * 2

# Default chain: AI Studio Live preview first (GenAI SDK get-started), then GA/native-audio fallbacks.
DEFAULT_LIVE_MODELS = (
    "gemini-3.1-flash-live-preview",
    "gemini-live-2.5-flash-native-audio",
    "gemini-2.5-flash-native-audio-preview-12-2025",
    "gemini-2.5-flash-native-audio-preview-09-2025",
)


def live_available() -> bool:
    settings = get_settings()
    return bool(settings.gemini_api_key) and settings.active_provider == "gemini"


def live_model_candidates(*, primary: str | None = None) -> list[str]:
    """Ordered Live model ids for connect retries."""
    settings = get_settings()
    preferred = (primary or settings.chitti_live_model or settings.interview_live_model or "").strip()
    out: list[str] = []
    for m in (preferred, *DEFAULT_LIVE_MODELS):
        if m and m not in out:
            out.append(m)
    return out


def live_model_name() -> str:
    return live_model_candidates()[0]


# Prebuilt Gemini Live voices. Default is a warm female interviewer.
FEMALE_LIVE_VOICES = ("Aoede", "Kore", "Leda", "Zephyr")
ALL_LIVE_VOICES = FEMALE_LIVE_VOICES + ("Puck", "Charon", "Fenrir", "Orus")
DEFAULT_LIVE_VOICE = "Aoede"


def live_voice_name() -> str:
    """Gemini Live prebuilt voice (Aoede unless GEMINI_LIVE_VOICE is set)."""
    raw = (get_settings().gemini_live_voice or DEFAULT_LIVE_VOICE).strip()
    for name in ALL_LIVE_VOICES:
        if name.lower() == raw.lower():
            return name
    return DEFAULT_LIVE_VOICE


def live_session_config(
    system: str, *, transcribe: bool = True, affective: bool = True
) -> dict[str, Any]:
    """Connect config: female voice, optional affective dialog + transcription."""
    cfg: dict[str, Any] = {
        "response_modalities": ["AUDIO"],
        "system_instruction": system,
        "speech_config": {
            "voice_config": {
                "prebuilt_voice_config": {"voice_name": live_voice_name()},
            }
        },
    }
    if affective:
        cfg["enable_affective_dialog"] = True
    if transcribe:
        cfg["input_audio_transcription"] = {}
        cfg["output_audio_transcription"] = {}
    return cfg


def merge_live_text(prev: str, nxt: str) -> str:
    """Join Live transcription deltas (or replace if the API sent a cumulative string)."""
    a = (prev or "").strip()
    b = (nxt or "").strip()
    if not b:
        return a
    if not a:
        return b
    if b.startswith(a):
        return b
    if a.startswith(b) and len(a) > len(b):
        return a
    if a.endswith(b):
        return a
    max_ov = min(len(a), len(b), 64)
    for i in range(max_ov, 0, -1):
        if a.endswith(b[:i]):
            return a + b[i:]
    glue = ""
    if a[-1].isalnum() and b[0].isalnum():
        glue = " "
    return a + glue + b


def _tx_piece(obj: Any) -> tuple[str, bool]:
    if obj is None:
        return ("", False)
    text = (getattr(obj, "text", None) or "").strip()
    finished = bool(getattr(obj, "finished", False))
    return (text, finished)


def iter_live_events(
    response: Any,
    *,
    transcribe: bool = True,
    asst_role: str = "interviewer",
) -> list[dict[str, Any]]:
    """Normalize a Live server message into audio / transcript / turn events."""
    events: list[dict[str, Any]] = []
    sc = getattr(response, "server_content", None)
    if not sc:
        return events
    saw_out_tx = False
    in_tx = getattr(sc, "input_transcription", None)
    if in_tx is not None:
        text, finished = _tx_piece(in_tx)
        if text:
            events.append(
                {"kind": "transcript", "role": "you", "text": text, "finished": finished}
            )
    out_tx = getattr(sc, "output_transcription", None)
    if out_tx is not None:
        text, finished = _tx_piece(out_tx)
        if text:
            saw_out_tx = True
            events.append(
                {
                    "kind": "transcript",
                    "role": asst_role,
                    "text": text,
                    "finished": finished,
                }
            )
    mt = getattr(sc, "model_turn", None)
    if mt:
        for part in getattr(mt, "parts", None) or []:
            inline = getattr(part, "inline_data", None)
            if inline and getattr(inline, "data", None):
                events.append({"kind": "audio", "data": inline.data})
            txt = getattr(part, "text", None)
            # Output transcription already covers spoken words — don't double-post.
            if txt and not transcribe and not saw_out_tx:
                events.append(
                    {
                        "kind": "transcript",
                        "role": asst_role,
                        "text": str(txt).strip(),
                        "finished": False,
                    }
                )
    if getattr(sc, "turn_complete", False):
        events.append({"kind": "turn_complete"})
    return events


def estimate_audio_tokens(*, in_bytes: int = 0, out_bytes: int = 0) -> tuple[int, int]:
    """Rough token estimate from PCM byte counts (16 kHz in / 24 kHz out)."""
    in_sec = max(0.0, float(in_bytes or 0) / PCM16_BYTES_PER_SEC)
    out_sec = max(0.0, float(out_bytes or 0) / PCM24_BYTES_PER_SEC)
    return (
        max(0, int(round(in_sec * AUDIO_TOKENS_PER_SEC))),
        max(0, int(round(out_sec * AUDIO_TOKENS_PER_SEC))),
    )


def record_live_usage(
    *,
    model: str,
    in_bytes: int = 0,
    out_bytes: int = 0,
    in_tokens: int | None = None,
    out_tokens: int | None = None,
    user_text: str = "",
    assistant_text: str = "",
    job_id: str = "",
    kind: str = "live_audio",
) -> None:
    """Record one Live session / turn for the admin cost dashboard."""
    from . import costs

    it, ot = estimate_audio_tokens(in_bytes=in_bytes, out_bytes=out_bytes)
    if in_tokens is not None:
        it = max(it, int(in_tokens))
    if out_tokens is not None:
        ot = max(ot, int(out_tokens))
    # Prefer text estimates when audio was silent but we still have transcripts.
    if it <= 0 and user_text:
        it = costs.estimate_tokens(user_text)
    if ot <= 0 and assistant_text:
        ot = costs.estimate_tokens(assistant_text)
    costs.record(
        provider="gemini",
        model=model or live_model_name(),
        kind=kind,
        in_tokens=it,
        out_tokens=ot,
        prompt=user_text or "",
        output=assistant_text or "",
        job_id=job_id or "",
    )
    _LOG.info(
        f"live usage model={model} kind={kind} in_tok={it} out_tok={ot} "
        f"in_b={in_bytes} out_b={out_bytes}"
    )


def pull_usage_tokens(response: Any) -> tuple[int, int]:
    """Best-effort (prompt, response) tokens from a Live server message."""
    um = getattr(response, "usage_metadata", None)
    if um is None:
        return (0, 0)
    prompt = (
        getattr(um, "prompt_token_count", None)
        or getattr(um, "promptTokenCount", None)
        or 0
    )
    resp = (
        getattr(um, "response_token_count", None)
        or getattr(um, "candidates_token_count", None)
        or getattr(um, "responseTokenCount", None)
        or 0
    )
    try:
        return (int(prompt or 0), int(resp or 0))
    except Exception:
        return (0, 0)


def chitti_system_prompt(*, product: str = "multimodal", session_hint: str = "") -> str:
    """System instruction for C.H.I.T.T.I. Live voice sessions."""
    base = (
        "You are C.H.I.T.T.I. (Cognitive Heuristic Interface Trained for Task Integration), "
        "a concise voice co-pilot inside Multimodal Studio. "
        "Speak briefly and clearly. Confirm actions in one short sentence. "
        "Never invent job status, API keys, or publish outcomes. "
        "Speak in a warm, natural woman's voice — complete sentences, human cadence, never clipped fragments. "
        "If the user asks you to run a workspace action (create a video, upload a document, status, history, help), "
        "acknowledge and state what you will do."
    )
    return (
        base
        + " Product context: Multimodal Studio video pipeline. "
        "You can report job status, open History, and start an upload so the user can create a video. "
        + (f" Extra context: {session_hint}" if session_hint else "")
    )
