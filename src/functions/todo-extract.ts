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
  DEFAULT_TODO_EXTRACT_SINCE_DAYS,
  DEFAULT_TODO_EXTRACT_MAX_INTERACTIONS,
  DEFAULT_TODO_EXTRACT_MAX_SESSIONS,
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
  // STEP-11: scope controls. sinceDays = only sessions within the last N days
  // are eligible (primary control). maxInteractionsPerSession = per session,
  // keep at most M most-recent interaction records (turns). Both fall back to
  // env (AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS / _MAX_INTERACTIONS_PER_SESSION)
  // then the config defaults when omitted.
  sinceDays?: number;
  maxInteractionsPerSession?: number;
  project?: string;
  force?: boolean;
  scanSources?: boolean;
  cleanup?: "none" | "dry-run" | "apply";
};

const TIME_BUCKETS = new Set(["current", "recent", "history"]);
const TYPE_BUCKETS = new Set(["pending", "to_start", "follow_up", "in_progress", "done", "processing"]);
const SIDE_CAR = "todo-extract-langextract.py";
const CLEANUP_SIDE_CAR = "todo-update-llm.py";
const MAX_LLM_OBSERVATIONS_PER_SESSION = 40;
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

// An action being requested — used to exempt status/completed-narration text
// from the pollution filter, so a real repair that mentions a status phrase
// ("修复服务可用性回归", "排查…失败") is not silently dropped.
const TODO_ACTION_TRIGGER = /(?:修复|补充|实现|调整|验证|排查|定位|跟进|整理|生成|上传|创建|更新|移除|删除|处理|审查|合并|推送|提交|构建|设计|重试|重新(?:运行|跑)|需要|必须|未完成|阻塞|TODO|FIXME|\b(?:fix|add|update|create|remove|validate|retry|rerun|re-run|follow up|follow-up|need to|must|blocked|blocking|investigate|debug|resolve|handle|implement)\b)/i;
const AGENT_PROGRESS_PREFIX = /^(?:我会|我将|我要|现在我会|接下来|先|继续|等待|查看|读取|检查|确认|核对|梳理|记录|准备|进行|定位当前|开始)\b/u;
const PROGRESS_NOUNS = /(?:仓库现状|远程元数据|关键入口|GitHub 状态|依赖安装|安装完成|空闲端口|健康检查|本地可运行性验证|静态梳理|运行验证|截图|console|服务可用|页面已经能返回|工作区状态|同名目录|PR\/issue|PR、issue|CI 配置)/i;
const DONE_NARRATION = /(?:已(?:经)?|成功|顺利|全绿|pass(?:ed)?|merged|pushed|resolved|done|completed|works now|no action needed|完成|通过|可用|生效|能返回|能显示|已合并|已推送|已更新|已修复|无需处理)/i;
const FAILURE_SIGNAL = /(?:失败|未通过|\b(?:failed|failing|command failed|exit code [1-9]\d*|exited with code [1-9]\d*)\b)/i;
const FAILURE_REPAIR_TRIGGER = /(?:修复|排查|定位|重试|重新(?:运行|跑)|处理|解决|\b(?:fix|retry|rerun|re-run|investigate|debug|resolve|handle)\b)/i;

function hasTodoActionTrigger(value: string | undefined): boolean {
  const text = normalizeText(value);
  if (!text) return false;
  if (TODO_ACTION_TRIGGER.test(text)) return true;
  return FAILURE_SIGNAL.test(text) && FAILURE_REPAIR_TRIGGER.test(text);
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
  if (/\b(?:Viewer|Health)\b\s*[：:]\s*(?:\[|https?:\/\/)/i.test(text)) return true;
  if (AGENT_PROGRESS_PREFIX.test(text) && PROGRESS_NOUNS.test(text) && !hasTodoActionTrigger(text)) return true;
  // Status-report and completed-work narration are pollution ONLY when no action
  // is being requested. The action-verb exception keeps genuine repairs like
  // "修复服务可用性回归" / "验证页面已经能返回后的边界问题" / "排查…失败" out of the filter.
  if (!hasTodoActionTrigger(text)) {
    if (/服务可用/.test(text)) return true;
  }
  return false;
}

function isCompletedTodoText(value: string | undefined): boolean {
  const text = normalizeText(value);
  if (!text || hasTodoActionTrigger(text)) return false;
  return DONE_NARRATION.test(text) && (
    /(?:验收|接口|页面|测试|CI|PR|提交|构建|服务|标签|标题|console|HTML|main|仓库|截图|tests?|build|service|deploy)/i.test(text) ||
    /(?:已完成|已通过|已合并|已推送|全绿|能返回|能显示|no action needed|works now)/i.test(text)
  );
}

function isPureStatusReport(value: string | undefined): boolean {
  const text = normalizeText(value);
  return !hasTodoActionTrigger(text) && (
    /服务可用/.test(text) ||
    /\b(?:Viewer|Health)\b\s*[：:]\s*(?:\[|https?:\/\/)/i.test(text) ||
    /\b(?:no action needed|works now)\b/i.test(text)
  );
}

function isUsefulTodoText(value: string | undefined): boolean {
  const text = normalizeText(value);
  if (!text || isPollutedTodoText(text) || isCompletedTodoText(text)) return false;
  if (AGENT_PROGRESS_PREFIX.test(text) && !hasTodoActionTrigger(text)) return false;
  return hasTodoActionTrigger(text) || /\b(?:TODO|FIXME|follow up|follow-up)\b/i.test(text);
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
  if (
    isCompletedTodoText(title) || isCompletedTodoText(description) || isCompletedTodoText(todo.evidence?.quote) ||
    isPollutedTodoText(title) || isPollutedTodoText(description) || isPollutedTodoText(todo.evidence?.quote)
  )
    return null;
  const rawDedupe = normalizeText(todo.dedupeKey);
  const dedupeKey = rawDedupe && !looksLikeBadTitle(rawDedupe)
    ? normalizedKey(rawDedupe)
    : normalizedKey(`${title}:${description}`);
  return { ...todo, title, description, dedupeKey };
}

function sessionSortTime(session: Session): string {
  return session.endedAt || session.startedAt || "";
}

// STEP-11 interaction windowing.
// A compressed observation starts a new "interaction record" (turn) when it is
// a user message. The default zero-LLM synthetic compression (replay.ts →
// buildSyntheticCompression) types a user prompt as "conversation" and titles it
// with its raw hookType "prompt_submit" — the only role signal that survives
// compression. If LLM auto-compress is on (non-default), titles are richer and
// no boundary is found, in which case takeRecentInteractions degrades to
// "whole session = one interaction" (keep everything).
function observationStartsInteraction(obs: CompressedObservation): boolean {
  return obs.type === "conversation" && /^prompt_submit$/i.test((obs.title || "").trim());
}

// Keep only the most recent `maxInteractions` interaction records of a
// timestamp-ascending observation list. One interaction = a user message
// through everything before the next user message (its tool calls + agent
// replies). Returns a contiguous chronological tail.
function takeRecentInteractions(
  observations: CompressedObservation[],
  maxInteractions: number,
): CompressedObservation[] {
  if (maxInteractions <= 0 || observations.length <= 1) return observations;
  const boundaries: number[] = [];
  for (let i = 0; i < observations.length; i++) {
    if (observationStartsInteraction(observations[i])) boundaries.push(i);
  }
  if (boundaries.length <= maxInteractions) return observations;
  const cutoff = boundaries[boundaries.length - maxInteractions];
  return observations.slice(cutoff);
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

function observationUsefulForTodo(obs: CompressedObservation): boolean {
  const text = textForObservation(obs);
  if (!text || isPollutedTodoText(text) || isCompletedTodoText(text)) return false;
  return isUsefulTodoText(text);
}

function todoObservationScore(obs: CompressedObservation): number {
  const text = textForObservation(obs);
  if (!observationUsefulForTodo(obs)) return 0;
  let score = 1;
  if (/(?:下一步|后续|待办|\b(?:need to|must|follow up|follow-up|TODO|FIXME)\b)/i.test(text)) score += 2;
  if (FAILURE_SIGNAL.test(text) && hasTodoActionTrigger(text)) score += 2;
  if (/(?:阻塞|卡住|\b(?:blocked|blocking)\b)/i.test(text)) score += 2;
  return score;
}

function prefilterTodoObservations(session: Session, observations: CompressedObservation[]): {
  ruleObservations: CompressedObservation[];
  llmObservations: CompressedObservation[];
} {
  const scored = observations
    .map((obs, index) => ({ obs, index, score: todoObservationScore(obs) }))
    .filter((entry) => entry.score > 0);
  const ruleObservations = scored.map((entry) => entry.obs);
  if (timeBucketFor(session) === "history") return { ruleObservations, llmObservations: [] };
  const llmObservations = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_LLM_OBSERVATIONS_PER_SESSION)
    .map((entry) => entry.obs);
  return { ruleObservations, llmObservations };
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

function sidecarPath(name: string = SIDE_CAR): string | null {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(base, name),
    join(base, "functions", name),
    join(base, "..", "src", "functions", name),
    join(base, "..", "functions", name),
    resolve(process.cwd(), "src", "functions", name),
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
  // The quote must be grounded IN the source observation — i.e. a substring of
  // it. The reverse (quote ⊇ blockText) was too permissive: a model returning
  // "[whole observation] + hallucinated extra" contains the block text and so
  // would pass, defeating source grounding. Require quote ⊆ block only.
  return !!blockText && !!quote && blockText.includes(quote);
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
      // STEP-12: store the session fingerprint like makeAction does, so a review
      // card can also be picked up by updateChangedTodoCards when its source
      // session later changes (otherwise the review-update path is dead).
      todoExtraction: withSourceCheckpoint(todo, session),
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

type CleanupDecision = "garbage" | "done" | "keep";

function cleanupDecision(title: string, description: string): CleanupDecision {
  if (isPureStatusReport(title) || isPureStatusReport(description)) return "garbage";
  if (isCompletedTodoText(title) || isCompletedTodoText(description)) return "done";
  if (isPollutedTodoText(title) || isPollutedTodoText(description)) return "garbage";
  if (!isUsefulTodoText(`${title} ${description}`)) return "garbage";
  return "keep";
}

function actionCleanupDecision(action: Action): CleanupDecision {
  if (!actionLooksGenerated(action)) return "keep";
  if (action.status === "done" || action.status === "cancelled") return "keep";
  return cleanupDecision(action.title, action.description);
}

function reviewCleanupDecision(item: ReviewQueueItem): CleanupDecision {
  if (!reviewLooksGenerated(item) || item.status !== "pending") return "keep";
  return cleanupDecision(item.title, item.content);
}

type CleanupMode = "dry-run" | "apply";
type CleanupPreviewItem = { id: string; title: string; decision: "garbage" | "done" };

export async function cleanPollutedTodoCards(
  kv: Pick<StateKV, "list" | "set">,
  mode: CleanupMode = "apply",
): Promise<{
  cleanedActions: number;
  cleanedReviews: number;
  completedActions: number;
  completedReviews: number;
  preview: { actions: CleanupPreviewItem[]; reviews: CleanupPreviewItem[] };
}> {
  const [actions, reviews] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
  ]);
  const now = new Date().toISOString();
  const actionDecisions = actions
    .map((action) => ({ action, decision: actionCleanupDecision(action) }))
    .filter((entry) => entry.decision !== "keep");
  const reviewDecisions = reviews
    .map((item) => ({ item, decision: reviewCleanupDecision(item) }))
    .filter((entry) => entry.decision !== "keep");
  if (mode === "apply") {
    await Promise.all([
      ...actionDecisions.map(({ action, decision }) => kv.set(KV.actions, action.id, {
        ...action,
        status: decision === "done" ? "done" : "cancelled",
        updatedAt: now,
        metadata: {
          ...(action.metadata || {}),
          cleanup: {
            decision,
            cleanedAt: now,
            previousStatus: action.status,
            title: action.title,
            description: action.description,
          },
        },
      })),
      ...reviewDecisions.map(({ item, decision }) => kv.set(KV.reviewQueue, item.id, {
        ...item,
        status: "dismissed",
        updatedAt: now,
        payload: {
          ...(item.payload || {}),
          cleanup: {
            decision,
            cleanedAt: now,
            previousStatus: item.status,
            title: item.title,
            content: item.content,
          },
        },
      })),
    ]);
  }
  return {
    cleanedActions: actionDecisions.filter((entry) => entry.decision === "garbage").length,
    cleanedReviews: reviewDecisions.filter((entry) => entry.decision === "garbage").length,
    completedActions: actionDecisions.filter((entry) => entry.decision === "done").length,
    completedReviews: reviewDecisions.filter((entry) => entry.decision === "done").length,
    preview: {
      actions: actionDecisions.map(({ action, decision }) => ({ id: action.id, title: action.title, decision })),
      reviews: reviewDecisions.map(({ item, decision }) => ({ id: item.id, title: item.title, decision })),
    },
  };
}

// ── LLM card update (STEP-12, evolved from the STEP-10 cleanup) ─────────────
// Re-judges EXISTING cards whose source session changed (vs. extracting new
// ones): an LLM decides KEEP/DROP/DONE/REWRITE/MERGE against the card plus its
// session's recent activity. Reuses the soft-delete + audit shape below. Update
// is LLM-only — on failure it leaves cards untouched (no rule fallback). The
// shared helpers/types keep the "Cleanup" name for continuity with the
// persisted metadata.cleanup audit bag.

type LlmCleanupDecision = "KEEP" | "DROP" | "DONE" | "REWRITE" | "MERGE";
type LlmCleanupItem = {
  id: string;
  decision: LlmCleanupDecision;
  reason?: string;
  newTitle?: string;
  newDescription?: string;
  mergeIntoId?: string;
};
type CleanupCard = { id: string; title: string; description: string; status: string; evidence?: string; sessionDelta?: string };

const DEFAULT_CLEANUP_MAX_CARDS = 60;

async function runCleanupSidecar(
  cards: CleanupCard[],
  opts: { timeoutMs?: number } = {},
): Promise<LlmCleanupItem[]> {
  const script = sidecarPath(CLEANUP_SIDE_CAR);
  if (!script) throw new Error("cleanup sidecar not found");
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
      reject(new Error("cleanup sidecar timed out"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim() || `cleanup sidecar exited ${code}`)); return; }
      try {
        const parsed = JSON.parse(stdout) as { decisions?: unknown };
        resolvePromise(Array.isArray(parsed.decisions) ? (parsed.decisions as LlmCleanupItem[]) : []);
      } catch (err) { reject(err); }
    });
    child.stdin.end(JSON.stringify({ cards }));
  });
}

function cardEvidence(meta: Record<string, unknown> | undefined): string {
  const extraction = meta?.todoExtraction as ExtractedTodo | undefined;
  return extraction?.evidence?.quote || "";
}

function applyActionCleanup(action: Action, d: LlmCleanupItem, now: string): Action {
  const cleanup: Record<string, unknown> = {
    decision: d.decision.toLowerCase(),
    llm: true,
    reason: d.reason || "",
    cleanedAt: now,
    previousStatus: action.status,
    title: action.title,
    description: action.description,
    ...(d.mergeIntoId ? { mergeIntoId: d.mergeIntoId } : {}),
  };
  if (d.decision === "REWRITE") {
    cleanup.previousTitle = action.title;
    cleanup.previousDescription = action.description;
    return {
      ...action,
      title: d.newTitle || action.title,
      description: d.newDescription ?? action.description,
      updatedAt: now,
      metadata: { ...(action.metadata || {}), cleanup },
    };
  }
  const status: Action["status"] = d.decision === "DONE" ? "done" : "cancelled";
  return { ...action, status, updatedAt: now, metadata: { ...(action.metadata || {}), cleanup } };
}

function applyReviewCleanup(item: ReviewQueueItem, d: LlmCleanupItem, now: string): ReviewQueueItem {
  const cleanup: Record<string, unknown> = {
    decision: d.decision.toLowerCase(),
    llm: true,
    reason: d.reason || "",
    cleanedAt: now,
    previousStatus: item.status,
    title: item.title,
    content: item.content,
    ...(d.mergeIntoId ? { mergeIntoId: d.mergeIntoId } : {}),
  };
  if (d.decision === "REWRITE") {
    cleanup.previousTitle = item.title;
    cleanup.previousContent = item.content;
    return {
      ...item,
      title: d.newTitle || item.title,
      content: d.newDescription ?? item.content,
      updatedAt: now,
      payload: { ...(item.payload || {}), cleanup },
    };
  }
  return { ...item, status: "dismissed", updatedAt: now, payload: { ...(item.payload || {}), cleanup } };
}

// STEP-12: after an update pass, advance the card's stored source checkpoint to
// the session's current fingerprint and clear the recheck markers, so a card is
// not re-selected until its session changes again.
function advanceActionCheckpoint(action: Action, checkpoint: string, now: string): Action {
  const extraction = (action.metadata?.todoExtraction || {}) as Record<string, unknown>;
  const tags = Array.isArray(action.tags) ? action.tags.filter((tag) => tag !== "todo-recheck") : action.tags;
  return {
    ...action,
    updatedAt: now,
    tags,
    metadata: {
      ...(action.metadata || {}),
      todoExtraction: { ...extraction, sourceCheckpoint: checkpoint, needsRecheck: false },
    },
  };
}

function advanceReviewCheckpoint(item: ReviewQueueItem, checkpoint: string, now: string): ReviewQueueItem {
  const extraction = (item.payload?.todoExtraction || {}) as Record<string, unknown>;
  return {
    ...item,
    updatedAt: now,
    payload: {
      ...(item.payload || {}),
      todoExtraction: { ...extraction, sourceCheckpoint: checkpoint, needsRecheck: false },
    },
  };
}

// The session's most-recent activity (last ~2 interaction records), as text, so
// the updater LLM can re-judge a card against what happened after it was first
// recorded. Capped so the prompt stays bounded.
async function buildSessionDelta(kv: Pick<StateKV, "list">, sessionId: string): Promise<string> {
  const observations = (await kv.list<CompressedObservation>(KV.observations(sessionId)).catch(() => []))
    .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  // Rule-filter before sending to the LLM — never ship raw session/tool dumps.
  // Keep the human-readable narrative of recent interactions and drop tool
  // traces / commands / paths / JSON (isPollutedTodoText), mirroring what the
  // extract path does with prefilterTodoObservations.
  const recent = takeRecentInteractions(observations, 2);
  const text = recent
    .map((obs) => textForObservation(obs))
    .filter((line) => line && !isPollutedTodoText(line))
    .join("\n")
    .trim();
  return text.length > 2000 ? text.slice(text.length - 2000) : text;
}

export type LlmCleanupResult = {
  engine: "llm" | "rules";
  scanned: number;
  kept: number;
  dropped: number;
  completed: number;
  rewritten: number;
  merged: number;
  preview: Array<{ id: string; title: string; decision: LlmCleanupDecision; reason?: string; newTitle?: string; mergeIntoId?: string }>;
  // The exact decisions used, so a dry-run preview can be applied verbatim
  // (the caller passes them back as opts.decisions) without re-calling the LLM.
  decisions?: LlmCleanupItem[];
  fallbackReason?: string;
};

export async function updateChangedTodoCards(
  kv: Pick<StateKV, "list" | "set">,
  opts: { mode?: CleanupMode; maxCards?: number; decide?: (cards: CleanupCard[]) => Promise<LlmCleanupItem[]>; decisions?: LlmCleanupItem[] } = {},
): Promise<LlmCleanupResult> {
  const mode = opts.mode ?? "apply";
  const maxCards = opts.maxCards ?? DEFAULT_CLEANUP_MAX_CARDS;
  const decide = opts.decide ?? runCleanupSidecar;
  const [actions, reviews, sessions] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
    kv.list<Session>(KV.sessions).catch(() => []),
  ]);
  const sessionsById = new Map(sessions.map((s) => [s.id, s] as [string, Session]));
  // Only open, generated cards whose source-session fingerprint moved on since
  // the card was recorded (sessionChangedSinceExtraction) — the "the session
  // updated, so update its cards" scope.
  const changedActions = actions.filter((a) => {
    if (!actionLooksGenerated(a) || a.status === "done" || a.status === "cancelled") return false;
    const ex = a.metadata?.todoExtraction as (ExtractedTodo & { sourceCheckpoint?: string }) | undefined;
    const session = ex?.sourceSessionId ? sessionsById.get(ex.sourceSessionId) : undefined;
    return !!ex && !!session && sessionChangedSinceExtraction(ex, session);
  });
  const changedReviews = reviews.filter((r) => {
    if (!reviewLooksGenerated(r) || r.status !== "pending") return false;
    const ex = r.payload?.todoExtraction as (ExtractedTodo & { sourceCheckpoint?: string }) | undefined;
    const session = ex?.sourceSessionId ? sessionsById.get(ex.sourceSessionId) : undefined;
    return !!ex && !!session && sessionChangedSinceExtraction(ex, session);
  });
  const actionById = new Map(changedActions.map((a) => [`a:${a.id}`, a] as [string, Action]));
  const reviewById = new Map(changedReviews.map((r) => [`r:${r.id}`, r] as [string, ReviewQueueItem]));

  // Build the LLM card batch (capped), attaching each card's session delta — the
  // session's most-recent activity — so the model can re-judge it against what
  // happened after it was first recorded. Delta is built once per session.
  const deltaCache = new Map<string, string>();
  const sessionDeltaFor = async (sessionId: string | undefined): Promise<string> => {
    if (!sessionId) return "";
    if (!deltaCache.has(sessionId)) deltaCache.set(sessionId, await buildSessionDelta(kv, sessionId));
    return deltaCache.get(sessionId) || "";
  };
  const entries = [
    ...changedActions.map((a) => ({ id: `a:${a.id}`, sessionId: (a.metadata?.todoExtraction as ExtractedTodo | undefined)?.sourceSessionId, title: a.title, description: a.description, status: a.status, evidence: cardEvidence(a.metadata) })),
    ...changedReviews.map((r) => ({ id: `r:${r.id}`, sessionId: (r.payload?.todoExtraction as ExtractedTodo | undefined)?.sourceSessionId, title: r.title, description: r.content, status: r.status, evidence: cardEvidence(r.payload) })),
  ].slice(0, maxCards);
  // When applying a previously-previewed result, the caller passes the dry-run
  // decisions back so we apply them verbatim — no LLM re-call, no session delta.
  const reuseDecisions = opts.decisions;
  const cards: CleanupCard[] = [];
  for (const entry of entries) {
    cards.push({ id: entry.id, title: entry.title, description: entry.description, status: entry.status, evidence: entry.evidence, sessionDelta: reuseDecisions ? "" : await sessionDeltaFor(entry.sessionId) });
  }

  if (cards.length === 0) {
    return { engine: "llm", scanned: 0, kept: 0, dropped: 0, completed: 0, rewritten: 0, merged: 0, preview: [], decisions: [] };
  }

  let decisions: LlmCleanupItem[];
  if (reuseDecisions) {
    // Apply the exact decisions from the dry-run preview — never re-call the LLM
    // on apply. Reasoning models vary even at temperature 0, so a re-call could
    // diverge from what the user just confirmed (e.g. preview MERGE, apply DONE).
    decisions = reuseDecisions;
  } else {
    try {
      decisions = await decide(cards);
    } catch (err) {
      // Update is an LLM-only operation (it re-judges cards against new session
      // content); there is no rule equivalent, so on failure leave every card
      // untouched and report why via fallbackReason. Callers detect "LLM
      // unavailable" by fallbackReason, not by a misnomer engine value.
      return {
        engine: "llm",
        scanned: cards.length,
        kept: cards.length,
        dropped: 0,
        completed: 0,
        rewritten: 0,
        merged: 0,
        preview: [],
        decisions: [],
        fallbackReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const now = new Date().toISOString();
  const decisionById = new Map(decisions.filter((d) => d && d.id).map((d) => [d.id, d] as [string, LlmCleanupItem]));
  const batchIds = new Set(cards.map((c) => c.id));
  const writes: Array<Promise<unknown>> = [];
  let kept = 0, dropped = 0, completed = 0, rewritten = 0, merged = 0;
  const preview: LlmCleanupResult["preview"] = [];

  // Process every changed card in the batch. A KEEP (or a card the LLM returned
  // no decision for) keeps its text but still has its checkpoint advanced — it
  // has now been re-judged against the latest session, so it should not reappear
  // until the session changes again.
  for (const card of cards) {
    const action = actionById.get(card.id);
    const review = reviewById.get(card.id);
    const target = action ?? review;
    if (!target) continue;
    const ex = (action ? action.metadata?.todoExtraction : review!.payload?.todoExtraction) as ExtractedTodo | undefined;
    const session = ex?.sourceSessionId ? sessionsById.get(ex.sourceSessionId) : undefined;
    const checkpoint = session ? checkpointKey(session) : undefined;
    const d = decisionById.get(card.id);
    let decision = d?.decision ?? "KEEP";
    // TS-side invariant: a MERGE whose target card isn't in this batch (or points
    // at itself) would cancel the source with nothing to merge into. Downgrade it
    // to KEEP so the source is preserved. (The sidecar normalizes this too, but an
    // injected decide must not be able to bypass it.)
    if (decision === "MERGE" && (!d?.mergeIntoId || d.mergeIntoId === card.id || !batchIds.has(d.mergeIntoId))) {
      decision = "KEEP";
    }
    if (decision === "KEEP") kept++;
    else if (decision === "DROP") dropped++;
    else if (decision === "DONE") completed++;
    else if (decision === "REWRITE") rewritten++;
    else if (decision === "MERGE") merged++;
    if (decision !== "KEEP") {
      preview.push({ id: card.id, title: target.title, decision, reason: d?.reason, newTitle: d?.newTitle, mergeIntoId: d?.mergeIntoId });
    }
    if (mode !== "apply") continue;
    if (action) {
      let next = decision === "KEEP" ? action : applyActionCleanup(action, d!, now);
      if (checkpoint) next = advanceActionCheckpoint(next, checkpoint, now);
      writes.push(kv.set(KV.actions, action.id, next));
    } else if (review) {
      let next = decision === "KEEP" ? review : applyReviewCleanup(review, d!, now);
      if (checkpoint) next = advanceReviewCheckpoint(next, checkpoint, now);
      writes.push(kv.set(KV.reviewQueue, review.id, next));
    }
  }
  await Promise.all(writes);
  return {
    engine: "llm",
    scanned: cards.length,
    kept,
    dropped,
    completed,
    rewritten,
    merged,
    preview,
    decisions,
  };
}

async function extractForSession(
  session: Session,
  observations: CompressedObservation[],
  mode: string,
): Promise<{ todos: ExtractedTodo[]; engine: "langextract" | "rules"; fallbackReason?: string }> {
  const { ruleObservations, llmObservations } = prefilterTodoObservations(session, observations);
  const blocks = llmObservations.map(blockFor).filter((block) => block.text);
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
  const candidates = extractActionCandidatesFromObservations(ruleObservations);
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
  completedActions: number;
  completedReviews: number;
  cleanupPreview?: { actions: CleanupPreviewItem[]; reviews: CleanupPreviewItem[] };
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
  const maxSessions = clampPositiveInt(data.maxSessions, DEFAULT_TODO_EXTRACT_MAX_SESSIONS, 100);
  const maxObservationsPerSession = clampPositiveInt(data.maxObservationsPerSession, 300, 1000);
  // STEP-11: body wins, else env, else config default. sinceDays caps at ~10y
  // (effectively unbounded); maxInteractions at 500 (well above any real cap).
  const sinceDays = clampPositiveInt(
    data.sinceDays ?? getEnvVar("AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS"),
    DEFAULT_TODO_EXTRACT_SINCE_DAYS,
    3650,
  );
  const maxInteractionsPerSession = clampPositiveInt(
    data.maxInteractionsPerSession ?? getEnvVar("AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION"),
    DEFAULT_TODO_EXTRACT_MAX_INTERACTIONS,
    500,
  );
  const sinceCutoffMs = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
  const mode = (getEnvVar("AGENTMEMORY_TODO_EXTRACTOR") || "auto").toLowerCase();
  const directThreshold = envNumber("AGENTMEMORY_TODO_DIRECT_CONFIDENCE", 0.82);
  const reviewThreshold = envNumber("AGENTMEMORY_TODO_REVIEW_CONFIDENCE", 0.55);
  const cleanupMode = data.cleanup === "apply" ? "apply" : data.cleanup === "dry-run" ? "dry-run" : null;
  const [actions, reviews, allSessions] = await Promise.all([
    kv.list<Action>(KV.actions).catch(() => []),
    kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => []),
    kv.list<Session>(KV.sessions).catch(() => []),
  ]);
  const cleanup = data.cleanup === "none"
    ? { cleanedActions: 0, cleanedReviews: 0, completedActions: 0, completedReviews: 0, preview: { actions: [], reviews: [] } }
    : cleanupMode
      ? await cleanPollutedTodoCards(kv, cleanupMode)
      : { cleanedActions: 0, cleanedReviews: 0, completedActions: 0, completedReviews: 0, preview: { actions: [], reviews: [] } };
  const remainingActions = cleanup.cleanedActions > 0 || cleanup.completedActions > 0
    ? await kv.list<Action>(KV.actions).catch(() => [])
    : actions;
  const remainingReviews = cleanup.cleanedReviews > 0 || cleanup.completedReviews > 0
    ? await kv.list<ReviewQueueItem>(KV.reviewQueue).catch(() => [])
    : reviews;
  const existing = existingDedupeKeys(remainingActions, remainingReviews);
  const seenTitles = existingActiveTitles(remainingActions, remainingReviews);
  const checkpointId = `todo-extract:${data.project || "all"}`;
  const checkpoint = await kv.get<ScanCheckpoint>(KV.scanCheckpoints, checkpointId).catch(() => null);
  const processed = parseCheckpoint(checkpoint?.cursor);
  const sessions = allSessions
    .filter((session) => !data.project || session.project === data.project || session.cwd === data.project)
    // STEP-11: day-window is the primary scope control. Sessions with no/invalid
    // timestamp are kept (never silently drop work); maxSessions is the cap that
    // still bounds a day with a flood of sessions.
    .filter((session) => {
      const raw = sessionSortTime(session);
      if (!raw) return true;
      const at = new Date(raw).getTime();
      return !Number.isFinite(at) || at >= sinceCutoffMs;
    })
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
    const sortedObservations = (await kv.list<CompressedObservation>(KV.observations(session.id)).catch(() => []))
      .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    // STEP-11: keep only the most recent N interaction records, then apply the
    // per-session observation safety cap to the most recent tail.
    const observations = takeRecentInteractions(sortedObservations, maxInteractionsPerSession)
      .slice(-maxObservationsPerSession);
    const { ruleObservations, llmObservations } = prefilterTodoObservations(session, observations);
    scannedObservations += ruleObservations.length;
    const evidenceObservations = mode === "rules" ? ruleObservations : llmObservations.length ? llmObservations : ruleObservations;
    const blockMap = new Map(evidenceObservations.map((obs) => [obs.id, blockFor(obs)]));
    const { todos, engine, fallbackReason } = await extractForSession(session, ruleObservations, mode);
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
    completedActions: cleanup.completedActions,
    completedReviews: cleanup.completedReviews,
    recheckMarked,
    ...(data.cleanup === "dry-run" ? { cleanupPreview: cleanup.preview } : {}),
    ...(sourceScan ? { sourceScan } : {}),
    ...(fallbackReasons.size ? { llmFallback: true } : {}),
    ...(fallbackReasons.size ? { fallbackReason: Array.from(fallbackReasons)[0] } : {}),
  };
}

export function registerTodoExtractFunctions(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::todo-extract-generate", async (data: TodoExtractOptions = {}) =>
    generateTodosFromSessions(kv, data),
  );
  sdk.registerFunction("mem::todo-update", async (data: { mode?: CleanupMode; maxCards?: number; decisions?: LlmCleanupItem[] } = {}) =>
    updateChangedTodoCards(kv, data),
  );
}
