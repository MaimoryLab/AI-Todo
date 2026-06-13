import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, generateId } from "../state/schema.js";
import type { InboxItem } from "../types.js";
import { recordAudit } from "./audit.js";

// Line C: Agent→user async inbox.
// Unlike signals (agent↔agent, requires agentId), inbox items are always
// addressed to the single human user, so list/answer need no agentId.
// `kind` distinguishes a question (needs a reply) from a briefing (ack-only
// proactive summary the Agent pushes after organizing todos/progress).
export function registerInboxFunction(sdk: ISdk, kv: StateKV): void {
  // Agent asks the user a question (needs a reply).
  sdk.registerFunction("mem::inbox-ask", async (data: {
    body: string;
    fromAgent?: string;
    project?: string;
    priority?: InboxItem["priority"];
    sourceObservationIds?: string[];
    sourceSessionId?: string;
    expiresInMs?: number;
  }) => {
    if (!data.body?.trim()) {
      return { success: false, error: "non-empty body is required" };
    }
    const item = buildItem("question", data);
    await kv.set(KV.inbox, item.id, item);
    await recordAudit(kv, "inbox_ask", "mem::inbox-ask", [item.id], {
      action: "create",
      kind: "question",
      fromAgent: data.fromAgent,
    });
    return { success: true, item };
  });

  // Agent pushes a briefing (proactive summary, ack-only).
  sdk.registerFunction("mem::inbox-notify", async (data: {
    body: string;
    fromAgent?: string;
    project?: string;
    priority?: InboxItem["priority"];
    sourceObservationIds?: string[];
    sourceSessionId?: string;
    expiresInMs?: number;
  }) => {
    if (!data.body?.trim()) {
      return { success: false, error: "non-empty body is required" };
    }
    const item = buildItem("briefing", data);
    await kv.set(KV.inbox, item.id, item);
    await recordAudit(kv, "inbox_notify", "mem::inbox-notify", [item.id], {
      action: "create",
      kind: "briefing",
      fromAgent: data.fromAgent,
    });
    return { success: true, item };
  });

  // List inbox items. No agentId required (single-user inbox).
  sdk.registerFunction("mem::inbox-list", async (data: {
    status?: InboxItem["status"];
    kind?: InboxItem["kind"];
    limit?: number;
  } = {}) => {
    let items = await kv.list<InboxItem>(KV.inbox);
    const now = Date.now();
    items = items.filter(
      (i) => !(i.expiresAt && new Date(i.expiresAt).getTime() <= now),
    );
    if (data.status) items = items.filter((i) => i.status === data.status);
    if (data.kind) items = items.filter((i) => i.kind === data.kind);
    // Newest first; priority intentionally not used for ordering this round.
    items.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const limit = data.limit || 50;
    return { success: true, items: items.slice(0, limit) };
  });

  // User answers a question (or acks a briefing with empty answer).
  sdk.registerFunction("mem::inbox-answer", async (data: {
    id: string;
    answer?: string;
  }) => {
    if (!data.id) return { success: false, error: "id is required" };
    const item = await kv.get<InboxItem>(KV.inbox, data.id);
    if (!item) return { success: false, error: "inbox item not found" };
    item.status = "answered";
    item.answer = data.answer?.trim() || undefined;
    item.answeredAt = new Date().toISOString();
    await kv.set(KV.inbox, item.id, item);
    await recordAudit(kv, "inbox_answer", "mem::inbox-answer", [item.id], {
      action: "answer",
      hasAnswer: !!item.answer,
    });
    return { success: true, item };
  });

  // User dismisses an item (e.g. when converting it to a regular todo).
  sdk.registerFunction("mem::inbox-dismiss", async (data: { id: string }) => {
    if (!data.id) return { success: false, error: "id is required" };
    const item = await kv.get<InboxItem>(KV.inbox, data.id);
    if (!item) return { success: false, error: "inbox item not found" };
    item.status = "dismissed";
    await kv.set(KV.inbox, item.id, item);
    await recordAudit(kv, "inbox_dismiss", "mem::inbox-dismiss", [item.id], {
      action: "dismiss",
    });
    return { success: true, item };
  });
}

function buildItem(
  kind: InboxItem["kind"],
  data: {
    body: string;
    fromAgent?: string;
    project?: string;
    priority?: InboxItem["priority"];
    sourceObservationIds?: string[];
    sourceSessionId?: string;
    expiresInMs?: number;
  },
): InboxItem {
  const now = new Date();
  return {
    id: generateId("inbox"),
    kind,
    body: data.body.trim(),
    status: "awaiting",
    priority: data.priority,
    fromAgent: data.fromAgent,
    project: data.project,
    sourceObservationIds: data.sourceObservationIds,
    sourceSessionId: data.sourceSessionId,
    createdAt: now.toISOString(),
    expiresAt: data.expiresInMs
      ? new Date(now.getTime() + data.expiresInMs).toISOString()
      : undefined,
  };
}
