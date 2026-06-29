import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAppPaths } from "../src/paths.js";
import { loadConfig, loadSecrets, maskSecret, saveConfig, saveSecrets } from "../src/config.js";
import { resolveSourcePath } from "../src/sources/scan.js";

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
        pythonPath: "python3",
        timeoutMs: 120000
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
        pythonPath: "/usr/bin/python3",
        timeoutMs: 30000
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
        pythonPath: "python3",
        timeoutMs: 120000
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
      }
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
      }
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
      }
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
      }
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
