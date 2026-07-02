# Repository Rules

## Scope

AI-Todo is a local-first todo extraction product for AI/browser/agent sessions.
Keep changes small, public-safe, and aligned with the current LLM-only product
direction.

## Do Not Commit

- Real `.env` files, API keys, tokens, or local credentials.
- Local data directories: `data/`, `data-*`, `.local/`, `.ai-todo/`.
- Build or dependency output: `dist/`, `node_modules/`, `*.tsbuildinfo`.
- Private planning docs or internal design notes.
- Old private repository internals or real user transcripts.

## Architecture Boundaries

- CLI entry point: `src/cli.ts`.
- HTTP UI/API: `src/server/index.ts` plus static files under `public/`.
- MCP stdio: `src/mcp/`.
- SQLite storage and migrations: `src/db/index.ts`.
- Source scanning: `src/sources/`.
- LLM todo extraction: `src/todos/` and `src/extract/llm-runner.ts`.

Reuse existing modules before adding new layers. Do not add abstractions for a
single caller.

## Fixed Port Rule

`ai-todo open` defaults to `127.0.0.1:3111`. Keep `--port <n>` as the explicit
override and keep `--port 0` available for tests or temporary avoidance. If the
default port is occupied, return a clear error and suggest
`ai-todo open --port <port>`; do not silently choose a random port.

## LLM-only Rule

Todo card generation remains LLM-only. Do not restore rules fallback as the
default organize path. Missing API keys, HTTP timeouts, invalid model output,
or provider errors should produce actionable diagnostics and warnings.

## Tests

Run the smallest relevant check first, then the full checks before handoff:

```bash
npm test
npm run build
git diff --check
```

For local UI verification, build first, start `ai-todo open`, and inspect
Settings, organize warnings, and LLM failure details in Chrome. Do not leak API
keys in logs, screenshots, fixtures, or docs.
