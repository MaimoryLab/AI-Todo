import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  RawObservation,
  Session,
  SessionHighlight,
  SessionHighlightCategory,
  SessionHighlightsError,
  SessionHighlightsView,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";

type ObservationRow = CompressedObservation | RawObservation;

const CATEGORY_ORDER: SessionHighlightCategory[] = [
  "goal",
  "agent_output",
  "failure",
  "validation",
  "command",
  "mcp",
  "tool",
  "file",
  "artifact",
  "skill",
  "todo",
  "follow_up",
];

function isRawObservation(row: ObservationRow): row is RawObservation {
  return "hookType" in row && typeof row.hookType === "string";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max = 240): string {
  const text = normalizeText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function categoryCounts(): Record<SessionHighlightCategory, number> {
  return Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0])) as Record<
    SessionHighlightCategory,
    number
  >;
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

function dedupeText(value: string): string {
  return normalizeText(value).toLowerCase();
}

function isJsonShaped(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isToolTraceText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (isJsonShaped(normalized)) return true;
  return includesAny(normalized.toLowerCase(), [
    "\"command\"",
    "toolinput",
    "tooloutput",
    "function_id",
    "apply_patch",
    "exec_command",
    "memory_",
    "agentmemory_memory_",
  ]);
}

function addHighlight(
  highlights: SessionHighlight[],
  row: ObservationRow | null,
  category: "goal" | "agent_output",
  title: string,
  summary: string,
  opts: { sessionId: string; importance?: number; confidence?: number },
): void {
  const cleanSummary = truncate(summary);
  if (!cleanSummary || isToolTraceText(cleanSummary)) return;
  const key = `${category}:${dedupeText(cleanSummary)}`;
  if (highlights.some((h) => `${h.category}:${dedupeText(h.summary)}` === key)) return;
  const sourceObservationId = row?.id;
  const timestamp = row?.timestamp;
  highlights.push({
    id: `${category}_${sourceObservationId || "session"}`,
    sessionId: opts.sessionId,
    category,
    title: truncate(title, 120),
    summary: cleanSummary,
    ...(timestamp ? { timestamp } : {}),
    ...(sourceObservationId ? { sourceObservationId } : {}),
    files: [],
    importance: opts.importance ?? 7,
    confidence: opts.confidence ?? 0.6,
  });
}

function compressedConversationText(row: CompressedObservation): string {
  return normalizeText([row.narrative, row.subtitle, ...(row.facts || [])].filter(Boolean).join(" | "));
}

function isAssistantConversation(row: CompressedObservation): boolean {
  return /\b(agent output|assistant response|assistant)\b/i.test(compressedConversationText(row));
}

function titleOf(row: ObservationRow, category: "goal" | "agent_output"): string {
  if (category === "agent_output") return "Agent output";
  if (isRawObservation(row)) return row.hookType;
  return row.title || row.type || "Conversation";
}

function hasAssistantOutputs(rows: ObservationRow[]): boolean {
  return rows.some((row) => {
    if (isRawObservation(row)) {
      return typeof row.assistantResponse === "string" && !isToolTraceText(row.assistantResponse);
    }
    return row.type === "conversation" && isAssistantConversation(row) && !isToolTraceText(compressedConversationText(row));
  });
}

function addConversationHighlights(
  highlights: SessionHighlight[],
  sessionId: string,
  row: ObservationRow,
): void {
  if (isRawObservation(row)) {
    if (typeof row.userPrompt === "string") {
      addHighlight(highlights, row, "goal", titleOf(row, "goal"), row.userPrompt, {
        sessionId,
        importance: 8,
        confidence: 0.65,
      });
    }
    if (typeof row.assistantResponse === "string") {
      addHighlight(highlights, row, "agent_output", "Agent output", row.assistantResponse, {
        sessionId,
        importance: 7,
        confidence: 0.65,
      });
    }
    return;
  }

  if (row.type !== "conversation") return;
  const text = compressedConversationText(row);
  if (isAssistantConversation(row)) {
    addHighlight(highlights, row, "agent_output", titleOf(row, "agent_output"), text, {
      sessionId,
      importance: row.importance || 7,
      confidence: row.confidence ?? 0.6,
    });
    return;
  }
  addHighlight(highlights, row, "goal", titleOf(row, "goal"), text, {
    sessionId,
    importance: row.importance || 7,
    confidence: row.confidence ?? 0.6,
  });
}

function buildHighlights(
  session: Session,
  rows: ObservationRow[],
  maxItems: number,
): SessionHighlightsView {
  const sorted = [...rows].sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  const highlights: SessionHighlight[] = [];
  if (session.firstPrompt) {
    addHighlight(highlights, null, "goal", "Initial user goal", session.firstPrompt, {
      sessionId: session.id,
      importance: 9,
      confidence: 0.7,
    });
  }

  for (const row of sorted) {
    addConversationHighlights(highlights, session.id, row);
  }

  highlights.sort((a, b) => {
    const categoryDiff = CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (categoryDiff !== 0) return categoryDiff;
    const importanceDiff = b.importance - a.importance;
    if (importanceDiff !== 0) return importanceDiff;
    return (a.timestamp || "").localeCompare(b.timestamp || "");
  });
  const limited = highlights.slice(0, maxItems);
  const counts = categoryCounts();
  for (const highlight of limited) counts[highlight.category] += 1;
  const assistantOutputs = hasAssistantOutputs(sorted);

  return {
    success: true,
    session,
    coverage: {
      llmUsed: false,
      hasAssistantOutputs: assistantOutputs,
      missingAssistantOutputs: !assistantOutputs,
      rawObservationCount: sorted.filter(isRawObservation).length,
      compressedObservationCount: sorted.filter((row) => !isRawObservation(row)).length,
    },
    stats: {
      observationCount: sorted.length,
      highlightCount: limited.length,
      categoryCounts: counts,
      fileCount: 0,
      toolCount: 0,
    },
    highlights: limited,
  };
}

export function registerSessionHighlightsFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::session-highlights",
    async (
      data: { sessionId?: string; maxItems?: number } | undefined,
    ): Promise<SessionHighlightsView | SessionHighlightsError> => {
      if (!data?.sessionId || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();
      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) return { success: false, error: "session_not_found" };
      const requestedMax = Number.isInteger(data.maxItems) ? data.maxItems as number : 40;
      const maxItems = Math.max(1, Math.min(200, requestedMax));
      const observations = await kv.list<ObservationRow>(KV.observations(sessionId));
      return buildHighlights(session, observations, maxItems);
    },
  );
}
