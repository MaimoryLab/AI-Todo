# Development

Local development, testing, and debugging for AI Todo. For PR flow, DCO
sign-off, coding style, and how to add an MCP tool / hook, see
[CONTRIBUTING.md](../CONTRIBUTING.md). For module boundaries, code patterns,
and the Definition of Done, see [AGENTS.md](../AGENTS.md).

## Requirements

- Node.js 20+
- npm

## Setup

```bash
cp .env.example .env   # optional — defaults work for local use
npm install
```

## Commands

Unified entrypoints — thin wrappers over the npm scripts, the same command for
humans, CI, and agents:

```bash
./scripts/dev.sh     # run the daemon from source   (= npm run dev)
./scripts/test.sh    # run the test suite           (= npm test)
./scripts/lint.sh    # consistency guard            (= npm run check:consistency-local)
```

Authoritative pre-PR gate (run before pushing):

```bash
npm run pre-pr       # consistency + build + test
```

Other useful scripts:

```bash
npm run build            # bundle (tsdown) + copy viewer assets into dist/
npm run start            # run the built daemon (node dist/cli.mjs)
npm run test:integration # integration tests
```

> There is no standalone linter. `./scripts/lint.sh` runs the local consistency
> guard (counts / version drift); `npm run pre-pr` is the authoritative gate.

## Testing rules

- Bug fixes include a regression test.
- REST / MCP changes include integration coverage.
- Core logic changes include unit-style tests in `test/` (`.test.ts`).
- Doc-only changes don't need a full test run unless examples changed.

## Debugging

1. Reproduce the issue.
2. Find the smallest failing test or command.
3. Fix the cause, not the symptom.
4. Add a regression test when possible.

> `ARCHITECTURE.md` (data flow, design principles) is planned — PLAN-003 STEP-01.
> Until it lands, see the Architecture section of [AGENTS.md](../AGENTS.md).
