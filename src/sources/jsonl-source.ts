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
  const paths = listJsonlFiles(root);
  const subagentParents = subagentParentMap(source, paths);

  for (const path of paths) {
    const stat = statSync(path);
    const checkpoint = db.prepare(
      "SELECT mtime_ms, size FROM scan_checkpoints WHERE source = ? AND path = ?"
    ).get(source, path) as { mtime_ms: number; size: number } | undefined;

    if (checkpoint?.mtime_ms === stat.mtimeMs && checkpoint.size === stat.size) {
      if (subagentParents.has(path)) {
        const sessionId = sessionIdFromRecords(source, path, readJsonlFile(path));
        db.prepare("DELETE FROM observations WHERE session_id = ?").run(sessionId);
        db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      } else {
        backfillProjectPath(db, source, path);
      }
      skipped++;
      continue;
    }

    const records = readJsonlFile(path);
    const sessionId = sessionIdFromRecords(source, path, records);
    const parentSessionId = subagentParents.get(path);
    const targetSessionId = parentSessionId ?? sessionId;
    const isSubagent = Boolean(parentSessionId);
    const projectPath = isSubagent ? null : projectPathFromRecords(source, records);
    const updatedAt = new Date(stat.mtimeMs).toISOString();
    const cleanObservations = observationsFromRecords(source, targetSessionId, path, records);
    if (cleanObservations.length === 0) {
      db.prepare("DELETE FROM observations WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      db.prepare(
        "INSERT OR REPLACE INTO scan_checkpoints (source, path, mtime_ms, size) VALUES (?, ?, ?, ?)"
      ).run(source, path, stat.mtimeMs, stat.size);
      scanned++;
      continue;
    }

    if (isSubagent) {
      db.prepare("DELETE FROM observations WHERE session_id = ?").run(sessionId);
      db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    } else {
      db.prepare(
        "INSERT OR REPLACE INTO sessions (id, source, path, project_path, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(sessionId, source, path, projectPath, updatedAt);
      deleteObservations(db, cleanObservations.map((observation) => observation.id));
    }

    for (const observation of cleanObservations) {
      db.prepare(
        "INSERT OR REPLACE INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run(observation.id, targetSessionId, source, observation.role, observation.text, observation.createdAt);
      observations++;
    }

    db.prepare(
      "INSERT OR REPLACE INTO scan_checkpoints (source, path, mtime_ms, size) VALUES (?, ?, ?, ?)"
    ).run(source, path, stat.mtimeMs, stat.size);
    scanned++;
  }

  return { source, scanned, observations, skipped };
}

function backfillProjectPath(db: Database, source: SourceKind, path: string): void {
  if (source !== "codex") return;
  const session = db.prepare("SELECT id, project_path as projectPath FROM sessions WHERE source = ? AND path = ?")
    .get(source, path) as { id: string; projectPath?: string | null } | undefined;
  if (!session || session.projectPath) return;
  const projectPath = projectPathFromRecords(source, readJsonlFile(path));
  if (!projectPath) return;
  db.prepare("UPDATE sessions SET project_path = ? WHERE id = ?").run(projectPath, session.id);
}

function deleteObservations(db: Database, ids: string[]): void {
  const statement = db.prepare("DELETE FROM observations WHERE id = ?");
  for (const id of ids) statement.run(id);
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

function subagentParentMap(source: SourceKind, paths: string[]): Map<string, string> {
  const byAgentPath = new Map<string, string>();
  for (const path of paths) {
    const records = readJsonlFile(path);
    const parentSessionId = sessionIdFromRecords(source, path, records);
    for (const agentPath of subagentPathsFromRecords(records)) {
      byAgentPath.set(normalizePathKey(agentPath), parentSessionId);
    }
  }
  const parents = new Map<string, string>();
  for (const path of paths) {
    const pathKey = normalizePathKey(path);
    const parentSessionId = byAgentPath.get(pathKey)
      ?? [...byAgentPath].find(([agentPath]) => pathKey === agentPath || pathKey.startsWith(`${agentPath}/`))?.[1];
    if (parentSessionId) parents.set(path, parentSessionId);
  }
  return parents;
}

function subagentPathsFromRecords(records: JsonlRecord[]): string[] {
  return records.flatMap((record) => stringLeaves(record.value).flatMap(subagentPathsFromText));
}

function subagentPathsFromText(text: string): string[] {
  return [...text.matchAll(/<subagent_notification>([\s\S]*?)<\/subagent_notification>/g)].flatMap((match) => {
    try {
      const parsed = JSON.parse(match[1].trim()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
      const agentPath = stringValue((parsed as Record<string, unknown>).agent_path);
      return agentPath ? [agentPath] : [];
    } catch {
      return [];
    }
  });
}

function normalizePathKey(path: string): string {
  return path.replace(/\/+$/u, "");
}

function stringLeaves(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(stringLeaves);
}

function sessionIdFromRecords(source: SourceKind, path: string, records: JsonlRecord[]): string {
  for (const record of records) {
    const meta = record.value.type === "session_meta" ? objectValue(record.value.payload) : null;
    const id = stringValue(meta?.id);
    if (id) return idFor(source, id);
  }
  return idFor(source, path);
}

function projectPathFromRecords(source: SourceKind, records: JsonlRecord[]): string | null {
  if (source !== "codex") return null;
  for (const record of records) {
    const meta = record.value.type === "session_meta" ? objectValue(record.value.payload) : null;
    const cwd = stringValue(meta?.cwd);
    if (cwd) return cwd;
  }
  return null;
}

function codexObservationFromRecord(value: Record<string, unknown>): { role: string; text: string; createdAt: string; channel: string } | null {
  const type = stringValue(value.type);
  const payload = objectValue(value.payload);
  if (type === "event_msg" && payload) {
    const eventType = stringValue(payload.type);
    if (eventType !== "user_message" && eventType !== "agent_message") return null;
    const role = eventType === "user_message" ? "user" : "assistant";
    const text = firstString(payload.message, payload.text) || textFromContent(payload.content, role);
    return {
      role,
      text: withAttachmentText(text, payload),
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
  if (isVisibleText) return stringValue(record.text) ?? "";
  if (type === "image" || type === "input_image" || type === "file" || type === "attachment") {
    const imageUrl = objectValue(record.image_url);
    const kind = type === "image" || type === "input_image" ? "Image" : "File";
    return attachmentLine(kind, firstString(record.name, record.file_name), firstString(record.path, record.file_path, record.url, imageUrl?.url));
  }
  return "";
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
  text = text
    .replace(/# AGENTS\.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/g, "")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/g, "")
    .replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/g, "")
    .replace(/<plugins_instructions>[\s\S]*?<\/plugins_instructions>/g, "")
    .replace(/^# In app browser:[\s\S]*?## My request for Codex:\s*/m, "")
    .replace(/^# Browser comments:[\s\S]*?## My request for Codex:\s*/m, "")
    .replace(/^## My request for Codex:\s*/m, "")
    .replace(/^The next image is untrusted page evidence[\s\S]*?instructions\.\s*/m, "")
    .trim();
  text = normalizeInlineAttachments(text);
  if (!text) return "";
  const noisyPrefixes = [
    "# AGENTS.md instructions",
    "Automation:",
    "<permissions instructions>",
    "<skills_instructions>",
    "<plugins_instructions>",
    "<environment_context>",
    "<system-reminder>",
    "<subagent_notification>",
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

function withAttachmentText(text: string, record: Record<string, unknown>): string {
  const lines = [text, ...structuredAttachmentLines(record)].filter(Boolean);
  return lines.join("\n");
}

function normalizeInlineAttachments(text: string): string {
  const lines = attachmentLinesFromText(text);
  const body = stripInlineAttachmentMarkup(text)
    .split(/\r?\n/)
    .filter((line) => !isFilesMentionedHeader(line))
    .filter((line) => !rawFileMentionFromLine(line))
    .filter((line) => !readableAttachmentFromLine(line))
    .join("\n")
    .trim();
  return [body, ...lines].filter(Boolean).join("\n");
}

function stripInlineAttachmentMarkup(text: string): string {
  return text
    .replace(/<(image|attachment)\b[\s\S]*?<\/\1>/giu, "")
    .replace(/<(image|attachment)\b[^>]*\/?>/giu, "")
    .trim();
}

function structuredAttachmentLines(record: Record<string, unknown>): string[] {
  return dedupeLines([
    ...attachmentLinesFromValues("Image", record.images),
    ...attachmentLinesFromValues("Image", record.local_images),
    ...attachmentLinesFromValues("File", record.text_elements)
  ]);
}

function attachmentLinesFromText(text: string): string[] {
  const tagLines = [...text.matchAll(/<(image|attachment)\b[^>]*>/giu)].map((match) => {
    const tag = match[0];
    const kind = match[1].toLowerCase() === "image" ? "Image" : "File";
    return attachmentLine(
      kind,
      tagAttribute(tag, "name") || tagAttribute(tag, "file_name"),
      tagAttribute(tag, "path") || tagAttribute(tag, "file_path") || tagAttribute(tag, "url")
    );
  });
  const readableLines = text.split(/\r?\n/).map((line) => readableAttachmentFromLine(line)).filter(Boolean);
  const fileLines = text.split(/\r?\n/).map((line) => rawFileMentionFromLine(line)).filter(Boolean);
  return dedupeLines([
    ...tagLines,
    ...readableLines.filter((line) => line.startsWith("Image: ")),
    ...fileLines,
    ...readableLines.filter((line) => !line.startsWith("Image: "))
  ]);
}

function attachmentLinesFromValues(kind: "File" | "Image", value: unknown): string[] {
  const items = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return dedupeLines(items.flatMap((item) => {
    if (typeof item === "string") return attachmentLine(kind, undefined, item);
    const record = objectValue(item);
    if (!record) return [];
    const path = firstString(record.path, record.file_path, record.url);
    if (path) return attachmentLine(kind, firstString(record.name, record.file_name), path);
    return attachmentLinesFromText(firstString(record.text, record.content));
  }).filter(Boolean));
}

function attachmentLine(kind: string, name: unknown, path: unknown): string {
  const cleanPath = stringValue(path)?.trim();
  if (!cleanPath || !looksLikeAttachmentPath(cleanPath)) return "";
  const cleanName = (stringValue(name)?.trim().replace(/\s+/g, " ") || cleanPath.split("/").filter(Boolean).at(-1) || "attachment")
    .replace(/^\[|\]$/g, "");
  return `${kind}: ${cleanName} (${cleanPath})`;
}

function dedupeLines(lines: string[]): string[] {
  const seenPaths = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const path = line.match(/\(([^)]+)\)$/)?.[1] ?? line;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);
    result.push(line);
  }
  return result;
}

function tagAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}=("([^"]*)"|'([^']*)'|\\[([^\\]]*)\\]|([^\\s>]+))`, "i"));
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? match?.[5] ?? "";
}

function isFilesMentionedHeader(line: string): boolean {
  return /^# Files mentioned by the user:\s*$/i.test(line.trim());
}

function rawFileMentionFromLine(line: string): string {
  const match = line.trim().match(/^##\s+(.+?):\s+(.+)$/);
  if (!match || !looksLikeAttachmentPath(match[2])) return "";
  return attachmentLine("Files mentioned", match[1], match[2]);
}

function readableAttachmentFromLine(line: string): string {
  const match = line.trim().match(/^(Image|File|Files mentioned):\s+(.+?)\s+\(([^)]+)\)$/);
  if (!match || !looksLikeAttachmentPath(match[3])) return "";
  return attachmentLine(match[1], match[2], match[3]);
}

function looksLikeAttachmentPath(value: string): boolean {
  return /^(?:\/|~\/|[A-Za-z]:\\|https?:\/\/)/.test(value.trim());
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
