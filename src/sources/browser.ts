import { createHash } from "node:crypto";
import type { SourceKind } from "../contracts.js";
import type { Database } from "../db/index.js";

export interface BrowserSessionInput {
  id?: string;
  path?: string;
  messages: Array<{ role?: string; text: string; createdAt?: string }>;
}

export function validateBrowserSessionInput(input: unknown): { ok: true; input: BrowserSessionInput } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "invalid_body" };
  }
  const record = input as Record<string, unknown>;
  if (record.id !== undefined && !nonEmptyString(record.id)) return { ok: false, error: "invalid_id" };
  if (record.path !== undefined && !nonEmptyString(record.path)) return { ok: false, error: "invalid_path" };
  if (!Array.isArray(record.messages) || record.messages.length === 0) {
    return { ok: false, error: "invalid_messages" };
  }

  const messages = [];
  for (const message of record.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return { ok: false, error: "invalid_message" };
    }
    const item = message as Record<string, unknown>;
    if (!nonEmptyString(item.text)) return { ok: false, error: "invalid_message_text" };
    if (item.role !== undefined && !nonEmptyString(item.role)) return { ok: false, error: "invalid_message_role" };
    if (item.createdAt !== undefined && (!nonEmptyString(item.createdAt) || Number.isNaN(Date.parse(item.createdAt)))) {
      return { ok: false, error: "invalid_message_created_at" };
    }
    messages.push({
      role: typeof item.role === "string" ? item.role.trim() : undefined,
      text: item.text.trim(),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined
    });
  }

  return {
    ok: true,
    input: {
      id: typeof record.id === "string" ? record.id.trim() : undefined,
      path: typeof record.path === "string" ? record.path.trim() : undefined,
      messages
    }
  };
}

export function ingestBrowserSession(db: Database, input: BrowserSessionInput) {
  const source: SourceKind = "browser";
  const sessionId = input.id ?? hash(JSON.stringify(input.messages));
  const path = input.path ?? "browser";
  const updatedAt = new Date().toISOString();

  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)"
  ).run(sessionId, source, path, updatedAt);
  db.prepare("DELETE FROM observations WHERE session_id = ?").run(sessionId);

  for (const [index, message] of input.messages.entries()) {
    db.prepare(
      "INSERT OR REPLACE INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(
      hash(sessionId, String(index)),
      sessionId,
      source,
      message.role ?? "unknown",
      message.text,
      message.createdAt ?? updatedAt
    );
  }

  return { sessionId, observations: input.messages.length };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hash(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex");
}
