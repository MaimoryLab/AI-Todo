import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV, fingerprintId, generateId, nearDuplicateTitle } from "../state/schema.js";
import type { Action, CompressedObservation, ReviewQueueItem, ScanCheckpoint, Session } from "../types.js";
import {
  DEFAULT_LANGEXTRACT_BASE_URL,
  DEFAULT_TODO_EXTRACT_TIMEOUT_MS,
  getEnvVar,
  normalizeTodoExtractorModel,
  normalizeTodoExtractorProvider,
} from "../config.js";
import { scanCodexSource } from "./source-scan-codex.js";
import {
  extractActionCandidatesFromObservations,
  type ActionCandidate,
} from "./action-candidates.js";

type TimeBucket = "current" | "recent" | "history";
type TypeBucket = "pending" | "to_start" | "follow_up" | "in_progress" | "done" | "processing";

export interface ExtractedTodo {
  title: string;
  description: string;
  confidence: number;
  timeBucket: TimeBucket;
  typeBucket: TypeBucket;
  sourceSessionId: string;
  evidence: {
    sourceObservationId: string;
    quote: string;
    charStart?: number;
    charEnd?: number;
  };
  dedupeKey: string;
}

type ObservationBlock = {
  sourceObservationId: string;
  timestamp: string;
  type: string;
  title: string;
  text: string;
};

type TodoExtractOptions = {
  maxSessions?: number;
  maxObservationsPerSession?: number;
  project?: string;
  force?: boolean;
  scanSources?: boolean;
};

const TIME_BUCKETS = new Set(["current", "recent", "history"]);
const TYPE_BUCKETS = new Set(["pending", "to_start", "follow_up", "in_progress", "done", "processing"]);
const SIDE_CAR = "todo-extract-langextract.py";
const SIDE_CAR_ENV_KEYS = [
  "LANGEXTRACT_API_KEY",
  "LANGEXTRACT_BASE_URL",
  "LANGEXTRACT_MODEL",
  "LANGEXTRACT_PROVIDER",
  "LANGEXTRACT_THINKING_DEPTH",
  "LANGEXTRACT_PASSES",
  "LANGEXTRACT_MAX_WORKERS",
  "LANGEXTRACT_MAX_CHAR_BUFFER",
];

function envNumber(key: string, fallback: number): number {
  const parsed = Number(getEnvVar(key));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "number" ? value : parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(max, Math.floor(parsed));
}

function normalizeText(value: string | undefined): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizedKey(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[，。！？；：,.!?;:]/g, "").replace(/\s+/g, " ");
}

// STEP-08 PR 4/5: the rules/LLM extractors emit clusters of near-identical
// titles ("克隆上游项目到子目录" reworded with insertions/word-order drift) that
// the exact-key dedup misses. nearDuplicateTitle (in schema.ts) is the single
// source of truth for the policy (similarity bar + discriminator vetoes); here
// we just scan it against already-accepted *active* titles.
function isNearDuplicateTitle(normalizedTitle: string, seenTitles: string[]): boolean {
  return seenTitles.some((seen) => nearDuplicateTitle(normalizedTitle, seen));
}

// Seed the near-dup guard only from titles of work that is still open. A new
// pending todo that resembles a done/cancelled action (or an already
// approved/dismissed review) must still be allowed — the work may have
// regressed or reopened. (Exact-dup suppression keeps its existing behavior.)
function existingActiveTitles(actions: Action[], reviews: ReviewQueueItem[]): string[] {
  const titles: string[] = [];
  for (const action of actions) {
    if (action.status === "done" || action.status === "cancelled") continue;
    const title = normalizedKey(action.title);
    if (title) titles.push(title);
  }
  for (const item of reviews) {
    if (item.kind !== "action") continue;
    if (item.status === "approved" || item.status === "dismissed") continue;
    const title = normalizedKey(item.title);
    if (title) titles.push(title);
  }
  return titles;
}

function stripTitleNoise(value: string): string {
  let text = normalizeText(value)
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/^[-–—•*]\s*/u, "");
  for (let i = 0; i < 3; i++) {
    text = text
      .replace(/^(todo|fixme)\s*[:：-]\s*/i, "")
      .replace(/^因为[^，,]{0,40}[，,]\s*/u, "")
      .replace(/^(下一步|后续|待办|请|需要|必须|我会|我将|现在我会|接下来|先)\s*[:：-]?\s*/u, "")
      .replace(/^(follow up|follow-up|fix)\s*[:：-]?\s*/i, "")
      .trim();
  }
  return text;
}

// Trim a title to `cap` characters without splitting a word / CJK char /
// surrogate pair: prefer the last clause boundary (，,；;、 or whitespace)
// at or before the cap; never hard-cut mid-token (the old `.slice(0, n)`
// produced fragments like "返回 4" / "…/he").
function trimToTitleBoundary(text: string, cap: number): string {
  const chars = Array.from(text);
  if (chars.length <= cap) return text.replace(/[，,；;：:\s]+$/u, "");
  const head = chars.slice(0, cap);
  let boundary = -1;
  for (let i = head.length - 1; i >= Math.min(12, cap >> 1); i--) {
    if (/[，,；;、\s]/u.test(head[i])) {
      boundary = i;
      break;
    }
  }
  const cut = (boundary > 0 ? head.slice(0, boundary) : head).join("");
  return cut.replace(/[，,；;：:\s]+$/u, "");
}

// Reject a title that is obviously a truncation fragment rather than a real
// todo (HTTP status cut to "返回 4", a list cut to "…、/he", or a dangling
// URL). Such a candidate is skipped in favour of the next source field.
function looksTruncated(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(?:返回|status|code|状态码)\s*\d{1,2}$/i.test(t)) return true;
  if (/[、,，]\s*\/[A-Za-z]{1,4}$/.test(t)) return true;
  if (/\bhttps?:\/\/\S*[:/]$/i.test(t)) return true;
  return false;
}

function firstTitleSentence(value: string): string {
  const text = stripTitleNoise(value).replace(/`[^`]*`/g, "").replace(/\s+/g, " ");
  const sentence = text.match(/[^。！？!?\n]+[。！？!?]?/u)?.[0] || text;
  const compact = sentence
    .replace(/[。！？!?；;,.，\s]+$/u, "")
    .replace(/[，,；;]\s*(?:若|如果|如仍|否则|并且|同时|以便|避免|不让)\b.*$/u, "")
    .replace(/[，,]?\s*(?:并|然后)?\s*(保存到|保存|写入|输出|放到|存到)\s*$/u, "")
    .replace(/(?:，|,)?\s*(并|然后)\s*$/u, "")
    .trim()
    .replace(/[，,；;：:\s]+$/u, "");
  if (compact.length <= 42) return compact;
  const short = compact
    .replace(/^(?:我会|我要|我将|现在我会|接下来)\s*/u, "")
    .replace(/[，,；;]\s*.*$/u, "")
    .trim();
  return trimToTitleBoundary(short || compact, 42);
}

function looksLikeBadTitle(value: string): boolean {
  const text = normalizeText(value);
  const lower = text.toLowerCase();
  if (text.length < 3) return true;
  if (!/[A-Za-z\u4e00-\u9fff]/.test(text)) return true;
  if (/^[{\[]/.test(text)) return true;
  if (/^-[a-z0-9_-]+(?:\s|$)/i.test(text)) return true;
  if (/^[A-Za-z0-9_.-]+\/?$/.test(text)) return true;
  if (/\b(tooluseid|tooluse|call_[a-z0-9]+|chunk id|wall time|process exited)\b/i.test(text)) return true;
  if (/"(cmd|command|workdir|yield_time_ms|max_output_tokens)"\s*:/.test(text)) return true;
  if (/^\/(?:tmp|users|var|private|volumes)\//i.test(text)) return true;
  if (/^[\w.-]+\/(?:\.\.\.|[\w.-]+\/)/.test(text)) return true;
  if ((/\/|\\/.test(text)) && /\.(png|jpe?g|gif|webp|json|ya?ml|ts|tsx|js|py|md)\b/i.test(text)) return true;
  if (/^\s*(?:gh|git|npm|pnpm|yarn|python3?|node|curl)\s+[^\n]*(?:--json|--limit|--workdir|--max-output|--yield-time|status|show|list|run|test|install|build)\b/i.test(text)) return true;
  if (/^(?:json|state|limit)\s+[\w.-]+/i.test(text)) return true;
  if (/\b(?:nameWithOwner|headRefName|baseRefName|databaseId)\b/.test(text)) return true;
  if (/\b--(?:json|limit|state|repo|workdir|max-output|yield-time)\b/i.test(text)) return true;
  const punctuation = (text.match(/[{}[\]":,]/g) || []).length;
  if (text.length >= 24 && punctuation / text.length > 0.2) return true;
  return lower === "untitled todo" || lower === "untitled candidate";
}

function isPollutedTodoText(value: string | undefined): boolean {
  const text = normalizeText(value);
  const lower = text.toLowerCase();
  if (!text) return false;
  if (text.length <= 90 && looksLikeBadTitle(text)) return true;
  if (/please implement this plan/i.test(text)) return true;
  if (/^#{1,3}\s+.*(?:计划|Plan)\s*$/im.test(text) && /#{1,3}\s+(?:Summary|Key Changes|Test Plan|Assumptions|Implementation|执行步骤|验证命令)\b/im.test(text)) return true;
  if (/"(?:plan|status|step)"\s*:/.test(text) && /"step"\s*:/.test(text)) return true;
  if (/审查结果\s*\[[Pp]\d+\]/.test(text) && /(?:src|test)\/[^\s]+/.test(text)) return true;
  if (/toolinput|tooloutput|function_id|tooluseid|tooluse|call_[a-z0-9]+|chunk id|wall time|process exited/i.test(text)) return true;
  if (/"(?:cmd|command|workdir|yield_time_ms|max_output_tokens)"\s*:/.test(text)) return true;
  if (/^\/(?:tmp|users|var|private|volumes)\//i.test(text)) return true;
  if (/^\s*(?:gh|git|npm|pnpm|yarn|python3?|node|curl)\s+[^\n]*(?:--json|--limit|--workdir|--max-output|--yield-time|status|show|list|run|test|install|build)\b/i.test(text)) return true;
  if (/^(?:json|state|limit)\s+[\w.-]+/i.test(lower)) return true;
  if (/\b(?:namewithowner|headrefname|baserefname|databaseid)\b/i.test(lower)) return true;
  if (/^⏺/.test(text) || /\b(?:bash|shell|exec)\(/i.test(text)) return true;
  if (/^[a-z][a-z0-9_-]*-[0-9a-f]{6,}`?$/i.test(text)) return true;
  if (/服务可用|页面已经能返回/.test(text)) return true;
  if (/\b(?:Viewer|Health)\b\s*[：:]\s*(?:\[|https?:\/\/)/i.test(text)) return true;
  if (
    /(?:都能|已(?:经)?|成功|顺利)[^。\n]{0,12}(?:显示|通过|完成|可用|生效)/.test(text) &&
    !/(?:修复|补充|实现|调整|验证|需要|必须|未完成|失败|阻塞|TODO|FIXME)/i.test(text)
  )
    return true;
  return false;
}

export function cleanTodoTitle(title: string, description = "", quote = ""): string | null {
  for (const raw of [title, description, quote]) {
    const candidate = firstTitleSentence(raw);
    if (candidate && !looksLikeBadTitle(candidate) && !looksTruncated(candidate)) return candidate;
  }
  return null;
}

function todoForStorage(todo: ExtractedTodo): ExtractedTodo | null {
  // STEP-08 Layer 2: never store completed work as a todo — the surface is
  // for UNRESOLVED pain points. (Enum keeps accepting "done"; we filter at emit.)
  if (todo.typeBucket === "done") return null;
  const title = cleanTodoTitle(todo.title, todo.description, todo.evidence?.quote);
  if (!title) return null;
  const description = normalizeText(todo.description || todo.evidence?.quote).slice(0, 1000);
  if (!description) return null;
  if (isPollutedTodoText(title) || isPollutedTodoText(description) || isPollutedTodoText(todo.evidence?.quote)) return null;
  const rawDedupe = normalizeText(todo.dedupeKey);
  const dedupeKey = rawDedupe && !looksLikeBadTitle(rawDedupe)
    ? normalizedKey(rawDedupe)
    : normalizedKey(`${title}:${description}`);
  return { ...todo, title, description, dedupeKey };
}

function sessionSortTime(session: Session): string {
  return session.endedAt || session.startedAt || "";
}

function timeBucketFor(session: Session, now = Date.now()): TimeBucket {
  if (session.status === "active") return "current";
  const raw = session.endedAt || session.startedAt;
  const at = raw ? new Date(raw).getTime() : 0;
  if (!Number.isFinite(at) || at <= 0) return "recent";
  const ageMs = now - at;
  if (ageMs <= 24 * 60 * 60 * 1000) return "current";
  if (ageMs <= 14 * 24 * 60 * 60 * 1000) return "recent";
  return "history";
}

function actionStatusFor(typeBucket: TypeBucket): Action["status"] {
  if (typeBucket === "done") return "done";
  if (typeBucket === "in_progress" || typeBucket === "processing") return "active";
  return "pending";
}

function textForObservation(obs: CompressedObservation): string {
  return normalizeText([obs.narrative, ...(obs.facts || []), obs.subtitle].filter(Boolean).join("\n"));
}

function blockFor(obs: CompressedObservation): ObservationBlock {
  return {
    sourceObservationId: obs.id,
    timestamp: obs.timestamp || "",
    type: obs.type,
    title: obs.title || "",
    text: textForObservation(obs),
  };
}

function sidecarPath(): string | null {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(base, SIDE_CAR),
    join(base, "functions", SIDE_CAR),
    join(base, "..", "src", "functions", SIDE_CAR),
    join(base, "..", "functions", SIDE_CAR),
    resolve(process.cwd(), "src", "functions", SIDE_CAR),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

export async function runLangExtractSidecar(
  input: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<ExtractedTodo[]> {
  const script = sidecarPath();
  if (!script) throw new Error("langextract sidecar not found");
  const python = getEnvVar("LANGEXTRACT_PYTHON") || "python3";
  const env = { ...process.env };
  for (const key of SIDE_CAR_ENV_KEYS) {
    const value = getEnvVar(key);
    if (value) env[key] = value;
  }
  env.LANGEXTRACT_MODEL = normalizeTodoExtractorModel(env.LANGEXTRACT_MODEL);
  env.LANGEXTRACT_PROVIDER = normalizeTodoExtractorProvider(env.LANGEXTRACT_PROVIDER);
  env.LANGEXTRACT_BASE_URL = env.LANGEXTRACT_BASE_URL || DEFAULT_LANGEXTRACT_BASE_URL;
  const timeoutMs = opts.timeoutMs ?? envNumber("AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS", DEFAULT_TODO_EXTRACT_TIMEOUT_MS);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"], env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("langextract sidecar timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `langextract sidecar exited ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { todos?: unknown };
        resolvePromise(Array.isArray(parsed.todos) ? parsed.todos as ExtractedTodo[] : []);
      } catch (err) {
        reject(err);
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function toTypeBucket(reason: ActionCandidate["reason"]): TypeBucket {
  if (reason === "follow_up") return "follow_up";
  if (reason === "command_failed" || reason === "validation_failed") return "processing";
  return "pending";
}

function candidateToTodo(candidate: ActionCandidate, session: Session, bucket: TimeBucket): ExtractedTodo | null {
  const obsId = candidate.sourceObservationIds[0];
  if (!obsId) return null;
  return {
    title: candidate.title,
    description: candidate.description,
    confidence: candidate.confidence,
    timeBucket: bucket,
    typeBucket: toTypeBucket(candidate.reason),
    sourceSessionId: session.id,
    evidence: {
      sourceObservationId: obsId,
      quote: candidate.description,
    },
    dedupeKey: normalizedKey(candidate.duplicateHint || `${candidate.title}:${candidate.description}`),
  };
}

function safeTodo(raw: ExtractedTodo, session: Session): ExtractedTodo {
  const confidence = Number(raw.confidence);
  const typeBucket = TYPE_BUCKETS.has(raw.typeBucket) ? raw.typeBucket : "pending";
  const fallbackTime = timeBucketFor(session);
  return {
    title: normalizeText(raw.title).slice(0, 120) || "Untitled todo",
    description: normalizeText(raw.description || raw.evidence?.quote).slice(0, 1000),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    timeBucket: TIME_BUCKETS.has(raw.timeBucket) ? raw.timeBucket : fallbackTime,
    typeBucket,
    sourceSessionId: raw.sourceSessionId || session.id,
    evidence: {
      sourceObservationId: normalizeText(raw.evidence?.sourceObservationId),
      quote: normalizeText(raw.evidence?.quote),
      ...(Number.isFinite(raw.evidence?.charStart) ? { charStart: Number(raw.evidence.charStart) } : {}),
      ...(Number.isFinite(raw.evidence?.charEnd) ? { charEnd: Number(raw.evidence.charEnd) } : {}),
    },
    dedupeKey: normalizedKey(raw.dedupeKey || `${raw.title}:${raw.description}`),
  };
}

export function validateTodoEvidence(todo: ExtractedTodo, blockMap: Map<string, Pick<ObservationBlock, "text">>): boolean {
  if (!todo.evidence.sourceObservationId || !todo.evidence.quote) return false;
  const block = blockMap.get(todo.evidence.sourceObservationId);
  const blockText = normalizeText(block?.text);
  const quote = normalizeText(todo.evidence.quote);
  return !!blockText && (blockText.includes(quote) || quote.includes(blockText));
}

function existingDedupeKeys(actions: Action[], reviews: ReviewQueueItem[]): Set<string> {
  const keys = new Set<string>();
  for (const action of actions) {
    const extraction = action.metadata?.todoExtraction as Record<string, unknown> | undefined;
    if (typeof extraction?.dedupeKey === "string") keys.add(extraction.dedupeKey);
    keys.add(normalizedKey(action.title));
    keys.add(normalizedKey(`${action.title}:${action.description || ""}`));
  }
  for (const item of reviews) {
    if (item.kind !== "action") continue;
    const extraction = item.payload?.todoExtraction as Record<string, unknown> | undefined;
    if (typeof extraction?.dedupeKey === "string") keys.add(extraction.dedupeKey);
    keys.add(normalizedKey(item.title));
    keys.add(normalizedKey(`${item.title}:${item.content || ""}`));
  }
  return keys;
}

function checkpointKey(session: Session): string {
  return `${session.endedAt || session.startedAt || ""}:${session.observationCount || 0}`;
}

function parseCheckpoint(cursor: string | undefined): Record<string, string> {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function makeAction(todo: ExtractedTodo, session: Session, now: string): Action {
  const changed = sessionChangedSinceExtraction(todo, session);
  const tags = ["todo-extracted", `time:${todo.timeBucket}`, `type:${todo.typeBucket}`, ...(changed ? ["todo-recheck"] : [])];
  return {
    id: fingerprintId("act", `todo:${todo.dedupeKey}`),
    title: todo.title,
    description: todo.description,
    status: actionStatusFor(todo.typeBucket),
    priority: todo.typeBucket === "follow_up" || todo.typeBucket === "processing" ? 7 : 5,
    createdAt: now,
    updatedAt: now,
    createdBy: "todo-extract",
    project: session.project || session.cwd,
    tags,
    sourceObservationIds: [todo.evidence.sourceObservationId],
    sourceMemoryIds: [],
    metadata: { todoExtraction: withSourceCheckpoint(todo, session) },
  };
}

function makeReview(todo: ExtractedTodo, session: Session, now: string): ReviewQueueItem {
  const tags = ["todo-extracted", `time:${todo.timeBucket}`, `type:${todo.typeBucket}`];
  return {
    id: generateId("review"),
    createdAt: now,
    updatedAt: now,
    status: "pending",
    kind: "action",
    title: todo.title,
    content: todo.description,
    source: "viewer",
    payload: {
      project: session.project || session.cwd,
      sourceSessionId: session.id,
      tags,
      actionCandidate: {
        priority: todo.typeBucket === "follow_up" || todo.typeBucket === "processing" ? 7 : 5,
        reason: todo.typeBucket,
        confidence: todo.confidence,
        sourceObservationIds: [todo.evidence.sourceObservationId],
      },
      todoExtraction: todo,
    },
  };
}

function actionLooksGenerated(action: Action): boolean {
  const tags = Array.isArray(action.tags) ? action.tags : [];
  return action.createdBy === "todo-extract" ||
    tags.includes("todo-extracted") ||
    tags.includes("action-candidate") ||
    !!action.metadata?.todoExtraction;
}

function sessionChangedSinceExtraction(todo: ExtractedTodo, session: Session): boolean {
  const stored = (todo as unknown as { sourceCheckpoint?: string }).sourceCheckpoint;
  return !!stored && stored !== checkpointKey(session);
}

function withSourceCheckpoint(todo: ExtractedTodo, session: Session): ExtractedTodo & { sourceCheckpoint: string } {
  return { ...todo, sourceCheckpoint: checkpointKey(session) };
}

async function markChangedGeneratedActions(
  kv: Pick<StateKV, "list" | "set">,
  sessionsById: Map<string, Session>,
  now: string,
): Promise<number> {
  const actions = await kv.list<Action>(KV.actions).catch(() => []);
  let marked = 0;
  for (const action of actions) {
    const extraction = action.metadata?.todoExtraction as (ExtractedTodo & { sourceCheckpoint?: string }) | undefined;
    const session = extraction?.sourceSessionId ? sessionsById.get(extraction.sourceSessionId) : undefined;
    if (!session || !extraction?.sourceCheckpoint || extraction.sourceCheckpoint === checkpointKey(session)) continue;
    const tags = Array.isArray(action.tags) ? action.tags : [];
    if (tags.includes("todo-recheck")) continue;
    await kv.set(KV.actions, action.id, {
      ...action,
      updatedAt: now,
      tags: [...tags, "todo-recheck"],
      metadata: {
        ...(action.metadata || {}),
        todoExtraction: {
          ...extraction,
          needsRecheck: true,
          latestSourceCheckpoint: checkpointKey(session),
        },
      },
    });
    marked++;
  }
  return marked;
}

function reviewLooksGenerated(item: ReviewQueueItem): boolean {
  const payload = item.payload || {};
  const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : [];
  return item.kind === "action" && (
    tags.includes("todo-extracted") ||
    tags.includes("action-candidate") ||
    !!payload.todoExtraction ||
    !!payload.actionCandidate
  );
}

function actionIsPolluted(action: Action): boolean {
  return actionLooksGenerated(action) &&
    (isPollutedTodoText(action.title) || isPollutedTodoText(action.description));
}

function reviewIsPolluted(item: ReviewQueueItem): boolean {
  return reviewLooksGenerated(item) &&
    (isPollutedTodoText(item.title) || isPollutedTodoText(item.content));
}

export async function cleanPollutedTodoCards(
  kv: Pick<StateKV, "list" | "delete">,
): Promise<{ cleanedActions: number; cleanedReviews: number }> {
  const [actions, reviews] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
  ]);
  const pollutedActions = actions.filter(actionIsPolluted);
  const pollutedReviews = reviews.filter(reviewIsPolluted);
  await Promise.all([
    ...pollutedActions.map((action) => kv.delete(KV.actions, action.id)),
    ...pollutedReviews.map((item) => kv.delete(KV.reviewQueue, item.id)),
  ]);
  return { cleanedActions: pollutedActions.length, cleanedReviews: pollutedReviews.length };
}

async function extractForSession(
  session: Session,
  observations: CompressedObservation[],
  mode: string,
): Promise<{ todos: ExtractedTodo[]; engine: "langextract" | "rules"; fallbackReason?: string }> {
  const blocks = observations.map(blockFor).filter((block) => block.text);
  const bucket = timeBucketFor(session);
  let fallbackReason = "";
  if (mode !== "rules" && blocks.length > 0) {
    try {
      const todos = await runLangExtractSidecar({
        sessionId: session.id,
        project: session.project,
        cwd: session.cwd,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        blocks,
      });
      return { todos: todos.map((todo) => safeTodo(todo, session)), engine: "langextract" };
    } catch (err) {
      fallbackReason = err instanceof Error ? err.message : String(err || "langextract failed");
      // Fall back to rules even in langextract mode; the sidecar is optional.
    }
  }
  const candidates = extractActionCandidatesFromObservations(observations);
  return {
    todos: candidates.map((candidate) => candidateToTodo(candidate, session, bucket)).filter((todo): todo is ExtractedTodo => !!todo),
    engine: "rules",
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}

export async function generateTodosFromSessions(
  kv: Pick<StateKV, "get" | "set" | "list" | "delete">,
  data: TodoExtractOptions = {},
): Promise<{
  success: true;
  engine: "langextract" | "rules" | "mixed";
  scannedSessions: number;
  scannedObservations: number;
  directCreated: number;
  reviewCreated: number;
  hiddenHistory: number;
  discarded: number;
  cleanedActions: number;
  cleanedReviews: number;
  recheckMarked: number;
  sourceScan?: { imported: number; skipped: number; errors: number };
  llmFallback?: boolean;
  fallbackReason?: string;
}> {
  let sourceScan: { imported: number; skipped: number; errors: number } | undefined;
  if (data.scanSources !== false) {
    const scan = await scanCodexSource(kv as StateKV).catch(() => null);
    if (scan) sourceScan = { imported: scan.imported, skipped: scan.skipped, errors: scan.errors };
  }
  const maxSessions = clampPositiveInt(data.maxSessions, 20, 100);
  const maxObservationsPerSession = clampPositiveInt(data.maxObservationsPerSession, 300, 1000);
  const mode = (getEnvVar("AGENTMEMORY_TODO_EXTRACTOR") || "auto").toLowerCase();
  const directThreshold = envNumber("AGENTMEMORY_TODO_DIRECT_CONFIDENCE", 0.82);
  const reviewThreshold = envNumber("AGENTMEMORY_TODO_REVIEW_CONFIDENCE", 0.55);
  const [actions, reviews, allSessions] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
    kv.list<Session>(KV.sessions).catch(() => []),
  ]);
  const cleanup = await cleanPollutedTodoCards(kv);
  const remainingActions = cleanup.cleanedActions > 0 ? await kv.list<Action>(KV.actions).catch(() => []) : actions;
  const remainingReviews = cleanup.cleanedReviews > 0 ? await kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []) : reviews;
  const existing = existingDedupeKeys(remainingActions, remainingReviews);
  const seenTitles = existingActiveTitles(remainingActions, remainingReviews);
  const checkpointId = `todo-extract:${data.project || "all"}`;
  const checkpoint = await kv.get<ScanCheckpoint>(KV.scanCheckpoints, checkpointId).catch(() => null);
  const processed = parseCheckpoint(checkpoint?.cursor);
  const sessions = allSessions
    .filter((session) => !data.project || session.project === data.project || session.cwd === data.project)
    .sort((a, b) => sessionSortTime(b).localeCompare(sessionSortTime(a)))
    .slice(0, maxSessions);
  let scannedObservations = 0;
  let directCreated = 0;
  let reviewCreated = 0;
  let hiddenHistory = 0;
  let discarded = 0;
  const engines = new Set<"langextract" | "rules">();
  const fallbackReasons = new Set<string>();
  const now = new Date().toISOString();
  const recheckMarked = await markChangedGeneratedActions(kv, new Map(allSessions.map((session) => [session.id, session])), now);

  for (const session of sessions) {
    const key = checkpointKey(session);
    if (!data.force && processed[session.id] === key) continue;
    const observations = (await kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []))
      .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""))
      .slice(0, maxObservationsPerSession);
    scannedObservations += observations.length;
    const blockMap = new Map(observations.map((obs) => [obs.id, blockFor(obs)]));
    const { todos, engine, fallbackReason } = await extractForSession(session, observations, mode);
    engines.add(engine);
    if (fallbackReason) fallbackReasons.add(fallbackReason.slice(0, 240));
    for (const rawTodo of todos) {
      const todo = todoForStorage(rawTodo);
      if (!todo || !validateTodoEvidence(todo, blockMap)) {
        discarded++;
        continue;
      }
      const dedupeKey = todo.dedupeKey || normalizedKey(`${todo.title}:${todo.description}`);
      const titleKey = normalizedKey(todo.title);
      if (!dedupeKey || existing.has(dedupeKey) || existing.has(titleKey)) {
        discarded++;
        continue;
      }
      if (isNearDuplicateTitle(titleKey, seenTitles)) {
        discarded++;
        continue;
      }
      if (todo.timeBucket === "history") {
        // History todos are hidden (dismissed), not open work. Mark them in the
        // exact-key set so they aren't re-emitted, but keep them out of the
        // near-dup seed so a later *open* near-dup is still allowed (matches
        // existingActiveTitles' open-only policy).
        existing.add(dedupeKey);
        existing.add(titleKey);
        const review = makeReview({ ...todo, dedupeKey }, session, now);
        review.status = "dismissed";
        review.payload = { ...(review.payload || {}), hiddenHistory: true };
        await kv.set(KV.reviewQueue, review.id, review);
        hiddenHistory++;
        continue;
      }
      if (todo.confidence >= directThreshold) {
        await kv.set(KV.actions, fingerprintId("act", `todo:${dedupeKey}`), makeAction({ ...todo, dedupeKey }, session, now));
        directCreated++;
      } else if (todo.confidence >= reviewThreshold) {
        const review = makeReview({ ...todo, dedupeKey }, session, now);
        await kv.set(KV.reviewQueue, review.id, review);
        reviewCreated++;
      } else {
        // Not persisted — seed nothing, so a discarded low-confidence todo can
        // never suppress a later genuine one (mirrors action-candidates).
        discarded++;
        continue;
      }
      // Reached only for persisted open work: now safe to seed both guards.
      existing.add(dedupeKey);
      existing.add(titleKey);
      seenTitles.push(titleKey);
    }
    processed[session.id] = key;
  }

  await kv.set(KV.scanCheckpoints, checkpointId, {
    sourceId: checkpointId,
    cursor: JSON.stringify(processed),
    lastSuccessAt: now,
  });

  return {
    success: true,
    engine: engines.size > 1 ? "mixed" : Array.from(engines)[0] || "rules",
    scannedSessions: sessions.length,
    scannedObservations,
    directCreated,
    reviewCreated,
    hiddenHistory,
    discarded,
    cleanedActions: cleanup.cleanedActions,
    cleanedReviews: cleanup.cleanedReviews,
    recheckMarked,
    ...(sourceScan ? { sourceScan } : {}),
    ...(fallbackReasons.size ? { llmFallback: true } : {}),
    ...(fallbackReasons.size ? { fallbackReason: Array.from(fallbackReasons)[0] } : {}),
  };
}

export function registerTodoExtractFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::todo-extract-generate", async (data: TodoExtractOptions = {}) =>
    generateTodosFromSessions(kv, data),
  );
}
