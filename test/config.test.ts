import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAppPaths } from "../src/paths.js";
import {
  ensureDefaultEnv,
  formatEnvFile,
  loadConfig,
  loadEnvConfig,
  loadSecrets,
  maskSecret,
  parseEnvFile,
  saveConfig,
  saveEnvConfig,
  saveSecrets
} from "../src/config.js";
import { resolveSourcePath, resolveSourcePaths } from "../src/sources/scan.js";

test("config reads defaults and persists source paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-config-"));
  try {
    const paths = getAppPaths(dir);
    assert.deepEqual(loadConfig(paths), {
      sources: {
        codex: {},
        "claude-code": {}
      },
      llm: {
        enabled: true,
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
        endpoint: "https://api.novita.ai/openai/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000
      },
      organize: {
        sinceDays: 7,
        maxInteractionsPerSession: 10,
        maxSessions: 16,
        maxObservationsPerSession: 40
      }
    });

    const config = {
      sources: {
        codex: { path: join(dir, "codex") },
        "claude-code": { path: join(dir, "claude") }
      },
      llm: {
        enabled: true,
        provider: "openai" as const,
        model: "custom/model",
        endpoint: "https://llm.example.test/v1",
        thinkingDepth: "high" as const,
        timeoutMs: 30000
      },
      organize: {
        sinceDays: 14,
        maxInteractionsPerSession: 20,
        maxSessions: 12,
        maxObservationsPerSession: 30
      }
    };
    saveConfig(paths, config);
    assert.deepEqual(loadConfig(paths), config);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config rejects invalid files and preserves source path precedence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-config-invalid-"));
  const previousCodex = process.env.AI_TODO_CODEX_HOME;
  delete process.env.AI_TODO_CODEX_HOME;

  try {
    const paths = getAppPaths(dir);
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(paths.configPath, "{");
    assert.throws(() => loadConfig(paths), /config_invalid/);

    const explicit = join(dir, "explicit");
    const env = join(dir, "env");
    const configPath = join(dir, "config-codex");
    saveConfig(paths, {
      sources: { codex: { path: configPath }, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
        endpoint: "https://api.novita.ai/openai/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000
      },
      organize: {
        sinceDays: 7,
        maxInteractionsPerSession: 10,
        maxSessions: 8,
        maxObservationsPerSession: 40
      }
    });
    assert.equal(resolveSourcePath("codex", explicit, paths), explicit);
    process.env.AI_TODO_CODEX_HOME = env;
    assert.equal(resolveSourcePath("codex", undefined, paths), env);
    delete process.env.AI_TODO_CODEX_HOME;
    assert.equal(resolveSourcePath("codex", undefined, paths), configPath);
  } finally {
    if (previousCodex === undefined) {
      delete process.env.AI_TODO_CODEX_HOME;
    } else {
      process.env.AI_TODO_CODEX_HOME = previousCodex;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config rejects invalid llm settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-config-llm-invalid-"));
  try {
    const paths = getAppPaths(dir);
    assert.throws(() => saveConfig(paths, {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "anthropic" as any,
        model: "model",
        endpoint: "https://example.test/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000
      },
      organize: { sinceDays: 7, maxInteractionsPerSession: 10, maxSessions: 8, maxObservationsPerSession: 40 }
    }), /config_invalid/);
    assert.throws(() => saveConfig(paths, {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "",
        endpoint: "https://example.test/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000
      },
      organize: { sinceDays: 7, maxInteractionsPerSession: 10, maxSessions: 8, maxObservationsPerSession: 40 }
    }), /config_invalid/);
    assert.throws(() => saveConfig(paths, {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "model",
        endpoint: "",
        thinkingDepth: "medium",
        timeoutMs: 120000
      },
      organize: { sinceDays: 7, maxInteractionsPerSession: 10, maxSessions: 8, maxObservationsPerSession: 40 }
    }), /config_invalid/);
    assert.throws(() => saveConfig(paths, {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "model",
        endpoint: "https://example.test/v1",
        thinkingDepth: "medium",
        timeoutMs: 0
      },
      organize: { sinceDays: 7, maxInteractionsPerSession: 10, maxSessions: 8, maxObservationsPerSession: 40 }
    }), /config_invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("secrets persist separately and mask api keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-secrets-"));
  try {
    const paths = getAppPaths(dir);
    assert.deepEqual(loadSecrets(paths), {});
    saveSecrets(paths, { llmApiKey: "dummy-llm-key-value" });
    assert.equal(loadSecrets(paths).llmApiKey, "dummy-llm-key-value");
    assert.equal(maskSecret("dummy-llm-key-value"), "dum****alue");
    assert.ok(existsSync(paths.secretsPath));
    assert.match(readFileSync(paths.secretsPath, "utf8"), /dummy-llm-key-value/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env config parses comments, quotes, defaults, and masks api keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-env-"));
  try {
    const paths = getAppPaths(dir);
    saveEnvConfig(paths, parseEnvFile([
      "# local config",
      "AI_TODO_CODEX_HOME='/tmp/codex sessions'",
      "AI_TODO_LLM_MODEL=custom/model # comment",
      "AI_TODO_LLM_API_KEY=\"dummy-llm-key-value\"",
      "AI_TODO_ORGANIZE_SINCE_DAYS=30"
    ].join("\n")));
    const env = loadEnvConfig(paths);
    assert.equal(env.AI_TODO_CODEX_HOME, "/tmp/codex sessions");
    assert.equal(env.AI_TODO_LLM_MODEL, "custom/model");
    assert.equal(loadSecrets(paths).llmApiKey, "dummy-llm-key-value");
    assert.match(formatEnvFile(env), /AI_TODO_LLM_API_KEY=dummy-llm-key-value/);
    assert.throws(() => parseEnvFile("UNSUPPORTED=value"), /env_invalid/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("env config ignores removed python setting for existing installs", () => {
  const removedKey = "AI_TODO_LLM_" + "PYTHON";
  assert.deepEqual(parseEnvFile(`${removedKey}=python3\nAI_TODO_LLM_MODEL=custom/model`), {
    AI_TODO_LLM_MODEL: "custom/model"
  });
});

test("default env generation writes necessary values without empty api key", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-env-default-"));
  try {
    const paths = getAppPaths(dir);
    ensureDefaultEnv(paths);
    const text = readFileSync(paths.envPath, "utf8");
    assert.match(text, /AI_TODO_CODEX_HOME=.*\.codex/);
    assert.doesNotMatch(text, /AI_TODO_CODEX_HOME=.*\.codex\/sessions/);
    assert.match(text, /AI_TODO_LLM_MODEL=deepseek\/deepseek-v4-flash/);
    assert.match(text, /AI_TODO_ORGANIZE_SINCE_DAYS=7/);
    assert.match(text, /AI_TODO_ORGANIZE_MAX_SESSIONS=16/);
    assert.match(text, /AI_TODO_ORGANIZE_MAX_OBSERVATIONS_PER_SESSION=40/);
    assert.doesNotMatch(text, /AI_TODO_LLM_API_KEY/);
    assert.equal((readFileSync(paths.envPath).byteLength > 0), true);
    assert.equal(statSync(paths.envPath).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex home expands to sessions and archived sessions roots", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-codex-roots-"));
  try {
    const codexHome = join(dir, ".codex");
    mkdirSync(join(codexHome, "sessions"), { recursive: true });
    mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });
    assert.deepEqual(resolveSourcePaths("codex", codexHome), [
      join(codexHome, "sessions"),
      join(codexHome, "archived_sessions")
    ]);
    assert.equal(resolveSourcePath("codex", codexHome), join(codexHome, "sessions"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale temporary source paths are ignored when loading config", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-stale-config-"));
  try {
    const paths = getAppPaths(dir);
    saveEnvConfig(paths, parseEnvFile("AI_TODO_CODEX_HOME=/var/folders/x/ai-todo-http-deadbeef/codex"));
    assert.deepEqual(loadConfig(paths).sources.codex, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
