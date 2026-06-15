import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  parseEventLine,
  makeReplyHandler,
  setPendingReplyTarget,
  getPendingReplyTarget,
  clearPendingReplyTarget,
  PENDING_REPLY_KEY,
} from "../src/functions/lark-reply-consumer.js";
import { KV } from "../src/state/schema.js";

// STEP-D5a — the reply-loop mapping kernel, with NO real subprocess. We feed
// NDJSON lines straight into makeReplyHandler().handleLine and assert the
// filter → dedup → method-A pointer mapping → inbox-answer pipeline. D5b wires
// the real `lark-cli event consume` stdout into this same handler.

const USER = "ou_target_user";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    // Mirror the real iii-engine state::get: a MISSING key resolves to
    // `undefined`, not `null`. (The earlier `?? null` mock hid the
    // duplicate_event bug where `!== null` dropped every first-seen event.)
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      const bucket = store.get(scope);
      return bucket && bucket.has(key) ? (bucket.get(key) as T) : (undefined as unknown as T);
    },
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

// p2p text-message event from the target user. Overridable per test.
function evt(over: Partial<{ event_id: string; sender_id: string; chat_type: string; content: string }> = {}) {
  return JSON.stringify({
    event_id: over.event_id ?? "evt_1",
    sender_id: over.sender_id ?? USER,
    chat_type: over.chat_type ?? "p2p",
    content: over.content ?? JSON.stringify({ text: "改,和 /api/* 一致" }),
  });
}

describe("D5a lark reply-consumer kernel", () => {
  let kv: ReturnType<typeof mockKV>;
  let trigger: ReturnType<typeof vi.fn>;
  let sdk: { trigger: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    kv = mockKV();
    trigger = vi.fn(async () => ({ success: true, item: { id: "x", status: "answered" } }));
    sdk = { trigger };
  });

  function handler() {
    return makeReplyHandler({ kv: kv as never, sdk: sdk as never, userId: USER });
  }

  // Seed an awaiting question so the consumer's stale-pointer guard passes.
  async function seedQuestion(id: string) {
    await kv.set(KV.inbox, id, {
      id, kind: "question", body: "q", status: "awaiting", createdAt: "2026-06-15T10:00:00Z",
    });
  }

  // --- NDJSON parsing ---

  it("parseEventLine returns null for blank/malformed lines", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("   ")).toBeNull();
    expect(parseEventLine("{ not json")).toBeNull();
    expect(parseEventLine("null")).toBeNull();
    expect(parseEventLine("42")).toBeNull();
  });

  it("parseEventLine reads flat and nested envelopes; unwraps {text}", () => {
    const flat = parseEventLine(evt({ content: JSON.stringify({ text: "hi" }) }));
    expect(flat).toEqual({ eventId: "evt_1", senderId: USER, chatType: "p2p", content: "hi" });

    const nested = parseEventLine(JSON.stringify({
      header: { event_id: "evt_n" },
      event: { sender: { sender_id: { open_id: USER } }, message: { chat_type: "p2p", content: JSON.stringify({ text: "yo" }) } },
    }));
    expect(nested?.eventId).toBe("evt_n");
    expect(nested?.senderId).toBe(USER);
    expect(nested?.content).toBe("yo");
  });

  it("parseEventLine returns null when a required field is missing", () => {
    expect(parseEventLine(JSON.stringify({ event_id: "e", sender_id: USER }))).toBeNull(); // no content
    expect(parseEventLine(JSON.stringify({ sender_id: USER, content: "x" }))).toBeNull(); // no event_id
  });

  // --- pointer helpers ---

  it("set/get/clear pending reply target round-trips via mem:delivery reserved key", async () => {
    expect(await getPendingReplyTarget(kv as never)).toBeNull();
    await setPendingReplyTarget(kv as never, "inbox_q1");
    expect(await getPendingReplyTarget(kv as never)).toBe("inbox_q1");
    // stored under the reserved key, not as a DeliveryRecord id
    expect(await kv.get(KV.delivery, PENDING_REPLY_KEY)).toBeTruthy();
    await clearPendingReplyTarget(kv as never);
    expect(await getPendingReplyTarget(kv as never)).toBeNull();
  });

  it("latest question overwrites the pointer (method A: newest wins)", async () => {
    await setPendingReplyTarget(kv as never, "inbox_q1");
    await setPendingReplyTarget(kv as never, "inbox_q2");
    expect(await getPendingReplyTarget(kv as never)).toBe("inbox_q2");
  });

  // --- reply mapping pipeline ---

  it("reply hitting the pointer answers the question and clears the pointer", async () => {
    await seedQuestion("inbox_q1");
    await setPendingReplyTarget(kv as never, "inbox_q1");
    const out = await handler().handleLine(evt({ content: JSON.stringify({ text: "改" }) }));
    expect(out.action).toBe("answered");
    expect(out.itemId).toBe("inbox_q1");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toMatchObject({
      function_id: "mem::inbox-answer",
      payload: { id: "inbox_q1", answer: "改" },
    });
    expect(await getPendingReplyTarget(kv as never)).toBeNull();
  });

  it("first-seen event (missing dedup key → undefined) is NOT treated as duplicate", async () => {
    // Regression: real iii-engine state::get returns undefined for a missing
    // key. A `!== null` dedup check wrongly flagged every first event as
    // duplicate_event and dropped the reply. A brand-new event must answer.
    await seedQuestion("inbox_fresh");
    await setPendingReplyTarget(kv as never, "inbox_fresh");
    const out = await handler().handleLine(evt({ event_id: "evt_never_seen" }));
    expect(out.action).toBe("answered");
    expect(out.reason).toBeUndefined();
    expect(trigger).toHaveBeenCalledTimes(1);
  });

  it("reply with no pending pointer is ignored (no answer)", async () => {
    const out = await handler().handleLine(evt());
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("no_pending_target");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("duplicate event_id does not answer twice", async () => {
    await seedQuestion("inbox_q1");
    await setPendingReplyTarget(kv as never, "inbox_q1");
    const line = evt({ event_id: "evt_dup" });
    const first = await handler().handleLine(line);
    expect(first.action).toBe("answered");
    // pointer cleared, but even with a fresh pointer the dup event must not act
    await setPendingReplyTarget(kv as never, "inbox_q2");
    const second = await handler().handleLine(line);
    expect(second.action).toBe("ignored");
    expect(second.reason).toBe("duplicate_event");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(await getPendingReplyTarget(kv as never)).toBe("inbox_q2"); // untouched
  });

  it("reply whose pointer target is no longer awaiting clears the stale pointer", async () => {
    // user answered the question in the workbench → item is 'answered'
    await kv.set(KV.inbox, "inbox_done", {
      id: "inbox_done", kind: "question", body: "q", status: "answered", createdAt: "2026-06-15T10:00:00Z",
    });
    await setPendingReplyTarget(kv as never, "inbox_done");
    const out = await handler().handleLine(evt({ event_id: "evt_stale" }));
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("target_not_awaiting");
    expect(trigger).not.toHaveBeenCalled();
    expect(await getPendingReplyTarget(kv as never)).toBeNull(); // stale pointer cleared
  });

  it("reply from a non-target user is ignored", async () => {
    await setPendingReplyTarget(kv as never, "inbox_q1");
    const out = await handler().handleLine(evt({ sender_id: "ou_someone_else" }));
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("not_target_user");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("non-p2p (group) message is ignored", async () => {
    await setPendingReplyTarget(kv as never, "inbox_q1");
    const out = await handler().handleLine(evt({ chat_type: "group" }));
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("not_p2p");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("empty/whitespace body is ignored (unparseable)", async () => {
    await setPendingReplyTarget(kv as never, "inbox_q1");
    const out = await handler().handleLine(evt({ content: JSON.stringify({ text: "   " }) }));
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("unparseable");
    expect(trigger).not.toHaveBeenCalled();
  });

  it("malformed NDJSON line is ignored, never throws", async () => {
    await setPendingReplyTarget(kv as never, "inbox_q1");
    const out = await handler().handleLine("{ broken json ");
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("unparseable");
    expect(trigger).not.toHaveBeenCalled();
    // pointer survives a junk line
    expect(await getPendingReplyTarget(kv as never)).toBe("inbox_q1");
  });

  it("inbox-answer failure: event still marked, pointer kept, no throw", async () => {
    await seedQuestion("inbox_gone");
    await setPendingReplyTarget(kv as never, "inbox_gone");
    trigger.mockResolvedValueOnce({ success: false, error: "inbox item not found" });
    const out = await handler().handleLine(evt({ event_id: "evt_fail" }));
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("answer_failed");
    // pointer NOT cleared (answer didn't take)
    expect(await getPendingReplyTarget(kv as never)).toBe("inbox_gone");
  });

  it("sdk.trigger throwing is contained (line skipped, loop survives)", async () => {
    await seedQuestion("inbox_q1");
    await setPendingReplyTarget(kv as never, "inbox_q1");
    trigger.mockRejectedValueOnce(new Error("engine down"));
    const out = await handler().handleLine(evt({ event_id: "evt_throw" }));
    expect(out.action).toBe("ignored");
    expect(out.reason).toBe("handler_error");
  });
});
