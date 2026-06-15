import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Delivery config gate (Line D / STEP-D3). Default OFF so the Line C inbox
// behavior — and the 9 tests below — are unaffected. Per-test toggle via
// mockGate.enabled. Only isLarkDeliveryEnabled is imported by inbox.ts.
const mockGate = { enabled: false };
vi.mock("../src/config.js", () => ({
  isLarkDeliveryEnabled: () => mockGate.enabled,
}));

import { registerInboxFunction } from "../src/functions/inbox.js";
import type { InboxItem } from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
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
}

function mockSdk() {
  const functions = new Map<string, Function>();
  const triggerVoid = vi.fn();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    triggerVoid,
    call: async (id: string, payload?: unknown) => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

describe("Inbox Functions (Line C)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    mockGate.enabled = false;
    registerInboxFunction(sdk as never, kv as never);
  });

  it("inbox-ask creates an awaiting question", async () => {
    const r = await sdk.call("mem::inbox-ask", { body: "删还是修这两个测试?" });
    expect(r.success).toBe(true);
    expect(r.item.kind).toBe("question");
    expect(r.item.status).toBe("awaiting");
    expect(r.item.id).toMatch(/^inbox_/);
  });

  it("inbox-ask rejects empty body", async () => {
    const r = await sdk.call("mem::inbox-ask", { body: "  " });
    expect(r.success).toBe(false);
  });

  it("inbox-notify creates an awaiting briefing", async () => {
    const r = await sdk.call("mem::inbox-notify", { body: "今天跟进了 3 件" });
    expect(r.success).toBe(true);
    expect(r.item.kind).toBe("briefing");
    expect(r.item.status).toBe("awaiting");
  });

  it("inbox-list returns items WITHOUT requiring agentId, filters by status/kind", async () => {
    await sdk.call("mem::inbox-ask", { body: "q1" });
    await sdk.call("mem::inbox-notify", { body: "b1" });
    const all = await sdk.call("mem::inbox-list", {});
    expect(all.success).toBe(true);
    expect(all.items.length).toBe(2);
    const onlyQ = await sdk.call("mem::inbox-list", { kind: "question" });
    expect(onlyQ.items.length).toBe(1);
    expect(onlyQ.items[0].kind).toBe("question");
    const awaiting = await sdk.call("mem::inbox-list", { status: "awaiting" });
    expect(awaiting.items.length).toBe(2);
  });

  it("inbox-answer flips status to answered and stores answer", async () => {
    const asked = await sdk.call("mem::inbox-ask", { body: "q" });
    const r = await sdk.call("mem::inbox-answer", { id: asked.item.id, answer: "改" });
    expect(r.success).toBe(true);
    expect(r.item.status).toBe("answered");
    expect(r.item.answer).toBe("改");
    expect(r.item.answeredAt).toBeTruthy();
    // no longer in awaiting list
    const awaiting = await sdk.call("mem::inbox-list", { status: "awaiting" });
    expect(awaiting.items.find((i: InboxItem) => i.id === asked.item.id)).toBeUndefined();
  });

  it("inbox-answer with empty answer = ack (briefing read)", async () => {
    const b = await sdk.call("mem::inbox-notify", { body: "b" });
    const r = await sdk.call("mem::inbox-answer", { id: b.item.id });
    expect(r.item.status).toBe("answered");
    expect(r.item.answer).toBeUndefined();
  });

  it("inbox-dismiss flips status to dismissed", async () => {
    const asked = await sdk.call("mem::inbox-ask", { body: "q" });
    const r = await sdk.call("mem::inbox-dismiss", { id: asked.item.id });
    expect(r.success).toBe(true);
    expect(r.item.status).toBe("dismissed");
  });

  it("answer/dismiss on missing id returns error", async () => {
    expect((await sdk.call("mem::inbox-answer", { id: "nope" })).success).toBe(false);
    expect((await sdk.call("mem::inbox-dismiss", { id: "nope" })).success).toBe(false);
  });

  it("expired items are filtered from list", async () => {
    await sdk.call("mem::inbox-ask", { body: "expired", expiresInMs: -1000 });
    const all = await sdk.call("mem::inbox-list", {});
    expect(all.items.length).toBe(0);
  });

  // Line D / STEP-D3 — fire-and-forget delivery dispatch on the write path.
  describe("delivery dispatch (STEP-D3)", () => {
    it("delivery OFF (default): ask/notify do NOT trigger deliver", async () => {
      await sdk.call("mem::inbox-ask", { body: "q" });
      await sdk.call("mem::inbox-notify", { body: "b" });
      expect(sdk.triggerVoid).not.toHaveBeenCalled();
    });

    it("delivery ON: ask triggers mem::inbox-deliver with the persisted item", async () => {
      mockGate.enabled = true;
      const r = await sdk.call("mem::inbox-ask", { body: "要不要加鉴权?" });
      expect(r.success).toBe(true);
      expect(sdk.triggerVoid).toHaveBeenCalledTimes(1);
      expect(sdk.triggerVoid).toHaveBeenCalledWith("mem::inbox-deliver", { item: r.item });
    });

    it("delivery ON: notify triggers mem::inbox-deliver with the persisted item", async () => {
      mockGate.enabled = true;
      const r = await sdk.call("mem::inbox-notify", { body: "今天完成了 3 件" });
      expect(r.success).toBe(true);
      expect(sdk.triggerVoid).toHaveBeenCalledTimes(1);
      expect(sdk.triggerVoid).toHaveBeenCalledWith("mem::inbox-deliver", { item: r.item });
    });

    it("triggerVoid throwing does NOT break the inbox write (still success)", async () => {
      mockGate.enabled = true;
      sdk.triggerVoid.mockImplementationOnce(() => {
        throw new Error("dispatch boom");
      });
      const r = await sdk.call("mem::inbox-ask", { body: "q" });
      expect(r.success).toBe(true);
      expect(r.item.status).toBe("awaiting");
      // and the item was still persisted
      const stored = await kv.get<InboxItem>("mem:inbox", r.item.id);
      expect(stored?.id).toBe(r.item.id);
    });
  });
});
