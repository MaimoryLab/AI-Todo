# AI-Todo

[English](README.md) | [中文](README.zh-CN.md)

AI-Todo is a local-first action inbox for AI sessions. It scans Codex, Claude Code, and browser sessions, uses your configured OpenAI-compatible LLM to extract unfinished work, and keeps source evidence available for review.

### Requirements

- Node.js 24 or newer
- An OpenAI-compatible Chat Completions API key

Without LLM configuration, AI-Todo can still open the UI and scan sources, but it cannot organize sessions into todo cards.

### Recommended: Web Workspace

From a fresh clone:

```bash
git clone https://github.com/MaimoryLab/AI-Todo.git
cd AI-Todo
./scripts/start-local.sh
```

Then open [http://127.0.0.1:3111/](http://127.0.0.1:3111/).

The script runs `npm install`, `npm run build`, and `npm start`. If dependencies are already installed and built, use `npm start`.

`start` automatically discovers default Codex and Claude Code paths at startup and writes missing source settings. It does not overwrite paths you already configured. The default port is fixed at `3111`; if it is occupied, choose one explicitly:

```bash
npm start -- --port 3112
```

Use the web workspace for daily work:

1. In `Settings`, choose Chinese or English, check Codex/Claude Code path discovery, enter your API key, adjust look-back days and max sessions if needed, then save.
2. In `Sources`, review scanned sessions and source evidence.
3. In `To-Do`, click organize, review the generated cards, then mark them done or ignored.

### CLI Usage

If you prefer the terminal, you can use only the CLI:

```bash
npm install
npm run build
AI_TODO_HOME=.local/ai-todo node dist/cli.js init --api-key <your-key>
AI_TODO_HOME=.local/ai-todo node dist/cli.js doctor
AI_TODO_HOME=.local/ai-todo node dist/cli.js scan codex
AI_TODO_HOME=.local/ai-todo node dist/cli.js scan claude-code
AI_TODO_HOME=.local/ai-todo node dist/cli.js organize
AI_TODO_HOME=.local/ai-todo node dist/cli.js list
```

| Command | Purpose |
| --- | --- |
| `init --api-key <key>` | Create local config and save the LLM key |
| `doctor` | Check config, data directory, and database |
| `start [--port <n>]` / `open [--port <n>]` | Start the web workspace |
| `scan <codex\|claude-code> [path]` | Scan a source |
| `extract` / `organize` | Ask the LLM to extract todo cards |
| `list` / `ls` | Print current todos |
| `done <id>` / `complete <id>` | Mark a card complete |
| `ignore <id>` / `dismiss <id>` | Ignore a card |
| `mcp` | Start the MCP stdio server |

### Configuration

The default config directory is `~/.ai-todo`. Set `AI_TODO_HOME` to use another location:

```bash
AI_TODO_HOME=.local/ai-todo npm start
```

The web `Settings` page and CLI read and write the same `.env` config. Common fields:

```bash
AI_TODO_CODEX_HOME=~/.codex
AI_TODO_CLAUDE_HOME=~/.claude/projects
AI_TODO_LLM_ENDPOINT=https://api.novita.ai/openai/v1
AI_TODO_LLM_MODEL=deepseek/deepseek-v4-flash
AI_TODO_LLM_API_KEY=<your-key>
AI_TODO_ORGANIZE_SINCE_DAYS=7
AI_TODO_ORGANIZE_MAX_SESSIONS=16
```

Copy `.env.example` only into your local config directory, not the repo root, when you want a starting point for file-based config.

The UI language preference is saved in browser local storage, not in `.env`.

### Sources and Privacy

- Codex: scans `sessions` and `archived_sessions` under `~/.codex` by default.
- Claude Code: scans `~/.claude/projects` by default.
- Browser: while the web server is running, browser sessions can be posted to `POST /browser/sessions`.

AI-Todo stores its database, config, and source records locally by default. During `organize`, relevant session snippets are sent to your configured LLM endpoint. Scanning imports session text and readable attachment references; it does not copy attachment files. Do not commit `.env`, `data/`, `.local/`, or real session records.

### Contributing

Issues and pull requests are welcome. Please keep reports and fixtures sanitized: no API keys, tokens, sensitive local paths, or real session transcripts. Before opening a PR, run:

```bash
npm test
npm run build
git diff --check
```

### License

Apache-2.0. See [LICENSE](LICENSE).
