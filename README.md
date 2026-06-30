# AI-Todo

AI-Todo is a local-first action inbox for AI agent sessions. It scans local
Codex and Claude Code session logs, accepts browser sessions through the local
HTTP API, uses an OpenAI-compatible LLM to organize unfinished work into todo
cards, and keeps source evidence available for review.

## Requirements

- Node.js 24 or newer
- An OpenAI-compatible chat completions endpoint and API key

AI-Todo does not fall back to rule-based todo generation. Without a configured
LLM key, the app can start and scan sessions, but organize runs cannot create
todo cards.

## Quick Start

```bash
npm install
npm run build
AI_TODO_HOME=.local/ai-todo node dist/cli.js init --api-key <your-key>
AI_TODO_HOME=.local/ai-todo node dist/cli.js doctor
AI_TODO_HOME=.local/ai-todo node dist/cli.js open
```

The UI listens on [http://127.0.0.1:3111/](http://127.0.0.1:3111/) by default.
Use `node dist/cli.js open --port <port>` to choose another port. If `3111` is
already occupied, AI-Todo reports the conflict instead of silently switching
ports.

`npm start` runs the default CLI command, which is `doctor`. Use
`node dist/cli.js open` to start the UI.

## First Use

After the UI is running:

1. Scan Codex or Claude Code sessions from the UI, or run `scan` from the CLI.
2. Run `organize` to ask the configured LLM to create todo cards.
3. Review each todo card and open its evidence before marking it done or ignored.

CLI example:

```bash
AI_TODO_HOME=.local/ai-todo node dist/cli.js scan codex
AI_TODO_HOME=.local/ai-todo node dist/cli.js scan claude-code
AI_TODO_HOME=.local/ai-todo node dist/cli.js organize
AI_TODO_HOME=.local/ai-todo node dist/cli.js list
```

## Commands

| Command | Description |
| --- | --- |
| `ai-todo init` | Create the local `.env` config and database directory. |
| `ai-todo doctor` | Show config paths and LLM setup without printing secrets. |
| `ai-todo scan <codex\|claude-code> [path]` | Import sessions from a configured or explicit source path. |
| `ai-todo organize` | Run LLM-only todo extraction over recent observations. |
| `ai-todo list` | Print current todo cards. |
| `ai-todo done <id>` / `ai-todo ignore <id>` | Mark a todo complete or ignored. |
| `ai-todo open [--port <n>]` | Start the local HTTP UI. |
| `ai-todo mcp` | Run the stdio MCP server. |

## Configuration

Config lives in `$AI_TODO_HOME/.env`, or `~/.ai-todo/.env` when
`AI_TODO_HOME` is not set.

Common keys:

```bash
AI_TODO_CODEX_HOME=~/.codex
AI_TODO_CLAUDE_HOME=~/.claude/projects
AI_TODO_LLM_ENABLED=true
AI_TODO_LLM_PROVIDER=openai
AI_TODO_LLM_MODEL=deepseek/deepseek-v4-flash
AI_TODO_LLM_ENDPOINT=https://api.novita.ai/openai/v1
AI_TODO_LLM_API_KEY=...
```

`ai-todo doctor` reports whether the key, model, and endpoint are configured.

## Sources

- Codex sessions default to `~/.codex`.
- Claude Code sessions default to `~/.claude/projects`.
- Browser sessions can be posted to `POST /browser/sessions` while the local UI
  server is running.

Raw evidence keeps its original language. Product controls are English-only.

## Privacy

AI-Todo stores data locally under `$AI_TODO_HOME` or `~/.ai-todo`.
Do not commit real `.env` files, API keys, local data, `dist/`, or
`node_modules/`.

## Development

```bash
npm test
npm run build
git diff --check
```

The package bin is `ai-todo` and points at `dist/cli.js`; run `npm run build`
before testing installed CLI behavior.
