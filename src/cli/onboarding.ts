// First-run interactive onboarding flow.
//
// Wakes up only when `isFirstRun()` is true (preferences are missing or
// have never recorded a `firstRunAt`) or when the user passes
// `--reset`. The flow asks for:
//
//   1. Which agent sessions AI-Todo should scan for To-Dos (multi-select).
//   2. Which model AI-Todo uses to extract To-Dos — this seeds the
//      LangExtract (`LANGEXTRACT_*`) config. "Skip" keeps the deterministic
//      rules extractor (no LLM key needed). The legacy memory-compression
//      provider is NOT asked here — it's an advanced `.env`-only setting.
//
// We then write `~/.agentmemory/preferences.json` and ensure
// `~/.agentmemory/.env` exists (seeding the chosen extractor model's
// `LANGEXTRACT_*` defaults). The user adds `LANGEXTRACT_API_KEY` after.

import { copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { writePrefs } from "./preferences.js";
import { resolveAdapter, runAdapter } from "./connect/index.js";
import type { ConnectResult } from "./connect/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function homeDir(): string {
  return process.env["HOME"] || process.env["USERPROFILE"] || homedir();
}

// Native plugin row — these agents ship an agentmemory plugin or
// first-party integration. Glyphs match SkillKit's published set
// where they overlap; the rest fall back to the generic `◇`.
const NATIVE_AGENTS: { value: string; label: string; glyph: string }[] = [
  { value: "codex", label: "Codex", glyph: "◎" },
];

// MCP-only row — emptied by PLAN-006 P2 (the inherited MCP-agent
// connectors were removed; Codex is the sole supported target).
const MCP_AGENTS: { value: string; label: string; glyph: string }[] = [];

type ExtractorModel = {
  value: string;
  label: string;
  // null = "skip": keep the deterministic rules extractor (no LLM key).
  // Otherwise the LANGEXTRACT_* config seeded into ~/.agentmemory/.env.
  // Only the LangExtract sidecar's openai-compatible branch is offered
  // (it is the only fully-wired path: api_key + base_url + reasoning_effort).
  defaults: Record<string, string> | null;
};

const SHARED_TODO_DEFAULTS: Record<string, string> = {
  AGENTMEMORY_TODO_EXTRACTOR: "langextract",
  LANGEXTRACT_PROVIDER: "openai",
  AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS: "120000",
};

// THINKING_DEPTH maps to the sidecar's `reasoning_effort`, which only
// non-reasoning models reject — so it's empty for gpt-4o-mini / deepseek-chat
// and "medium" for the reasoning-capable DeepSeek-V4 Flash default.
const EXTRACTOR_MODELS: ExtractorModel[] = [
  {
    value: "novita",
    label: "Novita · DeepSeek-V4 Flash (recommended)",
    defaults: {
      ...SHARED_TODO_DEFAULTS,
      LANGEXTRACT_MODEL: "deepseek/deepseek-v4-flash",
      LANGEXTRACT_BASE_URL: "https://api.novita.ai/openai/v1",
      LANGEXTRACT_THINKING_DEPTH: "medium",
    },
  },
  {
    value: "openai",
    label: "OpenAI · gpt-4o-mini",
    defaults: {
      ...SHARED_TODO_DEFAULTS,
      LANGEXTRACT_MODEL: "gpt-4o-mini",
      LANGEXTRACT_BASE_URL: "https://api.openai.com/v1",
      LANGEXTRACT_THINKING_DEPTH: "",
    },
  },
  {
    value: "openrouter",
    label: "OpenRouter · deepseek-chat",
    defaults: {
      ...SHARED_TODO_DEFAULTS,
      LANGEXTRACT_MODEL: "deepseek/deepseek-chat",
      LANGEXTRACT_BASE_URL: "https://openrouter.ai/api/v1",
      LANGEXTRACT_THINKING_DEPTH: "",
    },
  },
  {
    value: "skip",
    label: "Skip — rules-only extraction (no LLM key)",
    defaults: null,
  },
];

export function buildAgentOptions(): { value: string; label: string; hint?: string }[] {
  return [
    ...NATIVE_AGENTS.map((a) => ({
      value: a.value,
      label: `${a.glyph} ${a.label}`,
      hint: "native plugin",
    })),
    ...MCP_AGENTS.map((a) => ({
      value: a.value,
      label: `${a.glyph} ${a.label}`,
      hint: "MCP server",
    })),
  ];
}

export function getInitialAgentValues(
  _env: Record<string, string | undefined> = process.env,
): string[] {
  // Codex is the only wireable agent after PLAN-006 P2 removed the
  // inherited connector stack.
  return ["codex"];
}

// Mirror src/cli.ts findEnvExample so onboarding ships the same .env
// skeleton whether called directly or via `agentmemory-lab init`. We
// duplicate (rather than import) so the onboarding module doesn't
// pull cli.ts's top-level side effects into the test runner.
function findEnvExample(): string | null {
  const candidates = [
    join(__dirname, "..", "..", ".env.example"),
    join(__dirname, "..", ".env.example"),
    join(__dirname, ".env.example"),
    join(process.cwd(), ".env.example"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

async function seedEnvFile(): Promise<string | null> {
  const target = join(homeDir(), ".agentmemory", ".env");
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });

  const template = findEnvExample();
  if (template && !existsSync(target)) {
    try {
      await copyFile(template, target, fsConstants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
        return null;
      }
    }
  } else if (!template && !existsSync(target)) {
    // Fall back to a minimal skeleton so users always get a `.env` to edit.
    writeFileSync(
      target,
      [
        "# AI-Todo environment — uncomment what you need",
        "# AGENTMEMORY_URL=http://localhost:3111",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }

  return target;
}

function enableTodoExtractionDefaults(envPath: string, defaults: Record<string, string>): void {
  const current = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  const keys = new Set(
    current
      .split("\n")
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1])
      .filter((key): key is string => !!key),
  );
  const additions = Object.entries(defaults)
    .filter(([key]) => !keys.has(key))
    .map(([key, value]) => `${key}=${value}`);
  if (!additions.length) return;
  writeFileSync(envPath, `${current.replace(/\n*$/, "\n")}${additions.join("\n")}\n`, { mode: 0o600 });
}

export interface OnboardingResult {
  agents: string[];
  provider: string | null;
}

function shouldSkipInteractiveOnboarding(): boolean {
  const ci = process.env["CI"];
  return (
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    (ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false")
  );
}

function writeDefaultOnboardingPrefs(): OnboardingResult {
  writePrefs({
    lastAgent: null,
    lastAgents: [],
    lastProvider: null,
    skipSplash: true,
    firstRunAt: new Date().toISOString(),
  });
  return { agents: [], provider: null };
}

export async function runOnboarding(): Promise<OnboardingResult> {
  if (shouldSkipInteractiveOnboarding()) {
    return writeDefaultOnboardingPrefs();
  }

  p.note(
    [
      "Welcome to AI-Todo.",
      "",
      "Local-first extraction of unfinished To-Dos from your AI agent",
      "sessions, with evidence, in a local web UI. We'll pick which agent",
      "sessions to scan and which model extracts your To-Dos.",
    ].join("\n"),
    "first-run setup",
  );

  const agentsPicked = await p.multiselect<string>({
    message: "Which agents should AI-Todo scan for To-Dos? (space to toggle, enter to confirm)",
    options: buildAgentOptions(),
    required: false,
    initialValues: getInitialAgentValues(),
  });
  if (p.isCancel(agentsPicked)) {
    p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
    process.exit(0);
  }

  const pickedAgentsList = (agentsPicked as string[]) ?? [];
  if (pickedAgentsList.length > 0) {
    p.note(
      [
        "━ how this works ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "AI-Todo reads these agents' sessions locally and surfaces",
        "unfinished To-Dos — with evidence — in the web UI at :3111.",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      ].join("\n"),
    );
  }

  const modelPicked = await p.select<string>({
    message:
      "Which model should AI-Todo use to extract To-Dos? (add the API key later in Settings or ~/.agentmemory/.env)",
    options: EXTRACTOR_MODELS.map(({ value, label }) => ({ value, label })),
    initialValue: "novita",
  });
  if (p.isCancel(modelPicked)) {
    p.cancel("Setup cancelled. Re-run any time with: agentmemory --reset");
    process.exit(0);
  }

  const chosenModel = EXTRACTOR_MODELS.find((m) => m.value === modelPicked) ?? null;
  const provider = modelPicked === "skip" ? null : modelPicked;
  const agents = (agentsPicked as string[]) ?? [];

  const envPath = await seedEnvFile();
  if (chosenModel?.defaults && envPath) {
    enableTodoExtractionDefaults(envPath, chosenModel.defaults);
  }

  writePrefs({
    lastAgent: agents[0] ?? null,
    lastAgents: agents,
    lastProvider: provider,
    skipSplash: true,
    firstRunAt: new Date().toISOString(),
  });

  const prefsLocation = join(homeDir(), ".agentmemory", "preferences.json");
  const lines = [`✓ Saved preferences to ${prefsLocation}`];
  if (envPath) {
    lines.push(`✓ Wrote ${envPath}`);
  } else {
    lines.push(`! Could not write ~/.agentmemory/.env — run \`agentmemory-lab init\` after this completes.`);
  }
  if (chosenModel?.defaults) {
    lines.push(`  To-Do extraction → ${chosenModel.label}. Add LANGEXTRACT_API_KEY in Settings or ~/.agentmemory/.env before running it.`);
  } else {
    lines.push("  No model chosen — AI-Todo extracts To-Dos with the deterministic rules extractor (no LLM key needed).");
  }
  p.note(lines.join("\n"), "ready");

  if (agents.length > 0) {
    await wireSelectedAgents(agents);
  }

  return { agents, provider };
}

async function wireSelectedAgents(agents: string[]): Promise<void> {
  p.note("Wire selected agents now?", "next step");
  const confirmed = await p.confirm({
    message: "Run `agentmemory connect <agent>` for each selected agent now? [Y/n]",
    initialValue: true,
  });

  if (p.isCancel(confirmed) || confirmed === false) {
    const cmds = agents.map((a) => `  agentmemory connect ${a}`);
    p.note(["Wire later with:", ...cmds].join("\n"), "later");
    return;
  }

  const wired: string[] = [];
  const manual: { name: string; docs?: string }[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const name of agents) {
    const adapter = resolveAdapter(name);
    if (!adapter) {
      failed.push({ name, reason: "no adapter available" });
      p.log.warn(`Wiring ${name}… no adapter available (skipped).`);
      continue;
    }
    p.log.step(`Wiring ${name}...`);
    let result: ConnectResult;
    try {
      result = await runAdapter(adapter, { dryRun: false, force: false });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failed.push({ name, reason });
      p.log.error(`${name}: ${reason}`);
      continue;
    }
    switch (result.kind) {
      case "installed":
      case "already-wired":
        wired.push(name);
        break;
      case "stub":
        manual.push({ name, docs: adapter.docs });
        break;
      case "skipped":
        failed.push({ name, reason: result.reason });
        break;
    }
  }

  const summary: string[] = [];
  if (wired.length > 0) {
    summary.push(`Wired: ${wired.join(", ")}.`);
  }
  if (manual.length > 0 || failed.length > 0) {
    const parts: string[] = [];
    for (const m of manual) {
      parts.push(`${m.name} (manual install required${m.docs ? ` — see ${m.docs}` : ""})`);
    }
    for (const f of failed) {
      parts.push(`${f.name} (${f.reason})`);
    }
    summary.push(`Skipped/failed: ${parts.join(", ")}.`);
  }
  if (summary.length === 0) {
    summary.push("No agents were wired.");
  }
  p.note(summary.join("\n"), "wire summary");
}
