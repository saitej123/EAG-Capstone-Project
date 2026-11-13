"""Modal deployment entrypoint for Multimodal Studio (workspace: macharlasaiteja).

Deploy:
    modal secret create multimodal-studio-env --from-dotenv .env --force
    modal deploy modal_app.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import modal

APP_NAME = "multimodal-studio"
ROOT = Path(__file__).resolve().parent

# Filter desktop-only CUA dependencies not used in headless cloud containers.
# Only read requirements.txt locally at image-build time (not inside container).
_EXCLUDED_PKGS = ("cua>=", "cua-agent>=")
_REQ_FILE = ROOT / "requirements.txt"
_REQS = (
    [
        line.strip()
        for line in _REQ_FILE.read_text(encoding="utf-8").splitlines()
        if line.strip()
        and not line.strip().startswith("#")
        and not line.strip().startswith(_EXCLUDED_PKGS)
    ]
    if _REQ_FILE.is_file()
    else []
)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install(
        "ffmpeg",
        "curl",
        "ca-certificates",
        "libglib2.0-0",
        "libnss3",
        "libnspr4",
        "libdbus-1-3",
        "libatk1.0-0",
        "libatk-bridge2.0-0",
        "libcups2",
        "libdrm2",
        "libxkbcommon0",
        "libxcomposite1",
        "libxdamage1",
        "libxfixes3",
        "libxrandr2",
        "libgbm1",
        "libpango-1.0-0",
        "libcairo2",
        "libasound2",
        "fonts-dejavu-core",
        "fonts-liberation",
    )
    .env(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
            "PLAYWRIGHT_BROWSERS_PATH": "/app/.playwright-browsers",
            "PYTHONPATH": "/app",
        }
    )
    .pip_install(*_REQS)
    .run_commands("playwright install chromium")
    .add_local_dir(str(ROOT / "app"), remote_path="/app/app")
    .add_local_dir(str(ROOT / "frontend"), remote_path="/app/frontend")
    .add_local_dir(str(ROOT / "pitch"), remote_path="/app/pitch")
    .add_local_dir(str(ROOT / "docs"), remote_path="/app/docs")
)

workspace_vol = modal.Volume.from_name(
    "multimodal-studio-workspace", create_if_missing=True
)
models_vol = modal.Volume.from_name(
    "multimodal-studio-models", create_if_missing=True
)

app = modal.App(APP_NAME, image=image)


@app.function(
    cpu=4.0,
    memory=4096,
    timeout=1800,
    max_containers=1,
    scaledown_window=300,
    volumes={
        "/app/workspace": workspace_vol,
        "/app/models": models_vol,
    },
    secrets=[modal.Secret.from_name("multimodal-studio-env")],
)
@modal.concurrent(max_inputs=32)
@modal.asgi_app()
def web():
    # Ensure /app is the working root and importable as package parent.
    if "/app" not in sys.path:
        sys.path.insert(0, "/app")
    os.chdir("/app")

    # Point local Ollama check off when running in cloud unless overridden.
    os.environ.setdefault("AUTO_ENABLED", "false")
    os.environ.setdefault("AUTH_DEMO_ENABLED", "true")

    from app.main import app as fastapi_app

    return fastapi_app
