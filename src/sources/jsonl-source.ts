import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SourceKind } from "../contracts.js";
import type { Database } from "../db/index.js";
import { readJsonlFile, type JsonlRecord } from "../parser/jsonl.js";

export interface ScanResult {
  source: SourceKind;
  scanned: number;
  observations: number;
  skipped: number;
}

export function scanJsonlSource(db: Database, source: SourceKind, root: string): ScanResult {
  let scanned = 0;
  let observations = 0;
  let skipped = 0;

  for (const path of listJsonlFiles(root)) {
    const stat = statSync(path);
    const checkpoint = db.prepare(
      "SELECT mtime_ms, size FROM scan_checkpoints WHERE source = ? AND path = ?"
    ).get(source, path) as { mtime_ms: number; size: number } | undefined;

    if (checkpoint?.mtime_ms === stat.mtimeMs && checkpoint.size === stat.size) {
      skipped++;
      continue;
    }

    const records = readJsonlFile(path);
    const sessionId = sessionIdFromRecords(source, path, records);
    const updatedAt = new Date(stat.mtimeMs).toISOString();
    const cleanObservations = observationsFromRecords(source, sessionId, path, records);
    if (cleanObservations.length === 0) {
      db.prepare("DELETE FROM observations WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      db.prepare(
        "INSERT OR REPLACE INTO scan_checkpoints (source, path, mtime_ms, size) VALUES (?, ?, ?, ?)"
      ).run(source, path, stat.mtimeMs, stat.size);
      scanned++;
      continue;
    }

    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)"
    ).run(sessionId, source, path, updatedAt);
    db.prepare("DELETE FROM observations WHERE session_id = ?").run(sessionId);

    for (const observation of cleanObservations) {
      db.prepare(
        "INSERT OR REPLACE INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(observation.id, sessionId, source, observation.role, observation.text, observation.createdAt);
      observations++;
    }

    db.prepare(
      "INSERT OR REPLACE INTO scan_checkpoints (source, path, mtime_ms, size) VALUES (?, ?, ?, ?)"
    ).run(source, path, stat.mtimeMs, stat.size);
    scanned++;
  }

  return { source, scanned, observations, skipped };
}

export function observationsFromRecords(
  source: SourceKind,
  sessionId: string,
  path: string,
  records: JsonlRecord[]
): Array<{ id: string; role: string; text: string; createdAt: string }> {
  const candidates = records
    .map((record) => observationFromRecord(source, sessionId, path, record))
    .filter((observation): observation is NonNullable<typeof observation> => !!observation)
    .sort((a, b) => observationPriority(b.channel) - observationPriority(a.channel));
  const seen = new Set<string>();
  const selected: Array<NonNullable<ReturnType<typeof observationFromRecord>>> = [];
  for (const observation of candidates) {
    const key = `${observation.role}\0${normalizeDedupeText(observation.text)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    selected.push(observation);
  }
  return selected
    .sort((a, b) => a.line - b.line)
    .map(({ id, role, text, createdAt }) => ({ id, role, text, createdAt }));
}

export function observationFromRecord(
  source: SourceKind,
  sessionId: string,
  path: string,
  record: JsonlRecord
): { id: string; role: string; text: string; createdAt: string; channel: string; line: number } | null {
  const observation = source === "claude-code"
    ? claudeObservationFromRecord(record.value)
    : codexObservationFromRecord(record.value);
  if (!observation) return null;
  const text = cleanVisibleText(source, observation.text);
  if (!text) return null;
  return {
    id: idFor(source, path, String(record.line)),
    role: observation.role,
    text,
    createdAt: observation.createdAt,
    channel: observation.channel,
    line: record.line
  };
}

function listJsonlFiles(root: string): string[] {
  const stat = statSync(root);
  if (stat.isFile()) return root.endsWith(".jsonl") ? [root] : [];

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listJsonlFiles(path);
    return entry.isFile() && entry.name.endsWith(".jsonl") ? [path] : [];
  });
}

function sessionIdFromRecords(source: SourceKind, path: string, records: JsonlRecord[]): string {
  for (const record of records) {
    const meta = record.value.type === "session_meta" ? objectValue(record.value.payload) : null;
    const id = stringValue(meta?.id);
    if (id) return idFor(source, id);
  }
  return idFor(source, path);
}

function codexObservationFromRecord(value: Record<string, unknown>): { role: string; text: string; createdAt: string; channel: string } | null {
  const type = stringValue(value.type);
  const payload = objectValue(value.payload);
  if (type === "event_msg" && payload) {
    const eventType = stringValue(payload.type);
    if (eventType !== "user_message" && eventType !== "agent_message") return null;
    return {
      role: eventType === "user_message" ? "user" : "assistant",
      text: firstString(payload.message, payload.text) || textFromContent(payload.content, eventType === "user_message" ? "user" : "assistant"),
      createdAt: timestampFrom(value, payload),
      channel: "event_msg"
    };
  }
  if (type === "response_item" && payload) {
    if (stringValue(payload.type) !== "message") return null;
    const role = visibleRole(payload.role);
    if (!role) return null;
    return {
      role,
      text: textFromContent(payload.content, role),
      createdAt: timestampFrom(value, payload),
      channel: "response_item"
    };
  }

  const role = visibleRole(value.role) ?? visibleRole(objectValue(value.message)?.role);
  if (!role) return null;
  const message = objectValue(value.message);
  return {
    role,
    text: message ? textFromMessage(message, role) : textFromMessage(value, role),
    createdAt: timestampFrom(value, message),
    channel: "message"
  };
}

function claudeObservationFromRecord(value: Record<string, unknown>): { role: string; text: string; createdAt: string; channel: string } | null {
  if (value.isMeta === true || value.isSidechain === true) return null;
  const type = stringValue(value.type);
  const message = objectValue(value.message);
  if (message?.isMeta === true || message?.isSidechain === true) return null;
  const role = visibleRole(message?.role) ?? visibleRole(value.role) ?? visibleRole(type);
  if (!role) return null;
  if (type && type !== role && type !== "message") return null;
  return {
    role,
    text: message ? textFromMessage(message, role) : textFromMessage(value, role),
    createdAt: timestampFrom(value, message),
    channel: type || "message"
  };
}

function textFromMessage(message: Record<string, unknown>, role: string): string {
  return firstString(message.text)
    || textFromContent(message.content, role)
    || "";
}

function textFromContent(content: unknown, role: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => textPart(part, role)).filter(Boolean).join("\n").trim();
}

function textPart(part: unknown, role: string): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object" || Array.isArray(part)) return "";
  const record = part as Record<string, unknown>;
  const type = stringValue(record.type);
  const isVisibleText = type === "text"
    || (role === "user" && type === "input_text")
    || (role === "assistant" && type === "output_text")
    || (!type && typeof record.text === "string");
  return isVisibleText ? stringValue(record.text) ?? "" : "";
}

function visibleRole(value: unknown): "user" | "assistant" | null {
  return value === "user" || value === "assistant" ? value : null;
}

function timestampFrom(primary: Record<string, unknown>, secondary?: Record<string, unknown> | null): string {
  return stringValue(primary.timestamp)
    ?? stringValue(primary.created_at)
    ?? stringValue(secondary?.timestamp)
    ?? stringValue(secondary?.created_at)
    ?? new Date(0).toISOString();
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) return text;
  }
  return "";
}

function cleanVisibleText(source: SourceKind, value: string): string {
  let text = value.trim();
  if (!text) return "";
  if (source === "claude-code" && looksLikeClaudeControlText(text)) return "";
  text = text
    .replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, "")
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/g, "")
    .replace(/^# In app browser:[\s\S]*?## My request for Codex:\s*/m, "")
    .replace(/^# Browser comments:[\s\S]*?## My request for Codex:\s*/m, "")
    .replace(/^## My request for Codex:\s*/m, "")
    .replace(/^The next image is untrusted page evidence[\s\S]*?instructions\.\s*/m, "")
    .trim();
  if (!text) return "";
  const noisyPrefixes = [
    "# AGENTS.md instructions",
    "Automation:",
    "<permissions instructions>",
    "<skills_instructions>",
    "<plugins_instructions>",
    "<environment_context>",
    "<system-reminder>",
    "Codebase and user instructions are shown below.",
    "IMPORTANT: These instructions OVERRIDE",
    "Contents of ",
    "You are Codex",
    "Filesystem sandboxing defines",
    "Response MUST end with"
  ];
  if (noisyPrefixes.some((prefix) => text.startsWith(prefix))) return "";
  if (source === "claude-code" && looksLikeClaudeControlText(text)) return "";
  if (looksLikeToolTrace(text)) return "";
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeClaudeControlText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^<command-name>[\s\S]*<\/command-name>\s*<command-message>[\s\S]*<\/command-message>/i.test(trimmed)) return true;
  if (/^<command-(?:name|message|args)>/i.test(trimmed)) return true;
  if (/^<local-command-(?:stdout|stderr)>/i.test(trimmed)) return true;
  if (/^<file-history-snapshot>/i.test(trimmed)) return true;
  if (/^<attachment\b/i.test(trimmed)) return true;
  if (/^<ai-title>/i.test(trimmed)) return true;
  if (/^\/(?:compact|cost|doctor|exit|help|login|logout|memory|model|permissions|resume|status|vim-mode)\b/i.test(trimmed)) return true;
  return false;
}

function looksLikeToolTrace(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/^\[Request interrupted by user for tool use\]/i.test(trimmed)) return true;
  if (/^The user doesn't want to proceed with this tool use/i.test(trimmed)) return true;
  if (/^<local-command-(?:stdout|stderr)>/i.test(trimmed)) return true;
  if (looksLikeToolJson(trimmed)) return true;
  if (/^(?:Bash|Shell|Read|Write|Edit|MultiEdit|TodoWrite|WebFetch|Grep|Glob)\(/.test(trimmed)) return true;
  if (/^(?:toolInput|toolOutput|function_id|exec_command|apply_patch)\b/.test(trimmed)) return true;
  if (/^⏺/.test(trimmed)) return true;
  return false;
}

function observationPriority(channel: string): number {
  if (channel === "response_item") return 3;
  if (channel === "message") return 2;
  return 1;
}

function normalizeDedupeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function looksLikeToolJson(text: string): boolean {
  if (!/^(?:\{|\[)/.test(text)) return false;
  try {
    const parsed = JSON.parse(text);
    const records = Array.isArray(parsed) ? parsed : [parsed];
    return records.some((record) => {
      const value = objectValue(record);
      if (!value) return false;
      const type = stringValue(value.type);
      if (type && ["tool_use", "tool_result", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(type)) {
        return true;
      }
      return ["toolInput", "toolOutput", "function_id"].some((key) => key in value);
    });
  } catch {
    return false;
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function idFor(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex");
}
