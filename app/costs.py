"""LLM / paid-API cost tracking (admin only).

Every LLM or paid-API call records a usage event: which provider/model, how
many prompt/response tokens (estimated when the provider doesn't report them),
and an estimated dollar cost derived from configurable per-model rates. Local
providers (Ollama) are free and record $0.

The data lives in the shared SQLite database (``usage_events`` table) so it
survives restarts. The admin dashboard aggregates it into a cost report.

Design notes:
  * Never raises into the caller — a tracking failure must not break generation.
  * Token counts are best-effort: if a provider returns real usage we use it,
    otherwise we estimate ~4 chars/token on the prompt + output text.
  * Rates are per 1M tokens and come from ``settings`` (overridable via .env),
    with sensible built-in defaults for common cloud models.
  * Reports recompute $ from current rates so older rows stored at $0 (unknown
    model at the time) still show a useful estimate after rate tables update.
"""
from __future__ import annotations

import contextvars
import json
import re
import time
from contextlib import contextmanager
from typing import Iterator

from .db import _connect, _lock
from .logging_setup import log

# Set while a job pipeline (or thumbnail) runs so usage events attribute spend.
_current_job_id: contextvars.ContextVar[str] = contextvars.ContextVar(
    "cost_job_id", default=""
)


def get_job_id() -> str:
    return (_current_job_id.get() or "").strip()


@contextmanager
def job_context(job_id: str) -> Iterator[None]:
    """Attribute LLM / paid-API usage to ``job_id`` for the duration of the block."""
    token = _current_job_id.set((job_id or "").strip())
    try:
        yield
    finally:
        _current_job_id.reset(token)

# Built-in default rates (USD per 1M tokens): (input_rate, output_rate).
# Admins can override any of these via .env (see config.cost_rates).
# Sources: Google AI / OpenAI public pricing (paid tier, standard).
_DEFAULT_RATES: dict[str, tuple[float, float]] = {
    # Google Gemini 3.x — Standard paid tier (USD / 1M tokens).
    # 3.7 Flash intro through 2026-12-31: $0.75 in / $3.75 out (then $1.50 / $7.50).
    # https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
    "gemini-3.7-flash": (0.75, 3.75),
    "gemini-3.6-flash": (0.75, 3.75),
    "gemini-3.5-flash": (1.50, 9.00),
    "gemini-3.5-flash-lite": (0.30, 2.50),
    "gemini-3.5-pro": (2.00, 12.0),
    "gemini-3.1-flash-lite": (0.25, 1.50),
    # Live / native audio — paid-tier audio I/O (USD / 1M tokens).
    # https://ai.google.dev/gemini-api/docs/pricing  (Gemini 3.1 Flash Live)
    # Audio input $3.00 · audio output $12.00 (text rates are lower; we bill as audio).
    "gemini-3.1-flash-live-preview": (3.00, 12.0),
    "gemini-3.1-flash-live": (3.00, 12.0),
    "gemini-live-2.5-flash-native-audio": (3.00, 12.0),
    "gemini-2.5-flash-native-audio-preview-12-2025": (3.00, 12.0),
    "gemini-2.5-flash-native-audio-preview-09-2025": (3.00, 12.0),
    "gemini-2.5-flash-native-audio": (3.00, 12.0),
    "gemini-3-flash": (0.50, 3.00),
    "gemini-3-flash-preview": (0.50, 3.00),
    "gemini-3-pro": (2.00, 12.0),
    "gemini-3-pro-preview": (2.00, 12.0),
    # Image models — text I/O rates; image outputs use _IMAGE_FLAT_USD below.
    "gemini-3-pro-image": (2.00, 12.0),
    "gemini-3-pro-image-preview": (2.00, 12.0),
    "gemini-3.1-flash-image": (0.50, 3.00),
    "gemini-2.5-flash-image": (0.30, 2.50),
    # Google Gemini 2.x
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-2.5-pro": (1.25, 10.0),
    "gemini-2.0-flash": (0.10, 0.40),
    "gemini-2.0-flash-lite": (0.075, 0.30),
    "gemini-2.5-flash-lite": (0.10, 0.40),
    "gemini-1.5-flash": (0.075, 0.30),
    "gemini-1.5-pro": (1.25, 5.0),
    # OpenAI
    "gpt-4o": (2.50, 10.0),
    "gpt-4o-mini": (0.15, 0.60),
    "gpt-4.1": (2.0, 8.0),
    "gpt-4.1-mini": (0.40, 1.60),
}

# Family fallbacks when an exact model id isn't listed (longest match wins).
_FAMILY_RATES: list[tuple[str, tuple[float, float]]] = [
    ("gemini-3.7-flash", (0.75, 3.75)),
    ("gemini-3.7", (0.75, 3.75)),
    ("gemini-3.6-flash", (0.75, 3.75)),
    ("gemini-3.6", (0.75, 3.75)),
    ("gemini-3.5-flash-lite", (0.30, 2.50)),
    ("gemini-3.5-flash", (1.50, 9.00)),
    ("gemini-3.5", (1.50, 9.00)),
    ("gemini-3.1-flash-live", (3.00, 12.0)),
    ("gemini-3.1-flash-lite", (0.25, 1.50)),
    ("flash-live", (3.00, 12.0)),
    ("native-audio", (3.00, 12.0)),
    ("gemini-live", (3.00, 12.0)),
    ("gemini-3-flash", (0.50, 3.00)),
    ("gemini-3-pro-image", (2.00, 12.0)),
    ("gemini-3-pro", (2.00, 12.0)),
    ("gemini-3", (0.50, 3.00)),
    ("gemini-2.5-flash-lite", (0.10, 0.40)),
    ("gemini-2.5-flash", (0.30, 2.50)),
    ("gemini-2.5-pro", (1.25, 10.0)),
    ("gemini-2.5", (0.30, 2.50)),
    ("gemini-2.0-flash", (0.10, 0.40)),
    ("gemini-1.5-flash", (0.075, 0.30)),
    ("gemini-1.5-pro", (1.25, 5.0)),
    ("gemini-flash", (0.30, 2.50)),
    ("gemini-pro", (1.25, 10.0)),
    ("gemini", (0.30, 2.50)),
    ("gpt-4o-mini", (0.15, 0.60)),
    ("gpt-4o", (2.50, 10.0)),
    ("gpt-4.1-mini", (0.40, 1.60)),
    ("gpt-4.1", (2.0, 8.0)),
    ("gpt-4", (2.50, 10.0)),
]

# Flat USD per generated image when kind=image (or model name has "image") and
# the caller didn't count image output tokens (common for Nano Banana).
# ~1K/2K Gemini 3 Pro Image ≈ $0.134.
_IMAGE_FLAT_USD: dict[str, float] = {
    "gemini-3-pro-image": 0.134,
    "gemini-3-pro-image-preview": 0.134,
    "gemini-3.1-flash-image": 0.067,
    "gemini-2.5-flash-image": 0.039,
}
_IMAGE_FLAT_DEFAULT = 0.134


def _ensure_schema() -> None:
    conn = _connect()
    with _lock:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS usage_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                ts           REAL,
                provider     TEXT,
                model        TEXT,
                kind         TEXT,
                in_tokens    INTEGER,
                out_tokens   INTEGER,
                cost_usd     REAL,
                job_id       TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_job ON usage_events(job_id)")
        conn.commit()


def _normalize_model(model: str) -> str:
    return re.sub(r"\s+", "", (model or "").strip().lower())


def _rate_for(model: str) -> tuple[float, float]:
    """Return (input_rate, output_rate) USD per 1M tokens for ``model``.

    Order: explicit .env override -> exact default -> family prefix -> zero.
    """
    from .config import get_settings

    key = _normalize_model(model)
    if not key:
        return (0.0, 0.0)

    overrides = get_settings().cost_rate_map()
    if key in overrides:
        return overrides[key]
    for name, rate in overrides.items():
        if key.startswith(name) or name.startswith(key):
            return rate

    if key in _DEFAULT_RATES:
        return _DEFAULT_RATES[key]
    for name, rate in _DEFAULT_RATES.items():
        if key.startswith(name) or name.startswith(key):
            return rate

    for prefix, rate in sorted(_FAMILY_RATES, key=lambda x: len(x[0]), reverse=True):
        if prefix in key:
            return rate
    return (0.0, 0.0)


def _image_flat_for(model: str) -> float:
    key = _normalize_model(model)
    for name, usd in _IMAGE_FLAT_USD.items():
        if name in key or key.startswith(name):
            return usd
    if "image" in key:
        return _IMAGE_FLAT_DEFAULT
    return 0.0


def estimate_cost(
    *,
    provider: str,
    model: str,
    kind: str = "text",
    in_tokens: int = 0,
    out_tokens: int = 0,
) -> float:
    """Estimate USD cost for one call (0 for ollama / unknown free local)."""
    if (provider or "").lower() == "ollama":
        return 0.0
    it = max(0, int(in_tokens or 0))
    ot = max(0, int(out_tokens or 0))
    in_rate, out_rate = _rate_for(model)
    cost = (it / 1_000_000) * in_rate + (ot / 1_000_000) * out_rate
    # Image generations often report 0 output tokens — charge a flat per image.
    kind_l = (kind or "").lower()
    model_l = _normalize_model(model)
    if kind_l in ("image", "img", "thumbnail") or "image" in model_l:
        if ot <= 0:
            cost += _image_flat_for(model)
    return round(cost, 6)


def estimate_tokens(text: str) -> int:
    """Rough token estimate (~4 chars/token) when a provider reports none."""
    return max(0, round(len(text or "") / 4))


def record(
    *,
    provider: str,
    model: str,
    kind: str = "text",
    in_tokens: int | None = None,
    out_tokens: int | None = None,
    prompt: str = "",
    output: str = "",
    job_id: str = "",
) -> None:
    """Record one usage event. Never raises.

    ``in_tokens``/``out_tokens`` are used when known; otherwise estimated from
    ``prompt``/``output`` length. Local providers (ollama) always cost $0.
    ``job_id`` defaults to the active :func:`job_context` when omitted.
    """
    try:
        _ensure_schema()
        it = int(in_tokens if in_tokens is not None else estimate_tokens(prompt))
        ot = int(out_tokens if out_tokens is not None else estimate_tokens(output))
        cost = estimate_cost(
            provider=provider, model=model, kind=kind, in_tokens=it, out_tokens=ot
        )
        jid = (job_id or get_job_id() or "").strip()
        conn = _connect()
        with _lock:
            conn.execute(
                "INSERT INTO usage_events (ts, provider, model, kind, in_tokens, out_tokens, cost_usd, job_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (time.time(), provider, model, kind, it, ot, cost, jid),
            )
            conn.commit()
    except Exception as e:  # noqa: BLE001 — tracking must never break a run
        log.bind(task="cost").warning(f"usage record failed (ignored): {e}")


def backfill_costs() -> int:
    """Recompute ``cost_usd`` for all rows using current rate tables.

    Returns the number of rows updated. Safe to call from the report endpoint
    so the admin UI reflects new Gemini 3.x rates even for past usage.
    """
    try:
        _ensure_schema()
        conn = _connect()
        with _lock:
            rows = conn.execute(
                "SELECT id, provider, model, kind, in_tokens, out_tokens, cost_usd "
                "FROM usage_events"
            ).fetchall()
            updated = 0
            for r in rows:
                new_cost = estimate_cost(
                    provider=r["provider"] or "",
                    model=r["model"] or "",
                    kind=r["kind"] or "text",
                    in_tokens=r["in_tokens"] or 0,
                    out_tokens=r["out_tokens"] or 0,
                )
                old = float(r["cost_usd"] or 0.0)
                if abs(old - new_cost) > 1e-9:
                    conn.execute(
                        "UPDATE usage_events SET cost_usd = ? WHERE id = ?",
                        (new_cost, r["id"]),
                    )
                    updated += 1
            if updated:
                conn.commit()
                log.bind(task="cost").info(f"backfilled cost on {updated} usage row(s)")
            return updated
    except Exception as e:  # noqa: BLE001
        log.bind(task="cost").warning(f"cost backfill failed: {e}")
        return 0


def _job_labels(job_ids: list[str]) -> dict[str, dict]:
    """Map job_id -> {title, filename, status} from the jobs table."""
    ids = [j for j in job_ids if j]
    if not ids:
        return {}
    out: dict[str, dict] = {}
    # Synthetic topic-prep sessions (not in jobs table).
    real_ids: list[str] = []
    for jid in ids:
        if str(jid).startswith("topic-prep:"):
            slug = str(jid).split(":", 1)[-1].replace("-", " ")
            out[jid] = {
                "title": f"Topic prep · {slug}",
                "filename": "",
                "status": "prep",
            }
        else:
            real_ids.append(jid)
    if not real_ids:
        return out
    try:
        conn = _connect()
        placeholders = ",".join("?" * len(real_ids))
        with _lock:
            rows = conn.execute(
                f"SELECT id, filename, status, data FROM jobs WHERE id IN ({placeholders})",
                real_ids,
            ).fetchall()
        for r in rows:
            title = ""
            try:
                data = json.loads(r["data"] or "{}")
                content = data.get("content") or {}
                title = (
                    content.get("slide_title")
                    or content.get("title")
                    or (content.get("meta") or {}).get("title")
                    or ""
                )
            except Exception:  # noqa: BLE001
                title = ""
            out[r["id"]] = {
                "title": (title or r["filename"] or r["id"]).strip(),
                "filename": r["filename"] or "",
                "status": r["status"] or "",
            }
    except Exception as e:  # noqa: BLE001
        log.bind(task="cost").warning(f"job label lookup failed: {e}")
    return out


def report(days: int = 30, *, debug: bool = False) -> dict:
    """Aggregate usage for the admin dashboard.

    Returns totals plus per-model, per-job/session, and per-day breakdowns
    for the last ``days``. Recomputes stored $0 / stale costs from the current
    rate table first.
    """
    try:
        backfill_costs()
        _ensure_schema()
        since = time.time() - max(1, days) * 86400
        conn = _connect()
        with _lock:
            total = conn.execute(
                "SELECT COUNT(*) c, COALESCE(SUM(in_tokens),0) it, "
                "COALESCE(SUM(out_tokens),0) ot, COALESCE(SUM(cost_usd),0) cost "
                "FROM usage_events WHERE ts >= ?",
                (since,),
            ).fetchone()
            by_model = conn.execute(
                "SELECT provider, model, COUNT(*) c, COALESCE(SUM(in_tokens),0) it, "
                "COALESCE(SUM(out_tokens),0) ot, COALESCE(SUM(cost_usd),0) cost "
                "FROM usage_events WHERE ts >= ? GROUP BY provider, model "
                "ORDER BY cost DESC, c DESC",
                (since,),
            ).fetchall()
            by_job = conn.execute(
                "SELECT COALESCE(NULLIF(TRIM(job_id), ''), '') AS job_id, "
                "COUNT(*) c, COALESCE(SUM(in_tokens),0) it, "
                "COALESCE(SUM(out_tokens),0) ot, COALESCE(SUM(cost_usd),0) cost, "
                "MAX(ts) AS last_ts, MIN(ts) AS first_ts "
                "FROM usage_events WHERE ts >= ? "
                "AND TRIM(COALESCE(job_id, '')) != '' "
                "GROUP BY COALESCE(NULLIF(TRIM(job_id), ''), '') "
                "ORDER BY last_ts DESC",
                (since,),
            ).fetchall()
            by_job_models = conn.execute(
                "SELECT COALESCE(NULLIF(TRIM(job_id), ''), '') AS job_id, "
                "provider, model, COUNT(*) c, COALESCE(SUM(in_tokens),0) it, "
                "COALESCE(SUM(out_tokens),0) ot, COALESCE(SUM(cost_usd),0) cost "
                "FROM usage_events WHERE ts >= ? "
                "AND TRIM(COALESCE(job_id, '')) != '' "
                "GROUP BY job_id, provider, model "
                "ORDER BY cost DESC, c DESC",
                (since,),
            ).fetchall()
            by_day = conn.execute(
                "SELECT CAST((ts) / 86400 AS INT) * 86400 day, "
                "COUNT(*) c, COALESCE(SUM(cost_usd),0) cost "
                "FROM usage_events WHERE ts >= ? GROUP BY day ORDER BY day DESC",
                (since,),
            ).fetchall()
        labels = _job_labels([r["job_id"] for r in by_job if r["job_id"]])
        models_by_job: dict[str, list] = {}
        for r in by_job_models:
            jid = r["job_id"] or ""
            if not jid:
                continue
            models_by_job.setdefault(jid, []).append(
                {
                    "provider": r["provider"] or "",
                    "model": r["model"] or "",
                    "c": r["c"],
                    "it": r["it"],
                    "ot": r["ot"],
                    "cost": round(r["cost"] or 0.0, 4),
                }
            )
        by_job_out = []
        for r in by_job:
            jid = r["job_id"] or ""
            if not jid:
                continue  # unattributed rows removed from By job / session
            meta = labels.get(jid) or {}
            title = meta.get("title") or jid
            by_job_out.append(
                {
                    "job_id": jid,
                    "title": title,
                    "filename": meta.get("filename") or "",
                    "status": meta.get("status") or "",
                    "c": r["c"],
                    "it": r["it"],
                    "ot": r["ot"],
                    "cost": round(r["cost"] or 0.0, 4),
                    "last_ts": r["last_ts"] or 0,
                    "first_ts": r["first_ts"] or 0,
                    "models": models_by_job.get(jid) or [],
                }
            )
        by_job_out.sort(key=lambda j: float(j.get("last_ts") or 0), reverse=True)
        out: dict = {
            "days": days,
            "calls": total["c"],
            "in_tokens": total["it"],
            "out_tokens": total["ot"],
            "cost_usd": round(total["cost"] or 0.0, 4),
            "by_model": [dict(r) for r in by_model],
            "by_job": by_job_out,
            "by_day": [
                {
                    "day": r["day"],
                    "calls": r["c"],
                    "cost_usd": round(r["cost"] or 0.0, 4),
                }
                for r in by_day
            ],
            "rates_note": "Estimates use current public paid-tier rates; Ollama is $0.",
        }
        if debug:
            with _lock:
                raw = conn.execute(
                    "SELECT ts, provider, model, kind, in_tokens, out_tokens, "
                    "cost_usd, job_id FROM usage_events WHERE ts >= ? "
                    "ORDER BY ts DESC LIMIT 250",
                    (since,),
                ).fetchall()
            out["debug_events"] = [dict(r) for r in raw]
        return out
    except Exception as e:  # noqa: BLE001
        log.bind(task="cost").warning(f"usage report failed: {e}")
        return {
            "days": days,
            "calls": 0,
            "in_tokens": 0,
            "out_tokens": 0,
            "cost_usd": 0.0,
            "by_model": [],
            "by_job": [],
            "by_day": [],
        }
