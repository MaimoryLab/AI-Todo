# Feature: Codex source scanner

> Worked example of a feature doc. Status reflects the planned v1 scope.

## One-line definition

Automatically and incrementally turn local Codex sessions into todos, without re-reading already-processed history.

## Status / Priority

- Status: Planned
- Priority: P0

## Problem

Today, local Codex sessions become todos only through a manual import command. Users want the todo list to stay current on its own — without re-importing, and without producing duplicates on every run.

## Users

- **AI-heavy builder** and **Local-first power user** (see [PRD](../../PRD.md) → User Personas): they accumulate Codex sessions and want unfinished work surfaced automatically, on their own machine.

## Goals

- Scan a configured Codex source and ingest new sessions through the existing todo pipeline.
- Incremental: already-processed, unchanged history is not re-read on later runs.
- Reuse the existing parse + ingest pipeline — no second extraction path.

## Non-goals

- No LLM classifier (rule-based extraction only; deferred to v1.1).
- No other sources here (Claude Code / browser are handled separately).
- No REST/UI trigger in this feature (an internal trigger comes first).

## User flow

1. The daemon is configured with a Codex source (default Codex session directories).
2. On scan, it discovers new or changed session files.
3. New sessions are normalized and extracted into todos with evidence.
4. Re-running the scan does not re-read unchanged history and produces no duplicate todos.

## Requirements

| ID | Requirement | Priority |
|---|---|---|
| R1 | Ingest new Codex sessions via the existing pipeline | P0 |
| R2 | Incremental: skip already-processed, unchanged history | P0 |
| R3 | A failed file is recorded and retried next run; it does not abort the batch | P0 |
| R4 | Manual import remains available and unchanged | P1 |

## Acceptance criteria

- Re-running a scan over the same directory imports 0 new todos and re-reads no unchanged files (duplicate rate ≤5%; 0 history re-reads after first launch).
- A corrupt session file is recorded as an error and retried next run; valid files still ingest.
- Existing manual-import tests stay green.

## Localization & rules impact

- No new user-facing UI strings (backend feature).
- No change to stored todo status enums (see [RULES.md](../../RULES.md) — stored enums are stable).
- Adds storage scopes (sources, scan checkpoints) — list the [AGENTS.md](../../AGENTS.md) "new KV scope" files when implementing.

## Technical notes

- Reuse the normalization + ingest pipeline (see [ARCHITECTURE.md](../../ARCHITECTURE.md)). **Correctness** (no duplicate todos) is owned by the existing dedup layer; the scan checkpoint exists only to avoid **re-reading** unchanged history — so it must record recoverable per-file state, not an opaque watermark.

## Rollout

- Internal trigger first; a REST/UI trigger can follow. Rollback = revert the PR (new scopes carry no historical-data dependency).
