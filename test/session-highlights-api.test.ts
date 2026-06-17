import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function readText(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), "utf-8");
}

describe("session highlights REST API wiring", () => {
  it("registers a REST-only session highlights endpoint", () => {
    const api = readText("src/triggers/api.ts");
    const mcpRegistry = readText("src/mcp/tools-registry.ts");
    const mcpServer = readText("src/mcp/server.ts");

    expect(api).toContain('"api::session::highlights"');
    expect(api).toContain('api_path: "/agentmemory/session/highlights"');
    expect(api).toContain('function_id: "mem::session-highlights"');
    expect(api).toMatch(/maxItems must be a positive integer no greater than 200/);

    expect(mcpRegistry).not.toContain("memory_session_highlights");
    expect(mcpServer).not.toContain('case "memory_session_highlights"');
  });

  it("updates documented REST endpoint counts", () => {
    const api = readText("src/triggers/api.ts");
    const endpointCount = Array.from(api.matchAll(/api_path:\s*["`]/g)).length;
    const readme = readText("README.md");
    const agents = readText("AGENTS.md");
    const index = readText("src/index.ts");

    expect(endpointCount).toBe(137);
    expect(readme).toContain("137 endpoints on port");
    expect(agents).toContain("137 REST endpoints");
    expect(index).toContain("REST API: 137 endpoints");
  });
});
