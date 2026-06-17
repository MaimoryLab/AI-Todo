# Feature: Codex source scanner

> Reviewed feature doc (PLAN-002 STEP-01). Incorporates the implementation-plan
> review: incremental watermark instead of a hash, success-only checkpointing,
> per-file path+mtime/size state, and per-source locking.

## One-line definition

Automatically and incrementally turn local Codex sessions into todos, reusing the existing ingest pipeline and never re-reading already-processed, unchanged history.

## Status / Priority

- Status: In Progress
- Priority: P0

## Problem

Today local Codex sessions become todos only through a manual `import-jsonl` command. Users want the todo list to stay current on its own — without re-importing, and without re-reading or duplicating history on every run.

## Users

- **AI-heavy builder** and **Local-first power user** (see [PRD](../../PRD.md) → User Personas): they accumulate Codex sessions and want unfinished work surfaced automatically, on their own machine.

## Goals

- Scan a configured Codex source and ingest new sessions through the existing parse → dedup → persist pipeline.
- Incremental: already-processed, unchanged files are not re-read on later runs.
- A failed file is recorded and retried next run; it never aborts the batch.
- Manual `import-jsonl` keeps working, unchanged.

## Non-goals

- No LLM classifier (rule-based extraction only; deferred to v1.1).
- No other sources here (Claude Code / browser handled separately).
- No REST/UI trigger in this feature — an internal trigger first (REST is folded into the later first-run/backfill step).
- No two-dimensional workbench (v1.1).

## User flow

1. The daemon is configured with a Codex source (default Codex session roots).
2. On scan it discovers session files under the source root(s).
3. Files new-or-grown since the last scan are normalized and extracted into todos with evidence; unchanged files are skipped without being read.
4. Re-running the scan re-reads no unchanged history and produces no duplicate todos.

## Requirements

| ID | Requirement | Priority |
|---|---|---|
| R1 | Ingest new Codex sessions via the existing pipeline (no second extraction path) | P0 |
| R2 | Incremental: skip already-processed, unchanged files **without reading them** | P0 |
| R3 | A corrupt/failed file is recorded (`lastError`) and retried next run; the batch continues | P0 |
| R4 | Manual `import-jsonl` remains available and behaviourally unchanged | P0 |
| R5 | Default source covers both Codex roots: `~/.codex/sessions` and `~/.codex/archived_sessions` | P1 |
| R6 | Two concurrent scans (or a scan racing a manual import) never double-advance the checkpoint or duplicate a session | P1 |

## Acceptance criteria

- Re-running a scan over the same directory imports 0 new todos **and reads 0 unchanged files** (assert by spying `readFile` — observation counts alone do not prove re-read avoidance). Duplicate rate ≤5%; 0 history re-reads after first launch.
- A corrupt session file is recorded in `lastError` and retried on the next run; valid files still ingest and the batch is not aborted.
- Existing `import-jsonl` / replay tests stay green (the shared-ingest extraction is behaviour-preserving).
- Concurrent scans of one source produce a single checkpoint advance and no duplicate sessions.

## Localization & rules impact

- No new user-facing UI strings (backend feature).
- **No change to stored todo status enums** (see [RULES.md](../../RULES.md) — stored enums are stable).
- Adds two KV scopes (`sources`, `scanCheckpoints`) → update the AGENTS.md "new KV scope" files (`src/state/schema.ts` + `src/types.ts`). No MCP-tool / REST-endpoint / version count change in this step.

## Technical notes

See [ARCHITECTURE.md](../../ARCHITECTURE.md) for the pipeline.

- **Reuse, don't duplicate ingest.** Extract the per-file ingest from `import-jsonl` (`src/functions/replay.ts`) into a module-level `ingestJsonlFile(kv, file) → { sessionId, newObservations } | null`. The aggregate `safeAudit` and the `sessionIds`/`observationCount` accumulators stay in each **caller** (the scanner writes its own audit entry). `deriveCrystalAndLessons` is already per-file, so it moves cleanly. (This step ships first as a behaviour-preserving refactor with a regression test.)
- **Correctness vs. efficiency are separate.** No-duplicate-todos is already guaranteed by the existing dedup layer (parser-derived `sessionId` + `stabilizeObservationIds` + per-observation skip-by-id). The checkpoint exists **only** to avoid re-reading unchanged history.
- **Cursor = recoverable per-file state, not a hash.** `ScanCheckpoint.cursor` stores a JSON map `path → { mtimeMs, size }`. A file is skipped (not read) when its `mtimeMs` and `size` are unchanged; new or grown files are read. A file is recorded in the map **only on successful ingest**, so failures stay absent and are retried next run. There is no end-of-run "last file" watermark (a single scalar can't express per-file success and assumes a file ordering Codex's timestamp/uuid names don't guarantee).
- **Stable fallback session id.** For a Codex file lacking a `session_meta.id`, derive the fallback session id from the **file path** (rollout filename/uuid), not a hash of the full text — otherwise a growing transcript mints a new session every scan.
- **Concurrency.** Wrap each scan in `withKeyedLock(\`source-scan:${sourceId}\`, …)` (`src/state/keyed-mutex.ts`) so concurrent scans / a racing manual import can't clobber the checkpoint.
- **Path safety.** Reuse `isSensitive` / `isSymlink` / `findJsonlFiles` from `replay.ts` (export or move into a shared module); `findJsonlFiles` already clamps to `MAX_FILES` and reports truncation — surface that to `lastError`.

## Rollout

- Ships as two slices: (1) the behaviour-preserving `ingestJsonlFile` extraction + regression test; (2) the scanner function + `sources`/`scanCheckpoints` scopes + checkpoint + tests.
- Internal trigger first; a REST/UI trigger follows in the first-run/backfill step.
- Rollback = revert the PR(s); the new scopes carry no historical-data dependency and `import-jsonl` is untouched.
