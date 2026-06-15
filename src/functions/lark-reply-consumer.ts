import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { InboxItem } from "../types.js";
import { logger } from "../logger.js";

// Line D / STEP-D5a — Feishu reply-loop mapping kernel.
//
// A long-running `lark-cli event consume im.message.receive_v1 --as bot
// --quiet` subprocess (wired in D5b) streams the user's private replies as
// NDJSON on stdout. This module is the *testable* core: parse a line, decide
// whether it is a reply we should act on, map it to the pending question, and
// answer it — without ever spawning a process. D5b only feeds stdout lines
// into makeReplyHandler(...).handleLine and manages the subprocess lifecycle.
//
// Mapping uses "method A (single-pending pointer)": delivering a question
// records its id as the current pending-reply target; the next user reply
// answers that question and clears the pointer. briefings never set it.
//
// Pointer + event-dedup live in the existing mem:delivery KV scope under
// reserved keys (NOT InboxItem ids — those are "inbox_*"), so no new KV scope.

// Reserved key for the single-pending-reply pointer (method A).
export const PENDING_REPLY_KEY = "__lark_pending_reply_target__";
// Prefix for per-event dedup markers (event_id is dedup-safe per Feishu).
const EVENT_DEDUP_PREFIX = "__lark_event__";

interface PendingReplyTarget {
  itemId: string;
  setAt: string;
}

interface ProcessedEvent {
  eventId: string;
  processedAt: string;
}

// The normalized shape we care about from im.message.receive_v1. lark-cli
// --quiet emits the event payload; we read defensively since upstream may
// nest under different envelopes.
export interface ParsedReply {
  eventId: string;
  senderId: string;
  chatType: string; // plain text (lark-cli renders message content)
  content: string;
}

// ---- NDJSON parsing ----

// Pull a string field that may live at the top level or under a nested
// envelope (event / event.message / event.sender). Returns "" if absent.
function pick(obj: Record<string, unknown>, ...paths: string[][]): string {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const key of path) {
      if (cur && typeof cur === "object" && key in (cur as object)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        cur = undefined;
        break;
      }
    }
    if (typeof cur === "string" && cur.length > 0) return cur;
  }
  return "";
}

// Feishu text message content arrives as a JSON string like {"text":"hi"}.
// Some lark-cli modes pre-render to plain text. Handle both.
function extractText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as { text?: unknown };
      if (typeof j.text === "string") return j.text.trim();
    } catch {
      /* not JSON content; fall through to raw */
    }
  }
  return trimmed;
}

// Parse one NDJSON line into a ParsedReply, or null if the line is blank,
// malformed, or missing the fields we need. NEVER throws — a bad line must
// not kill the consume loop.
export function parseEventLine(line: string): ParsedReply | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const eventId = pick(obj, ["event_id"], ["header", "event_id"]);
  const senderId = pick(
    obj,
    ["sender_id"],
    ["event", "sender", "sender_id", "open_id"],
    ["sender", "sender_id", "open_id"],
  );
  const chatType = pick(
    obj,
    ["chat_type"],
    ["event", "message", "chat_type"],
    ["message", "chat_type"],
  );
  const rawContent = pick(
    obj,
    ["content"],
    ["event", "message", "content"],
    ["message", "content"],
  );
  const content = extractText(rawContent);

  if (!eventId || !senderId || !content) return null;
  return { eventId, senderId, chatType: chatType || "", content };
}

// ---- pending-reply pointer (method A) ----

// Record the just-delivered question as the current pending-reply target.
// Called by the delivery primitive on a successful question send. Briefings
// never call this. A newer question overwrites the pointer (latest wins).
export async function setPendingReplyTarget(kv: StateKV, itemId: string): Promise<void> {
  const target: PendingReplyTarget = { itemId, setAt: new Date().toISOString() };
  await kv.set(KV.delivery, PENDING_REPLY_KEY, target);
}

export async function getPendingReplyTarget(kv: StateKV): Promise<string | null> {
  const t = await kv.get<PendingReplyTarget>(KV.delivery, PENDING_REPLY_KEY);
  return t?.itemId ?? null;
}

export async function clearPendingReplyTarget(kv: StateKV): Promise<void> {
  await kv.delete(KV.delivery, PENDING_REPLY_KEY);
}

// ---- event_id dedup ----

function eventKey(eventId: string): string {
  return `${EVENT_DEDUP_PREFIX}${eventId}`;
}

async function isEventProcessed(kv: StateKV, eventId: string): Promise<boolean> {
  // The real iii-engine state::get returns `undefined` for a missing key, not
  // `null`. A `!== null` check would treat a first-seen event (undefined) as a
  // duplicate and silently drop every reply. Treat both null and undefined as
  // "not processed".
  const existing = await kv.get<ProcessedEvent>(KV.delivery, eventKey(eventId));
  return existing != null;
}

async function markEventProcessed(kv: StateKV, eventId: string): Promise<void> {
  const rec: ProcessedEvent = { eventId, processedAt: new Date().toISOString() };
  await kv.set(KV.delivery, eventKey(eventId), rec);
}

// ---- reply handler ----

export interface ReplyHandlerDeps {
  kv: StateKV;
  sdk: ISdk;
  userId: string; // AGENTMEMORY_LARK_USER_ID — only this user's replies count
}

export interface HandleOutcome {
  action: "answered" | "ignored";
  reason?: string;
  itemId?: string;
}

// Build the per-line handler used by the D5b subprocess. handleLine parses a
// stdout NDJSON line, applies all the filters/dedup/mapping, and answers the
// pending question via mem::inbox-answer. It NEVER throws — any failure is
// logged and returned as an ignored outcome so the consume loop stays alive.
export function makeReplyHandler(deps: ReplyHandlerDeps): {
  handleLine: (line: string) => Promise<HandleOutcome>;
} {
  const { kv, sdk, userId } = deps;

  async function handleLine(line: string): Promise<HandleOutcome> {
    try {
      const reply = parseEventLine(line);
      if (!reply) return { action: "ignored", reason: "unparseable" };

      // Only the target user's private (p2p) messages are replies to us.
      if (reply.chatType && reply.chatType !== "p2p") {
        return { action: "ignored", reason: "not_p2p" };
      }
      if (reply.senderId !== userId) {
        return { action: "ignored", reason: "not_target_user" };
      }

      // Dedup on event_id (Feishu marks it dedup-safe). Mark BEFORE answering
      // so a retry of the same event can't double-answer even if answer races.
      if (await isEventProcessed(kv, reply.eventId)) {
        return { action: "ignored", reason: "duplicate_event" };
      }
      await markEventProcessed(kv, reply.eventId);

      const targetId = await getPendingReplyTarget(kv);
      if (!targetId) {
        // No pending question — method A can't map this reply.
        return { action: "ignored", reason: "no_pending_target" };
      }

      // The pointer can go stale if the user answered/dismissed the question in
      // the workbench instead of via Feishu. Don't re-answer a non-awaiting
      // item — clear the stale pointer and ignore this reply.
      const target = await kv.get<InboxItem>(KV.inbox, targetId);
      if (!target || target.status !== "awaiting") {
        await clearPendingReplyTarget(kv);
        return { action: "ignored", reason: "target_not_awaiting", itemId: targetId };
      }

      const result = (await sdk.trigger({
        function_id: "mem::inbox-answer",
        payload: { id: targetId, answer: reply.content },
      })) as { success?: boolean; item?: InboxItem; error?: string };

      if (!result?.success) {
        // Answer failed (e.g. item gone). Keep the dedup marker (the event is
        // consumed) but leave the pointer so a later valid reply can retry the
        // mapping is moot — log and move on.
        logger.warn("lark reply: inbox-answer failed", {
          targetId,
          error: result?.error,
        });
        return { action: "ignored", reason: "answer_failed", itemId: targetId };
      }

      // Answered — clear the pointer so the next bare reply isn't misrouted.
      await clearPendingReplyTarget(kv);
      logger.info("lark reply answered a question", { itemId: targetId });
      return { action: "answered", itemId: targetId };
    } catch (err) {
      logger.warn("lark reply handler error (line skipped)", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: "ignored", reason: "handler_error" };
    }
  }

  return { handleLine };
}


