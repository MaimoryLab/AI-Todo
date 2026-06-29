import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AppPaths } from "./paths.js";

export const DEFAULT_LLM_MODEL = "deepseek/deepseek-v4-flash";
export const DEFAULT_LLM_PROVIDER = "openai";
export const DEFAULT_LLM_ENDPOINT = "https://api.novita.ai/openai/v1";
export const DEFAULT_LLM_TIMEOUT_MS = 120000;

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
    pythonPath?: string;
    timeoutMs: number;
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
      pythonPath: "python3",
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS
    }
  };
}

export function loadConfig(paths: AppPaths): AppConfig {
  if (!existsSync(paths.configPath)) return defaultConfig();
  try {
    return parseConfig(JSON.parse(readFileSync(paths.configPath, "utf8")));
  } catch (error) {
    if ((error as Error).message === "config_invalid") throw error;
    throw new Error("config_invalid");
  }
}

export function saveConfig(paths: AppPaths, config: AppConfig): void {
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.configPath, `${JSON.stringify(parseConfig(config), null, 2)}\n`);
}

export function parseConfig(input: unknown): AppConfig {
  const record = objectValue(input);
  if (!record) throw new Error("config_invalid");
  const sources = objectValue(record?.sources);
  if (!sources) throw new Error("config_invalid");
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "sources" && key !== "llm")) throw new Error("config_invalid");
  const sourceKeys = Object.keys(sources);
  if (sourceKeys.some((key) => key !== "codex" && key !== "claude-code")) throw new Error("config_invalid");
  return {
    sources: {
      codex: sourceConfig(sources.codex),
      "claude-code": sourceConfig(sources["claude-code"])
    },
    llm: llmConfig(record.llm)
  };
}

export function normalizeConfig(input: unknown): AppConfig {
  try {
    return parseConfig(input);
  } catch {
    return defaultConfig();
  }
}

function sourceConfig(value: unknown): { path?: string } {
  const input = objectValue(value);
  if (!input) throw new Error("config_invalid");
  const keys = Object.keys(input);
  if (keys.some((key) => key !== "path")) throw new Error("config_invalid");
  const path = input?.path;
  if (path === undefined) return {};
  if (typeof path !== "string" || !path.trim()) throw new Error("config_invalid");
  return { path: path.trim() };
}

function llmConfig(value: unknown): AppConfig["llm"] {
  if (value === undefined) return defaultConfig().llm;
  const input = objectValue(value);
  if (!input) throw new Error("config_invalid");
  const keys = Object.keys(input);
  if (keys.some((key) => !["enabled", "provider", "model", "endpoint", "thinkingDepth", "pythonPath", "timeoutMs"].includes(key))) {
    throw new Error("config_invalid");
  }
  const enabled = input.enabled;
  if (typeof enabled !== "boolean") throw new Error("config_invalid");
  if (input.provider !== "openai") throw new Error("config_invalid");
  const model = nonEmptyString(input.model);
  const endpoint = nonEmptyString(input.endpoint);
  if (input.thinkingDepth !== "low" && input.thinkingDepth !== "medium" && input.thinkingDepth !== "high") {
    throw new Error("config_invalid");
  }
  const pythonPath = input.pythonPath === undefined ? undefined : nonEmptyString(input.pythonPath);
  const timeoutMs = input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
    throw new Error("config_invalid");
  }
  return { enabled, provider: "openai", model, endpoint, thinkingDepth: input.thinkingDepth, pythonPath, timeoutMs };
}

export function loadSecrets(paths: AppPaths): AppSecrets {
  if (!existsSync(paths.secretsPath)) return {};
  try {
    return parseSecrets(JSON.parse(readFileSync(paths.secretsPath, "utf8")));
  } catch {
    throw new Error("secrets_invalid");
  }
}

export function saveSecrets(paths: AppPaths, secrets: AppSecrets): void {
  mkdirSync(paths.configDir, { recursive: true });
  const parsed = parseSecrets(secrets);
  writeFileSync(paths.secretsPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
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

function parseSecrets(input: unknown): AppSecrets {
  const record = objectValue(input);
  if (!record) throw new Error("secrets_invalid");
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "llmApiKey")) throw new Error("secrets_invalid");
  if (record.llmApiKey === undefined) return {};
  return { llmApiKey: nonEmptyString(record.llmApiKey) };
}

export function maskSecret(value: string | undefined): string {
  if (!value?.trim()) return "";
  const secret = value.trim();
  if (secret.length <= 8) return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
  return `${secret.slice(0, 3)}****${secret.slice(-4)}`;
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("config_invalid");
  return value.trim();
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
