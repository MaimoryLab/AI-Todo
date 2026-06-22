import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_HOME = process.env["HOME"];
const ORIGINAL_USERPROFILE = process.env["USERPROFILE"];

let sandboxHome: string;

async function freshConfig() {
  vi.resetModules();
  return await import("../src/config.js");
}

describe("todo extractor user config", () => {
  beforeEach(() => {
    sandboxHome = mkdtempSync(join(tmpdir(), "agentmemory-todo-config-"));
    process.env["HOME"] = sandboxHome;
    process.env["USERPROFILE"] = sandboxHome;
    delete process.env.LANGEXTRACT_API_KEY;
    delete process.env.LANGEXTRACT_MODEL;
    delete process.env.LANGEXTRACT_PROVIDER;
    delete process.env.LANGEXTRACT_BASE_URL;
    delete process.env.AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS;
    delete process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS;
    delete process.env.AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION;
  });

  afterEach(() => {
    if (ORIGINAL_HOME === undefined) delete process.env["HOME"];
    else process.env["HOME"] = ORIGINAL_HOME;
    if (ORIGINAL_USERPROFILE === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = ORIGINAL_USERPROFILE;
    rmSync(sandboxHome, { recursive: true, force: true });
  });

  it("writes only allowed LangExtract keys and never exposes the API key", async () => {
    const { getTodoExtractorUserConfig, getUserEnvPath, writeUserEnv } = await freshConfig();
    writeUserEnv({
      LANGEXTRACT_MODEL: "deepseek/deepseek-v4-flash",
      LANGEXTRACT_API_KEY: "secret",
      NOT_ALLOWED: "ignored",
    });

    const raw = readFileSync(getUserEnvPath(), "utf-8");
    expect(raw).toContain("LANGEXTRACT_MODEL=deepseek/deepseek-v4-flash");
    expect(raw).toContain("LANGEXTRACT_API_KEY=secret");
    expect(raw).not.toContain("NOT_ALLOWED");

    const cfg = getTodoExtractorUserConfig();
    expect(cfg.LANGEXTRACT_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.LANGEXTRACT_API_KEY_CONFIGURED).toBe(true);
    expect(cfg.LANGEXTRACT_API_KEY_MASKED).toBe("se****et");
    expect(cfg).not.toHaveProperty("LANGEXTRACT_API_KEY");
  });

  it("treats the old bundled model as unset and returns the current default", async () => {
    const { getTodoExtractorUserConfig, writeUserEnv } = await freshConfig();
    writeUserEnv({ LANGEXTRACT_MODEL: "pa/gpt-5.5" });

    expect(getTodoExtractorUserConfig().LANGEXTRACT_MODEL).toBe("deepseek/deepseek-v4-flash");
  });

  it("defaults LangExtract to Novita OpenAI-compatible routing", async () => {
    const { getTodoExtractorUserConfig, writeUserEnv } = await freshConfig();
    writeUserEnv({ LANGEXTRACT_PROVIDER: "novita" });

    const cfg = getTodoExtractorUserConfig();
    expect(cfg.LANGEXTRACT_PROVIDER).toBe("openai");
    expect(cfg.LANGEXTRACT_BASE_URL).toBe("https://api.novita.ai/openai/v1");
  });

  it("round-trips the LLM extract timeout: defaults when unset, persists + reads back when set", async () => {
    const { getTodoExtractorUserConfig, getUserEnvPath, writeUserEnv } = await freshConfig();

    // read-back returns the default when unset (UI shows a real value, not blank)
    expect(getTodoExtractorUserConfig().AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS).toBe("120000");

    // it is an allowed key: write persists it, and the GET path returns it
    writeUserEnv({ AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS: "45000" });
    expect(readFileSync(getUserEnvPath(), "utf-8")).toContain("AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS=45000");
    expect(getTodoExtractorUserConfig().AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS).toBe("45000");
  });

  it("round-trips the STEP-11 scope settings (sinceDays + max interactions): defaults when unset, persists when set", async () => {
    const { getTodoExtractorUserConfig, getUserEnvPath, writeUserEnv } = await freshConfig();

    // defaults surface in the GET path so the UI shows real values, not blanks
    const defaults = getTodoExtractorUserConfig();
    expect(defaults.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS).toBe("7");
    expect(defaults.AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION).toBe("10");

    // both are allowed keys: writes persist and read back
    writeUserEnv({
      AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS: "14",
      AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION: "5",
    });
    const raw = readFileSync(getUserEnvPath(), "utf-8");
    expect(raw).toContain("AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS=14");
    expect(raw).toContain("AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION=5");
    const cfg = getTodoExtractorUserConfig();
    expect(cfg.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS).toBe("14");
    expect(cfg.AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION).toBe("5");
  });
});
