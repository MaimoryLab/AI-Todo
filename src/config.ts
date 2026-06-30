import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AppPaths } from "./paths.js";

export const DEFAULT_LLM_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_LLM_PROVIDER = "openai";
export const DEFAULT_LLM_ENDPOINT = "https://api.novita.ai/openai/v1";
export const DEFAULT_LLM_TIMEOUT_MS = 120000;
export const DEFAULT_ORGANIZE_SINCE_DAYS = 7;
export const DEFAULT_ORGANIZE_MAX_INTERACTIONS_PER_SESSION = 10;
export const DEFAULT_ORGANIZE_MAX_SESSIONS = 16;
export const DEFAULT_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION = 40;

const DEFAULT_CODEX_HOME = join(homedir(), ".codex");
const DEFAULT_CLAUDE_HOME = join(homedir(), ".claude", "projects");
const IGNORED_ENV_KEYS = new Set(["AI_TODO_LLM_" + "PYTHON"]);

export interface AppConfig {
  sources: {
    codex: { path?: string };
    "claude-code": { path?: string };
  };
  llm: {
    enabled: boolean;
    provider: "openai";
    model: string;
    endpoint: string;
    thinkingDepth: "low" | "medium" | "high";
    timeoutMs: number;
  };
  organize: {
    sinceDays: number;
    maxInteractionsPerSession: number;
    maxSessions: number;
    maxObservationsPerSession: number;
  };
}

export interface AppSecrets {
  llmApiKey?: string;
}

export type PublicAppConfig = AppConfig & {
  llm: AppConfig["llm"] & {
    apiKeyConfigured: boolean;
    apiKeyMasked: string;
  };
};

export const WRITABLE_ENV_KEYS = [
  "AI_TODO_CODEX_HOME",
  "AI_TODO_CLAUDE_HOME",
  "AI_TODO_LLM_ENABLED",
  "AI_TODO_LLM_PROVIDER",
  "AI_TODO_LLM_MODEL",
  "AI_TODO_LLM_ENDPOINT",
  "AI_TODO_LLM_THINKING_DEPTH",
  "AI_TODO_LLM_TIMEOUT_MS",
  "AI_TODO_LLM_API_KEY",
  "AI_TODO_ORGANIZE_SINCE_DAYS",
  "AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION",
  "AI_TODO_ORGANIZE_MAX_SESSIONS",
  "AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION"
] as const;

export type WritableEnvKey = typeof WRITABLE_ENV_KEYS[number];
export type EnvConfig = Partial<Record<WritableEnvKey, string>>;

export function defaultConfig(): AppConfig {
  return {
    sources: {
      codex: {},
      "claude-code": {}
    },
    llm: {
      enabled: true,
      provider: DEFAULT_LLM_PROVIDER,
      model: DEFAULT_LLM_MODEL,
      endpoint: DEFAULT_LLM_ENDPOINT,
      thinkingDepth: "medium",
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS
    },
    organize: {
      sinceDays: DEFAULT_ORGANIZE_SINCE_DAYS,
      maxInteractionsPerSession: DEFAULT_ORGANIZE_MAX_INTERACTIONS_PER_SESSION,
      maxSessions: DEFAULT_ORGANIZE_MAX_SESSIONS,
      maxObservationsPerSession: DEFAULT_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION
    }
  };
}

export function defaultEnvConfig(includeApiKey?: string): EnvConfig {
  return sanitizeEnvConfig({
    AI_TODO_CODEX_HOME: DEFAULT_CODEX_HOME,
    AI_TODO_CLAUDE_HOME: DEFAULT_CLAUDE_HOME,
    AI_TODO_LLM_ENABLED: "true",
    AI_TODO_LLM_PROVIDER: DEFAULT_LLM_PROVIDER,
    AI_TODO_LLM_MODEL: DEFAULT_LLM_MODEL,
    AI_TODO_LLM_ENDPOINT: DEFAULT_LLM_ENDPOINT,
    AI_TODO_LLM_THINKING_DEPTH: "medium",
    AI_TODO_LLM_TIMEOUT_MS: String(DEFAULT_LLM_TIMEOUT_MS),
    AI_TODO_LLM_API_KEY: includeApiKey,
    AI_TODO_ORGANIZE_SINCE_DAYS: String(DEFAULT_ORGANIZE_SINCE_DAYS),
    AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION: String(DEFAULT_ORGANIZE_MAX_INTERACTIONS_PER_SESSION),
    AI_TODO_ORGANIZE_MAX_SESSIONS: String(DEFAULT_ORGANIZE_MAX_SESSIONS),
    AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION: String(DEFAULT_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION)
  });
}

export function loadConfig(paths: AppPaths): AppConfig {
  const jsonConfig = loadJsonConfig(paths);
  return parseConfig(applyEnvConfig(jsonConfig, loadEnvConfig(paths)));
}

export function saveConfig(paths: AppPaths, config: AppConfig): void {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.configPath, `${JSON.stringify(parseConfig(config), null, 2)}\n`);
}

export function loadSecrets(paths: AppPaths): AppSecrets {
  const env = loadEnvConfig(paths);
  if (env.AI_TODO_LLM_API_KEY) return { llmApiKey: env.AI_TODO_LLM_API_KEY };
  if (!existsSync(paths.secretsPath)) return {};
  try {
    return parseSecrets(JSON.parse(readFileSync(paths.secretsPath, "utf8")));
  } catch {
    throw new Error("secrets_invalid");
  }
}

export function saveSecrets(paths: AppPaths, secrets: AppSecrets): void {
  if (existsSync(paths.envPath)) {
    const env = loadEnvConfig(paths);
    if (secrets.llmApiKey) env.AI_TODO_LLM_API_KEY = secrets.llmApiKey;
    else delete env.AI_TODO_LLM_API_KEY;
    saveEnvConfig(paths, env);
    return;
  }
  mkdirSync(paths.configDir, { recursive: true });
  const parsed = parseSecrets(secrets);
  writeFileSync(paths.secretsPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
}

export function loadEnvConfig(paths: AppPaths): EnvConfig {
  if (!existsSync(paths.envPath)) return {};
  return parseEnvFile(readFileSync(paths.envPath, "utf8"));
}

export function saveEnvConfig(paths: AppPaths, env: EnvConfig): void {
  mkdirSync(paths.configDir, { recursive: true });
  const sanitized = sanitizeEnvConfig(env);
  writeFileSync(paths.envPath, `${formatEnvFile(sanitized)}\n`, { mode: 0o600 });
  chmodSync(paths.envPath, 0o600);
}

export function ensureDefaultEnv(paths: AppPaths, overrides: EnvConfig = {}): EnvConfig {
  const env = existsSync(paths.envPath)
    ? { ...defaultEnvConfig(), ...loadEnvConfig(paths), ...sanitizeEnvConfig(overrides) }
    : { ...defaultEnvConfig(), ...sanitizeEnvConfig(overrides) };
  saveEnvConfig(paths, env);
  return env;
}

export function publicConfig(config: AppConfig, secrets: AppSecrets): PublicAppConfig {
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKeyConfigured: !!secrets.llmApiKey,
      apiKeyMasked: maskSecret(secrets.llmApiKey)
    }
  };
}

export function parseSettingsUpdate(input: unknown): { config: AppConfig; apiKey?: string } {
  const record = objectValue(input);
  if (!record) throw new Error("config_invalid");
  const llm = objectValue(record.llm);
  const apiKey = llm && "apiKey" in llm ? llm.apiKey : undefined;
  if (apiKey !== undefined && typeof apiKey !== "string") throw new Error("config_invalid");
  if (llm && "apiKey" in llm) {
    const { apiKey: _apiKey, ...rest } = llm;
    return { config: parseConfig({ ...record, llm: rest }), apiKey };
  }
  return { config: parseConfig(record) };
}

export function settingsToEnv(config: AppConfig, currentSecrets: AppSecrets, apiKey?: string): EnvConfig {
  const env = configToEnv(config);
  if (apiKey !== undefined) {
    if (apiKey.trim()) env.AI_TODO_LLM_API_KEY = apiKey.trim();
    else delete env.AI_TODO_LLM_API_KEY;
  } else if (currentSecrets.llmApiKey) {
    env.AI_TODO_LLM_API_KEY = currentSecrets.llmApiKey;
  }
  return env;
}

export function configToEnv(config: AppConfig): EnvConfig {
  const parsed = parseConfig(config);
  return sanitizeEnvConfig({
    AI_TODO_CODEX_HOME: parsed.sources.codex.path,
    AI_TODO_CLAUDE_HOME: parsed.sources["claude-code"].path,
    AI_TODO_LLM_ENABLED: String(parsed.llm.enabled),
    AI_TODO_LLM_PROVIDER: parsed.llm.provider,
    AI_TODO_LLM_MODEL: parsed.llm.model,
    AI_TODO_LLM_ENDPOINT: parsed.llm.endpoint,
    AI_TODO_LLM_THINKING_DEPTH: parsed.llm.thinkingDepth,
    AI_TODO_LLM_TIMEOUT_MS: String(parsed.llm.timeoutMs),
    AI_TODO_ORGANIZE_SINCE_DAYS: String(parsed.organize.sinceDays),
    AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION: String(parsed.organize.maxInteractionsPerSession),
    AI_TODO_ORGANIZE_MAX_SESSIONS: String(parsed.organize.maxSessions),
    AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION: String(parsed.organize.maxObservationsPerSession)
  });
}

export function parseConfig(input: unknown): AppConfig {
  const record = objectValue(input);
  if (!record) throw new Error("config_invalid");
  const sources = objectValue(record.sources);
  if (!sources) throw new Error("config_invalid");
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "sources" && key !== "llm" && key !== "organize")) throw new Error("config_invalid");
  const sourceKeys = Object.keys(sources);
  if (sourceKeys.some((key) => key !== "codex" && key !== "claude-code")) throw new Error("config_invalid");
  return {
    sources: {
      codex: sourceConfig(sources.codex),
      "claude-code": sourceConfig(sources["claude-code"])
    },
    llm: llmConfig(record.llm),
    organize: organizeConfig(record.organize)
  };
}

export function normalizeConfig(input: unknown): AppConfig {
  try {
    return parseConfig(input);
  } catch {
    return defaultConfig();
  }
}

export function parseEnvFile(text: string): EnvConfig {
  const env: EnvConfig = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("env_invalid");
    const key = line.slice(0, separator).trim();
    if (!isWritableEnvKey(key)) {
      if (IGNORED_ENV_KEYS.has(key)) continue;
      throw new Error("env_invalid");
    }
    env[key] = parseEnvValue(line.slice(separator + 1));
  }
  return sanitizeEnvConfig(env);
}

export function formatEnvFile(env: EnvConfig): string {
  const sanitized = sanitizeEnvConfig(env);
  return WRITABLE_ENV_KEYS
    .filter((key) => sanitized[key] !== undefined)
    .map((key) => `${key}=${quoteEnvValue(sanitized[key] ?? "")}`)
    .join("\n");
}

export function maskSecret(value: string | undefined): string {
  if (!value?.trim()) return "";
  const secret = value.trim();
  if (secret.length <= 8) return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
  return `${secret.slice(0, 3)}****${secret.slice(-4)}`;
}

function loadJsonConfig(paths: AppPaths): AppConfig {
  if (!existsSync(paths.configPath)) return defaultConfig();
  try {
    return parseConfig(JSON.parse(readFileSync(paths.configPath, "utf8")));
  } catch (error) {
    if ((error as Error).message === "config_invalid") throw error;
    throw new Error("config_invalid");
  }
}

function applyEnvConfig(config: AppConfig, env: EnvConfig): AppConfig {
  const next: AppConfig = {
    sources: {
      codex: { ...config.sources.codex },
      "claude-code": { ...config.sources["claude-code"] }
    },
    llm: { ...config.llm },
    organize: { ...config.organize }
  };
  if (env.AI_TODO_CODEX_HOME) next.sources.codex = { path: cleanSourcePath(env.AI_TODO_CODEX_HOME) };
  if (env.AI_TODO_CLAUDE_HOME) next.sources["claude-code"] = { path: cleanSourcePath(env.AI_TODO_CLAUDE_HOME) };
  if (env.AI_TODO_LLM_ENABLED !== undefined) next.llm.enabled = parseBoolean(env.AI_TODO_LLM_ENABLED);
  if (env.AI_TODO_LLM_PROVIDER !== undefined) {
    if (env.AI_TODO_LLM_PROVIDER !== "openai") throw new Error("config_invalid");
    next.llm.provider = "openai";
  }
  if (env.AI_TODO_LLM_MODEL) next.llm.model = env.AI_TODO_LLM_MODEL;
  if (env.AI_TODO_LLM_ENDPOINT) next.llm.endpoint = env.AI_TODO_LLM_ENDPOINT;
  if (env.AI_TODO_LLM_THINKING_DEPTH !== undefined) next.llm.thinkingDepth = parseThinkingDepth(env.AI_TODO_LLM_THINKING_DEPTH);
  if (env.AI_TODO_LLM_TIMEOUT_MS !== undefined) next.llm.timeoutMs = parseIntRange(env.AI_TODO_LLM_TIMEOUT_MS, 1000, 600000);
  if (env.AI_TODO_ORGANIZE_SINCE_DAYS !== undefined) {
    next.organize.sinceDays = parseIntRange(env.AI_TODO_ORGANIZE_SINCE_DAYS, 1, 3650);
  }
  if (env.AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION !== undefined) {
    next.organize.maxInteractionsPerSession = parseIntRange(env.AI_TODO_ORGANIZE_MAX_INTERACTIONS_PER_SESSION, 1, 500);
  }
  if (env.AI_TODO_ORGANIZE_MAX_SESSIONS !== undefined) {
    next.organize.maxSessions = parseIntRange(env.AI_TODO_ORGANIZE_MAX_SESSIONS, 1, 200);
  }
  if (env.AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION !== undefined) {
    next.organize.maxObservationsPerSession = parseIntRange(env.AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION, 1, 1000);
  }
  return parseConfig(next);
}

function sourceConfig(value: unknown): { path?: string } {
  const input = objectValue(value);
  if (!input) throw new Error("config_invalid");
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "path")) throw new Error("config_invalid");
  const path = input.path;
  if (path === undefined) return {};
  if (typeof path !== "string" || !path.trim()) throw new Error("config_invalid");
  const cleaned = cleanSourcePath(path);
  return cleaned ? { path: cleaned } : {};
}

function cleanSourcePath(path: string): string | undefined {
  const trimmed = path.trim();
  if (!trimmed) return undefined;
  if (isStaleTempSourcePath(trimmed) && !existsSync(trimmed)) return undefined;
  return trimmed;
}

function isStaleTempSourcePath(path: string): boolean {
  return /\/ai-todo-http-[A-Za-z0-9_-]+(?:\/|$)/.test(path);
}

function llmConfig(value: unknown): AppConfig["llm"] {
  if (value === undefined) return defaultConfig().llm;
  const input = objectValue(value);
  if (!input) throw new Error("config_invalid");
  const keys = Object.keys(input);
  if (keys.some((key) => !["enabled", "provider", "model", "endpoint", "thinkingDepth", "timeoutMs"].includes(key))) {
    throw new Error("config_invalid");
  }
  if (typeof input.enabled !== "boolean") throw new Error("config_invalid");
  if (input.provider !== "openai") throw new Error("config_invalid");
  const model = nonEmptyString(input.model);
  const endpoint = nonEmptyString(input.endpoint);
  const thinkingDepth = parseThinkingDepth(input.thinkingDepth);
  const timeoutMs = input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error("config_invalid");
  }
  return { enabled: input.enabled, provider: "openai", model, endpoint, thinkingDepth, timeoutMs };
}

function organizeConfig(value: unknown): AppConfig["organize"] {
  if (value === undefined) return defaultConfig().organize;
  const input = objectValue(value);
  if (!input) throw new Error("config_invalid");
  const keys = Object.keys(input);
  if (keys.some((key) =>
    key !== "sinceDays" &&
    key !== "maxInteractionsPerSession" &&
    key !== "maxSessions" &&
    key !== "maxObservationsPerSession"
  )) throw new Error("config_invalid");
  const defaults = defaultConfig().organize;
  return {
    sinceDays: numberRange(input.sinceDays, 1, 3650),
    maxInteractionsPerSession: numberRange(input.maxInteractionsPerSession, 1, 500),
    maxSessions: input.maxSessions === undefined ? defaults.maxSessions : numberRange(input.maxSessions, 1, 200),
    maxObservationsPerSession: input.maxObservationsPerSession === undefined
      ? defaults.maxObservationsPerSession
      : numberRange(input.maxObservationsPerSession, 1, 1000)
  };
}

function parseSecrets(input: unknown): AppSecrets {
  const record = objectValue(input);
  if (!record) throw new Error("secrets_invalid");
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "llmApiKey")) throw new Error("secrets_invalid");
  if (record.llmApiKey === undefined) return {};
  return { llmApiKey: nonEmptyString(record.llmApiKey) };
}

function sanitizeEnvConfig(input: EnvConfig): EnvConfig {
  const env: EnvConfig = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isWritableEnvKey(key)) throw new Error("env_invalid");
    if (value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    if (/[\r\n]/.test(text)) throw new Error("env_invalid");
    env[key] = text;
  }
  return env;
}

function parseEnvValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

function quoteEnvValue(value: string): string {
  if (/[\s#'"]/.test(value)) return JSON.stringify(value);
  return value;
}

function isWritableEnvKey(key: string): key is WritableEnvKey {
  return (WRITABLE_ENV_KEYS as readonly string[]).includes(key);
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("config_invalid");
  return value.trim();
}

function parseThinkingDepth(value: unknown): "low" | "medium" | "high" {
  if (value !== "low" && value !== "medium" && value !== "high") throw new Error("config_invalid");
  return value;
}

function parseBoolean(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("config_invalid");
}

function parseIntRange(value: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error("config_invalid");
  return numberRange(Number(value), min, max);
}

function numberRange(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error("config_invalid");
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
