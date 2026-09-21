"""Application configuration loaded from environment / .env file."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any

from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_DIR = BASE_DIR / "workspace"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ---------------------------------------------------------------- LLM ----
    # Which LLM backend to use for text generation + vision extraction.
    #   "gemini"           -> Google Gemini cloud API (needs gemini_api_key)
    #   "ollama"           -> local Ollama server (OpenAI-compatible, no key)
    #   "openai"           -> OpenAI or any OpenAI-compatible endpoint
    # "auto" picks Gemini when a key is set, otherwise Ollama if reachable.
    llm_provider: str = "auto"

    # --- Gemini (cloud) ---
    gemini_api_key: str = ""
    # Workhorse for slides / VLM / cron ([Gemini 3.7 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash)).
    gemini_model: str = "gemini-3.7-flash"
    gemini_vision_model: str = "gemini-3.7-flash"
    # Cheap model for trending-topic / content prep (not slide authoring).
    # Prefer current Flash-Lite GA ids; 2.0-flash-lite was retired mid-2026.
    gemini_lite_model: str = "gemini-3.5-flash-lite"
    # Interview Prep: VLM + content prep on Flash-Lite (cheap). Empty = gemini_lite_model.
    interview_vlm_model: str = ""
    # Gemini Live model for mock interviews + C.H.I.T.T.I. voice (full-duplex audio).
    # Primary (GenAI SDK get-started): gemini-3.1-flash-live-preview
    # https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
    # Fallbacks: gemini-live-2.5-flash-native-audio, native-audio-preview-*
    # Override with INTERVIEW_LIVE_MODEL / CHITTI_LIVE_MODEL.
    interview_live_model: str = "gemini-3.1-flash-live-preview"
    # Empty = same as interview_live_model.
    chitti_live_model: str = ""
    # Gemini Live prebuilt voice for mock interviews + C.H.I.T.T.I.
    # Female: Aoede, Kore, Leda, Zephyr. Male: Puck, Charon, Fenrir, Orus.
    gemini_live_voice: str = "Aoede"
    # Gemini embedding model for sqlite-vec semantic search (Interview Prep).
    gemini_embedding_model: str = "text-embedding-004"
    gemini_embedding_dims: int = 768
    # Nano Banana Pro — thumbnail IMAGE generation ONLY (never used for slides/content).
    # See https://ai.google.dev/gemini-api/docs/image-generation
    gemini_image_model: str = "gemini-3-pro-image"

    # --- Ollama (local) ---
    # Ollama exposes an OpenAI-compatible API at /v1. gemma4:12b is multimodal
    # (text + vision), so the same model can serve text and image extraction.
    ollama_base_url: str = "http://localhost:11434/v1"
    ollama_model: str = "gemma4:12b"
    ollama_vision_model: str = "gemma4:12b"
    # Ollama defaults to a 2048-token context which truncates long prompts and
    # yields short/empty lessons. Raise the context window and allow a long
    # completion so full multi-slide JSON comes back. (Larger num_ctx uses more
    # VRAM but is needed for long lessons + JSON output.)
    ollama_num_ctx: int = 16384
    ollama_max_tokens: int = 8192

    # --- Resilience & concurrency (all providers) ---
    # Transient failures (rate limits, timeouts, a flaky local model returning
    # empty/garbled JSON) are retried with exponential backoff instead of
    # breaking the run. These apply to every LLM/VLM call.
    llm_max_retries: int = 3
    llm_retry_base_delay: float = 1.5
    llm_timeout_seconds: float = 600.0
    # Max LLM/VLM calls to run at once. Cloud APIs happily parallelise; a local
    # Ollama serving one model does NOT benefit from many concurrent requests
    # (they queue and can OOM), so keep this small — it is additionally clamped
    # to 1 for Ollama at call time. 0 = auto (based on provider).
    llm_max_parallel: int = 4
    # VLM page extraction: process the document in small page-groups so a local
    # multimodal model isn't handed a huge multi-image prompt (slow, truncates,
    # or OOMs). Groups are generated in parallel (subject to llm_max_parallel).
    vlm_pages_per_call: int = 2

    # --- OpenAI / other OpenAI-compatible vendors ---
    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"
    openai_vision_model: str = "gpt-4o-mini"

    @property
    def active_provider(self) -> str:
        """Resolve "auto" to a concrete provider based on configuration."""
        p = (self.llm_provider or "auto").strip().lower()
        if p in {"gemini", "ollama", "openai"}:
            return p
        # auto: prefer Gemini if a key is present, else local Ollama.
        return "gemini" if self.gemini_api_key else "ollama"

    @property
    def llm_text_model(self) -> str:
        return {
            "gemini": self.gemini_model,
            "ollama": self.ollama_model,
            "openai": self.openai_model,
        }[self.active_provider]

    @property
    def llm_vision_model(self) -> str:
        return {
            "gemini": self.gemini_vision_model,
            "ollama": self.ollama_vision_model,
            "openai": self.openai_vision_model,
        }[self.active_provider]

    def effective_llm_parallel(self) -> int:
        """Concurrency limit for LLM/VLM fan-out.

        A single local Ollama instance serialises requests internally and can
        run out of VRAM under concurrency, so cap it at 1. Cloud providers get
        the configured limit (or a sensible default).
        """
        if self.active_provider == "ollama":
            return 1
        n = int(self.llm_max_parallel or 0)
        return n if n > 0 else 4

    # --- Authentication (invite-only) ---
    # Bootstrap admin is controlled by AUTH_ADMIN_* in .env (synced on startup).
    # Registration is invite-only: visitors request an invite, an admin approves
    # it from the dashboard, and only then can that email set a password.
    auth_admin_email: str = "macharlasaiteja@gmail.com"
    auth_admin_username: str = "admin"
    auth_admin_password: str = "saiteja"
    # Secret used to sign session cookies. Change in production via .env.
    auth_secret_key: str = "change-me-multimodal-studio-secret"
    # Session lifetime in hours (only when AUTH_SESSION_PERSISTENT=true).
    auth_session_hours: int = 720
    # When false (default), the session cookie is cleared when the browser/app
    # closes and the user must sign in again on the next visit.
    auth_session_persistent: bool = False

    @field_validator(
        "auth_admin_email",
        "auth_admin_username",
        "auth_admin_password",
        "auth_secret_key",
        mode="before",
    )
    @classmethod
    def _blank_auth_keeps_default(cls, v: Any, info: ValidationInfo) -> Any:
        """Empty AUTH_* in .env must not wipe defaults (Pydantic treats '' as set)."""
        defaults = {
            "auth_admin_email": "macharlasaiteja@gmail.com",
            "auth_admin_username": "admin",
            "auth_admin_password": "saiteja",
            "auth_secret_key": "change-me-multimodal-studio-secret",
        }
        if v is None or (isinstance(v, str) and not v.strip()):
            return defaults[info.field_name]
        return v.strip() if isinstance(v, str) else v

    # --- Cost tracking (admin only) ---
    # Estimated $ cost of LLM/paid-API usage is derived from per-model rates.
    # Provide overrides as a comma-separated list of
    #   model=INPUT_RATE/OUTPUT_RATE   (USD per 1M tokens),
    # e.g. "gemini-2.5-flash=0.30/2.50,gpt-4o-mini=0.15/0.60". Unknown models
    # fall back to built-in defaults, then to $0 (treated as free/local).
    cost_rates: str = ""

    # --- Voice library limits (saved cloned voices per account) ---
    voice_limit_user: int = 10
    voice_limit_admin: int = 30

    def cost_rate_map(self) -> dict[str, tuple[float, float]]:
        """Parse ``cost_rates`` into {model: (in_rate, out_rate)}."""
        out: dict[str, tuple[float, float]] = {}
        for part in (self.cost_rates or "").split(","):
            part = part.strip()
            if not part or "=" not in part:
                continue
            model, _, rates = part.partition("=")
            try:
                in_s, _, out_s = rates.partition("/")
                out[model.strip().lower()] = (float(in_s), float(out_s or in_s))
            except (TypeError, ValueError):
                continue
        return out

    youtube_client_secrets: str = "client_secrets.json"
    youtube_privacy: str = "unlisted"
    # Public https origin of this app (no trailing slash). Required for Instagram
    # Graph API to fetch staged carousel/video URLs under /files/{job}/….
    public_base_url: str = ""

    # --- Publish metadata + thumbnail generation ---
    # Auto-generate a YouTube title/description/tags (via the active LLM) and a
    # thumbnail image before upload. Both are best-effort: if they fail the flow
    # continues with a sensible fallback and a message is surfaced.
    generate_thumbnail: bool = True
    # Optional Pillow title overlay (unused for Nano Banana which renders text).
    thumbnail_text_overlay: bool = True
    # Thumbnail image backend:
    #   "nano_banana" / "gemini" / "auto" -> Gemini Nano Banana Pro (cloud).
    #   Thumbnail-only — never used for slide/content gen.
    #   "off" / "none" -> skip AI thumbnail (slide-frame fallback may still apply).
    # Local diffusion (Boogu etc.) removed for now — re-add later as optional.
    thumbnail_backend: str = "auto"
    # Experimental: AI images inside slides (UI default off until validated).
    slide_ai_images_default: bool = False

    # PDF page -> image rendering resolution for VLM extraction.
    vlm_dpi: int = 150
    vlm_max_pages: int = 15

    capture_duration: int = 20
    capture_fps: int = 24

    # Output video quality tier: "1080p" (1920x1080), "2k"/"1440p" (2560x1440),
    # or "4k" (3840x2160). Vertical formats scale to the matching short edge.
    # Slides are laid out at a logical 1080-line canvas and captured at a higher
    # device pixel ratio so text/vectors stay razor-sharp when scaled up.
    video_quality: str = "2k"
    # x264 constant-rate-factor (lower = better quality/larger file; 18-23 sane).
    video_crf: int = 20
    # Encode speed. "slow" looks marginally better but makes long (8‑min) merges
    # crawl across dozens of slide segments — use medium as the studio default.
    video_preset: str = "medium"

    # Animation mode for slide capture:
    #   "animated" -> deterministic frame-by-frame seek capture (real in-slide
    #                 motion driven by the page's frame timeline; slower render).
    #   "still"    -> one screenshot per slide (fastest; motion only via
    #                 crossfades between slides).
    animation_mode: str = "animated"
    # Seconds of entrance motion captured frame-by-frame per slide. After this
    # window the slide is static, so we capture ONE settled frame and let ffmpeg
    # hold it for the rest of the narration — this keeps real motion while
    # cutting the screenshot count from thousands to a few dozen per slide.
    motion_seconds: float = 2.0
    # Frames per second used for the seek-captured motion window. Lower than the
    # final video fps because entrance + highlight transitions read fine at a
    # modest rate, and every extra fps multiplies the screenshot count. The final
    # video is still encoded at capture_fps; ffmpeg upsamples the held frames.
    motion_fps: int = 24
    # When True the item highlight (active bullet/step/stat) walks through the
    # slide IN TIME with the narration: the whole slide duration is seek-captured
    # at motion_fps so on-screen focus stays synced to what's being explained.
    # When False only the short entrance window is captured (faster, no walk).
    sync_highlight: bool = True
    # Max PNG screenshots per slide during animated capture. When the narration-
    # synced timeline would exceed this, only entrance + highlight-transition
    # keyframes are captured (timing is preserved via keyframes.json).
    max_motion_frames: int = 144
    # How many Playwright worker processes capture slides in parallel. Slides are
    # split into this many disjoint batches, each rendered in its own browser,
    # then the segments are assembled. 0 = auto (based on CPU count).
    capture_workers: int = 0

    # Text-to-speech engine: "kokoro" (offline neural) or "gtts" (online).
    # "auto" prefers Kokoro when its model files are available, else gTTS.
    tts_engine: str = "auto"
    # Kokoro voice. A single voice (e.g. af_heart, af_nicole, am_michael) OR a
    # weighted blend written as "name:weight" pairs (e.g.
    # "af_nicole:80,am_michael:20" for a female narrator with male depth).
    # Default is af_heart, the grade-A voice best suited to natural long-form
    # narration.
    kokoro_voice: str = "af_heart"
    kokoro_lang: str = "en-us"
    kokoro_speed: float = 1.0
    # Kokoro ONNX model + voices files (downloaded into models/ on first use,
    # and again at process startup when tts_warmup_on_startup is true).
    kokoro_model_path: str = "models/kokoro-v1.0.onnx"
    kokoro_voices_path: str = "models/voices-v1.0.bin"
    # Pre-download + load free engines (Kokoro + Pocket) in a background thread
    # so the first narration / voices UI hit is fast.
    tts_warmup_on_startup: bool = True

    # --- Supertonic 3 (opt-in voice cloning) ---
    # Used only when a job supplies a voice style (a Voice Builder style JSON
    # or a preset name). Otherwise Kokoro remains the default engine.
    supertonic_lang: str = "en"
    # Preset voice used when Supertonic is requested without a full style file
    # (or when a style JSON fails to load).
    supertonic_default_style: str = "M1"
    # Optional: build Supertonic style JSON from a saved recording automatically.
    # POST multipart WAV → JSON with style_ttl + style_dp.
    voice_style_builder_url: str = ""
    # Optional shell command: {input}=recording.wav, {output}=style.json path.
    voice_style_builder_cmd: str = ""
    # Optional Supertone cloud API key — clones via POST /v1/custom-voices/cloned-voice.
    supertone_api_key: str = ""
    # Local clone quality: spectral preset match + style_ttl search (CPU).
    voice_clone_optimize_enabled: bool = True
    voice_clone_optimize_steps: int = 48

    # --- Kyutai Pocket TTS (https://github.com/kyutai-labs/pocket-tts) ---
    # CPU-friendly neural TTS with built-in voices + wav cloning (.safetensors).
    pocket_tts_language: str = "english"
    pocket_tts_default_voice: str = "jane"
    pocket_tts_temp: float | None = None

    @property
    def kokoro_model_file(self) -> Path:
        p = Path(self.kokoro_model_path)
        return p if p.is_absolute() else BASE_DIR / p

    @property
    def kokoro_voices_file(self) -> Path:
        p = Path(self.kokoro_voices_path)
        return p if p.is_absolute() else BASE_DIR / p

    @property
    def youtube_secrets_path(self) -> Path:
        p = Path(self.youtube_client_secrets)
        return p if p.is_absolute() else BASE_DIR / p

    # ===================================================== paper automation ====
    # Built-in "paper -> video" automation. Runs in-process (reuses the same
    # pipeline the UI uses) so it never needs to call the app over HTTP. The
    # admin controls it from the dashboard; it can also run on a schedule.
    # Master switch for the background scheduler (manual trigger always works).
    auto_enabled: bool = False
    # Paper source:
    #   "trending" / "auto" -> HF Daily Papers + arXiv GenAI + Semantic Scholar
    #   "hf"                -> Hugging Face Daily Papers only
    #   "arxiv"             -> arXiv Atom API
    #   "semantic_scholar"  -> Semantic Scholar bulk search
    auto_source: str = "trending"
    auto_arxiv_categories: str = "cs.LG,cs.CL,cs.CV,cs.AI,cs.NE,stat.ML"
    # Extra arXiv abs/ti keyword clause (GenAI-focused). Empty = built-in defaults.
    auto_arxiv_keywords: str = ""
    auto_ss_query: str = (
        "large language model OR multimodal OR diffusion OR generative AI "
        "OR vision language OR agentic OR RLHF"
    )
    auto_ss_api_key: str = ""
    # Only keep papers that reference a code repo (keeps the "with code" spirit).
    # When none match, the engine falls back to newest PDF with a log note.
    auto_require_code: bool = True
    # How many papers to process per run (preview UI shows the same queue, up to 3).
    auto_max_papers: int = 3
    # Outputs per paper.
    auto_make_video: bool = True
    auto_video_format: str = "youtube_video"
    auto_video_seconds: int = 480  # 8 min default for cron papers
    # Reels/Instagram are a manual Studio format choice — cron/automation renders
    # long-form video only so one paper does not spawn two History jobs.
    auto_make_reel: bool = False
    auto_reel_format: str = "instagram_reels"
    auto_reel_seconds: int = 45
    auto_video_theme: str = "snow"
    auto_video_style: str = "whiteboard"  # Teach · board
    # Free narration for cron jobs (Pocket catalog id, else Kokoro preset).
    auto_pocket_voice: str = "jane"
    auto_voice_preset: str = ""
    # Generate a thumbnail into the paper output folder after each render.
    auto_generate_thumbnail: bool = True
    # Push to YouTube after render (only if client_secrets.json is present).
    auto_publish: bool = False
    # Root folder for per-paper output folders.
    auto_output_dir: str = "automation_output"
    # --- schedule: run twice a day in non-working hours ---
    # Comma-separated hours-of-day (0-23). Default 01:00 & 19:00 stay outside
    # the 9–18 working-hours block (13:00 was previously blocked by that window).
    auto_run_hours: str = "1,19"
    # Working-hours window to AVOID auto-runs in (inclusive start, exclusive end).
    auto_work_start_hour: int = 9
    auto_work_end_hour: int = 18
    # --- compute gating (only run when the machine is free) ---
    auto_compute_gate: bool = True
    auto_max_load: float = 0.85
    auto_min_gpu_free_mb: int = 0
    auto_compute_wait_seconds: int = 1800

    # --- Topic web research ("Add topics" in More options) ---
    # When the user lists extra topics, we scrape/search the public web and
    # inject fresh facts/examples into slide generation. Free backends
    # (DuckDuckGo via ``ddgs``, Wikipedia, Jina Reader) always run; optional
    # API keys below are raced first for speed/quality when present.
    topic_research_enabled: bool = True
    topic_research_max_results: int = 4
    topic_research_fetch_pages: int = 2
    topic_research_timeout: float = 8.0
    brave_api_key: str = ""
    tavily_api_key: str = ""
    serper_api_key: str = ""

    @property
    def auto_output_path(self) -> Path:
        p = Path(self.auto_output_dir)
        return p if p.is_absolute() else BASE_DIR / p


@lru_cache
def get_settings() -> Settings:
    return Settings()
