#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { Database } from "./db/index.js";
import { openDatabase } from "./db/index.js";
import { getAppPaths } from "./paths.js";
import { runMcpStdio } from "./mcp/stdio.js";
import { createAppServer, createStartupScanner } from "./server/index.js";
import { scanSource } from "./sources/scan.js";
import { defaultEnvConfig, ensureDefaultEnv, type EnvConfig } from "./config.js";
import { getLlmDoctorStatus, organizeConfiguredTodos } from "./todos/configured.js";
import { listTodos, updateTodoStatus } from "./todos/service.js";

export const DEFAULT_UI_PORT = 3111;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "doctor";

  if (command === "init") {
    return init(argv.slice(1));
  }

  if (command === "doctor") {
    const paths = getAppPaths();
    mkdirSync(paths.configDir, { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    openDatabase(paths).close();
    const llm = getLlmDoctorStatus(paths);
    console.log(`config: ${paths.configDir}`);
    console.log(`env: ${paths.envPath}`);
    if (!existsSync(paths.envPath)) console.log("env status: missing; run ai-todo init");
    console.log(`data: ${paths.dataDir}`);
    console.log(`llm enabled: ${llm.enabled}`);
    console.log(`llm key: ${llm.keyConfigured ? "configured" : "missing"}`);
    console.log(`llm model: ${llm.model}`);
    console.log(`llm endpoint: ${llm.endpoint}`);
    console.log("ok");
    return 0;
  }

  if (command === "scan") {
    return withDatabase((db) => scan(db, argv[1], argv[2]));
  }

  if (command === "organize") {
    const paths = getAppPaths();
    return withDatabase(async (db) => {
      const result = await organizeConfiguredTodos(db, paths);
      console.log(`scanned: ${result.scanned}`);
      console.log(`created: ${result.created}`);
      console.log(`updated: ${result.updated}`);
      console.log(`completed: ${result.completed}`);
      console.log(`ignored: ${result.ignored}`);
      console.log(`engine: ${result.engine}`);
      if (result.warnings.length > 0) console.log(`warnings: ${result.warnings.join(",")}`);
      return 0;
    });
  }

  if (command === "list") {
    return withDatabase((db) => {
      const todos = listTodos(db);
      if (todos.length === 0) {
        console.log("No todos");
        return 0;
      }
      for (const todo of todos) {
        console.log(`${todo.id} ${todo.status} ${todo.title}`);
      }
      return 0;
    });
  }

  if (command === "done" || command === "ignore") {
    return withDatabase((db) => updateStatus(db, argv[1], command === "done" ? "done" : "ignored"));
  }

  if (command === "open") {
    return openUi(argv.slice(1));
  }

  if (command === "mcp") {
    await runMcpStdio();
    return 0;
  }

  console.error(`unknown command: ${command}`);
  return 1;
}

async function init(argv: string[]): Promise<number> {
  const paths = getAppPaths();
  const args = parseOptions(argv);
  let env: EnvConfig = {
    AI_TODO_LLM_ENABLED: args["llm-enabled"],
    AI_TODO_LLM_PROVIDER: args.provider,
    AI_TODO_LLM_API_KEY: args["api-key"],
    AI_TODO_LLM_MODEL: args.model,
    AI_TODO_LLM_ENDPOINT: args.endpoint,
    AI_TODO_CODEX_HOME: args["codex-home"],
    AI_TODO_CLAUDE_HOME: args["claude-home"],
    AI_TODO_ORGANIZE_SINCE_DAYS: args["since-days"],
    AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION: args["max-interactions"],
    AI_TODO_ORGANIZE_MAX_SESSIONS: args["max-sessions"],
    AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION: args["max-observations"]
  };

  if (process.stdin.isTTY && Object.keys(args).length === 0) {
    env = await promptInit(env);
  }

  ensureDefaultEnv(paths, env);
  mkdirSync(paths.dataDir, { recursive: true });
  openDatabase(paths).close();
  console.log(`env: ${paths.envPath}`);
  console.log("initialized");
  return 0;
}

async function promptInit(defaults: EnvConfig): Promise<EnvConfig> {
  const rl = createInterface({ input, output });
  const env = { ...defaultEnvConfig(), ...defaults };
  try {
    return {
      AI_TODO_CODEX_HOME: await ask(rl, "Codex source path", env.AI_TODO_CODEX_HOME),
      AI_TODO_CLAUDE_HOME: await ask(rl, "Claude Code source path", env.AI_TODO_CLAUDE_HOME),
      AI_TODO_LLM_ENABLED: await ask(rl, "LLM enabled", env.AI_TODO_LLM_ENABLED),
      AI_TODO_LLM_PROVIDER: await ask(rl, "LLM provider", env.AI_TODO_LLM_PROVIDER),
      AI_TODO_LLM_MODEL: await ask(rl, "LLM model", env.AI_TODO_LLM_MODEL),
      AI_TODO_LLM_ENDPOINT: await ask(rl, "LLM endpoint", env.AI_TODO_LLM_ENDPOINT),
      AI_TODO_LLM_API_KEY: await ask(rl, "LLM API key", env.AI_TODO_LLM_API_KEY),
      AI_TODO_ORGANIZE_SINCE_DAYS: await ask(rl, "Look-back days", env.AI_TODO_ORGANIZE_SINCE_DAYS),
      AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION: await ask(rl, "Max interactions per session", env.AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION),
      AI_TODO_ORGANIZE_MAX_SESSIONS: await ask(rl, "Max sessions", env.AI_TODO_ORGANIZE_MAX_SESSIONS),
      AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION: await ask(rl, "Max observations per session", env.AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION)
    };
  } finally {
    rl.close();
  }
}

async function ask(rl: ReturnType<typeof createInterface>, label: string, value: string | undefined): Promise<string | undefined> {
  const suffix = value ? ` [${value}]` : "";
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer || value;
}

function parseOptions(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    index++;
  }
  return args;
}

async function withDatabase(fn: (db: Database) => number | Promise<number>): Promise<number> {
  const db = openDatabase(getAppPaths());
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function openUi(argv: string[] = []): Promise<number> {
  const args = parseOptions(argv);
  const port = args.port ? Number(args.port) : DEFAULT_UI_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("invalid port");
    return 1;
  }
  const paths = getAppPaths();
  const db = openDatabase(paths);
  let dbClosed = false;
  const closeDb = () => {
    if (dbClosed) return;
    dbClosed = true;
    db.close();
  };
  const startupScanner = createStartupScanner(db, paths);
  const server = createAppServer({ db, paths, startupScan: startupScanner.status });
  try {
    await listen(server, port);
  } catch (error) {
    closeDb();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`${port} is already in use. Try ai-todo open --port <port>.`);
      return 1;
    }
    console.error((error as Error).message);
    return 1;
  }
  startupScanner.start();
  const address = server.address();
  if (!address || typeof address === "string") {
    closeDb();
    return 1;
  }
  console.log(`AI-Todo UI: http://127.0.0.1:${address.port}/`);
  console.log("Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      server.close(() => {
        closeDb();
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

function listen(server: ReturnType<typeof createAppServer>, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function scan(db: Database, source: string | undefined, path: string | undefined): number {
  if (!source) {
    console.error("usage: ai-todo scan <codex|claude-code> [path]");
    return 1;
  }

  const scan = scanSource(db, source, path);
  if (!scan.ok && scan.error === "unsupported_source") {
    console.error(`unsupported source: ${source}`);
    return 1;
  }
  if (!scan.ok) {
    console.error(`path not found for ${source}`);
    return 1;
  }

  const result = scan.result;
  console.log(`source: ${result.source}`);
  console.log(`scanned: ${result.scanned}`);
  console.log(`observations: ${result.observations}`);
  console.log(`skipped: ${result.skipped}`);
  return 0;
}

function updateStatus(db: Database, id: string | undefined, status: "done" | "ignored"): number {
  if (!id) {
    console.error("missing todo id");
    return 1;
  }
  if (!updateTodoStatus(db, id, status)) {
    console.error(`todo not found: ${id}`);
    return 1;
  }
  console.log(`${status}: ${id}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
