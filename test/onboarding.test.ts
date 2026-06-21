import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildAgentOptions, getInitialAgentValues } from "../src/cli/onboarding.js";

describe("first-run onboarding", () => {
  it("offers Codex as a native setup target", () => {
    const options = buildAgentOptions();
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "codex",
          label: expect.stringContaining("Codex"),
          hint: "native plugin",
        }),
      ]),
    );
  });

  it("selects Codex by default (the only wireable agent after PLAN-006 P2)", () => {
    expect(getInitialAgentValues({ COPILOT_CLI: "1" })).toEqual(["codex"]);
    expect(getInitialAgentValues({})).toEqual(["codex"]);
  });

  it("frames the first-run model selection as To-Do extraction (not memory compression)", () => {
    const source = readFileSync("src/cli/onboarding.ts", "utf-8");
    expect(source).toContain("extract To-Dos");
    expect(source).not.toContain("memory compression/consolidation");
    expect(source).not.toContain("Not To-Do extraction");
  });
});
