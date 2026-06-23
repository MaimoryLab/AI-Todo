# AI Todo

**AI Todo** is a local-first todo extraction tool for AI workflows.

It scans local agent sessions and captures browser AI conversations, extracts the unfinished work, stores everything locally, and shows it in a simple local web UI — answering one practical question:

> What did my AI agents leave unfinished, and what should I review next?

People work across coding agents, browser AI assistants, and project tools, and useful follow-ups stay buried in conversations: an agent waiting for confirmation, a failed command that blocked a task, a draft never reviewed, a plan never turned into an issue. AI Todo turns these open loops into local, reviewable todo candidates **with evidence**.

> **Status: internal trial / prototype.** It runs end to end locally. Some package names, CLI commands, and API paths still use the earlier implementation name while the project is being renamed to AI Todo. The UI defaults to English for open-source use, with Chinese available from Settings or `?lang=zh`.

## Quick start

Requirements: **Node.js 20+**.

```bash
npm install
npm run build
npm run start:local-memory
```

The daemon prints a local viewer URL (default REST API on port **3111**). Open it in your browser.

**Try it with sample data** — in another terminal:

```bash
node dist/cli.mjs demo
```

Then refresh the viewer: the dashboard fills with browsable sessions, memory, and extracted todos. The **To-Do** tab shows the extracted todos (each with evidence); the **Evidence** tab shows the sessions they came from.

> Prefer running from source while developing? `npm run dev` (via `tsx`) instead of build + start.

## Use your own data

- **Codex sessions (local):** the daemon scans your Codex session directories (`~/.codex/sessions` and `~/.codex/archived_sessions`) on startup and on an interval. Toggle with `AGENTMEMORY_CODEX_AUTOSCAN=false`; tune the cadence with `AGENTMEMORY_CODEX_SCAN_INTERVAL_MS` (default 5 min). You can also import a transcript on demand from a source checkout with `node dist/cli.mjs import-jsonl <path>` (installed package binary: `agentmemory-lab import-jsonl <path>`).
- **Browser AI conversations:** load the browser extension under [`browser-extension/`](browser-extension/); it captures supported AI sites and posts them to the local daemon, which extracts todos into the same queue.
- **LangExtract extraction (optional):** install Python deps with `python3 -m pip install -r requirements-langextract.txt` (add `socksio` if your network uses a SOCKS proxy). Configure it during first-run setup (`node dist/cli.mjs --reset` from source, or `agentmemory-lab --reset` when installed), from the viewer Settings panel, or in `~/.agentmemory/.env`: `AGENTMEMORY_TODO_EXTRACTOR=langextract`, `LANGEXTRACT_PYTHON=/path/to/python`, `LANGEXTRACT_PROVIDER=openai`, `LANGEXTRACT_MODEL=deepseek/deepseek-v4-pro`, `LANGEXTRACT_BASE_URL=https://api.novita.ai/openai/v1`, `LANGEXTRACT_API_KEY=<runtime secret>`, and optionally `AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS=120000`. Trigger it from the To-Do tab or with `POST /agentmemory/todo-extract/generate`.
- **First-run setup:** the first-run CLI model choice configures To-Do extraction — it seeds the `LANGEXTRACT_*` settings above for the model you pick (or keeps the rules extractor if you skip). The legacy memory compression/consolidation/embeddings provider is an advanced `.env`-only setting.

Everything stays on your machine — see [Privacy](#privacy).

## How it works

```
local agent sessions ─┐
                       ├─▶ normalize ─▶ extractor ─▶ local DB ─▶ local API ─▶ web UI
browser AI capture ───┘                         (rules or LangExtract)
```

Built on iii-engine (file-based SQLite state), with a local REST API + MCP server + web UI. The default extractor is deterministic rules. LangExtract is opt-in: the To-Do tab reads stored cards, and the **Organize with LLM** button runs extraction for recent sessions. The **Update** button dry-runs LLM maintenance for generated cards whose source sessions changed, asks before dropping/closing/rewriting/merging cards, then applies the reviewed decisions. See [ARCHITECTURE.md](ARCHITECTURE.md) for detail.

## Core todo state

Persisted todo cards use the existing `Action.status` values:

| Status | Meaning |
|---|---|
| `pending` | Open work that has not started or needs user review |
| `active` | Work that appears in progress |
| `done` | Completed work |
| `blocked` | Work blocked by a tool, dependency, permission, network, or runtime issue |
| `cancelled` | Work the user or system dismissed |

LLM extraction also writes classification tags such as `type:waiting_for_user`, `type:agent_blocked`, `type:partial_done`, `type:needs_review`, and `type:stale_thread` so the UI can explain why a card was created without adding new stored status values.

## Privacy

- Local-first by default; captured browser content and local sessions stay on your machine.
- No cloud sync in v1; no automatic writes into external todo tools in v1.
- Secrets, API keys, and tokens are redacted before display when detected.
- Every extracted todo includes evidence; you can mark todos done, ignored, or deleted.

## Under the hood

Under the hood, the current prototype still exposes the full implementation surface: **55 MCP tools** (8 visible by default — 55 tools, 6 resources, 3 prompts over MCP) and a local REST API serving **141 endpoints on port** 3111. These counts track the implementation that is mid-rename to AI Todo.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Rules](RULES.md)
- [Roadmap](ROADMAP.md)
- [Development](docs/development.md)
- [Features](docs/features/index.md)

## License

Apache-2.0. See [LICENSE](LICENSE).
