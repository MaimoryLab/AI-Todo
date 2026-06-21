import type { HookType, RawObservation } from "../types.js";
import { fingerprintId, generateId } from "../state/schema.js";

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  payload?: Record<string, unknown>;
  message?: {
    role?: string;
    content?: unknown;
  };
  toolUseResult?: unknown;
  [k: string]: unknown;
}

export interface ParsedTranscript {
  sessionId: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  observations: RawObservation[];
}

// A real cwd is an absolute filesystem path. Tool-trace pollution sometimes
// lands a shell command in the cwd field (e.g. `pwd && echo "--- branch ---" &&
// git branch --show-current`), which the old "last path segment" rule turned
// into a garbage project name. Reject anything that isn't absolute or that
// carries shell-command *shape* — operators (`&&`, `||`, `$(`, backtick), a
// flag (`\s-x`/`\s--x`), or a metachar adjacent to whitespace. Bare punctuation
// in a segment name is allowed: `app/(marketing)`, `q&a-service`, `cost$` are
// legal directories, not commands.
const SHELL_POLLUTION = /&&|\|\||\$\(|`|\s--?[A-Za-z]|\s[&|;<>(){}"$]|[&|;<>(){}"$]\s/u;

function isPlausibleCwd(cwd: string): boolean {
  if (!cwd) return false;
  // must be absolute: POSIX (/…, ~/…), Windows drive (C:\…), or UNC (\\…)
  if (!/^(?:\/|~(?:\/|$)|[A-Za-z]:[\\/]|\\\\)/.test(cwd)) return false;
  if (SHELL_POLLUTION.test(cwd)) return false;
  return true;
}

function deriveProject(cwd: string): string {
  const trimmed = (cwd || "").trim();
  if (!isPlausibleCwd(trimmed)) return "unknown";
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1] || "";
  if (!last || last === "~") return "unknown";
  return last;
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "text" && typeof entry.text === "string") {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

function extractToolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_use") {
      out.push({
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "unknown",
        input: entry.input,
      });
    }
  }
  return out;
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; output: unknown; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; output: unknown; isError: boolean }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_result") {
      out.push({
        toolUseId: typeof entry.tool_use_id === "string" ? entry.tool_use_id : "",
        output: entry.content,
        isError: entry.is_error === true,
      });
    }
  }
  return out;
}

function stringField(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value : "";
}

function codexTimestamp(entry: JsonlEntry, payload: Record<string, unknown>): string {
  return stringField(payload, "timestamp") || entry.timestamp || new Date().toISOString();
}

function codexTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.join("\n");
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rawObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function observationFingerprintParts(obs: RawObservation, index: number): string[] {
  const raw = rawObject(obs.raw);
  const entry = rawObject(raw.entry ?? obs.raw);
  const payload = rawObject(entry.payload);
  const message = rawObject(entry.message);
  const role = String(payload.role || message.role || (obs.userPrompt ? "user" : obs.assistantResponse ? "assistant" : ""));
  const toolOrCallId = String(
    raw.toolUseId ||
      payload.call_id ||
      payload.id ||
      obs.toolName ||
      "",
  );
  return [
    obs.sessionId,
    obs.timestamp,
    String(entry.type || ""),
    obs.hookType,
    role,
    String(obs.toolName || ""),
    toolOrCallId,
    String(index),
  ];
}

function stabilizeObservationIds(observations: RawObservation[], sessionId: string): void {
  observations.forEach((obs, index) => {
    obs.sessionId = sessionId;
    obs.id = fingerprintId("obs", observationFingerprintParts(obs, index).join("|"));
  });
}

export function parseJsonlText(text: string, fallbackSessionId?: string): ParsedTranscript {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as JsonlEntry);
    } catch {
      // skip malformed lines
    }
  }

  let sessionId = "";
  let cwd = "";
  let firstTs = "";
  let lastTs = "";

  const observations: RawObservation[] = [];
  let lastCodexTool:
    | { id: string; name: string; input: unknown }
    | null = null;

  for (const entry of entries) {
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (entry.cwd && !cwd) cwd = entry.cwd;
    const payload = entry.payload || {};
    if (entry.type === "session_meta") {
      if (!sessionId) sessionId = stringField(payload, "id");
      if (!cwd) cwd = stringField(payload, "cwd");
    }
    const ts = entry.type === "session_meta" || entry.type === "event_msg" || entry.type === "response_item"
      ? codexTimestamp(entry, payload)
      : entry.timestamp || new Date().toISOString();
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    const role = entry.message?.role;
    const content = entry.message?.content;

    if (entry.type === "session_meta") {
      continue;
    } else if (entry.type === "event_msg" && payload.type === "user_message") {
      const prompt = stringField(payload, "message") || stringField(payload, "text") || stringField(payload, "content");
      if (prompt.trim().length > 0) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "prompt_submit" as HookType,
          userPrompt: prompt,
          raw: entry,
        });
      }
    } else if (entry.type === "event_msg" && payload.type === "agent_message") {
      const response = stringField(payload, "message") || stringField(payload, "text") || stringField(payload, "content");
      if (response.trim().length > 0) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "stop" as HookType,
          assistantResponse: response,
          raw: entry,
        });
      }
    } else if (entry.type === "response_item" && payload.type === "message") {
      const text = codexTextFromContent(payload.content);
      if (text.trim().length > 0) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: payload.role === "user" ? "prompt_submit" as HookType : "stop" as HookType,
          ...(payload.role === "user" ? { userPrompt: text } : { assistantResponse: text }),
          raw: entry,
        });
      }
    } else if (entry.type === "response_item" && payload.type === "function_call") {
      const name = stringField(payload, "name") || "unknown";
      const toolId = stringField(payload, "call_id") || stringField(payload, "id");
      const input = parseMaybeJson(payload.arguments ?? payload.input);
      lastCodexTool = { id: toolId, name, input };
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "pre_tool_use" as HookType,
        toolName: name,
        toolInput: input,
        raw: { toolUseId: toolId, entry },
      });
    } else if (entry.type === "response_item" && payload.type === "function_call_output") {
      const toolId = stringField(payload, "call_id") || stringField(payload, "id") || lastCodexTool?.id || "";
      const toolName = lastCodexTool?.name;
      observations.push({
        id: generateId("obs"),
        sessionId: sessionId || "imported",
        timestamp: ts,
        hookType: "post_tool_use" as HookType,
        toolName,
        toolInput: toolId ? { toolUseId: toolId } : undefined,
        toolOutput: payload.output,
        raw: { toolUseId: toolId, entry },
      });
      lastCodexTool = null;
    } else if (entry.type === "user" && role === "user") {
      const toolResults = extractToolResults(content);
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          observations.push({
            id: generateId("obs"),
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: (result.isError ? "post_tool_failure" : "post_tool_use") as HookType,
            toolName: undefined,
            toolInput: { toolUseId: result.toolUseId },
            toolOutput: result.output,
            raw: entry,
          });
        }
      } else {
        const text = toText(content);
        if (text.trim().length > 0) {
          observations.push({
            id: generateId("obs"),
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: "prompt_submit" as HookType,
            userPrompt: text,
            raw: entry,
          });
        }
      }
    } else if (entry.type === "assistant" && role === "assistant") {
      const text = toText(content);
      const tools = extractToolUses(content);
      if (text.trim().length > 0) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "stop" as HookType,
          assistantResponse: text,
          raw: entry,
        });
      }
      for (const tool of tools) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use" as HookType,
          toolName: tool.name,
          toolInput: tool.input,
          raw: { toolUseId: tool.id, entry },
        });
      }
    } else if (entry.type === "summary" || entry.type === "system") {
      // ignore meta entries
    }
  }

  const effectiveSessionId = sessionId || fallbackSessionId || generateId("sess");
  stabilizeObservationIds(observations, effectiveSessionId);

  const nowIso = new Date().toISOString();
  return {
    sessionId: effectiveSessionId,
    project: deriveProject(cwd),
    // Don't persist a polluted cwd (a shell command captured in the cwd field):
    // fall back to the trusted process cwd, the same fallback already used for a
    // missing cwd. Keeps the garbage out of session metadata / UI / downstream.
    cwd: isPlausibleCwd(cwd) ? cwd : process.cwd(),
    startedAt: firstTs || nowIso,
    endedAt: lastTs || nowIso,
    observations,
  };
}
