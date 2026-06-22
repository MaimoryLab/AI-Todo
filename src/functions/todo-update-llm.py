#!/usr/bin/env python3
"""LLM update sidecar for AI Todo cards (PLAN-002 STEP-12).

Reads {"cards": [...]} from stdin and writes {"decisions": [...]} to stdout.
Each card's source session has gained new activity since the card was recorded
(`sessionDelta` carries that recent activity). This re-judges the card in light
of it: KEEP / DROP / DONE / REWRITE / MERGE. Uses a direct OpenAI-compatible
chat completion (stdlib urllib, no extra deps), reusing the same LANGEXTRACT_*
config. On any failure (no key, network, bad JSON) it exits non-zero so the
TypeScript caller leaves every card untouched and reports why.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
DEFAULT_BASE_URL = "https://api.novita.ai/openai/v1"
LEGACY_MODELS = {"pa/gpt-5.5"}
VALID_DECISIONS = {"KEEP", "DROP", "DONE", "REWRITE", "MERGE"}

SYSTEM_PROMPT = """\
You are a strict, conservative maintainer of a developer's personal Todo list.
Each card was auto-extracted earlier from an AI coding-agent session. It may be
selected because that session has SINCE gained new activity (`sessionDelta`), or
because a full-list maintenance pass is improving existing card quality. Your
job is to UPDATE each card using only the card, its evidence, its sessionDelta
when present, and other cards in this same batch. Keep the list trustworthy —
every surviving card must be a REAL, SPECIFIC, STILL-OPEN action with a clear
title.

For EACH input card, output exactly one decision:
- KEEP    — still a genuine, still-open action and the new activity does not
            change it; clear enough as-is.
- DROP    — the new activity (or the card itself) shows it is not a real todo:
            tool/command output, a status report, a git ref/hash fragment,
            meta-commentary, or too vague to act on.
- DONE    — the new session activity shows this task is now completed.
- REWRITE — still a real, still-open todo, but its title/description should be
            updated because it is vague, process-narration, too broad, or stale
            given the new activity. Provide a corrected concise `newTitle`
            (<= 80 chars) and one-line `newDescription`. Stay faithful to the
            card + evidence + sessionDelta; never invent scope or steps not
            supported by them.
- MERGE   — a duplicate of another card in this same batch; give `mergeIntoId`
            of the canonical (clearest) card to merge into.

Rules:
1. BE CONSERVATIVE. When unsure, choose KEEP. Only DROP or DONE when the card's
   own text/evidence or the sessionDelta makes you confident. It is far worse to
   wrongly drop or close a real todo than to keep a borderline one.
2. Ground every decision ONLY in the card's own text/evidence and its
   sessionDelta. No outside knowledge, no assumed facts.
3. For REWRITE, only clarify or reflect the new state; do not add unsupported
   scope, steps, or detail.
4. KEEP bar: a specific subject + a verb/action + a discernible outcome
   (e.g. "Fix the N+1 query in the dashboard loader"). Reject pure observations,
   logs, status lines, and vibes.
5. Title quality bar: use concrete verb + specific object (+ target/outcome when
   it adds signal). Remove filler such as "全面了解", "了解现状", "梳理现状",
   "获取信息", "进行", "处理". Prefer "克隆 AI-Todo 仓库" over
   "克隆仓库并全面了解其状况".
6. If a card has `titleQualityHint`, actively consider REWRITE even if it is
   still open. If that card is also the best MERGE target, output REWRITE for
   the target card and MERGE the duplicates into that same id.

Output STRICT JSON only, exactly one entry per input card, same ids:
{"decisions":[{"id":"<card id>","decision":"KEEP|DROP|DONE|REWRITE|MERGE",
"reason":"<short>","newTitle":"<only if REWRITE>","newDescription":"<only if
REWRITE>","mergeIntoId":"<only if MERGE>"}]}

Examples of decisions:
- sessionDelta shows the change was committed/merged/tests passed             -> DONE
- "⏺ Bash(npm test)" / "Viewer: http://localhost:3114" / "abc1234 (HEAD)"     -> DROP
- "克隆仓库并全面了解其状况" with AI-Todo evidence                            -> REWRITE to "克隆 AI-Todo 仓库"
- a real task whose wording is vague or stale given the new activity          -> REWRITE
- two cards describing the same fix                                           -> MERGE duplicates + KEEP/REWRITE canonical
- a still-open task the new activity does not touch                           -> KEEP
"""


def model_id() -> str:
    m = (os.environ.get("LANGEXTRACT_MODEL") or DEFAULT_MODEL).strip()
    return DEFAULT_MODEL if m in LEGACY_MODELS else m


def call_llm(cards: list) -> list:
    """Direct OpenAI-compatible chat completion. Raises SystemExit on failure."""
    api_key = os.environ.get("LANGEXTRACT_API_KEY", "").strip()
    if not api_key:
        raise SystemExit("LANGEXTRACT_API_KEY is required for LLM update")
    base_url = (os.environ.get("LANGEXTRACT_BASE_URL", DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL).rstrip("/")
    body = {
        "model": model_id(),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "Update these existing cards. Use sessionDelta when "
                'present, and otherwise judge card quality and same-batch '
                'duplicates from the card text/evidence. Return strict JSON '
                '{"decisions":[...]} with one entry '
                "per card.\n"
                + json.dumps({"cards": cards}, ensure_ascii=False),
            },
        ],
        "temperature": 0,
        "response_format": {"type": "json_object"},
    }
    req = urllib.request.Request(
        base_url + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Cloudflare in front of Novita 403s the default Python-urllib UA
            # ("error code: 1010"); a stable explicit UA is required.
            "User-Agent": "AI-Todo",
        },
        method="POST",
    )
    timeout = float(os.environ.get("AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS", "120000")) / 1000.0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:  # pragma: no cover
        detail = ""
        try:
            detail = exc.read().decode("utf-8")[:300]
        except Exception:
            pass
        raise SystemExit(f"LLM request failed: HTTP {exc.code} {detail}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:  # pragma: no cover
        raise SystemExit(f"LLM request failed: {exc}") from exc
    content = data["choices"][0]["message"]["content"]
    parsed = json.loads(content)
    return parsed.get("decisions") or []


def normalize(cards: list, decisions: list) -> list:
    """Validate raw decisions against the input ids + decision enum."""
    valid_ids = {c.get("id") for c in cards if isinstance(c, dict)}
    out = []
    seen = set()
    for d in decisions:
        if not isinstance(d, dict):
            continue
        cid = d.get("id")
        dec = str(d.get("decision") or "").upper()
        if cid not in valid_ids or cid in seen or dec not in VALID_DECISIONS:
            continue
        seen.add(cid)
        entry = {"id": cid, "decision": dec, "reason": str(d.get("reason") or "")[:200]}
        if dec == "REWRITE":
            nt = str(d.get("newTitle") or "").strip()[:120]
            nd = str(d.get("newDescription") or "").strip()[:400]
            if not nt:  # rewrite without a usable title is meaningless → keep instead
                entry["decision"] = "KEEP"
            else:
                entry["newTitle"] = nt
                entry["newDescription"] = nd
        if dec == "MERGE":
            mid = d.get("mergeIntoId")
            if mid not in valid_ids or mid == cid:  # bad target → keep instead
                entry["decision"] = "KEEP"
            else:
                entry["mergeIntoId"] = mid
        out.append(entry)
    return out


def main() -> int:
    payload = json.load(sys.stdin)
    cards = payload.get("cards") or []
    if not isinstance(cards, list) or not cards:
        print(json.dumps({"decisions": []}, ensure_ascii=False))
        return 0
    decisions = normalize(cards, call_llm(cards))
    print(json.dumps({"decisions": decisions}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if os.environ.get("AGENTMEMORY_TODO_UPDATE_SELF_TEST") == "1":
        # Offline smoke: exercise normalize() without any network call.
        _cards = [{"id": "a", "title": "x"}, {"id": "b", "title": "y"}, {"id": "c", "title": "z"}]
        _raw = [
            {"id": "a", "decision": "drop", "reason": "tool log"},
            {"id": "b", "decision": "REWRITE", "newTitle": "Fix it", "newDescription": "do the fix"},
            {"id": "c", "decision": "MERGE", "mergeIntoId": "b"},
            {"id": "zzz", "decision": "DROP"},  # unknown id → dropped
            {"id": "a", "decision": "KEEP"},  # duplicate id → ignored
        ]
        _out = normalize(_cards, _raw)
        assert [d["decision"] for d in _out] == ["DROP", "REWRITE", "MERGE"], _out
        assert _out[1]["newTitle"] == "Fix it"
        assert _out[2]["mergeIntoId"] == "b"
        assert "KEEP" in SYSTEM_PROMPT and "MERGE" in SYSTEM_PROMPT
        assert "Title quality bar" in SYSTEM_PROMPT and "克隆 AI-Todo 仓库" in SYSTEM_PROMPT
        print("ok")
        raise SystemExit(0)
    raise SystemExit(main())
