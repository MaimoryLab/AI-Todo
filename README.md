# AI Todo

**AI Todo** is a local-first todo extraction tool for AI workflows.

It scans local agent sessions, captures browser AI conversations, extracts unfinished work, stores the results locally, and shows them in a simple local web UI. The goal is not to become another generic todo app. The goal is to answer one practical question:

> What did my AI agents leave unfinished, and what should I review next?

## Why

People now work across coding agents, browser AI assistants, and project tools. Useful follow-ups often stay buried inside conversations:

- an agent is waiting for user confirmation
- a command failed and blocked the task
- a draft was generated but never reviewed
- a feature plan was written but not turned into an issue
- a browser AI conversation contains follow-up work

AI Todo turns these open loops into local, reviewable todo candidates with evidence.

## v1 Scope

AI Todo v1 focuses on the current core product plus the required launch constraints:

| Area | v1 Requirement |
|---|---|
| Local scanner | Scan at least one local agent session source |
| Browser capture | Capture at least one browser AI conversation source |
| Local database | Store todos, sources, evidence, status, and scan checkpoints |
| Incremental extraction | Avoid duplicate todos across repeated scans |
| Local UI | Show active todos in a local web page |
| Manual cleanup | Support done, ignored, and deleted states |
| Evidence | Every todo must include at least one source reference |
| Localization-ready | Core UI strings live outside business logic |
| Connectors | Define a generic connector interface for future integrations |
| Docs | Include PRD, features, architecture, rules, and roadmap |

## Product Documents

- [PRD](PRD.md)
- [Architecture](ARCHITECTURE.md)
- [Rules](RULES.md)
- [Roadmap](ROADMAP.md)
- [Development](docs/development.md)
- `FEATURES.md` - planned

## Core Todo Statuses

| Status | Meaning |
|---|---|
| `waiting_for_user` | The agent is waiting for user input, confirmation, or authorization |
| `agent_blocked` | The agent failed because of a tool, dependency, permission, network, or runtime issue |
| `partial_done` | Work has an intermediate result but no final completion evidence |
| `needs_review` | The agent produced something that requires human review |
| `stale_thread` | The conversation indicates later continuation but has no recent progress |

## Current Prototype

This repository currently contains the implementation foundation for the local daemon, local API, browser extension, and web UI. Some internal package names, CLI commands, and API paths may still use earlier implementation names while the product is being renamed to AI Todo.

Under the hood, the current prototype still exposes the full implementation surface: **55 MCP tools** (8 visible by default — 55 tools, 6 resources, 3 prompts over MCP) and a local REST API serving **136 endpoints on port** 3111. These counts track the implementation that is mid-rename to AI Todo.

Common local checks:

```bash
npm install
npm run build
npm test
```

Local preview:

```bash
npm run start:local-memory
```

Then open the viewer URL printed by the command.

## Privacy Principles

- Local-first by default.
- No cloud sync in v1.
- No automatic writes into external todo tools in v1.
- Captured browser content and local sessions stay on the user's machine by default.
- Extracted todos must include evidence.
- Users can mark todos as done, ignored, or deleted.

## License

Apache-2.0. See [LICENSE](LICENSE).
