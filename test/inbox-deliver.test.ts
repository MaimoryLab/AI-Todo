import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Config gate is toggled per-test via these mocks (env-free, deterministic).
const mockGate = { enabled: false, config: null as null | { userId: string; urgentQuestion: boolean } };
vi.mock("../src/config.js", () => ({
  isLarkDeliveryEnabled: () => mockGate.enabled,
  getLarkConfig: () => mockGate.config,
}));

import { registerInboxDeliverFunction } from "../src/functions/inbox-deliver.js";
import { KV } from "../src/state/schema.js";
import type { DeliveryRecord, InboxItem } from "../src/types.js";
import type { DeliveryOutcome } from "../src/functions/lark-adapter.js";

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
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    call: async (id: string, payload?: unknown) => {
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "inbox_test_1",
    kind: "question",
    body: "要不要加鉴权?",
    status: "awaiting",
    createdAt: "2026-06-15T10:00:00Z",
    ...over,
  };
}

describe("Inbox delivery primitive (Line D / STEP-D1)", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let deliver: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    deliver = vi.fn(async (): Promise<DeliveryOutcome> => ({ ok: true, messageId: "om_x", urgent: true }));
    mockGate.enabled = false;
    mockGate.config = null;
    registerInboxDeliverFunction(sdk as never, kv as never, deliver as never);
  });

  it("rejects payload without item id", async () => {
    const r = await sdk.call("mem::inbox-deliver", {});
    expect(r.success).toBe(false);
  });

  it("config gate: delivery disabled → skipped, adapter never called", async () => {
    mockGate.enabled = false;
    const r = await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(r.success).toBe(true);
    expect(r.skipped).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
    const rec = await kv.get<DeliveryRecord>(KV.delivery, "inbox_test_1");
    expect(rec?.status).toBe("skipped");
  });

  it("config gate: enabled but no lark config → skipped", async () => {
    mockGate.enabled = true;
    mockGate.config = null;
    const r = await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(r.skipped).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("enabled + config: calls adapter, writes sent record + audit", async () => {
    mockGate.enabled = true;
    mockGate.config = { userId: "ou_abc", urgentQuestion: true };
    const r = await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(r.success).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    const rec = await kv.get<DeliveryRecord>(KV.delivery, "inbox_test_1");
    expect(rec?.status).toBe("sent");
    expect(rec?.messageId).toBe("om_x");
    expect(rec?.urgent).toBe(true);
    expect(rec?.attempts).toBe(1);
    expect(rec?.deliveredAt).toBeTruthy();
    // audit row written
    const audits = await kv.list<{ operation: string }>(KV.audit);
    expect(audits.some((a) => a.operation === "inbox_delivered")).toBe(true);
  });

  it("dedup: a sent item is not pushed again", async () => {
    mockGate.enabled = true;
    mockGate.config = { userId: "ou_abc", urgentQuestion: true };
    await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(deliver).toHaveBeenCalledTimes(1);
    // second call for same id → skip, adapter not called again
    const r2 = await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(r2.skipped).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("failure: records failed + audit, allows retry (attempts increments)", async () => {
    mockGate.enabled = true;
    mockGate.config = { userId: "ou_abc", urgentQuestion: true };
    deliver.mockResolvedValueOnce({ ok: false, error: "missing_scope" });
    const r = await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(r.success).toBe(false);
    expect(r.error).toBe("missing_scope");
    let rec = await kv.get<DeliveryRecord>(KV.delivery, "inbox_test_1");
    expect(rec?.status).toBe("failed");
    expect(rec?.attempts).toBe(1);
    const audits = await kv.list<{ operation: string }>(KV.audit);
    expect(audits.some((a) => a.operation === "delivery_failed")).toBe(true);

    // retry: failed row is not deduped; adapter called again, now succeeds
    deliver.mockResolvedValueOnce({ ok: true, messageId: "om_y" });
    const r2 = await sdk.call("mem::inbox-deliver", { item: makeItem() });
    expect(r2.success).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(2);
    rec = await kv.get<DeliveryRecord>(KV.delivery, "inbox_test_1");
    expect(rec?.status).toBe("sent");
    expect(rec?.attempts).toBe(2);
  });

  it("briefing delivery records kind in audit", async () => {
    mockGate.enabled = true;
    mockGate.config = { userId: "ou_abc", urgentQuestion: false };
    deliver.mockResolvedValueOnce({ ok: true, messageId: "om_b", urgent: false });
    await sdk.call("mem::inbox-deliver", { item: makeItem({ id: "inbox_b", kind: "briefing", body: "今天完成了 3 件" }) });
    const rec = await kv.get<DeliveryRecord>(KV.delivery, "inbox_b");
    expect(rec?.status).toBe("sent");
    expect(rec?.urgent).toBe(false);
  });
});
