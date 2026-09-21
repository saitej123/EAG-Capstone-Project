"""Backwards-compatible shim.

The LLM layer is now provider-agnostic and lives in :mod:`llm_client` (Gemini,
Ollama, or any OpenAI-compatible vendor, selected via ``LLM_PROVIDER`` in
``.env``). This module is kept so existing ``from . import gemini_client``
imports continue to work.
"""
from __future__ import annotations

from .llm_client import generate_from_images, generate_text, parallel_map

__all__ = ["generate_text", "generate_from_images", "parallel_map"]
