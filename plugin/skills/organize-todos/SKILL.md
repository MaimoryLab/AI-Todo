---
name: organize-todos
description: When a work session winds down, proactively summarize what you followed up on and what's still owed, then post a single briefing to the user's workbench inbox. Use when a multi-step task reaches a natural stopping point (feature shipped, batch of fixes done, session ending) so the user gets one tidy rollup instead of scrolling the transcript. Not for trivial one-step tasks or mid-flight chatter.
user-invocable: false
---

A stretch of work just reached a natural stopping point. Instead of leaving the user to scroll the transcript, post ONE tidy briefing to their workbench inbox: what you followed up on, what's done, what's still owed.

## When to use this (high bar — one signal, not a stream)

Post a briefing ONLY when:
1. **The work was non-trivial** — a multi-step task, a feature, a batch of fixes. A one-line edit or a pure Q&A does not warrant a briefing.
2. **It reached a natural stopping point** — feature shipped, PR opened, batch complete, or the session is ending. Not mid-flight.
3. **There is something worth telling** — concrete progress and/or remaining items. If nothing happened, don't post.

Post **at most one** briefing per stopping point. Never post a running commentary — that buries the signal.

## What goes in the briefing

Call the `memory_inbox_notify` MCP tool:
- `body` — a short Markdown rollup. Lead with a one-line summary, then a tight list. Cover:
  - ✅ **完成** — what you actually finished (with PR/file refs where useful).
  - ⏳ **还欠着** — what's started-but-not-done or deferred, so nothing silently drops.
  - ⚠️ **需你定** — anything you had to assume or that needs the user's eventual sign-off (but if it's *blocking*, use `ask-user` instead — a briefing is "知悉即可", not "在等你回").
- `fromAgent` — a short label for the work (e.g. `line-c-c1`).
- `project` — the repo/project path when known.
- `sourceObservationIds` — IDs of key observations (PRs, commits, test runs) so the user can click "看原文 →".

A good briefing is skimmable in five seconds:

> 今天跟进了 C1.5(Agent 接入点 skill):
> - ✅ 完成:`ask-user` + `organize-todos` 两个 skill,PR#NN 已开。
> - ⏳ 还欠着:viewer 接真数据(C2)未动。
> - ⚠️ 需你定:skill 触发判据的措辞,开 PR 时帮看一眼。

## What NOT to do

- Don't notify on every tool call or mid-task — only at a real stopping point.
- Don't restate the whole transcript; the user followed along. Summarize the outcome.
- Don't use this for blocking questions — those go through `ask-user` as `question`, not `briefing`.
- Don't pad. If there's nothing material to report, stay silent.

This briefing is `kind: briefing` (知悉即可,可一键已读), distinct from `ask-user`'s `kind: question` (Agent 在等你回). Keep the two roles clean.

If `memory_inbox_notify` isn't available, fall back to `POST $AGENTMEMORY_URL/agentmemory/inbox/notify` with body `{ "body": "...", "fromAgent": "...", "project": "..." }` and `Authorization: Bearer $AGENTMEMORY_SECRET` when set.
