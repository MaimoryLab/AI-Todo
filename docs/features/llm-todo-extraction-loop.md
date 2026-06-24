# Feature: LLM todo extraction and update loop

> Current contract for the LLM-backed todo loop. This document records what is
> implemented today and the small follow-up gaps that should be fixed next.

## One-line definition

Use recent local sessions as evidence, ask an LLM for structured todo output,
and keep generated cards reviewable, updateable, and traceable back to their
source session.

## Status / Priority

- Status: Implemented, with follow-up documentation/UI gaps
- Priority: P0

## Problem

The To-Do tab must not look like a generic memory summary list. Users need
cards that are visibly actionable, grounded in session evidence, and updated
when the source session changes. The product contract needs to stay explicit:
when sessions are read, when the LLM runs, how a card is classified as
todo/done/in-progress, and how evidence helps users return to the original work
context.

## Users

- **AI-heavy builder:** works across Codex and browser AI sessions and needs
  unfinished work surfaced without re-reading or manually scanning history.
- **Local-first power user:** wants evidence-backed local cards and control over
  model configuration, cost, and cleanup.

## Goals

- Make the startup contract explicit: first launch reads historical Codex
  session files into the local database; later launches and daemon scans are
  incremental and skip unchanged history.
- Make LLM extraction explicit and observable: the To-Do UI triggers the
  extraction loop via **Organize with LLM** and shows progress plus whether it
  used LLM or rules fallback.
- Require structured LLM output with title, description, confidence, time
  bucket, type bucket, dedupe key, and evidence quote.
- Classify generated cards as pending, active, or done based on extracted
  `typeBucket`, not merely because a sentence appears in a session.
- Detect source-session changes after a card is created and update cards through
  an LLM dry-run/apply loop instead of silently changing card text.
- Improve evidence navigation so a card can take the user to both the evidence
  panel and the local Codex session/work directory when available.

## Non-goals

- No automatic background LLM calls on daemon startup or To-Do tab refresh.
- No cloud sync.
- No writes back into Codex, browser AI tools, GitHub Issues, or external todo
  apps.
- No new stored todo status enum in this feature. Visual recheck state should
  live in metadata/tags until a migration is approved; archive/delete remain UI
  operations over existing Action records, not new status literals.
- No full connector framework for Claude, OpenClaw, Hermes, or other agents in
  this feature.

## User flow

1. On first daemon startup, Codex session files under the configured roots are
   imported into local `sessions` and `observations`.
2. Later scans read only new or changed files. Unchanged history is skipped by
   source checkpoints.
3. The user opens To-Do; the tab reads stored cards and does not run the LLM by
   itself.
4. The user clicks **Organize with LLM**. The extractor reads recent sessions,
   sends observation blocks to the
   LangExtract sidecar when configured, and falls back to rules if the sidecar
   fails.
5. High-confidence, evidence-valid todos become Actions. Medium-confidence
   todos enter the review queue. Low-confidence or evidence-less candidates are
   discarded.
6. If a source session changes after a generated card was created, the user can
   click **Update**. The UI first calls `/agentmemory/todo/update` in `dry-run`
   mode for changed cards, then confirms before applying DROP, DONE, REWRITE, or
   MERGE decisions. If every decision is KEEP, the UI applies silently so
   checkpoints advance.
7. The user clicks evidence. The UI jumps to the evidence record and, when
   available, exposes the local work directory/session path as the next action.

## Requirements

| ID | Requirement | Priority |
|---|---|---|
| R1 | First startup imports historical Codex sessions into local storage; follow-up scans are incremental and skip unchanged history | P0 |
| R2 | LLM extraction uses the configured model; default `LANGEXTRACT_MODEL` is `deepseek/deepseek-v4-flash` | P0 |
| R3 | The extraction prompt must require actionable output, source quote, `timeBucket`, `typeBucket`, confidence, and dedupe key | P0 |
| R4 | A todo is stored only when its evidence quote matches the source observation | P0 |
| R5 | `typeBucket=done` maps to `Action.status=done`; `in_progress` and `processing` map to `active`; all other buckets map to `pending` | P0 |
| R6 | Cards created from sessions store enough metadata to compare their source checkpoint with the latest session checkpoint | P1 |
| R7 | If the source checkpoint changes, `/agentmemory/todo/update` can dry-run and apply KEEP, DROP, DONE, REWRITE, and MERGE decisions | P1 |
| R8 | Evidence jump lands on the evidence item and makes the local Codex session/work directory discoverable when present | P1 |
| R9 | `/agentmemory/todo/update` supports `scope=changed` by default and `scope=all` for explicit maintenance runs | P1 |

## Acceptance criteria

- A first run with existing Codex history imports sessions once; a second run
  imports no unchanged files.
- With LangExtract configured, pressing the LLM organize button returns
  `engine=langextract` or `engine=mixed`, and at least one generated card has
  `todo-extracted`, `time:*`, and `type:*` tags.
- With LangExtract unavailable, the same UI action reports rules fallback and
  does not block the To-Do page.
- Every generated card has a short readable title and evidence quote; command
  JSON, file paths, tool logs, and screenshots are rejected as card titles.
- A completed-work sentence creates either a `done` Action or a discarded
  historical candidate; it must not appear as a pending todo by default.
- When a source session changes after card creation, **Update** previews LLM
  maintenance before any destructive or rewriting change is applied.
- `POST /agentmemory/todo/update` with `{ "mode": "dry-run", "scope": "all" }`
  can evaluate existing generated cards for explicit maintenance runs; this is
  an API path today, not a separate viewer control.
- Evidence navigation can show the observation, source session id, local session
  file or work directory when available.

## Localization & rules impact

- New user-facing strings must be English-first and added to the viewer i18n
  catalog with Chinese translations.
- Stored enum values stay unchanged: `Action.status` remains the current
  persisted set (`pending`, `active`, `done`, `blocked`, `cancelled`).
- No REST endpoint count change is required unless the evidence deep-link or
  recheck operation needs a new API. If a REST endpoint is added, update
  README, AGENTS.md, `src/index.ts`, and the consistency tests in the same PR.

## Technical notes

- Current startup ingestion is in `src/index.ts` via
  `mem::source-scan::codex`; checkpointed file scanning lives in
  `src/functions/source-scan-codex.ts`.
- Current LLM/rules extraction is `mem::todo-extract-generate` in
  `src/functions/todo-extract.ts`, with the Python LangExtract sidecar in
  `src/functions/todo-extract-langextract.py`.
- Current LLM update is `mem::todo-update` / `POST /agentmemory/todo/update` in
  `src/functions/todo-extract.ts`, `src/triggers/api.ts`, and
  `src/viewer/server.ts`.
- Current structured prompt requires action-only extraction, source quote,
  readable title, confidence, time bucket, type bucket, and dedupe key.
- Existing `metadata.todoExtraction.sourceCheckpoint` is used to decide whether
  generated cards need changed-session maintenance.
- `scope=all` is supported by the API/function for stock cleanup and title
  quality passes, but the viewer's **Update** button currently uses the default
  changed-card scope.
- Evidence navigation should reuse `sourceObservationIds`,
  `metadata.todoExtraction.evidence`, session `cwd`, and scanner source
  metadata before adding new storage.

## Follow-up plan

1. Keep docs aligned with the current default model (`deepseek/deepseek-v4-flash`)
   until the code default is changed and tested.
2. Decide whether the viewer needs an explicit **Update all generated cards**
   control; until then, document `scope=all` as API-only.
3. Replace old CLI wording in code help/onboarding strings in a separate PR if
   the installed binary name stays `agentmemory-lab`.
4. Verify future changes with `npm run check:consistency-local`, `npm run build`,
   and the focused To-Do tests before opening a PR.
