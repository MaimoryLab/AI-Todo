#!/usr/bin/env python3
"""Optional LangExtract sidecar for AI Todo extraction.

Reads JSON from stdin and writes {"todos": [...]} to stdout. If langextract or
its model config is unavailable, exit non-zero so TypeScript can fall back to
the existing rules extractor.
"""

from __future__ import annotations

import json
import os
import sys
import textwrap

DEFAULT_MODEL = "deepseek/deepseek-v4-pro"
DEFAULT_PROVIDER = "openai"
DEFAULT_BASE_URL = "https://api.novita.ai/openai/v1"
LEGACY_MODELS = {"pa/gpt-5.5"}


PROMPT = textwrap.dedent(
    """\
    Extract actionable todos from AI agent session text.
    Extract only explicit next actions, follow-ups, failed validations, blocked
    work, in-progress work, and completed work. Ignore background summaries,
    generic facts, read-only tool traces, and anything without a source quote.
    Use exact source text as extraction_text. Put fields in attributes:
    title, description, confidence, timeBucket, typeBucket, dedupeKey.
    title must be a short human-readable action summary. Never use raw command
    JSON, file paths, screenshots, toolUseId/call IDs, shell flags, logs, or
    truncated trace fragments as title. If the only source text is a tool log,
    command payload, path, or JSON object, do not extract a todo.
    timeBucket must be current, recent, or history.
    typeBucket must be pending, to_start, follow_up, in_progress, done, or processing.
    """
)


def load_langextract():
    try:
        import langextract as lx  # type: ignore

        return lx
    except Exception as exc:  # pragma: no cover - exercised by TS fallback
        raise SystemExit(f"langextract unavailable: {exc}") from exc


def model_id_from_env() -> str:
    model = (os.environ.get("LANGEXTRACT_MODEL") or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL).strip()
    return DEFAULT_MODEL if model in LEGACY_MODELS else model


def extract_kwargs(lx, model_id: str, model_config_cls=None) -> dict:
    provider = os.environ.get("LANGEXTRACT_PROVIDER", DEFAULT_PROVIDER).strip().lower()
    if provider in ("", "novita", "deepseek"):
        provider = DEFAULT_PROVIDER
    api_key = os.environ.get("LANGEXTRACT_API_KEY", "").strip()
    base_url = os.environ.get("LANGEXTRACT_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL
    thinking_depth = os.environ.get("LANGEXTRACT_THINKING_DEPTH", "medium").strip()
    params = {
        "extraction_passes": int(os.environ.get("LANGEXTRACT_PASSES", "2")),
        "max_workers": int(os.environ.get("LANGEXTRACT_MAX_WORKERS", "4")),
        "max_char_buffer": int(os.environ.get("LANGEXTRACT_MAX_CHAR_BUFFER", "1600")),
    }
    if provider == "openai":
        if not api_key:
            raise SystemExit("LANGEXTRACT_API_KEY is required for LANGEXTRACT_PROVIDER=openai")
        if model_config_cls is None:
            from langextract.factory import ModelConfig as model_config_cls  # type: ignore

        provider_kwargs = {"api_key": api_key}
        if base_url:
            provider_kwargs["base_url"] = base_url
        if thinking_depth:
            provider_kwargs["reasoning_effort"] = thinking_depth
        params["config"] = model_config_cls(
            model_id=model_id,
            provider="openai",
            provider_kwargs=provider_kwargs,
        )
        params["use_schema_constraints"] = False
    else:
        params["model_id"] = model_id
    return params


def main() -> int:
    payload = json.load(sys.stdin)
    blocks = payload.get("blocks") or []
    if not isinstance(blocks, list) or not blocks:
        print(json.dumps({"todos": []}, ensure_ascii=False))
        return 0

    lx = load_langextract()
    text = "\n\n".join(
        f"[obs:{b.get('sourceObservationId','')}]\n{b.get('text','')}"
        for b in blocks
        if isinstance(b, dict) and b.get("text")
    )
    if not text.strip():
        print(json.dumps({"todos": []}, ensure_ascii=False))
        return 0

    examples = [
        lx.data.ExampleData(
            text="[obs:obs_1]\n后续需要修复 CI 失败，并重新跑测试。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="后续需要修复 CI 失败，并重新跑测试",
                    attributes={
                        "title": "修复 CI 失败并重新跑测试",
                        "description": "后续需要修复 CI 失败，并重新跑测试。",
                        "confidence": 0.9,
                        "timeBucket": "current",
                        "typeBucket": "follow_up",
                        "dedupeKey": "fix-ci-rerun-tests",
                    },
                )
            ],
        )
    ]
    model_id = model_id_from_env()
    result = lx.extract(
        text_or_documents=text,
        prompt_description=PROMPT,
        examples=examples,
        **extract_kwargs(lx, model_id),
    )

    todos = []
    for item in getattr(result, "extractions", []):
        if getattr(item, "extraction_class", "") != "todo":
            continue
        quote = getattr(item, "extraction_text", "") or ""
        attrs = getattr(item, "attributes", {}) or {}
        interval = getattr(item, "char_interval", None)
        if not quote or interval is None:
            continue
        start = getattr(interval, "start_pos", None)
        end = getattr(interval, "end_pos", None)
        prefix = text[: start if isinstance(start, int) else text.find(quote)]
        obs_marker = prefix.rsplit("[obs:", 1)[-1].split("]", 1)[0] if "[obs:" in prefix else ""
        title = attrs.get("title")
        if not title:
            # No model-provided title → skip rather than emit a hard-cut
            # quote slice (which produced mid-sentence fragment cards).
            continue
        todos.append(
            {
                "title": title,
                "description": attrs.get("description") or quote,
                "confidence": attrs.get("confidence", 0.6),
                "timeBucket": attrs.get("timeBucket", "recent"),
                "typeBucket": attrs.get("typeBucket", "pending"),
                "sourceSessionId": payload.get("sessionId"),
                "evidence": {
                    "sourceObservationId": obs_marker,
                    "quote": quote,
                    "charStart": start,
                    "charEnd": end,
                },
                "dedupeKey": attrs.get("dedupeKey") or "",
            }
        )

    print(json.dumps({"todos": todos}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if os.environ.get("LANGEXTRACT_SELF_TEST") == "1":
        os.environ.setdefault("LANGEXTRACT_API_KEY", "self-test-key")

        class DummyConfig:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)

        class DummyFactory:
            ModelConfig = DummyConfig

        class DummyLx:
            factory = DummyFactory

        params = extract_kwargs(DummyLx, model_id_from_env(), DummyConfig)
        config = params.get("config")
        assert config.model_id == "deepseek/deepseek-v4-pro"
        assert config.provider == "openai"
        assert config.provider_kwargs["base_url"] == "https://api.novita.ai/openai/v1"
        assert config.provider_kwargs["reasoning_effort"] == "medium"
        assert params["use_schema_constraints"] is False
        params = extract_kwargs(DummyLx, "custom/openai-compatible-model", DummyConfig)
        assert params["use_schema_constraints"] is False
        print("ok")
        raise SystemExit(0)
    raise SystemExit(main())
