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

DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
DEFAULT_PROVIDER = "openai"
DEFAULT_BASE_URL = "https://api.novita.ai/openai/v1"
LEGACY_MODELS = {"pa/gpt-5.5"}


PROMPT = textwrap.dedent(
    """\
    Extract mature, user-facing todo cards from AI agent session text.
    When refreshAction metadata is provided, use it as advisory context about the
    existing card. Prefer a clearer title/description suggested by cleanup
    metadata only when the nearby source quote supports it.
    Extract only UNRESOLVED, actionable items: explicit next actions, follow-ups,
    failed validations, blocked work, and in-progress work that still needs doing.
    DO NOT extract completed work, results, status reports, confirmations, or
    narration of what was already done (e.g. "…已通过", "…都能显示", "确认…完成").
    Ignore background summaries, generic facts, read-only tool traces, transient
    agent process narration, and anything without a source quote.
    Use exact source text as extraction_text. Put fields in attributes:
    title, description, confidence, timeBucket, typeBucket, dedupeKey.
    The generated card must read like a mature todo app item, not a transcript
    snippet. title must be a CRISP, SCANNABLE user-facing action summary — a
    concrete verb + the semantic object (+ the concrete target/outcome when it
    adds signal), so the title alone makes clear what THIS todo is. Preserve the
    source language unless the source itself mixes languages. Keep it short, but
    do not drop the user-relevant object or constraint just to hit a character
    target.
    Precise technical identifiers must be preserved, but they should usually go
    in description rather than the title when they are long: branch names,
    commit hashes, file paths, URLs, session ids, package names, and raw repos.
    Prefer title "推送当前工作分支到远程仓库" with description
    "分支：codex/todo-cleanup-flash-model。" over title
    "推送 codex/todo-cleanup-flash-model 分支到远程仓库".
    A good title may contain tightly related steps when they serve one outcome,
    e.g. "修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染".
    description must be one concise sentence about the remaining user-relevant
    work; do not start with "I will / 我会 / 现在 / 接下来".
    DO NOT pad with vague filler such as
    "全面了解 / 了解现状 / 梳理现状 / 获取信息 / 进行 / 处理" — name the actual thing
    (the repo, the file, the bug, the command's purpose), not the process of
    "understanding" it. Prefer "克隆 AI-Todo 仓库" over "克隆仓库并全面了解其状况".
    Do NOT turn agent workflow/status chores into todos unless a durable user
    outcome remains. Examples to skip: "做最后一次状态确认", "启动后做健康检查",
    "确认工作区干净", "服务可用", "健康检查已完成", "重启后再测一次" when it is just
    suggested procedure or stale troubleshooting, and "我会/接下来/现在确认…".
    Negative example: source text "我会做最后一次状态确认，确保工作区干净、当前分支和 PR 链接明确。服务可用，健康检查已完成。"
    should produce no todo.
    If text might be useful but is ambiguous or process-like, set confidence
    below the direct-create threshold (0.55-0.81) so it goes to human review.
    dedupeKey must be a short STABLE slug of the core action+object (e.g.
    clone-aitodo-repo, read-project-config), the SAME for two todos that are the
    same task regardless of wording, so reworded duplicates collapse.
    Never use raw command JSON, file paths, screenshots, toolUseId/call IDs,
    shell flags, logs, or truncated trace fragments as title. If the only source
    text is a tool log, command payload, path, or JSON object, do not extract a
    todo.
    Never extract dangling/truncated titles such as
    "准备推送分支 codex/todo-cleanup-flash-model 到"; if context cannot repair
    them into a complete, supported action, produce no todo.
    Never extract tool-call echo lines (starting with ⏺ or containing Bash(/Shell(),
    service-status reports (e.g. "服务可用", "Viewer:"/"Health:" URL lists), or
    git-ref fragments — these are not todos.
    timeBucket must be current, recent, or history.
    typeBucket must be pending, to_start, follow_up, in_progress, or processing.
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

    refresh_action = payload.get("refreshAction")
    if isinstance(refresh_action, dict):
        refresh_json = json.dumps(refresh_action, ensure_ascii=False, sort_keys=True)
        text = f"[refreshAction]\n{refresh_json}\n\n{text}"

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
        ),
        lx.data.ExampleData(
            text="[obs:obs_2]\n我会先确认工作区状态，然后把远程仓库 MaimoryLab/AI-Todo 克隆到子目录，再从 Git 元数据、依赖和测试入口梳理现状。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="把远程仓库 MaimoryLab/AI-Todo 克隆到子目录",
                    attributes={
                        "title": "克隆 AI-Todo 仓库到子目录",
                        "description": "把 MaimoryLab/AI-Todo 克隆到子目录，避免与外层 Git 状态混在一起。",
                        "confidence": 0.85,
                        "timeBucket": "current",
                        "typeBucket": "to_start",
                        "dedupeKey": "clone-aitodo-repo",
                    },
                )
            ],
        ),
        lx.data.ExampleData(
            text="[obs:obs_3]\n接下来我会读项目结构、README、包管理文件和环境配置样例，再补一层远程 GitHub 元数据。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="读项目结构、README、包管理文件和环境配置样例",
                    attributes={
                        "title": "读 README 与依赖配置",
                        "description": "读项目结构、README、包管理与环境配置样例，并补远程 GitHub 元数据。",
                        "confidence": 0.8,
                        "timeBucket": "current",
                        "typeBucket": "to_start",
                        "dedupeKey": "read-project-config",
                    },
                )
            ],
        ),
        lx.data.ExampleData(
            text="[obs:obs_4]\n下一步需要修复深色模式按钮对比度，避免主操作在暗色背景下不可读。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="修复深色模式按钮对比度，避免主操作在暗色背景下不可读",
                    attributes={
                        "title": "修复深色模式按钮对比度",
                        "description": "修复深色模式按钮对比度，避免主操作在暗色背景下不可读。",
                        "confidence": 0.9,
                        "timeBucket": "current",
                        "typeBucket": "follow_up",
                        "dedupeKey": "fix-dark-mode-button-contrast",
                    },
                )
            ],
        ),
        lx.data.ExampleData(
            text="[obs:obs_5]\n下一步需要推送 codex/todo-cleanup-flash-model 分支到远程仓库。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="推送 codex/todo-cleanup-flash-model 分支到远程仓库",
                    attributes={
                        "title": "推送当前工作分支到远程仓库",
                        "description": "推送当前工作分支到远程仓库。分支：codex/todo-cleanup-flash-model。",
                        "confidence": 0.88,
                        "timeBucket": "current",
                        "typeBucket": "to_start",
                        "dedupeKey": "push-current-branch",
                    },
                )
            ],
        ),
        lx.data.ExampleData(
            text="[obs:obs_7]\n下一步需要修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染",
                    attributes={
                        "title": "修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染",
                        "description": "修正目录显示文字，去掉重复编号，并更新页码缓存后重渲染。",
                        "confidence": 0.9,
                        "timeBucket": "current",
                        "typeBucket": "follow_up",
                        "dedupeKey": "fix-toc-numbering-rerender",
                    },
                )
            ],
        ),
        lx.data.ExampleData(
            text="[obs:obs_6]\n建议处理顺序：2. 重启 Codex desktop app 后再测一次。",
            extractions=[
                lx.data.Extraction(
                    extraction_class="todo",
                    extraction_text="重启 Codex desktop app 后再测一次",
                    attributes={
                        "title": "验证重启后的 Codex desktop app",
                        "description": "重启 Codex desktop app 后再验证问题是否仍存在。",
                        "confidence": 0.65,
                        "timeBucket": "recent",
                        "typeBucket": "follow_up",
                        "dedupeKey": "verify-codex-desktop-after-restart",
                    },
                )
            ],
        ),
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
        assert config.model_id == "deepseek/deepseek-v4-flash"
        assert config.provider == "openai"
        assert config.provider_kwargs["base_url"] == "https://api.novita.ai/openai/v1"
        assert config.provider_kwargs["reasoning_effort"] == "medium"
        assert params["use_schema_constraints"] is False
        params = extract_kwargs(DummyLx, "custom/openai-compatible-model", DummyConfig)
        assert params["use_schema_constraints"] is False
        assert "CRISP, SCANNABLE" in PROMPT
        assert "codex/todo-cleanup-flash-model" in PROMPT
        assert "推送当前工作分支到远程仓库" in PROMPT
        assert "修正目录显示文字" in PROMPT
        assert "mature todo app item" in PROMPT
        assert "做最后一次状态确认" in PROMPT
        assert "Negative example" in PROMPT
        assert "refreshAction metadata" in PROMPT
        assert "0.55-0.81" in PROMPT
        assert "dedupeKey must be a short STABLE slug" in PROMPT
        assert "克隆 AI-Todo 仓库" in PROMPT
        print("ok")
        raise SystemExit(0)
    raise SystemExit(main())
