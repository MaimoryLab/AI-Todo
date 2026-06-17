# Rules

Hard rules for working on AI Todo — for humans and AI agents alike. For the
exhaustive per-change checklists (counts, registration), see [AGENTS.md](AGENTS.md);
for setup and PR flow, see [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/development.md](docs/development.md).

## Language

- Public-facing surfaces are **English-first**: README, docs, UI copy, issue/PR templates.
- Internal planning notes may use other languages, but anything users or external contributors read defaults to English.

## Storage & display

- Stored enum values (todo status, etc.) are **stable** — never change persisted enum literals; a change to stored values is a deliberate, separate migration.
- Separate display labels from enum values: UI strings live in i18n resources keyed by the stored value, so changing a label or switching language never touches stored data.

## Consistency

- Counts and versions must stay in sync across **every** file that records them (MCP tools, REST endpoints, version). The authoritative list is [AGENTS.md → Consistency Rules](AGENTS.md). `npm run pre-pr` runs the local consistency guard.

## Pull requests

- **One PR = one** reviewable, reversible change; keep the diff small (soft cap ~400 lines); the product stays usable at every step.
- Sign off every commit (DCO): `git commit -s`.
- No attribution headers in commits (no "Generated with …" / "Co-Authored-By" trailers).
- `npm run pre-pr` (consistency + build + test) must pass before pushing.
- See [AGENTS.md → Done Means](AGENTS.md) for the definition of done.

## Architecture

- All state goes through iii-engine's StateModule — never a standalone SQLite or in-process store.
- Validate inputs at MCP/REST boundaries; REST endpoints whitelist fields and never forward a raw request body to `sdk.trigger()`.
- See [ARCHITECTURE.md](ARCHITECTURE.md) for the system overview.

## Security & privacy

- Local-first: captured browser content and local sessions stay on the user's machine by default.
- No cloud sync in v1; no automatic writes into external todo tools in v1.
- Redact secrets, API keys, and tokens before display when detected.
- Every extracted todo must include at least one piece of evidence.
- Users can mark todos done, ignored, or deleted.

## Release checklist

Run before any external release or announcement — covers the four release
dimensions (localization / README / rules / architecture):

- [ ] README is in English and current (What / Why / v1 Scope / Docs / Privacy / License).
- [ ] Core UI strings are available in English (i18n base in place).
- [ ] `RULES.md` and `ARCHITECTURE.md` exist and are linked from README.
- [ ] New features have a reviewed feature doc (feature template + review process).
- [ ] Issue and PR templates are present and working.
- [ ] `npm run pre-pr` is green; counts and versions are consistent.
