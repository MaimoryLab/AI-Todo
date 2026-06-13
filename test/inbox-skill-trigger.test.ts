import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerInboxFunction } from "../src/functions/inbox.js";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { InboxItem } from "../src/types.js";

// End-to-end scenario harness for STEP-C1.5. The two Agent skills
// (ask-user / organize-todos) never touch the mem::inbox-* functions
// directly: they call the MCP tool memory_inbox_ask / memory_inbox_notify,
// and fall back to POST /agentmemory/inbox/{ask,notify} when MCP is down.
// inbox.test.ts only exercises the innermost functions, so this file proves
// the two real skill entry points actually land an item in the inbox and
// that a user opening their workbench (inbox-list) sees it.

type RegisteredHandler = (input: unknown) => unknown;

interface TriggerRoute {
  method: string;
  path: string;
  functionId: string;
}

function makeHarness() {
  const store = new Map<string, Map<string, unknown>>();
  const kv = {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };

  const functions = new Map<string, RegisteredHandler>();
  const routes: TriggerRoute[] = [];
  const sdk = {
    registerFunction: (idOrOpts: string | { id: string }, handler: RegisteredHandler) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: (t: {
      type: string;
      function_id: string;
      config?: { api_path?: string; http_method?: string };
    }) => {
      if (t.type === "http" && t.config?.api_path) {
        routes.push({
          method: (t.config.http_method ?? "GET").toUpperCase(),
          path: t.config.api_path,
          functionId: t.function_id,
        });
      }
    },
    // The handlers call sdk.trigger({ function_id, payload }) to reach the
    // underlying mem::inbox-* function; route it through the same registry.
    trigger: async ({ function_id, payload }: { function_id: string; payload?: unknown }) => {
      const fn = functions.get(function_id);
      if (!fn) throw new Error(`No function: ${function_id}`);
      return fn(payload);
    },
  };

  registerInboxFunction(sdk as never, kv as never);
  registerMcpEndpoints(sdk as never, kv as never);
  registerApiTriggers(sdk as never, kv as never);

  return { sdk, kv, functions, routes };
}

describe("STEP-C1.5 skill → inbox end-to-end", () => {
  let h: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    h = makeHarness();
  });

  // --- Primary path: the MCP tool the skills call first. ---

  function callMcpTool(name: string, args: Record<string, unknown>) {
    const handler = h.functions.get("mcp::tools::call");
    if (!handler) throw new Error("mcp::tools::call not registered");
    return handler({ body: { name, arguments: args } }) as Promise<{
      status_code: number;
      body: { content?: { type: string; text: string }[]; error?: string };
    }>;
  }

  function parseToolItem(res: {
    body: { content?: { type: string; text: string }[] };
  }): { success: boolean; item: InboxItem } {
    const text = res.body.content?.[0]?.text;
    if (!text) throw new Error("tool returned no content");
    return JSON.parse(text);
  }

  it("ask-user via memory_inbox_ask lands an awaiting question the user can see", async () => {
    // Scenario: Agent is blocked on a destructive decision, user is away.
    const res = await callMcpTool("memory_inbox_ask", {
      body: "`/admin/*` 路由要不要也加鉴权?我改完了 `/api/*`。",
      fromAgent: "auth-refactor",
      project: "/repo/agentmemory",
      sourceObservationIds: ["obs_123", "obs_456"],
    });
    expect(res.status_code).toBe(200);
    const { success, item } = parseToolItem(res);
    expect(success).toBe(true);
    expect(item.kind).toBe("question");
    expect(item.status).toBe("awaiting");
    expect(item.fromAgent).toBe("auth-refactor");
    expect(item.project).toBe("/repo/agentmemory");
    expect(item.sourceObservationIds).toEqual(["obs_123", "obs_456"]);

    // User opens their workbench → the question is there.
    const list = await h.functions.get("mem::inbox-list")!({ status: "awaiting", kind: "question" });
    expect((list as { items: InboxItem[] }).items.some((i) => i.id === item.id)).toBe(true);
  });

  it("organize-todos via memory_inbox_notify lands an awaiting briefing the user can see", async () => {
    // Scenario: a multi-step task reached a natural stopping point.
    const res = await callMcpTool("memory_inbox_notify", {
      body: "今天跟进了 C1.5:✅ 两个 skill 已开 PR;⏳ C2 未动。",
      fromAgent: "line-c-c1.5",
      project: "/repo/agentmemory",
    });
    expect(res.status_code).toBe(200);
    const { success, item } = parseToolItem(res);
    expect(success).toBe(true);
    expect(item.kind).toBe("briefing");
    expect(item.status).toBe("awaiting");

    const list = await h.functions.get("mem::inbox-list")!({ kind: "briefing" });
    expect((list as { items: InboxItem[] }).items.some((i) => i.id === item.id)).toBe(true);
  });

  it("memory_inbox_ask rejects an empty body (skill must supply a real question)", async () => {
    const res = await callMcpTool("memory_inbox_ask", { body: "   " });
    expect(res.status_code).toBe(400);
    expect(res.body.error).toMatch(/body is required/);
    const list = await h.functions.get("mem::inbox-list")!({});
    expect((list as { items: InboxItem[] }).items.length).toBe(0);
  });

  // --- Fallback path: skills POST to the REST endpoint when MCP is down. ---

  function callRest(method: string, path: string, body?: unknown, query?: Record<string, string>) {
    const route = h.routes.find((r) => r.path === path && r.method === method.toUpperCase());
    if (!route) throw new Error(`no route for ${method} ${path}`);
    const handler = h.functions.get(route.functionId);
    if (!handler) throw new Error(`no handler for ${route.functionId}`);
    return handler({ body, query_params: query ?? {}, headers: {} }) as Promise<{
      status_code: number;
      body: { success?: boolean; item?: InboxItem; items?: InboxItem[]; error?: string };
    }>;
  }

  it("ask-user fallback POST /agentmemory/inbox/ask lands the question", async () => {
    const res = await callRest("POST", "/agentmemory/inbox/ask", {
      body: "删还是修这两个失败测试?",
      fromAgent: "ci-triage",
    });
    expect(res.status_code).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.item?.kind).toBe("question");

    const list = await callRest("GET", "/agentmemory/inbox", undefined, { status: "awaiting" });
    expect(list.body.items?.some((i) => i.id === res.body.item?.id)).toBe(true);
  });

  it("organize-todos fallback POST /agentmemory/inbox/notify lands the briefing", async () => {
    const res = await callRest("POST", "/agentmemory/inbox/notify", {
      body: "批量修复完成,3 处已改。",
      fromAgent: "batch-fix",
    });
    expect(res.status_code).toBe(201);
    expect(res.body.item?.kind).toBe("briefing");

    const list = await callRest("GET", "/agentmemory/inbox", undefined, { kind: "briefing" });
    expect(list.body.items?.some((i) => i.id === res.body.item?.id)).toBe(true);
  });

  it("fallback POST rejects an empty body before reaching the inbox", async () => {
    const res = await callRest("POST", "/agentmemory/inbox/ask", { body: "" });
    expect(res.status_code).toBe(400);
    const list = await callRest("GET", "/agentmemory/inbox", undefined, {});
    expect(list.body.items?.length).toBe(0);
  });

  // --- Both entry points feed the same single-user inbox. ---

  it("MCP and REST writes converge in one inbox, newest first", async () => {
    await callMcpTool("memory_inbox_ask", { body: "first via MCP" });
    await new Promise((r) => setTimeout(r, 2));
    await callRest("POST", "/agentmemory/inbox/notify", { body: "second via REST" });

    const list = await callRest("GET", "/agentmemory/inbox", undefined, {});
    const items = list.body.items ?? [];
    expect(items.length).toBe(2);
    // inbox-list sorts by createdAt desc; the REST write is newest.
    expect(items[0]?.body).toBe("second via REST");
    expect(items[1]?.body).toBe("first via MCP");
  });
});
