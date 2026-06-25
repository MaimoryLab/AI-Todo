import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

describe("package scripts", () => {
  it("installs LangExtract Python dependencies during npm install", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.postinstall).toBe("node scripts/install-langextract.mjs");
    expect(pkg.files).toContain("scripts/install-langextract.mjs");
    expect(readFileSync(join(ROOT, "scripts/install-langextract.mjs"), "utf-8")).toContain(".agentmemory-python");
  });
});
