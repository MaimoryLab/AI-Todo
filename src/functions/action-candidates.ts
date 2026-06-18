import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type { Action, CompressedObservation, ReviewQueueItem, Session } from "../types.js";

export interface ActionCandidate {
  title: string;
  description: string;
  priority: number;
  source: "observation" | "browser-review";
  sourceObservationIds: string[];
  tags: string[];
  confidence: number;
  reason: "todo" | "follow_up" | "command_failed" | "blocked" | "validation_failed";
  duplicateHint?: string;
}

export interface ActionCandidateOptions {
  existingActions?: Action[];
  existingReviewItems?: ReviewQueueItem[];
}

type BrowserTurn = { role?: string; text?: string };

const READ_ONLY_TYPES = new Set(["file_read", "search", "web_fetch"]);
const ACTION_VERB_PATTERN = "(修复|补充|实现|调整|验证|提交|创建|更新|移除|处理)";
const ENGLISH_FOLLOW_UP_PATTERN = /\b(follow up|follow-up)\b.{0,80}\b(fix|add|update|create|remove|validate|submit|handle|implement)\b/i;
const ACTION_DESCRIPTION_MAX_LENGTH = 180;

function normalizeText(value: string | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:]/g, "")
    .replace(/\s+/g, " ");
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

function isToolTrace(text: string): boolean {
  const lower = normalizeText(text).toLowerCase();
  if (!lower || isJsonShaped(lower)) return true;
  if (/"(?:cmd|command|workdir|yield_time_ms|max_output_tokens)"\s*:/.test(lower)) return true;
  if (/toolinput|tooloutput|function_id|tooluseid|tooluse|call_[a-z0-9]+|chunk id|wall time|process exited/.test(lower)) return true;
  if (/^\/(?:tmp|users|var|private|volumes)\//i.test(lower)) return true;
  if (/^\s*(?:gh|git|npm|pnpm|yarn|python3?|node|curl)\s+[^\n]*(?:--json|--limit|--workdir|--max-output|--yield-time|status|show|list|run|test|install|build)\b/i.test(lower)) return true;
  if (/^(?:json|state|limit)\s+[\w.-]+/i.test(lower)) return true;
  if (/\b(?:namewithowner|headrefname|baserefname|databaseid|tooluseid)\b/i.test(lower)) return true;
  return false;
}

function candidateText(obs: CompressedObservation): string {
  return normalizeText([obs.narrative, obs.subtitle, ...(obs.facts || [])].filter(Boolean).join(" "));
}

function isMarkdownPlanDocument(text: string): boolean {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  const hasPlanHeading = /^#{1,3}\s+.*(?:计划|Plan)\s*$/im.test(raw);
  const sectionMatches = raw.match(/^#{1,3}\s+(?:Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation|执行步骤|验证命令)\b/img) || [];
  const compact = raw.replace(/\s+/g, " ");
  const compactPlanSectionCount = [
    /#{1,3}\s+Summary\b/i,
    /#{1,3}\s+Key Changes\b/i,
    /#{1,3}\s+Test Plan\b/i,
    /#{1,3}\s+Assumptions\b/i,
    /#{1,3}\s+Implementation\b/i,
    /#{1,3}\s+执行步骤\b/i,
    /#{1,3}\s+验证命令\b/i,
  ].filter((pattern) => pattern.test(compact)).length;
  const compactPlan = /#{1,3}\s+[^#]{0,160}(?:计划|Plan)/i.test(compact) &&
    (compactPlanSectionCount >= 2 || /#{1,3}\s+Summary\b/i.test(compact));
  return (hasPlanHeading && sectionMatches.length >= 2) || compactPlan;
}

function splitCandidateSentences(text: string): string[] {
  const raw = String(text || "").replace(/\r\n/g, "\n");
  const output: string[] = [];
  for (const rawLine of raw.split(/\n+/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, "").trim();
    if (!line || /^#{1,6}\s/.test(line)) continue;
    if (/^(Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation|验证命令|执行步骤)\b[:：]?$/i.test(line)) continue;
    const parts = line.match(/[^。！？!?]+[。！？!?]?/gu) || [line];
    for (const part of parts) {
      const sentence = part.trim();
      if (sentence) output.push(sentence);
    }
  }
  return output;
}

function conciseDescription(sentence: string): string {
  const normalized = normalizeText(sentence);
  if (normalized.length <= ACTION_DESCRIPTION_MAX_LENGTH) return normalized;
  return normalized.slice(0, ACTION_DESCRIPTION_MAX_LENGTH).replace(/[，,；;：:\s]+$/u, "");
}

function cleanTitle(text: string): string {
  const stripped = normalizeText(text)
    .replace(/^(todo|fixme)\s*[:：-]\s*/i, "")
    .replace(/^(下一步|后续|待办)\s*[:：-]?\s*/u, "")
    .replace(/^(请|需要|必须)\s*/u, "")
    .replace(/^(follow up|follow-up|fix)\s*[:：-]?\s*/i, "");
  const first = stripped.split(/[。！？\n]/u)[0] || stripped;
  return first.replace(/[。！？；;,.，]+$/u, "").trim().slice(0, 80);
}

function titleFromText(text: string, fallback: string): string {
  const followUpMatch = text.match(new RegExp(`(?:下一步|后续)\\s*(?:请|需要|必须)?\\s*(${ACTION_VERB_PATTERN}[^。！？\\n]*)`, "u"))?.[1];
  const failureRepairMatch = text.match(new RegExp(`(?:验证未通过|验证失败|测试未通过|测试失败|command failed|exit code [1-9]\\d*|exited with code [1-9]\\d*)[，,。\\s]*(?:请|需要|必须)?\\s*(${ACTION_VERB_PATTERN}[^。！？\\n]*)`, "iu"))?.[1];
  const explicit = text.match(/\b(?:TODO|FIXME)\b\s*[:：-]\s*([^。！？\n]+)/i)?.[1] ||
    text.match(/待办\s*[:：-]\s*([^。！？\n]+)/u)?.[1] ||
    followUpMatch ||
    failureRepairMatch ||
    text.match(/\b(?:follow up|follow-up|fix)\b\s*[:：-]?\s*([^。！？\n]+)/i)?.[1];
  const title = cleanTitle(explicit || text);
  return title || fallback;
}

function hasExplicitFollowUpAction(text: string): boolean {
  return new RegExp(`(?:下一步|后续)\\s*(?:请|需要|必须)?\\s*${ACTION_VERB_PATTERN}`, "u").test(text) ||
    ENGLISH_FOLLOW_UP_PATTERN.test(text);
}

function hasExplicitFailureRepair(text: string): boolean {
  return /验证未通过|验证失败|测试未通过|测试失败|\b(command failed|exit code [1-9]\d*|exited with code [1-9]\d*)\b/iu.test(text);
}

function sentenceReason(text: string): ActionCandidate["reason"] | null {
  if (isToolTrace(text)) return null;
  if (/不应生成待办|不要生成待办|无需生成待办|不是待办|not an action|not a todo/i.test(text)) return null;
  if (/\b(?:TODO|FIXME)\b\s*[:：-]\s*\S/i.test(text) || /待办\s*[:：-]\s*\S/u.test(text)) return "todo";
  if (hasExplicitFollowUpAction(text)) return "follow_up";
  if (/验证未通过|验证失败|测试未通过|测试失败/.test(text)) return "validation_failed";
  if (/\b(command failed|exit code [1-9]\d*|exited with code [1-9]\d*)\b/i.test(text)) return "command_failed";
  if (/\bblocked\b|未完成|被阻塞|阻塞/u.test(text)) return "blocked";
  if (hasExplicitFailureRepair(text)) return "validation_failed";
  return null;
}

function extractActionSentence(text: string): { text: string; reason: ActionCandidate["reason"] } | null {
  if (isToolTrace(text) || isMarkdownPlanDocument(text)) return null;
  for (const sentence of splitCandidateSentences(text)) {
    const reason = sentenceReason(sentence);
    if (!reason) continue;
    return { text: conciseDescription(sentence), reason };
  }
  return null;
}

function reasonFromObservation(obs: CompressedObservation, text: string): ActionCandidate["reason"] | null {
  if (READ_ONLY_TYPES.has(obs.type)) return null;
  return extractActionSentence(text)?.reason || null;
}

function reasonFromTurn(text: string): ActionCandidate["reason"] | null {
  return extractActionSentence(text)?.reason || null;
}

function priorityFor(reason: ActionCandidate["reason"]): number {
  if (reason === "command_failed" || reason === "validation_failed" || reason === "blocked") return 8;
  if (reason === "todo") return 6;
  return 5;
}

function tagsFor(reason: ActionCandidate["reason"]): string[] {
  const tags = ["action-candidate"];
  if (reason === "follow_up") tags.push("follow-up");
  if (reason === "todo") tags.push("todo");
  if (reason === "blocked") tags.push("blocked");
  if (reason === "command_failed" || reason === "validation_failed") tags.push("repair");
  return tags;
}

function candidateKey(title: string, description: string): string {
  return `${normalizedKey(title)}:${normalizedKey(description)}`;
}

function candidateKeys(title: string, description: string): string[] {
  return [candidateKey(title, description), normalizedKey(title)].filter(Boolean);
}

function existingKeys(options: ActionCandidateOptions): Set<string> {
  const keys = new Set<string>();
  for (const action of options.existingActions || []) {
    if (action.status === "pending" || action.status === "active" || action.status === "blocked") {
      keys.add(candidateKey(action.title, action.description || ""));
      keys.add(normalizedKey(action.title));
    }
  }
  for (const item of options.existingReviewItems || []) {
    if (item.kind === "action") {
      keys.add(candidateKey(item.title, item.content || ""));
      keys.add(normalizedKey(item.title));
    }
  }
  return keys;
}

function pushCandidate(
  output: ActionCandidate[],
  seen: Set<string>,
  existing: Set<string>,
  candidate: ActionCandidate,
): void {
  const key = candidateKey(candidate.title, candidate.description);
  const titleKey = normalizedKey(candidate.title);
  if (!titleKey || seen.has(key) || seen.has(titleKey) || existing.has(key) || existing.has(titleKey)) return;
  seen.add(key);
  seen.add(titleKey);
  output.push(candidate);
}

export function extractActionCandidatesFromObservations(
  observations: CompressedObservation[],
  options: ActionCandidateOptions = {},
): ActionCandidate[] {
  const output: ActionCandidate[] = [];
  const seen = new Set<string>();
  const existing = existingKeys(options);
  for (const obs of observations) {
    const text = candidateText(obs);
    if (READ_ONLY_TYPES.has(obs.type)) continue;
    const extracted = extractActionSentence(text);
    const reason = extracted?.reason || reasonFromObservation(obs, text);
    const description = extracted?.text || "";
    if (!reason || !description) continue;
    const title = titleFromText(description, obs.title || "待处理行动");
    pushCandidate(output, seen, existing, {
      title,
      description,
      priority: priorityFor(reason),
      source: "observation",
      sourceObservationIds: [obs.id],
      tags: tagsFor(reason),
      confidence: reason === "follow_up" ? 0.62 : 0.72,
      reason,
    });
  }
  return output;
}

export function extractActionCandidatesFromTurns(
  turns: BrowserTurn[],
  options: ActionCandidateOptions = {},
): ActionCandidate[] {
  const output: ActionCandidate[] = [];
  const seen = new Set<string>();
  const existing = existingKeys(options);
  for (const turn of turns) {
    if (turn.role !== "user") continue;
    const text = normalizeText(turn.text);
    const extracted = extractActionSentence(text);
    const reason = extracted?.reason || reasonFromTurn(text);
    const description = extracted?.text || "";
    if (!reason || !description) continue;
    const title = titleFromText(description, "待处理行动");
    pushCandidate(output, seen, existing, {
      title,
      description,
      priority: priorityFor(reason),
      source: "browser-review",
      sourceObservationIds: [],
      tags: tagsFor(reason),
      confidence: reason === "follow_up" ? 0.62 : 0.72,
      reason,
    });
  }
  return output;
}

function reviewItemId(): string {
  return `review_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

export function actionReviewItemFromCandidate(opts: {
  candidate: ActionCandidate;
  now: string;
  source: ReviewQueueItem["source"];
  page: ReviewQueueItem["page"];
  conversation?: ReviewQueueItem["conversation"];
  basePayload: Record<string, unknown>;
}): ReviewQueueItem {
  return {
    id: `review_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`,
    createdAt: opts.now,
    updatedAt: opts.now,
    status: "pending",
    kind: "action",
    title: opts.candidate.title,
    content: opts.candidate.description,
    source: opts.source,
    page: opts.page,
    ...(opts.conversation ? { conversation: opts.conversation } : {}),
    payload: {
      ...opts.basePayload,
      actionCandidate: {
        priority: opts.candidate.priority,
        reason: opts.candidate.reason,
        confidence: opts.candidate.confidence,
        duplicateHint: opts.candidate.duplicateHint,
        sourceObservationIds: opts.candidate.sourceObservationIds,
      },
      tags: opts.candidate.tags,
    },
  };
}

/**
 * Extract action candidates from browser conversation turns and build
 * deduped review drafts. Shared by the REST review-create trigger and the
 * viewer-server review fallback so both browser-capture paths produce todos
 * through one implementation (single dedup source). Does not persist — the
 * caller writes the returned drafts to KV.reviewQueue.
 */
export async function buildTurnActionDrafts(
  kv: { list<T = unknown>(scope: string): Promise<T[]> },
  opts: {
    turns: BrowserTurn[];
    now: string;
    source: ReviewQueueItem["source"];
    page: ReviewQueueItem["page"];
    conversation?: ReviewQueueItem["conversation"];
    basePayload: Record<string, unknown>;
  },
): Promise<ReviewQueueItem[]> {
  if (!opts.turns.length) return [];
  const [existingActions, existingReviewItems] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
  ]);
  return extractActionCandidatesFromTurns(opts.turns, {
    existingActions,
    existingReviewItems,
  }).map((candidate) =>
    actionReviewItemFromCandidate({
      candidate,
      now: opts.now,
      source: opts.source,
      page: opts.page,
      conversation: opts.conversation,
      basePayload: opts.basePayload,
    }),
  );
}

function nonEmptySessionValue(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function actionReviewItemFromObservationCandidate(
  candidate: ActionCandidate,
  session: Session,
  now: string,
): ReviewQueueItem {
  const sourceSessionProject = nonEmptySessionValue(session.project);
  const sourceSessionCwd = nonEmptySessionValue(session.cwd);
  const project = sourceSessionProject || sourceSessionCwd;
  return {
    id: reviewItemId(),
    createdAt: now,
    updatedAt: now,
    status: "pending",
    kind: "action",
    title: candidate.title,
    content: candidate.description,
    source: "viewer",
    payload: {
      ...(project ? { project } : {}),
      sourceSessionId: session.id,
      ...(sourceSessionProject ? { sourceSessionProject } : {}),
      ...(sourceSessionCwd ? { sourceSessionCwd } : {}),
      tags: candidate.tags,
      actionCandidate: {
        priority: candidate.priority,
        reason: candidate.reason,
        confidence: candidate.confidence,
        duplicateHint: candidate.duplicateHint,
        sourceObservationIds: candidate.sourceObservationIds,
      },
    },
  };
}

function sessionSortTime(session: Session): string {
  return session.endedAt || session.startedAt || "";
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.floor(parsed));
}

export function registerActionCandidateFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction(
    "mem::action-candidates-generate",
    async (
      data: {
        maxSessions?: number;
        maxObservationsPerSession?: number;
        project?: string;
      } = {},
    ): Promise<{
      success: true;
      generated: number;
      items: ReviewQueueItem[];
      scannedSessions: number;
      scannedObservations: number;
    }> => {
      const maxSessions = clampPositiveInt(data.maxSessions, 20, 100);
      const maxObservationsPerSession = clampPositiveInt(data.maxObservationsPerSession, 200, 1000);
      const project = typeof data.project === "string" && data.project.trim()
        ? data.project.trim()
        : undefined;

      const [actions, reviewItems, allSessions] = await Promise.all([
        kv.list<Action>(KV.actions).catch(() => []),
        kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
        kv.list<Session>(KV.sessions).catch(() => []),
      ]);
      const sessions = allSessions
        .filter((session) => !project || session.project === project || session.cwd === project)
        .sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)))
        .slice(0, maxSessions);

      let scannedObservations = 0;
      const candidates: Array<{ candidate: ActionCandidate; session: Session }> = [];
      const generatedKeys = new Set<string>();
      for (const session of sessions) {
        const observations = (await kv.list<CompressedObservation>(
          KV.observations(session.id),
        ).catch(() => []))
          .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
          .slice(0, maxObservationsPerSession);
        scannedObservations += observations.length;
        const sessionCandidates = extractActionCandidatesFromObservations(observations, {
          existingActions: actions,
          existingReviewItems: reviewItems,
        });
        for (const candidate of sessionCandidates) {
          const keys = candidateKeys(candidate.title, candidate.description);
          if (keys.some((key) => generatedKeys.has(key))) continue;
          keys.forEach((key) => generatedKeys.add(key));
          candidates.push({ candidate, session });
        }
      }

      const now = new Date().toISOString();
      const items = candidates.map(({ candidate, session }) =>
        actionReviewItemFromObservationCandidate(candidate, session, now),
      );
      await Promise.all(items.map((item) => kv.set(KV.reviewQueue, item.id, item)));
      return {
        success: true,
        generated: items.length,
        items,
        scannedSessions: sessions.length,
        scannedObservations,
      };
    },
  );
}
