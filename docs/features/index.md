# Features

Registry of approved features and the process for adding new ones.

## Process

Substantial new features follow **doc → review → implement**:

1. Copy [template.md](template.md) to `docs/features/<feature>.md` and fill it in.
2. Open it for review — a maintainer signs off on scope, non-goals, and acceptance criteria.
3. Only after the feature doc is approved does implementation start; the implementation PR links the feature doc.

Bug fixes and small, obvious changes do not need a feature doc. See
[example-feature.md](example-feature.md) for a worked example, and the release
checklist in [RULES.md](../../RULES.md).

## Registry

| Feature | Status | Priority | Doc | Notes |
|---|---|---|---|---|
| Viewer i18n base | Done | P0 | shipped | Inline `{en, zh}` catalog + `t()` |
| Codex source scanner | Planned | P0 | [example-feature.md](example-feature.md) | First local source; incremental, no re-reads |

### Status

- **Draft** — under discussion
- **Planned** — confirmed, not started
- **In Progress** — being built
- **Done** — implemented and verified
- **Paused** — intentionally stopped

### Priority

- **P0** — must have
- **P1** — important
- **P2** — useful but not urgent
