import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// DELETE /agentmemory/sessions?project=... is what `demo` prints as its
// cleanup command; before this route existed it 405'd and left seeded
// sessions in the local store. Guard the wiring + the by-project filter.
describe("sessions delete-by-project REST API", () => {
  const api = readFileSync("src/triggers/api.ts", "utf-8");

  it("registers a DELETE route for /agentmemory/sessions", () => {
    expect(api).toContain('"api::sessions::delete"');
    expect(api).toMatch(
      /function_id:\s*"api::sessions::delete",\s*config:\s*\{\s*api_path:\s*"\/agentmemory\/sessions",\s*http_method:\s*"DELETE"/,
    );
  });

  it("requires project, filters by it, and deletes matching sessions", () => {
    expect(api).toContain("project is required");
    expect(api).toMatch(/s\.project === project/);
    expect(api).toMatch(/kv\.delete\(KV\.sessions, s\.id\)/);
    expect(api).toMatch(/deleted:\s*targets\.length/);
  });
});
