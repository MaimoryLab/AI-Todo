# Feature: &lt;Name&gt;

> Copy this file to `docs/features/<feature>.md`, fill it in, get it reviewed,
> and register it in [index.md](index.md) **before** implementation starts.

## One-line definition

What this feature does, in one sentence.

## Status / Priority

- Status: Draft | Planned | In Progress | Done | Paused
- Priority: P0 | P1 | P2

## Problem

The user problem, stated before any solution. Why is this needed?

## Users

Which personas this serves (see [PRD](../../PRD.md) → User Personas).

## Goals

- ...

## Non-goals

- What this explicitly does **not** do (prevents scope creep).

## User flow

1. The user does X.
2. The system responds with Y.
3. The user gets Z.

## Requirements

| ID | Requirement | Priority |
|---|---|---|
| R1 | ... | P0 |
| R2 | ... | P1 |

## Acceptance criteria

- What counts as done.
- Which edge cases must be covered.
- Which tests are required.

## Localization & rules impact

- New user-facing strings? They must live in i18n resources, keyed by stored value (see [RULES.md](../../RULES.md)).
- Any change to stored enums? Stored enum values are stable — call it out explicitly (see RULES.md).
- Touches MCP tools / REST endpoints / version? List the matching [AGENTS.md](../../AGENTS.md) consistency files.

## Technical notes

- Relevant modules (see [ARCHITECTURE.md](../../ARCHITECTURE.md)), APIs, data-structure impact, compatibility notes.

## Rollout

- How it ships, any gating, and how to roll back.
