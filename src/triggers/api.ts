import { TriggerAction, type ISdk, type ApiRequest } from "iii-sdk";
import type { Session, CompressedObservation, HookPayload, CommitLink, ReviewQueueItem, InboxItem, DeliveryRecord } from "../types.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { KV, fingerprintId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { getLatestHealth } from "../health/monitor.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import type { ResilientProvider } from "../providers/resilient.js";
import { VERSION } from "../version.js";
import { timingSafeCompare } from "../auth.js";
import { isSlotsEnabled, isReflectEnabled } from "../functions/slots.js";
import { renderViewerDocument } from "../viewer/document.js";
import { getBoundViewerPort, getViewerSkipped } from "../viewer/server.js";
import { MAX_FILES_UPPER_BOUND } from "../functions/replay.js";
import { logger } from "../logger.js";
import {
  isGraphExtractionEnabled,
  isConsolidationEnabled,
  isAutoCompressEnabled,
  isContextInjectionEnabled,
  detectEmbeddingProvider,
  detectLlmProviderKind,
  getTodoExtractorUserConfig,
  getUserEnvPath,
  writeUserEnv,
  WRITABLE_TODO_EXTRACT_KEYS,
  getAgentId,
  isAgentScopeIsolated,
} from "../config.js";

type Response = {
  status_code: number;
  headers?: Record<string, string>;
  body: unknown;
};

function parseOptionalInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

function cleanConfigValue(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (!value || /[\r\n]/.test(value)) return null;
  return value;
}

function checkAuth(
  req: ApiRequest,
  secret: string | undefined,
): Response | null {
  if (!secret) return null;
  const auth = req.headers?.["authorization"] || req.headers?.["Authorization"];
  if (
    typeof auth !== "string" ||
    !timingSafeCompare(auth, `Bearer ${secret}`)
  ) {
    return { status_code: 401, body: { error: "unauthorized" } };
  }
  return null;
}

function requireConfiguredSecret(
  secret: string | undefined,
  feature: string,
): Response | null {
  if (secret) return null;
  return {
    status_code: 503,
    body: { error: `${feature} requires AGENTMEMORY_SECRET` },
  };
}

function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function browserSessionId(reviewId: string, page: Record<string, unknown>, createdAt: string): string {
  const url = asNonEmptyString(page.url) || asNonEmptyString(page.title) || reviewId;
  return `browser_${shortHash(`${url}:${createdAt}:${reviewId}`)}`;
}

function browserSyncKey(page: Record<string, unknown>, conversation: { provider?: string; turns?: Array<{ role?: string; text?: string }> }): string {
  const url = asNonEmptyString(page.url) || asNonEmptyString(page.title) || "browser";
  const provider = conversation.provider || asNonEmptyString(page.host) || "browser";
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const lastText = turns.slice(-3).map((turn) => `${turn.role || "unknown"}:${turn.text || ""}`).join("\n");
  return shortHash(`${url}:${provider}:${turns.length}:${lastText}`);
}

function cleanBrowserCandidateText(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^(用户|User|我)[:：]\s*/i, "")
    .replace(/^(AI|Assistant|ChatGPT|Claude|Gemini|Perplexity)[:：]\s*/i, "")
    .trim();
}

function isBrowserUiNoise(value: string): boolean {
  const text = cleanBrowserCandidateText(value);
  if (!text) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/^(下载|打开|安装|查看|测试|反馈|分诊|外测|验收|刷新|关闭|复制|保存|确认|取消|加入待确认|高级选项|自动整理|最近加入|最近同步)$/.test(text)) return true;
  if (/^(总览|记忆|会话|活动|Skill|待办|状态|最近会话|浏览器记忆入口?|本地工作台|当前页面|页面识别|候选记忆|其他建议)$/.test(text)) return true;
  if (/浏览器记忆入口/.test(text) || /从网页和\s*AI\s*对话提取具体事实/.test(text)) return true;
  if (/(按钮|点击|入口|侧栏|弹窗|工作台|插件|页面|选择器|测试卡|诊断|刷新|加载)/.test(text) && !/(用户|我|我的|我们|偏好|喜欢|不喜欢|希望|需要|计划|决定|负责|待办|TODO|必须|不要)/i.test(text)) return true;
  return false;
}

function browserFactScore(value: string): number {
  const text = cleanBrowserCandidateText(value);
  if (text.length < 8 || isBrowserUiNoise(text)) return 0;
  let score = 0;
  if (/(我|我的|我们|用户|SZn|szn|刘欣|Liu Xin|Coco|你是|你叫)/i.test(text)) score += 0.26;
  if (/(希望|想要|需要|正在|计划|负责|决定|偏好|喜欢|不喜欢|不要|应该|必须|待办|TODO)/i.test(text)) score += 0.35;
  if (/(项目|产品|设计|飞书|GitHub|雅思|IELTS|UCL|英国|插件|记忆)/i.test(text)) score += 0.16;
  if (text.length >= 18 && text.length <= 220) score += 0.16;
  if (/[。！？!?]$/.test(text)) score += 0.04;
  return Math.min(0.95, score);
}

function splitBrowserFactSentences(value: unknown): string[] {
  return String(value || "")
    .split(/[。！？!?\n]+/)
    .map(cleanBrowserCandidateText)
    .filter(Boolean)
    .filter((text) => browserFactScore(text) >= 0.58)
    .filter((text) => text.length <= 240);
}

function uniqueBrowserFacts(items: string[]): string[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferBrowserMemoryType(text: string): "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact" {
  if (/(偏好|喜欢|不喜欢|希望|想要|不要)/.test(text)) return "preference";
  if (/(流程|步骤|工作流|每次|默认|应该|必须)/.test(text)) return "workflow";
  if (/(问题|报错|失败|无法|bug|风险)/i.test(text)) return "bug";
  return "fact";
}

function buildBrowserMemoryCandidate(body: Record<string, unknown>, page: Record<string, unknown>, conversation: { provider?: string; promptDraft?: string; turns?: Array<{ role?: string; text?: string }> }): {
  decision: "candidate" | "evidence_only";
  title: string;
  content: string;
  confidence: number;
  reason: string;
  type: "pattern" | "preference" | "architecture" | "bug" | "workflow" | "fact";
} {
  const rawCandidates = body.candidates && typeof body.candidates === "object" ? body.candidates as Record<string, unknown> : {};
  const memoryCandidates = Array.isArray(rawCandidates.memories) ? rawCandidates.memories : [];
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const facts = uniqueBrowserFacts([
    ...memoryCandidates.flatMap(splitBrowserFactSentences),
    ...turns.filter((turn) => turn.role === "user").flatMap((turn) => splitBrowserFactSentences(turn.text)),
    ...turns.filter((turn) => turn.role === "assistant").flatMap((turn) => splitBrowserFactSentences(turn.text)),
    ...splitBrowserFactSentences((page as Record<string, unknown>).selection),
  ]);
  const best = facts
    .map((fact) => ({ fact, score: browserFactScore(fact) }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best) {
    return {
      decision: "evidence_only",
      title: asNonEmptyString(page.title) || "浏览器会话",
      content: [asNonEmptyString(page.title), asNonEmptyString(page.url), turns.length ? `已同步 ${turns.length} 条网页对话。` : "已同步网页上下文。"].filter(Boolean).join("\n"),
      confidence: 0.25,
      reason: "没有识别到足够具体的事实、偏好、决定或待办；仅作为工作台证据保留。",
      type: "fact",
    };
  }
  const fact = best.fact;
  return {
    decision: "candidate",
    title: fact.length > 42 ? `${fact.slice(0, 42)}...` : fact,
    content: [`候选事实：${fact}`, `依据：来自 ${conversation.provider || asNonEmptyString(page.typeLabel) || asNonEmptyString(page.host) || "浏览器"} 的网页会话`].join("\n"),
    confidence: best.score,
    reason: "本地规则识别到明确事实、偏好、决定或待办，进入工作台候选区。",
    type: inferBrowserMemoryType(fact),
  };
}

async function recordBrowserSessionFromReview(
  sdk: ISdk,
  item: ReviewQueueItem,
): Promise<{ sessionId: string; observationCount: number }> {
  const page = item.page || {};
  const conversation = item.conversation || {};
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const provider = conversation.provider || (typeof item.payload?.provider === "string" ? item.payload.provider : undefined) || page.host || "浏览器";
  const createdAt = item.createdAt || new Date().toISOString();
  const sessionId = browserSessionId(item.id, page as Record<string, unknown>, createdAt);
  const project = String(provider || "浏览器");
  const cwd = `browser/${page.host || provider || "web"}`;
  await sdk.trigger({
    function_id: "api::session::start",
    payload: {
      sessionId,
      project,
      cwd,
      title: page.title || item.title || "浏览器会话",
      agentId: provider || "浏览器",
    },
  });
  let observationCount = 0;
  const observe = async (timestamp: string, data: Record<string, unknown>) => {
    observationCount += 1;
    await sdk.trigger({
      function_id: "mem::observe",
      payload: {
        hookType: "prompt_submit",
        sessionId,
        project,
        cwd,
        timestamp,
        data,
      },
    });
  };
  if (page.title || page.url) {
    await observe(createdAt, {
      tool_name: "browser_page",
      prompt: `打开网页：${[page.title, page.url].filter(Boolean).join("\n")}`,
      tool_output: { page },
    });
  }
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const role = turn.role === "assistant" ? "AI" : turn.role === "user" ? "用户" : "对话";
    await observe(createdAt, {
      tool_name: "browser_conversation",
      prompt: `${role}：${turn.text}`,
      tool_output: { role: turn.role || "unknown", provider, pageTitle: page.title || "" },
    });
  }
  await observe(item.updatedAt || createdAt, {
    tool_name: item.kind === "lesson" ? "browser_lesson_candidate" : "browser_memory_candidate",
    prompt: `${item.kind === "lesson" ? "从浏览器会话抽取经验" : "从浏览器会话抽取记忆"}：${item.title}`,
    tool_output: { content: item.content, status: item.status, kind: item.kind },
  });
  await sdk.trigger({ function_id: "api::session::end", payload: { sessionId } });
  return { sessionId, observationCount };
}

function reviewKind(value: unknown): ReviewQueueItem["kind"] {
  return value === "lesson" || value === "action" ? value : "memory";
}

function defaultReviewTitle(kind: ReviewQueueItem["kind"], pageTitle?: string): string {
  if (pageTitle) return pageTitle;
  if (kind === "lesson") return "待审阅经验";
  if (kind === "action") return "待审阅行动";
  return "待审阅记忆";
}

function isJsonLikeReviewText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return true;
  }
}

function isMarkdownPlanReviewText(value: string): boolean {
  const raw = String(value || "");
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

function isReviewTextDisplayable(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  if (isJsonLikeReviewText(trimmed)) return false;
  if (isMarkdownPlanReviewText(trimmed)) return false;
  if (/please implement this plan/i.test(trimmed)) return false;
  if (/"plan"\s*:/.test(trimmed) && /"status"\s*:/.test(trimmed) && /"step"\s*:/.test(trimmed)) return false;
  if (/"command"\s*:|toolinput|tooloutput|function_id/.test(lower)) return false;
  if (/审查结果\s*\[[Pp]\d+\]/.test(trimmed) && /(?:src|test)\/[^\s]+(?:\s*\(line\s+\d+\))?/.test(trimmed)) return false;
  if (/^src\/[^\s]+/m.test(trimmed) && /\bnpm\s+(test|run|install|build)\b/i.test(trimmed)) return false;
  if (/^\s*(npm|pnpm|yarn)\s+(test|run|install|build)\b/im.test(trimmed)) return false;
  return true;
}

function isReviewCandidateDisplayable(title: string, content: string): boolean {
  return isReviewTextDisplayable(title) && isReviewTextDisplayable(content);
}

function flagDisabledResponse(opts: {
  error: string;
  flag: string;
  enableHow: string;
  docsHref: string;
}): Response {
  return {
    status_code: 503,
    body: opts,
  };
}

function graphDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Knowledge graph not enabled",
    flag: "GRAPH_EXTRACTION_ENABLED",
    enableHow: "Set GRAPH_EXTRACTION_ENABLED=true and restart. Requires an LLM provider key.",
    docsHref: "https://github.com/MaimoryLab/agentmemory-lab#knowledge-graph",
  });
}

function consolidationDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Consolidation pipeline not enabled",
    flag: "CONSOLIDATION_ENABLED",
    enableHow: "Set CONSOLIDATION_ENABLED=true and restart. Requires an LLM provider key.",
    docsHref: "https://github.com/MaimoryLab/agentmemory-lab#consolidation",
  });
}

function slotsDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Memory slots not enabled",
    flag: "AGENTMEMORY_SLOTS",
    enableHow: "Set AGENTMEMORY_SLOTS=true (in ~/.agentmemory/.env or the shell) and restart.",
    docsHref: "https://github.com/MaimoryLab/agentmemory-lab#memory-slots",
  });
}

function reflectDisabledResponse(): Response {
  return flagDisabledResponse({
    error: "Slot reflection not enabled",
    flag: "AGENTMEMORY_REFLECT",
    enableHow: "Set AGENTMEMORY_REFLECT=true (in ~/.agentmemory/.env or the shell) and restart. Requires AGENTMEMORY_SLOTS=true.",
    docsHref: "https://github.com/MaimoryLab/agentmemory-lab#memory-slots",
  });
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseOptionalFiniteNumber(value: unknown): number | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseOptionalPositiveInt(value: unknown): number | undefined | null {
  const parsed = parseOptionalFiniteNumber(value);
  if (parsed === undefined || parsed === null) return parsed;
  if (!Number.isInteger(parsed) || parsed < 1) return null;
  return parsed;
}

export function registerApiTriggers(
  sdk: ISdk,
  kv: StateKV,
  secret?: string,
  metricsStore?: MetricsStore,
  provider?: ResilientProvider | { circuitState?: unknown },
): void {
  sdk.registerFunction(
    "middleware::api-auth",
    async (input: {
      request?: { headers?: Record<string, string | undefined> };
    }) => {
      if (!secret) return { action: "continue" };
      const headers = input?.request?.headers || {};
      const auth = headers["authorization"] || headers["Authorization"];
      if (
        typeof auth !== "string" ||
        !timingSafeCompare(auth, `Bearer ${secret}`)
      ) {
        return {
          action: "respond",
          response: { status_code: 401, body: { error: "unauthorized" } },
        };
      }
      return { action: "continue" };
    },
  );

  sdk.registerFunction("api::liveness",
    async (): Promise<Response> => ({
      status_code: 200,
      body: { status: "ok", service: "agentmemory", viewerPort: getBoundViewerPort(), viewerSkipped: getViewerSkipped() },
    }),
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::liveness",
    config: { api_path: "/agentmemory/livez", http_method: "GET" },
  });

  sdk.registerFunction("api::config-flags",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const providerKind = detectLlmProviderKind();
      const embeddingProvider = detectEmbeddingProvider() ? "embeddings" : "none";
      const flags = [
        {
          key: "GRAPH_EXTRACTION_ENABLED",
          label: "Knowledge graph extraction",
          enabled: isGraphExtractionEnabled(),
          default: false,
          affects: ["Graph", "Dashboard"],
          needsLlm: true,
          description: "Extracts entities and relations from observations into a knowledge graph.",
          enableHow: "Set GRAPH_EXTRACTION_ENABLED=true and provide an LLM key, then restart.",
          docsHref: "https://github.com/MaimoryLab/agentmemory-lab#knowledge-graph",
        },
        {
          key: "CONSOLIDATION_ENABLED",
          label: "Memory consolidation",
          enabled: isConsolidationEnabled(),
          default: false,
          affects: ["Dashboard", "Memories", "Crystals"],
          needsLlm: true,
          description: "Periodically summarizes sessions into semantic facts + procedures.",
          enableHow: "Set CONSOLIDATION_ENABLED=true and provide an LLM key, then restart.",
          docsHref: "https://github.com/MaimoryLab/agentmemory-lab#consolidation",
        },
        {
          key: "AGENTMEMORY_AUTO_COMPRESS",
          label: "LLM-powered observation compression",
          enabled: isAutoCompressEnabled(),
          default: false,
          affects: ["Memories", "Timeline"],
          needsLlm: true,
          description: "Every observation is compressed by the LLM for richer summaries (costs tokens). OFF uses zero-LLM synthetic compression.",
          enableHow: "Set AGENTMEMORY_AUTO_COMPRESS=true and provide an LLM key.",
          docsHref: "https://github.com/MaimoryLab/agentmemory-lab/issues/138",
        },
        {
          key: "AGENTMEMORY_INJECT_CONTEXT",
          label: "In-conversation context injection",
          enabled: isContextInjectionEnabled(),
          default: false,
          affects: ["Hooks"],
          needsLlm: false,
          description: "Hooks write recalled context into Claude Code's conversation. OFF captures in the background without injecting.",
          enableHow: "Set AGENTMEMORY_INJECT_CONTEXT=true and restart.",
          docsHref: "https://github.com/MaimoryLab/agentmemory-lab/issues/143",
        },
      ];
      return {
        status_code: 200,
        body: {
          version: VERSION,
          provider: providerKind,
          embeddingProvider,
          flags,
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::config-flags",
    config: {
      api_path: "/agentmemory/config/flags",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::todo-extractor-config",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (req.body && Object.keys(req.body as Record<string, unknown>).length) {
        const body = req.body as Record<string, unknown>;
        const updates: Record<string, string> = {};
        // Iterate the single writable-keys source of truth so a UI field can
        // never silently drop (writeUserEnv applies the same allowlist).
        for (const key of WRITABLE_TODO_EXTRACT_KEYS) {
          const value = cleanConfigValue(body[key]);
          if (value) updates[key] = value;
        }
        if (Object.keys(updates).length) writeUserEnv(updates);
      }
      return {
        status_code: 200,
        body: {
          success: true,
          envPath: getUserEnvPath(),
          config: getTodoExtractorUserConfig(),
          restartRequired: false,
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::todo-extractor-config",
    config: {
      api_path: "/agentmemory/config/todo-extractor",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::todo-extractor-config",
    config: {
      api_path: "/agentmemory/config/todo-extractor",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::health", 
    async (req: ApiRequest): Promise<Response> => {
      const health = await getLatestHealth(kv);
      const functionMetrics = metricsStore ? await metricsStore.getAll() : [];
      const circuitBreaker =
        provider && "circuitState" in provider ? provider.circuitState : null;

      const status = health?.status || "healthy";
      const statusCode = status === "critical" ? 503 : 200;

      return {
        status_code: statusCode,
        body: {
          status,
          service: "agentmemory",
          version: VERSION,
          health: health || null,
          functionMetrics,
          circuitBreaker,
          viewerPort: getBoundViewerPort(),
          viewerSkipped: getViewerSkipped(),
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::health",
    config: {
      api_path: "/agentmemory/health",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::observe",
    async (req: ApiRequest<HookPayload>): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const hookType = asNonEmptyString(body.hookType);
      const sessionId = asNonEmptyString(body.sessionId);
      const project = asNonEmptyString(body.project);
      const cwd = asNonEmptyString(body.cwd);
      const timestamp = asNonEmptyString(body.timestamp);
      if (!hookType || !sessionId || !project || !cwd || !timestamp) {
        return {
          status_code: 400,
          body: {
            error:
              "hookType, sessionId, project, cwd, and timestamp are required strings",
          },
        };
      }
      const payload: HookPayload = {
        hookType: hookType as HookPayload["hookType"],
        sessionId,
        project,
        cwd,
        timestamp,
        data: body.data,
      };
      const result = await sdk.trigger({ function_id: "mem::observe", payload });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::observe",
    config: {
      api_path: "/agentmemory/observe",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::context",
    async (
      req: ApiRequest<{ sessionId: string; project: string; budget?: number }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = asNonEmptyString(body.sessionId);
      const project = asNonEmptyString(body.project);
      if (!sessionId || !project) {
        return {
          status_code: 400,
          body: { error: "sessionId and project are required strings" },
        };
      }
      const budget = parseOptionalPositiveInt(body.budget);
      if (budget === null) {
        return {
          status_code: 400,
          body: { error: "budget must be a positive integer" },
        };
      }
      const payload: { sessionId: string; project: string; budget?: number } = {
        sessionId,
        project,
      };
      if (budget !== undefined) payload.budget = budget;
      const result = await sdk.trigger({ function_id: "mem::context", payload });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::context",
    config: {
      api_path: "/agentmemory/context",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::search", 
    async (
      req: ApiRequest<{
        query: string;
        limit?: number;
        project?: string;
        cwd?: string;
        format?: string;
        token_budget?: number;
      }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.query !== "string" || !body.query.trim()) {
        return { status_code: 400, body: { error: "query is required and must be a non-empty string" } };
      }
      if (
        body.limit !== undefined &&
        (!Number.isInteger(body.limit) || (body.limit as number) < 1)
      ) {
        return { status_code: 400, body: { error: "limit must be a positive integer" } };
      }
      if (body.project !== undefined && typeof body.project !== "string") {
        return { status_code: 400, body: { error: "project must be a string" } };
      }
      if (body.cwd !== undefined && typeof body.cwd !== "string") {
        return { status_code: 400, body: { error: "cwd must be a string" } };
      }
      if (
        body.format !== undefined &&
        (typeof body.format !== "string" ||
          !["full", "compact", "narrative"].includes(body.format.trim().toLowerCase()))
      ) {
        return {
          status_code: 400,
          body: { error: "format must be one of: full, compact, narrative" },
        };
      }
      if (
        body.token_budget !== undefined &&
        (!Number.isInteger(body.token_budget) || (body.token_budget as number) < 1)
      ) {
        return {
          status_code: 400,
          body: { error: "token_budget must be a positive integer" },
        };
      }
      const payload = {
        query: body.query.trim(),
        limit: body.limit as number | undefined,
        project: body.project as string | undefined,
        cwd: body.cwd as string | undefined,
        format:
          typeof body.format === "string"
            ? body.format.trim().toLowerCase()
            : undefined,
        token_budget: body.token_budget as number | undefined,
      };
      const result = await sdk.trigger({ function_id: "mem::search", payload: payload });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::search",
    config: {
      api_path: "/agentmemory/search",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::compress-file", 
    async (req: ApiRequest<{ filePath: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const filePath = asNonEmptyString(body.filePath);
      if (!filePath) {
        return {
          status_code: 400,
          body: { error: "filePath is required and must be a non-empty string" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::compress-file",
        payload: { filePath },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::compress-file",
    config: { api_path: "/agentmemory/compress-file", http_method: "POST" },
  });

  sdk.registerFunction("api::replay::load",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessionId = asNonEmptyString(req.query_params?.["sessionId"]);
      if (!sessionId) {
        return { status_code: 400, body: { error: "sessionId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::replay::load",
        payload: { sessionId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::replay::load",
    config: { api_path: "/agentmemory/replay/load", http_method: "GET" },
  });

  sdk.registerFunction("api::replay::sessions",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessions = await kv.list<Session>(KV.sessions);
      sessions.sort((a, b) =>
        (b.startedAt || "").localeCompare(a.startedAt || ""),
      );
      return { status_code: 200, body: { success: true, sessions } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::replay::sessions",
    config: { api_path: "/agentmemory/replay/sessions", http_method: "GET" },
  });

  sdk.registerFunction("api::replay::import",
    async (
      req: ApiRequest<{ path?: string; maxFiles?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payload: { path?: string; maxFiles?: number } = {};
      if (body.path !== undefined) {
        if (typeof body.path !== "string" || body.path.trim().length === 0) {
          return {
            status_code: 400,
            body: { error: "path must be a non-empty string" },
          };
        }
        payload.path = body.path.trim();
      }
      if (body.maxFiles !== undefined) {
        const n = body.maxFiles as number;
        if (
          !Number.isInteger(n) ||
          n < 1 ||
          n > MAX_FILES_UPPER_BOUND
        ) {
          return {
            status_code: 400,
            body: {
              error: `maxFiles must be an integer between 1 and ${MAX_FILES_UPPER_BOUND}`,
            },
          };
        }
        payload.maxFiles = n;
      }
      const result = await sdk.trigger({
        function_id: "mem::replay::import-jsonl",
        payload,
      });
      return { status_code: 202, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::replay::import",
    config: { api_path: "/agentmemory/replay/import-jsonl", http_method: "POST" },
  });

  sdk.registerFunction("api::session::start",
    async (
      req: ApiRequest<{ sessionId: string; project: string; cwd: string }>,
    ): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sessionId = asNonEmptyString(body.sessionId);
      const project = asNonEmptyString(body.project);
      const cwd = asNonEmptyString(body.cwd);
      if (!sessionId || !project || !cwd) {
        return {
          status_code: 400,
          body: {
            error: "sessionId, project, and cwd are required non-empty strings",
          },
        };
      }
      const title = typeof body.title === "string" ? body.title.trim() : undefined;
      // allow session/start to override AGENT_ID from request body
      // (multi-agent runtimes that route many roles through one server
      // process). Falls back to the AGENT_ID env on the server.
      const requestAgentId =
        typeof body.agentId === "string" && body.agentId.trim().length > 0
          ? body.agentId.trim().slice(0, 128)
          : undefined;
      const agentId = requestAgentId ?? getAgentId();
      const session: Session = {
        id: sessionId,
        project,
        cwd,
        startedAt: new Date().toISOString(),
        status: "active",
        observationCount: 0,
        ...(title ? { summary: title.slice(0, 200) } : {}),
        ...(title ? { firstPrompt: title.slice(0, 200) } : {}),
        ...(agentId ? { agentId } : {}),
      };
      await kv.set(KV.sessions, sessionId, session);
      const contextResult = await sdk.trigger<
        { sessionId: string; project: string },
        { context: string }
      >({ function_id: "mem::context", payload: { sessionId, project } });
      return {
        status_code: 200,
        body: { session, context: contextResult.context },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::start",
    config: {
      api_path: "/agentmemory/session/start",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::session::end",
    async (req: ApiRequest<{ sessionId: string }>): Promise<Response> => {
      const sessionId = asNonEmptyString((req.body as Record<string, unknown>)?.sessionId);
      if (!sessionId) {
        return {
          status_code: 400,
          body: { error: "sessionId is required and must be a non-empty string" },
        };
      }
      await kv.update(KV.sessions, sessionId, [
        { type: "set", path: "endedAt", value: new Date().toISOString() },
        { type: "set", path: "status", value: "completed" },
      ]);
      // Fan out session-stopped lifecycle (non-blocking).
      try {
        void sdk.trigger({ function_id: "event::session::stopped", payload: { sessionId }, action: TriggerAction.Void() }).catch(() => {});
      } catch (err) {
        logger.warn("event::session::stopped trigger failed", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return { status_code: 200, body: { success: true } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::end",
    config: {
      api_path: "/agentmemory/session/end",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::summarize", 
    async (req: ApiRequest<{ sessionId: string }>): Promise<Response> => {
      const sessionId = asNonEmptyString((req.body as Record<string, unknown>)?.sessionId);
      if (!sessionId) {
        return { status_code: 400, body: { error: "sessionId is required" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::summarize",
        payload: { sessionId },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::summarize",
    config: {
      api_path: "/agentmemory/summarize",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::session::commit",
    async (req: ApiRequest): Promise<Response> => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sha = asNonEmptyString(body.sha);
      if (!sha) {
        return {
          status_code: 400,
          body: { error: "sha is required and must be a non-empty string" },
        };
      }
      const sessionId = asNonEmptyString(body.sessionId) ?? undefined;
      const branch = asNonEmptyString(body.branch) ?? undefined;
      const repo = asNonEmptyString(body.repo) ?? undefined;
      const message = asNonEmptyString(body.message) ?? undefined;
      const author = asNonEmptyString(body.author) ?? undefined;
      const authoredAt = asNonEmptyString(body.authoredAt) ?? undefined;
      const files = Array.isArray(body.files)
        ? (body.files as unknown[]).filter(
            (f): f is string => typeof f === "string" && f.length > 0,
          )
        : undefined;

      const link = await withKeyedLock(`commit:${sha}`, async () => {
        const existing = await kv.get<CommitLink>(KV.commits, sha);
        const sessionSet = new Set<string>(existing?.sessionIds ?? []);
        if (sessionId) sessionSet.add(sessionId);
        const merged: CommitLink = {
          sha,
          shortSha: existing?.shortSha ?? sha.slice(0, 7),
          branch: branch ?? existing?.branch,
          repo: repo ?? existing?.repo,
          message: message ?? existing?.message,
          author: author ?? existing?.author,
          authoredAt: authoredAt ?? existing?.authoredAt,
          files: files ?? existing?.files,
          sessionIds: Array.from(sessionSet),
          linkedAt: existing?.linkedAt ?? new Date().toISOString(),
        };
        await kv.set(KV.commits, sha, merged);
        return merged;
      });

      if (sessionId) {
        await withKeyedLock(`session:${sessionId}`, async () => {
          const session = await kv.get<Session>(KV.sessions, sessionId);
          if (!session) return;
          const shaSet = new Set<string>(session.commitShas ?? []);
          shaSet.add(sha);
          session.commitShas = Array.from(shaSet);
          await kv.set(KV.sessions, sessionId, session);
        });
      }

      return { status_code: 200, body: { commit: link } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::commit",
    config: {
      api_path: "/agentmemory/session/commit",
      http_method: "POST",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::session::by-commit",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sha = asNonEmptyString(req.query_params?.["sha"]);
      if (!sha) {
        return {
          status_code: 400,
          body: { error: "sha is required and must be a non-empty string" },
        };
      }
      const link = await kv.get<CommitLink>(KV.commits, sha);
      if (!link) {
        return {
          status_code: 404,
          body: { error: "no sessions linked to this commit" },
        };
      }
      const fetched = await Promise.all(
        (link.sessionIds ?? []).map((sid) => kv.get<Session>(KV.sessions, sid)),
      );
      const sessions = fetched.filter((s): s is Session => s !== null);
      return { status_code: 200, body: { commit: link, sessions } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::by-commit",
    config: {
      api_path: "/agentmemory/session/by-commit",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::commits",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const branch = asNonEmptyString(req.query_params?.["branch"]);
      const repo = asNonEmptyString(req.query_params?.["repo"]);
      const rawLimit = parseOptionalInt(req.query_params?.["limit"]);
      const limit = Math.max(1, Math.min(500, rawLimit ?? 100));
      const all = await kv.list<CommitLink>(KV.commits);
      const filtered = all
        .filter((c) => !branch || c.branch === branch)
        .filter((c) => !repo || c.repo === repo)
        .sort((a, b) => ((a.linkedAt ?? "") < (b.linkedAt ?? "") ? 1 : -1))
        .slice(0, limit);
      return { status_code: 200, body: { commits: filtered } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::commits",
    config: {
      api_path: "/agentmemory/commits",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::sessions",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessions = await kv.list<Session>(KV.sessions);
      const normalizedAgentId =
        typeof req.query_params?.["agentId"] === "string"
          ? req.query_params["agentId"].trim()
          : undefined;
      const wildcardAgent = normalizedAgentId === "*";
      const explicitAgentId =
        normalizedAgentId && !wildcardAgent ? normalizedAgentId : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ??
          (isAgentScopeIsolated() ? getAgentId() : undefined);
      const filtered = filterAgentId
        ? sessions.filter((s) => s.agentId === filterAgentId)
        : sessions;
      return { status_code: 200, body: { sessions: filtered } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::sessions",
    config: { api_path: "/agentmemory/sessions", http_method: "GET" },
  });

  sdk.registerFunction("api::sessions::delete",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const project = asNonEmptyString(req.query_params?.["project"]);
      if (!project) {
        return { status_code: 400, body: { error: "project is required" } };
      }
      const sessions = await kv.list<Session>(KV.sessions);
      // Scope deletes to the calling agent when isolation is on, mirroring GET /sessions.
      const filterAgentId = isAgentScopeIsolated() ? getAgentId() : undefined;
      const targets = sessions.filter(
        (s) => s.project === project && (!filterAgentId || s.agentId === filterAgentId),
      );
      for (const s of targets) {
        await kv.delete(KV.sessions, s.id);
      }
      // ponytail: removes session records only; their observations/memories
      // remain (use governance bulk-delete for those). Enough to clear the
      // sessions `demo` seeds, which is what advertises this route.
      return { status_code: 200, body: { success: true, deleted: targets.length } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::sessions::delete",
    config: { api_path: "/agentmemory/sessions", http_method: "DELETE" },
  });

  sdk.registerFunction("api::session::highlights",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessionId = asNonEmptyString(req.query_params?.["sessionId"]);
      if (!sessionId) {
        return { status_code: 400, body: { error: "sessionId is required" } };
      }
      const parsedMaxItems = parseOptionalPositiveInt(req.query_params?.["maxItems"]);
      if (parsedMaxItems === null || (parsedMaxItems !== undefined && parsedMaxItems > 200)) {
        return {
          status_code: 400,
          body: { error: "maxItems must be a positive integer no greater than 200" },
        };
      }
      const payload: { sessionId: string; maxItems?: number } = { sessionId };
      if (parsedMaxItems !== undefined) payload.maxItems = parsedMaxItems;
      const result = await sdk.trigger({
        function_id: "mem::session-highlights",
        payload,
      });
      const statusCode =
        result &&
        typeof result === "object" &&
        (result as { success?: unknown; error?: unknown }).success === false &&
        (result as { error?: unknown }).error === "session_not_found"
          ? 404
          : 200;
      return { status_code: statusCode, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::session::highlights",
    config: {
      api_path: "/agentmemory/session/highlights",
      http_method: "GET",
      middleware_function_ids: ["middleware::api-auth"],
    },
  });

  sdk.registerFunction("api::observations",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const sessionId = asNonEmptyString(req.query_params?.["sessionId"]);
      if (!sessionId)
        return { status_code: 400, body: { error: "sessionId required" } };
      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const normalizedAgentId =
        typeof req.query_params?.["agentId"] === "string"
          ? req.query_params["agentId"].trim()
          : undefined;
      const wildcardAgent = normalizedAgentId === "*";
      const explicitAgentId =
        normalizedAgentId && !wildcardAgent ? normalizedAgentId : undefined;
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ??
          (isAgentScopeIsolated() ? getAgentId() : undefined);
      const filtered = filterAgentId
        ? observations.filter((o) => o.agentId === filterAgentId)
        : observations;
      return { status_code: 200, body: { observations: filtered } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::observations",
    config: { api_path: "/agentmemory/observations", http_method: "GET" },
  });

  sdk.registerFunction("api::file-context", 
    async (
      req: ApiRequest<{ sessionId: string; files: string[] }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::file-context", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::file-context",
    config: { api_path: "/agentmemory/file-context", http_method: "POST" },
  });

  sdk.registerFunction("api::enrich",
    async (
      req: ApiRequest<{
        sessionId: string;
        files: string[];
        terms?: string[];
        toolName?: string;
        project?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !req.body?.sessionId ||
        typeof req.body.sessionId !== "string" ||
        !Array.isArray(req.body?.files) ||
        req.body.files.length === 0 ||
        !req.body.files.every((f: unknown) => typeof f === "string")
      ) {
        return {
          status_code: 400,
          body: {
            error: "sessionId (string) and files (string[]) are required",
          },
        };
      }
      if (
        req.body.terms !== undefined &&
        (!Array.isArray(req.body.terms) ||
          !req.body.terms.every((t: unknown) => typeof t === "string"))
      ) {
        return {
          status_code: 400,
          body: { error: "terms must be an array of strings" },
        };
      }
      if (
        req.body.project !== undefined &&
        (typeof req.body.project !== "string" || !req.body.project.trim())
      ) {
        return {
          status_code: 400,
          body: { error: "project must be a non-empty string" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::enrich",
        payload: {
          sessionId: req.body.sessionId,
          files: req.body.files,
          ...(req.body.terms !== undefined && { terms: req.body.terms }),
          ...(req.body.toolName !== undefined && { toolName: req.body.toolName }),
          ...(req.body.project !== undefined && { project: req.body.project }),
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::enrich",
    config: { api_path: "/agentmemory/enrich", http_method: "POST" },
  });

  sdk.registerFunction("api::remember",
    async (
      req: ApiRequest<{
        content: string;
        type?: string;
        concepts?: string[];
        files?: string[];
        ttlDays?: number;
        sourceObservationIds?: string[];
        project?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !req.body?.content ||
        typeof req.body.content !== "string" ||
        !req.body.content.trim()
      ) {
        return { status_code: 400, body: { error: "content is required" } };
      }
      if (
        req.body.project !== undefined &&
        (typeof req.body.project !== "string" || !req.body.project.trim())
      ) {
        return { status_code: 400, body: { error: "project must be a non-empty string" } };
      }
      const result = await sdk.trigger({
        function_id: "mem::remember",
        payload: {
          content: req.body.content,
          ...(req.body.type !== undefined && { type: req.body.type }),
          ...(req.body.concepts !== undefined && { concepts: req.body.concepts }),
          ...(req.body.files !== undefined && { files: req.body.files }),
          ...(req.body.ttlDays !== undefined && { ttlDays: req.body.ttlDays }),
          ...(req.body.sourceObservationIds !== undefined && { sourceObservationIds: req.body.sourceObservationIds }),
          ...(req.body.project !== undefined && { project: req.body.project }),
        },
      });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::remember",
    config: { api_path: "/agentmemory/remember", http_method: "POST" },
  });

  sdk.registerFunction("api::review-create",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const syncMode = body.mode === "sync" || body.source === "browser-sync";
      const rawKind = reviewKind(body.kind);
      const now = new Date().toISOString();
      const page = body.page && typeof body.page === "object" ? body.page as Record<string, unknown> : {};
      const rawConversation = body.conversation && typeof body.conversation === "object" ? body.conversation as Record<string, unknown> : {};
      const rawTurns = Array.isArray(rawConversation.turns) ? rawConversation.turns : [];
      const conversation = {
        provider: asNonEmptyString(rawConversation.provider) || undefined,
        promptDraft: asNonEmptyString(rawConversation.promptDraft) || undefined,
        turns: rawTurns.map((turn) => {
          const t = turn && typeof turn === "object" ? turn as Record<string, unknown> : {};
          const role = asNonEmptyString(t.role) || "unknown";
          const text = asNonEmptyString(t.text);
          return text ? { role, text } : null;
        }).filter((turn): turn is { role: string; text: string } => turn !== null).slice(-12),
      };
      const autoCandidate = syncMode ? buildBrowserMemoryCandidate(body, page, conversation) : null;
      const rawContent = asNonEmptyString(body.content) || autoCandidate?.content;
      if (!rawContent) {
        return { status_code: 400, body: { error: "content is required" } };
      }
      const title = asNonEmptyString(body.title) || autoCandidate?.title || defaultReviewTitle(rawKind, asNonEmptyString(page.title) || undefined);
      if (!isReviewCandidateDisplayable(title, rawContent)) {
        return { status_code: 400, body: { error: "review_content_not_displayable" } };
      }
      const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};
      const source = syncMode ? "browser-sync" : (body.source === "viewer" || body.source === "api" ? body.source : "browser-extension");
      const syncId = syncMode ? browserSyncKey(page, conversation) : "";
      const itemId = syncId ? `browser_sync_${syncId}` : `review_${Date.now().toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
      const existing = syncId ? await kv.get<ReviewQueueItem>(KV.reviewQueue, itemId) : null;
      const item: ReviewQueueItem = {
        id: existing?.id || itemId,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        status: autoCandidate?.decision === "evidence_only" ? "dismissed" : (existing?.status || "pending"),
        kind: rawKind,
        title,
        content: rawContent,
        source,
        ...(autoCandidate ? { decision: autoCandidate.decision, confidence: autoCandidate.confidence, reason: autoCandidate.reason } : {}),
        page: {
          type: typeof page.type === "string" ? page.type : undefined,
          typeLabel: typeof page.typeLabel === "string" ? page.typeLabel : undefined,
          title: typeof page.title === "string" ? page.title : undefined,
          url: typeof page.url === "string" ? page.url : undefined,
          host: typeof page.host === "string" ? page.host : undefined,
        },
        ...(conversation.provider || conversation.promptDraft || conversation.turns.length ? { conversation } : {}),
        payload: {
          ...payload,
          ...(autoCandidate ? { type: autoCandidate.type, decision: autoCandidate.decision, confidence: autoCandidate.confidence, reason: autoCandidate.reason } : {}),
          ...(syncId ? { browserSyncId: syncId } : {}),
        },
      };
      // STEP-14: browser sessions now flow through the todo-extract LLM pipeline
      // (recorded below as a session + observations), not the rule-based action
      // drafts that produced session-narration noise.
      if (item.source === "browser-extension" || item.source === "browser-sync") {
        try {
          const browserSession = await recordBrowserSessionFromReview(sdk, item);
          item.payload = {
            ...(item.payload || {}),
            browserSessionId: browserSession.sessionId,
            browserObservationCount: browserSession.observationCount,
          };
        } catch (err) {
          logger.warn("failed to record browser session from review candidate", {
            reviewId: item.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      await kv.set(KV.reviewQueue, item.id, item);
      return {
        status_code: existing ? 200 : 201,
        body: { success: true, item },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::review-create",
    config: { api_path: "/agentmemory/review", http_method: "POST" },
  });

  sdk.registerFunction("api::review-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const status = asNonEmptyString(req.query_params?.["status"]);
      const kinds = new Set((asNonEmptyString(req.query_params?.["kind"]) || "")
        .split(",")
        .map((kind) => kind.trim())
        .filter(Boolean));
      const rawLimit = parseOptionalInt(req.query_params?.["limit"]);
      const limit = Math.max(1, Math.min(200, rawLimit ?? 50));
      const items = (await kv.list<ReviewQueueItem>(KV.reviewQueue))
        .filter((item) => !status || item.status === status)
        .filter((item) => kinds.size === 0 || kinds.has(item.kind))
        .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
        .slice(0, limit);
      return { status_code: 200, body: { items } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::review-list",
    config: { api_path: "/agentmemory/review", http_method: "GET" },
  });

  sdk.registerFunction("api::review-actions-generate",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const maxSessions = parseOptionalPositiveInt(body.maxSessions);
      if (maxSessions === null) {
        return { status_code: 400, body: { error: "maxSessions must be a positive integer" } };
      }
      const maxObservationsPerSession = parseOptionalPositiveInt(body.maxObservationsPerSession);
      if (maxObservationsPerSession === null) {
        return { status_code: 400, body: { error: "maxObservationsPerSession must be a positive integer" } };
      }
      const payload: Record<string, unknown> = {};
      if (maxSessions !== undefined) payload.maxSessions = maxSessions;
      if (maxObservationsPerSession !== undefined) {
        payload.maxObservationsPerSession = maxObservationsPerSession;
      }
      const project = asNonEmptyString(body.project);
      if (project) payload.project = project;
      const result = await sdk.trigger({
        function_id: "mem::action-candidates-generate",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::review-actions-generate",
    config: { api_path: "/agentmemory/review/actions/generate", http_method: "POST" },
  });

  sdk.registerFunction("api::todo-extract-generate",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const maxSessions = parseOptionalPositiveInt(body.maxSessions);
      if (maxSessions === null) {
        return { status_code: 400, body: { error: "maxSessions must be a positive integer" } };
      }
      const maxObservationsPerSession = parseOptionalPositiveInt(body.maxObservationsPerSession);
      if (maxObservationsPerSession === null) {
        return { status_code: 400, body: { error: "maxObservationsPerSession must be a positive integer" } };
      }
      const sinceDays = parseOptionalPositiveInt(body.sinceDays);
      if (sinceDays === null) {
        return { status_code: 400, body: { error: "sinceDays must be a positive integer" } };
      }
      const maxInteractionsPerSession = parseOptionalPositiveInt(body.maxInteractionsPerSession);
      if (maxInteractionsPerSession === null) {
        return { status_code: 400, body: { error: "maxInteractionsPerSession must be a positive integer" } };
      }
      const payload: Record<string, unknown> = {};
      if (maxSessions !== undefined) payload.maxSessions = maxSessions;
      if (maxObservationsPerSession !== undefined) payload.maxObservationsPerSession = maxObservationsPerSession;
      if (sinceDays !== undefined) payload.sinceDays = sinceDays;
      if (maxInteractionsPerSession !== undefined) payload.maxInteractionsPerSession = maxInteractionsPerSession;
      const project = asNonEmptyString(body.project);
      if (project) payload.project = project;
      if (body.force === true) payload.force = true;
      if (body.cleanup === "none" || body.cleanup === "dry-run" || body.cleanup === "apply") payload.cleanup = body.cleanup;
      const result = await sdk.trigger({ function_id: "mem::todo-extract-generate", payload });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::todo-extract-generate",
    config: { api_path: "/agentmemory/todo-extract/generate", http_method: "POST" },
  });

  sdk.registerFunction("api::todo-refresh-action",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const actionId = asNonEmptyString(body.actionId);
      if (!actionId) return { status_code: 400, body: { error: "actionId is required" } };
      const result = await sdk.trigger({ function_id: "mem::todo-refresh-action", payload: { actionId } }) as Record<string, unknown>;
      if (result.success === false && result.reason === "action-not-found") return { status_code: 404, body: result };
      if (result.success === false) return { status_code: 400, body: result };
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::todo-refresh-action",
    config: { api_path: "/agentmemory/todo/action-refresh", http_method: "POST" },
  });

  sdk.registerFunction("api::todo-update",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const maxCards = parseOptionalPositiveInt(body.maxCards);
      if (maxCards === null) {
        return { status_code: 400, body: { error: "maxCards must be a positive integer" } };
      }
      const payload: Record<string, unknown> = {};
      if (body.mode === "dry-run" || body.mode === "apply") payload.mode = body.mode;
      if (body.scope === "changed" || body.scope === "all") payload.scope = body.scope;
      if (maxCards !== undefined) payload.maxCards = maxCards;
      // Apply previously-previewed decisions verbatim (no LLM re-call) when given.
      if (Array.isArray(body.decisions)) payload.decisions = body.decisions;
      const result = await sdk.trigger({ function_id: "mem::todo-update", payload });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::todo-update",
    config: { api_path: "/agentmemory/todo/update", http_method: "POST" },
  });

  sdk.registerFunction("api::review-approve",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = asNonEmptyString(body.id);
      if (!id) return { status_code: 400, body: { error: "id is required" } };
      const item = await kv.get<ReviewQueueItem>(KV.reviewQueue, id);
      if (!item) return { status_code: 404, body: { error: "review item not found" } };
      if (item.status !== "pending") return { status_code: 409, body: { error: "review item is not pending" } };
      const content = asNonEmptyString(body.content) || item.content;
      const title = asNonEmptyString(body.title) || item.title;
      const project = asNonEmptyString(body.project);
      const tags = Array.isArray(body.tags)
        ? body.tags.map((tag) => typeof tag === "string" ? tag.trim() : "").filter(Boolean)
        : typeof body.tags === "string"
          ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
          : undefined;
      const now = new Date().toISOString();
      let result: unknown;
      const approvedKind = body.kind === "lesson" || body.kind === "memory" || body.kind === "action" ? body.kind : item.kind;
      const payload = (item.payload || {}) as Record<string, unknown>;
      const actionCandidate = payload.actionCandidate && typeof payload.actionCandidate === "object"
        ? payload.actionCandidate as Record<string, unknown>
        : {};
      const provider = asNonEmptyString(payload.provider) || undefined;
      const pageType = asNonEmptyString(payload.pageType) || item.page?.type;
      const sourceLabel = asNonEmptyString(payload.sourceLabel) || provider || item.page?.typeLabel || item.page?.host;
      const sourceConcepts = [
        "browser-context",
        item.page?.host,
        pageType ? `browser-page:${pageType}` : undefined,
        provider ? `browser-source:${provider.toLowerCase()}` : undefined,
        !provider && item.page?.host ? `browser-host:${item.page.host}` : undefined,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      const sourceTags = [
        "browser",
        "reviewed",
        provider ? `source:${provider.toLowerCase()}` : undefined,
        pageType ? `page:${pageType}` : undefined,
      ].filter((value): value is string => typeof value === "string" && value.length > 0);
      if (approvedKind === "action") {
        const priorityValue = parseOptionalFiniteNumber(body.priority) ?? parseOptionalFiniteNumber(actionCandidate.priority) ?? 5;
        const priority = typeof priorityValue === "number" ? Math.max(1, Math.min(10, Math.floor(priorityValue))) : 5;
        const todoExtraction = payload.todoExtraction && typeof payload.todoExtraction === "object"
          ? payload.todoExtraction as Record<string, unknown>
          : {};
        const typeBucket = typeof todoExtraction.typeBucket === "string" ? todoExtraction.typeBucket : "";
        const dedupeKey = typeof todoExtraction.dedupeKey === "string" ? todoExtraction.dedupeKey : "";
        const actionStatus =
          typeBucket === "done" ? "done" :
          typeBucket === "in_progress" || typeBucket === "processing" ? "active" :
          undefined;
        const sourceObservationIds = Array.isArray(actionCandidate.sourceObservationIds)
          ? actionCandidate.sourceObservationIds.filter((id): id is string => typeof id === "string" && id.length > 0)
          : [];
        result = await sdk.trigger({
          function_id: "mem::action-create",
          payload: {
            title,
            description: content,
            id: dedupeKey ? fingerprintId("act", `todo:${dedupeKey}`) : undefined,
            priority,
            createdBy: "review",
            project: project || (typeof payload.project === "string" ? payload.project : undefined),
            tags: tags || (Array.isArray(payload.tags) ? payload.tags : sourceTags),
            sourceObservationIds,
            status: actionStatus,
            metadata: Object.keys(todoExtraction).length ? { todoExtraction } : undefined,
          },
        });
        const resultObj = result && typeof result === "object" ? result as Record<string, unknown> : {};
        const action = resultObj.action && typeof resultObj.action === "object" ? resultObj.action as Record<string, unknown> : null;
        if (!resultObj.success || !action?.id) {
          return {
            status_code: 502,
            body: {
              success: false,
              error: typeof resultObj.error === "string" ? resultObj.error : "action_create_failed",
              result,
            },
          };
        }
      } else if (approvedKind === "lesson") {
        result = await sdk.trigger({
          function_id: "mem::lesson-save",
          payload: {
            content,
            context: typeof payload.context === "string" ? payload.context : [item.page?.title, item.page?.url].filter(Boolean).join("\n"),
            confidence: typeof payload.confidence === "number" ? payload.confidence : 0.75,
            project: project || (typeof payload.project === "string" ? payload.project : "browser"),
            tags: tags || (Array.isArray(payload.tags) ? payload.tags : sourceTags),
            source: "manual",
          },
        });
      } else {
        const rawType = asNonEmptyString(body.type) || (typeof payload.type === "string" ? payload.type : "fact");
        const validTypes = new Set(["pattern", "preference", "architecture", "bug", "workflow", "fact"]);
        const concepts = Array.isArray(payload.concepts)
          ? Array.from(new Set([...payload.concepts.filter((c): c is string => typeof c === "string" && c.length > 0), ...sourceConcepts]))
          : sourceConcepts;
        result = await sdk.trigger({
          function_id: "mem::remember",
          payload: {
            content: title ? `${title}\n\n${content}` : content,
            type: validTypes.has(rawType) ? rawType : "fact",
            concepts,
            files: Array.isArray(payload.files) ? payload.files : [],
            project: project || (typeof payload.project === "string" ? payload.project : "browser"),
          },
        });
      }
      const resultObj = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const resultAction = resultObj.action && typeof resultObj.action === "object" ? resultObj.action as Record<string, unknown> : null;
      const resultMemory = resultObj.memory && typeof resultObj.memory === "object" ? resultObj.memory as Record<string, unknown> : null;
      const resultLesson = resultObj.lesson && typeof resultObj.lesson === "object" ? resultObj.lesson as Record<string, unknown> : null;
      item.status = "approved";
      item.kind = approvedKind;
      item.title = title;
      item.content = content;
      item.payload = {
        ...(item.payload || {}),
        ...(project ? { project } : {}),
        ...(tags ? { tags } : {}),
        ...(body.type ? { type: body.type } : {}),
        ...(sourceLabel ? { sourceLabel } : {}),
        ...(provider ? { provider } : {}),
        ...(pageType ? { pageType } : {}),
      };
      item.updatedAt = now;
      item.reviewedAt = now;
      item.resultId = String(resultAction?.id || resultMemory?.id || resultLesson?.id || "");
      await kv.set(KV.reviewQueue, item.id, item);
      return { status_code: 200, body: { success: true, item, result } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::review-approve",
    config: { api_path: "/agentmemory/review/approve", http_method: "POST" },
  });

  sdk.registerFunction("api::review-dismiss",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = asNonEmptyString(body.id);
      if (!id) return { status_code: 400, body: { error: "id is required" } };
      const item = await kv.get<ReviewQueueItem>(KV.reviewQueue, id);
      if (!item) return { status_code: 404, body: { error: "review item not found" } };
      const now = new Date().toISOString();
      item.status = "dismissed";
      item.updatedAt = now;
      item.reviewedAt = now;
      await kv.set(KV.reviewQueue, item.id, item);
      return { status_code: 200, body: { success: true, item } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::review-dismiss",
    config: { api_path: "/agentmemory/review/dismiss", http_method: "POST" },
  });

  sdk.registerFunction("api::forget", 
    async (
      req: ApiRequest<{
        sessionId?: string;
        observationIds?: string[];
        memoryId?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.sessionId && !req.body?.memoryId) {
        return {
          status_code: 400,
          body: { error: "sessionId or memoryId is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::forget", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::forget",
    config: { api_path: "/agentmemory/forget", http_method: "POST" },
  });

  sdk.registerFunction("api::consolidate", 
    async (
      req: ApiRequest<{ project?: string; minObservations?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::consolidate", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::consolidate",
    config: { api_path: "/agentmemory/consolidate", http_method: "POST" },
  });

  sdk.registerFunction("api::patterns", 
    async (req: ApiRequest<{ project?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::patterns", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::patterns",
    config: { api_path: "/agentmemory/patterns", http_method: "POST" },
  });

  sdk.registerFunction("api::generate-rules", 
    async (req: ApiRequest<{ project?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::generate-rules", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::generate-rules",
    config: { api_path: "/agentmemory/generate-rules", http_method: "POST" },
  });

  sdk.registerFunction("api::migrate",
    async (
      req: ApiRequest<{ dbPath?: string; step?: string; dryRun?: boolean }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const hasStep =
        typeof req.body?.step === "string" && req.body.step.trim().length > 0;
      const hasDbPath =
        typeof req.body?.dbPath === "string" && req.body.dbPath.trim().length > 0;
      if (!hasStep && !hasDbPath) {
        return {
          status_code: 400,
          body: { error: "Either step (string) or dbPath (string) is required" },
        };
      }
      const result = await sdk.trigger({
        function_id: "mem::migrate",
        payload: {
          ...(req.body.step !== undefined && { step: req.body.step }),
          ...(req.body.dbPath !== undefined && { dbPath: req.body.dbPath }),
          ...(req.body.dryRun !== undefined && { dryRun: req.body.dryRun }),
        },
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::migrate",
    config: { api_path: "/agentmemory/migrate", http_method: "POST" },
  });

  sdk.registerFunction("api::evict", 
    async (req: ApiRequest<{ dryRun?: boolean }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const dryRun =
        req.query_params?.["dryRun"] === "true" || req.body?.dryRun === true;
      const result = await sdk.trigger({ function_id: "mem::evict", payload: { dryRun } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::evict",
    config: { api_path: "/agentmemory/evict", http_method: "POST" },
  });

  sdk.registerFunction("api::smart-search", 
    async (
      req: ApiRequest<{ query?: string; expandIds?: string[]; limit?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !req.body?.query &&
        (!req.body?.expandIds || req.body.expandIds.length === 0)
      ) {
        return {
          status_code: 400,
          body: { error: "query or expandIds is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::smart-search", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::smart-search",
    config: { api_path: "/agentmemory/smart-search", http_method: "POST" },
  });

  sdk.registerFunction("api::timeline", 
    async (
      req: ApiRequest<{
        anchor: string;
        project?: string;
        before?: number;
        after?: number;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.anchor) {
        return { status_code: 400, body: { error: "anchor is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::timeline", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::timeline",
    config: { api_path: "/agentmemory/timeline", http_method: "POST" },
  });

  sdk.registerFunction("api::profile", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const project = req.query_params["project"] as string;
      if (!project) {
        return {
          status_code: 400,
          body: { error: "project query param is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::profile", payload: { project } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::profile",
    config: { api_path: "/agentmemory/profile", http_method: "GET" },
  });

  sdk.registerFunction("api::export",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      // mem::export already supports maxSessions/offset internally,
      // but the HTTP endpoint hardcoded an empty payload — so /export on a
      // real corpus (40 sessions × 34K observations × 8K memories) hit the
      // iii engine invocation timeout and `agentmemory-lab status` reported 0.
      // Pass through the query-string pagination so callers can chunk.
      const rawMax = req.query_params?.["maxSessions"];
      const rawOffset = req.query_params?.["offset"];
      const payload: { maxSessions?: number; offset?: number } = {};
      if (typeof rawMax === "string") {
        const n = Number(rawMax);
        if (Number.isInteger(n) && n > 0) payload.maxSessions = n;
      }
      if (typeof rawOffset === "string") {
        const n = Number(rawOffset);
        if (Number.isInteger(n) && n >= 0) payload.offset = n;
      }
      const result = await sdk.trigger({
        function_id: "mem::export",
        payload,
      });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::export",
    config: { api_path: "/agentmemory/export", http_method: "GET" },
  });

  sdk.registerFunction("api::import", 
    async (
      req: ApiRequest<{
        exportData: unknown;
        strategy?: "merge" | "replace" | "skip";
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.exportData) {
        return { status_code: 400, body: { error: "exportData is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::import", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::import",
    config: { api_path: "/agentmemory/import", http_method: "POST" },
  });

  sdk.registerFunction("api::relations", 
    async (
      req: ApiRequest<{ sourceId: string; targetId: string; type: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.sourceId || !req.body?.targetId || !req.body?.type) {
        return {
          status_code: 400,
          body: { error: "sourceId, targetId, and type are required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::relate", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::relations",
    config: { api_path: "/agentmemory/relations", http_method: "POST" },
  });

  sdk.registerFunction("api::evolve", 
    async (
      req: ApiRequest<{
        memoryId: string;
        newContent: string;
        newTitle?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.memoryId || !req.body?.newContent) {
        return {
          status_code: 400,
          body: { error: "memoryId and newContent are required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::evolve", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::evolve",
    config: { api_path: "/agentmemory/evolve", http_method: "POST" },
  });

  sdk.registerFunction("api::auto-forget", 
    async (req: ApiRequest<{ dryRun?: boolean }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const dryRun =
        req.query_params?.["dryRun"] === "true" || req.body?.dryRun === true;
      const result = await sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::auto-forget",
    config: { api_path: "/agentmemory/auto-forget", http_method: "POST" },
  });

  sdk.registerFunction("api::claude-bridge-read", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::claude-bridge-read", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return {
          status_code: 404,
          body: { error: "Claude bridge not enabled" },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::claude-bridge-read",
    config: { api_path: "/agentmemory/claude-bridge/read", http_method: "GET" },
  });

  sdk.registerFunction("api::claude-bridge-sync", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::claude-bridge-sync", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return {
          status_code: 404,
          body: { error: "Claude bridge not enabled" },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::claude-bridge-sync",
    config: {
      api_path: "/agentmemory/claude-bridge/sync",
      http_method: "POST",
    },
  });

  sdk.registerFunction("api::graph-query", 
    async (
      req: ApiRequest<{
        startNodeId?: string;
        nodeType?: string;
        maxDepth?: number;
        query?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::graph-query", payload: req.body || {} });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-query",
    config: { api_path: "/agentmemory/graph/query", http_method: "POST" },
  });

  sdk.registerFunction("api::graph-stats", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::graph-stats", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-stats",
    config: { api_path: "/agentmemory/graph/stats", http_method: "GET" },
  });

  sdk.registerFunction("api::graph-extract", 
    async (req: ApiRequest<{ observations: unknown[] }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (
        !Array.isArray(req.body?.observations) ||
        req.body.observations.length === 0
      ) {
        return {
          status_code: 400,
          body: { error: "observations array is required" },
        };
      }
      try {
        const result = await sdk.trigger({ function_id: "mem::graph-extract", payload: req.body });
        return { status_code: 200, body: result };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-extract",
    config: { api_path: "/agentmemory/graph/extract", http_method: "POST" },
  });

  // Backfill the knowledge graph from existing compressed observations.
  // Viewer calls this when the graph is empty (#666). Iterates every
  // session, collects observations that have a `title` (compressed only),
  // and feeds them through `mem::graph-extract` in batches.
  sdk.registerFunction("api::graph-build",
    async (req: ApiRequest<{ batchSize?: number }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const batchSize = Math.max(
        1,
        Math.min(100, Number((req.body as { batchSize?: number })?.batchSize) || 25),
      );
      try {
        const sessions = await kv.list<Session>(KV.sessions);
        let totalNodes = 0;
        let totalEdges = 0;
        let batchesRun = 0;
        for (const session of sessions) {
          const sid = session?.id;
          if (typeof sid !== "string" || sid.length === 0) continue;
          const observations = await kv.list<CompressedObservation>(KV.observations(sid));
          const compressed = observations.filter((o) => o && typeof o.title === "string" && o.title.length > 0);
          if (compressed.length === 0) continue;
          for (let i = 0; i < compressed.length; i += batchSize) {
            const batch = compressed.slice(i, i + batchSize);
            try {
              const result = (await sdk.trigger({
                function_id: "mem::graph-extract",
                payload: { observations: batch },
              })) as { success?: boolean; nodesAdded?: number; edgesAdded?: number };
              if (result?.success) {
                totalNodes += Number(result.nodesAdded) || 0;
                totalEdges += Number(result.edgesAdded) || 0;
              }
              batchesRun++;
            } catch (err) {
              logger.warn("graph-build batch failed", {
                sessionId: sid,
                batchIndex: Math.floor(i / batchSize),
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        return {
          status_code: 200,
          body: {
            success: true,
            sessions: sessions.length,
            batches: batchesRun,
            nodes: totalNodes,
            edges: totalEdges,
          },
        };
      } catch {
        return graphDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::graph-build",
    config: { api_path: "/agentmemory/graph/build", http_method: "POST" },
  });

  sdk.registerFunction("api::consolidate-pipeline",
    async (req: ApiRequest<{ tier?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::consolidate-pipeline", payload: req.body || {},
         });
        return { status_code: 200, body: result };
      } catch {
        return consolidationDisabledResponse();
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::consolidate-pipeline",
    config: {
      api_path: "/agentmemory/consolidate-pipeline",
      http_method: "POST",
    },
  });

  sdk.registerFunction("api::team-share", 
    async (
      req: ApiRequest<{ itemId: string; itemType: string; project?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.itemId || !req.body?.itemType) {
        return {
          status_code: 400,
          body: { error: "itemId and itemType are required" },
        };
      }
      try {
        const result = await sdk.trigger({ function_id: "mem::team-share", payload: req.body });
        return { status_code: 201, body: result };
      } catch {
        return { status_code: 404, body: { error: "Team memory not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::team-share",
    config: { api_path: "/agentmemory/team/share", http_method: "POST" },
  });

  sdk.registerFunction("api::team-feed", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
        const limit = parsedLimit ?? 20;
        const result = await sdk.trigger({ function_id: "mem::team-feed", payload: { limit } });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Team memory not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::team-feed",
    config: { api_path: "/agentmemory/team/feed", http_method: "GET" },
  });

  sdk.registerFunction("api::team-profile", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::team-profile", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Team memory not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::team-profile",
    config: { api_path: "/agentmemory/team/profile", http_method: "GET" },
  });

  sdk.registerFunction("api::audit",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
      const entries = await sdk.trigger({ function_id: "mem::audit-query", payload: {
        operation: req.query_params?.["operation"],
        limit: parsedLimit ?? 50,
      } });
      return { status_code: 200, body: { entries, success: true } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::audit",
    config: { api_path: "/agentmemory/audit", http_method: "GET" },
  });

  sdk.registerFunction("api::governance-delete", 
    async (
      req: ApiRequest<{ memoryIds: string[]; reason?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.memoryIds || !Array.isArray(req.body.memoryIds)) {
        return {
          status_code: 400,
          body: { error: "memoryIds array is required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::governance-delete", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::governance-delete",
    config: {
      api_path: "/agentmemory/governance/memories",
      http_method: "DELETE",
    },
  });

  sdk.registerFunction("api::governance-bulk", 
    async (
      req: ApiRequest<{
        type?: string[];
        dateFrom?: string;
        dateTo?: string;
        qualityBelow?: number;
        dryRun?: boolean;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::governance-bulk", payload: req.body || {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::governance-bulk",
    config: {
      api_path: "/agentmemory/governance/bulk-delete",
      http_method: "POST",
    },
  });

  sdk.registerFunction("api::snapshots", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::snapshot-list", payload: {} });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Snapshots not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::snapshots",
    config: { api_path: "/agentmemory/snapshots", http_method: "GET" },
  });

  sdk.registerFunction("api::snapshot-create", 
    async (req: ApiRequest<{ message?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::snapshot-create", payload: req.body || {},
         });
        return { status_code: 201, body: result };
      } catch {
        return { status_code: 404, body: { error: "Snapshots not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::snapshot-create",
    config: { api_path: "/agentmemory/snapshot/create", http_method: "POST" },
  });

  sdk.registerFunction("api::snapshot-restore", 
    async (req: ApiRequest<{ commitHash: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.commitHash) {
        return { status_code: 400, body: { error: "commitHash is required" } };
      }
      try {
        const result = await sdk.trigger({ function_id: "mem::snapshot-restore", payload: req.body });
        return { status_code: 200, body: result };
      } catch {
        return { status_code: 404, body: { error: "Snapshots not enabled" } };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::snapshot-restore",
    config: { api_path: "/agentmemory/snapshot/restore", http_method: "POST" },
  });

  sdk.registerFunction("api::memories",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const memories = await kv.list<import("../types.js").Memory>(KV.memories);
      const latest = req.query_params?.["latest"] === "true";
      // agentId filter. Request param wins, env AGENT_ID (when
      // scope=isolated) is the fallback. Shared mode keeps the tag but
      // does not restrict the list endpoint. Pass agentId=* to opt out
      // of the env scope entirely. includeOrphans=true surfaces
      // pre-AGENT_ID memories whose agentId is undefined.
      const normalizedAgentId =
        typeof req.query_params?.["agentId"] === "string"
          ? req.query_params["agentId"].trim()
          : undefined;
      const wildcardAgent = normalizedAgentId === "*";
      const explicitAgentId =
        normalizedAgentId && !wildcardAgent ? normalizedAgentId : undefined;
      const includeOrphans =
        req.query_params?.["includeOrphans"] === "true";
      const filterAgentId = wildcardAgent
        ? undefined
        : explicitAgentId ?? (isAgentScopeIsolated() ? getAgentId() : undefined);
      let filtered = latest ? memories.filter((m) => m.isLatest) : memories;
      if (filterAgentId) {
        filtered = filtered.filter(
          (m) =>
            m.agentId === filterAgentId ||
            (includeOrphans && m.agentId === undefined),
        );
      }

      // viewer + `agentmemory-lab status` were hitting this endpoint to
      // count memories. On a real corpus (8K+ memories) the unbounded
      // response either timed out at the iii engine boundary ("Invocation
      // stopped") or arrived too large for the viewer to render — so the
      // UI showed 0 memories despite a healthy store. Two opt-in modes:
      //   ?count=true       — totals only, no payload
      //   ?limit=N&offset=M — page slice (default unlimited for back-compat)
      if (req.query_params?.["count"] === "true") {
        // Match the SAME scope that the list path applies — returning
        // unfiltered totals here would leak cross-agent counts to a
        // caller that's blocked from the underlying rows.
        return {
          status_code: 200,
          body: {
            total: filtered.length,
            latestCount: filtered.filter((m) => m.isLatest).length,
          },
        };
      }

      const rawLimit = req.query_params?.["limit"];
      const rawOffset = req.query_params?.["offset"];
      const parsedLimit =
        typeof rawLimit === "string" ? Number(rawLimit) : Number.NaN;
      const parsedOffset =
        typeof rawOffset === "string" ? Number(rawOffset) : Number.NaN;
      const limit =
        Number.isInteger(parsedLimit) && parsedLimit > 0
          ? Math.min(parsedLimit, 5000)
          : undefined;
      const offset =
        Number.isInteger(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
      const sliced =
        limit !== undefined ? filtered.slice(offset, offset + limit) : filtered;

      return {
        status_code: 200,
        body: {
          memories: sliced,
          total: filtered.length,
          offset,
          limit: limit ?? null,
        },
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memories",
    config: { api_path: "/agentmemory/memories", http_method: "GET" },
  });

  sdk.registerFunction("api::memory-by-id",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const id = req.path_params?.["id"];
      if (!id || typeof id !== "string") {
        return { status_code: 400, body: { error: "id path parameter is required" } };
      }
      const memory = await kv.get<import("../types.js").Memory>(KV.memories, id);
      if (!memory) {
        return { status_code: 404, body: { error: `memory not found: ${id}` } };
      }
      return { status_code: 200, body: { memory } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::memory-by-id",
    config: { api_path: "/agentmemory/memories/:id", http_method: "GET" },
  });

  sdk.registerFunction("api::semantic-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const semantic = await kv.list<import("../types.js").SemanticMemory>(KV.semantic);
      return { status_code: 200, body: { semantic } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::semantic-list",
    config: { api_path: "/agentmemory/semantic", http_method: "GET" },
  });

  sdk.registerFunction("api::procedural-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const procedural = await kv.list<import("../types.js").ProceduralMemory>(KV.procedural);
      return { status_code: 200, body: { procedural } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::procedural-list",
    config: { api_path: "/agentmemory/procedural", http_method: "GET" },
  });

  sdk.registerFunction("api::relations-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const relations = await kv.list<import("../types.js").MemoryRelation>(KV.relations);
      return { status_code: 200, body: { relations } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::relations-list",
    config: { api_path: "/agentmemory/relations", http_method: "GET" },
  });

  sdk.registerFunction("api::vision-search",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const queryText = asNonEmptyString(body["queryText"]);
      const queryImageRef = asNonEmptyString(body["queryImageRef"]);
      const queryImageBase64 = asNonEmptyString(body["queryImageBase64"]);
      const sessionId = asNonEmptyString(body["sessionId"]);
      if (!queryText && !queryImageRef && !queryImageBase64) {
        return {
          status_code: 400,
          body: { error: "queryText, queryImageRef, or queryImageBase64 required" },
        };
      }
      const topKParsed = parseOptionalPositiveInt(body["topK"]);
      if (topKParsed === null) {
        return { status_code: 400, body: { error: "topK must be a positive integer" } };
      }
      const payload: Record<string, unknown> = {};
      if (queryText) payload["queryText"] = queryText;
      if (queryImageRef) payload["queryImageRef"] = queryImageRef;
      if (queryImageBase64) payload["queryImageBase64"] = queryImageBase64;
      if (sessionId) payload["sessionId"] = sessionId;
      if (topKParsed !== undefined) payload["topK"] = Math.min(50, topKParsed);
      const result = await sdk.trigger({ function_id: "mem::vision-search", payload });
      const resp = result as { success?: boolean; error?: string };
      if (resp?.success === false) {
        return { status_code: resp.error?.includes("disabled") ? 503 : 400, body: resp };
      }
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::vision-search",
    config: { api_path: "/agentmemory/vision-search", http_method: "POST" },
  });

  sdk.registerFunction("api::vision-embed",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const imageRef = asNonEmptyString(body["imageRef"]);
      const sessionId = asNonEmptyString(body["sessionId"]);
      const observationId = asNonEmptyString(body["observationId"]);
      if (!imageRef) {
        return { status_code: 400, body: { error: "imageRef is required" } };
      }
      const payload: Record<string, unknown> = { imageRef };
      if (sessionId) payload["sessionId"] = sessionId;
      if (observationId) payload["observationId"] = observationId;
      const result = await sdk.trigger({ function_id: "mem::vision-embed", payload });
      const resp = result as { success?: boolean; error?: string };
      if (resp?.success === false) {
        return { status_code: resp.error?.includes("disabled") ? 503 : 400, body: resp };
      }
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::vision-embed",
    config: { api_path: "/agentmemory/vision-embed", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-list", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const result = await sdk.trigger({ function_id: "mem::slot-list", payload: {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-list",
    config: { api_path: "/agentmemory/slots", http_method: "GET" },
  });

  sdk.registerFunction("api::slot-get", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const label = asNonEmptyString(req.query_params?.["label"]);
    if (!label) return { status_code: 400, body: { error: "label query param required" } };
    const result = await sdk.trigger({ function_id: "mem::slot-get", payload: { label } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      return { status_code: resp.error?.includes("not found") ? 404 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-get",
    config: { api_path: "/agentmemory/slot", http_method: "GET" },
  });

  sdk.registerFunction("api::slot-create", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = asNonEmptyString(body["label"]);
    if (!label) return { status_code: 400, body: { error: "label required" } };
    // Reject malformed inputs instead of silently dropping them.
    if (body["content"] !== undefined && typeof body["content"] !== "string") {
      return { status_code: 400, body: { error: "content must be a string" } };
    }
    if (body["description"] !== undefined && typeof body["description"] !== "string") {
      return { status_code: 400, body: { error: "description must be a string" } };
    }
    if (body["pinned"] !== undefined && typeof body["pinned"] !== "boolean") {
      return { status_code: 400, body: { error: "pinned must be a boolean" } };
    }
    if (
      body["scope"] !== undefined &&
      body["scope"] !== "project" &&
      body["scope"] !== "global"
    ) {
      return { status_code: 400, body: { error: "scope must be 'project' or 'global'" } };
    }
    const sizeLimit = parseOptionalPositiveInt(body["sizeLimit"]);
    if (sizeLimit === null) {
      return { status_code: 400, body: { error: "sizeLimit must be a positive integer" } };
    }
    if (sizeLimit !== undefined && sizeLimit > 20000) {
      return { status_code: 400, body: { error: "sizeLimit must be <= 20000" } };
    }
    const payload: Record<string, unknown> = { label };
    if (typeof body["content"] === "string") payload["content"] = body["content"];
    if (typeof body["description"] === "string") payload["description"] = body["description"];
    if (sizeLimit !== undefined) payload["sizeLimit"] = sizeLimit;
    if (typeof body["pinned"] === "boolean") payload["pinned"] = body["pinned"];
    if (body["scope"] === "project" || body["scope"] === "global") payload["scope"] = body["scope"];
    const result = await sdk.trigger({ function_id: "mem::slot-create", payload });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      return { status_code: resp.error?.includes("exists") ? 409 : 400, body: resp };
    }
    return { status_code: 201, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-create",
    config: { api_path: "/agentmemory/slot", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-append", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = asNonEmptyString(body["label"]);
    const text = typeof body["text"] === "string" ? body["text"] : null;
    if (!label || !text) return { status_code: 400, body: { error: "label and text required" } };
    const result = await sdk.trigger({ function_id: "mem::slot-append", payload: { label, text } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      const notFound = resp.error?.includes("not found");
      const overLimit = resp.error?.includes("exceed");
      return { status_code: notFound ? 404 : overLimit ? 413 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-append",
    config: { api_path: "/agentmemory/slot/append", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-replace", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const label = asNonEmptyString(body["label"]);
    const content = body["content"];
    if (!label || typeof content !== "string") {
      return { status_code: 400, body: { error: "label and content (string) required" } };
    }
    const result = await sdk.trigger({ function_id: "mem::slot-replace", payload: { label, content } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      const notFound = resp.error?.includes("not found");
      const overLimit = resp.error?.includes("exceed");
      return { status_code: notFound ? 404 : overLimit ? 413 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-replace",
    config: { api_path: "/agentmemory/slot/replace", http_method: "POST" },
  });

  sdk.registerFunction("api::slot-delete", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    const label = asNonEmptyString(req.query_params?.["label"]);
    if (!label) return { status_code: 400, body: { error: "label query param required" } };
    const result = await sdk.trigger({ function_id: "mem::slot-delete", payload: { label } });
    const resp = result as { success?: boolean; error?: string };
    if (resp?.success === false) {
      return { status_code: resp.error?.includes("not found") ? 404 : 400, body: resp };
    }
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-delete",
    config: { api_path: "/agentmemory/slot", http_method: "DELETE" },
  });

  sdk.registerFunction("api::slot-reflect", async (req: ApiRequest): Promise<Response> => {
    const authErr = checkAuth(req, secret);
    if (authErr) return authErr;
    if (!isSlotsEnabled()) return slotsDisabledResponse();
    if (!isReflectEnabled()) return reflectDisabledResponse();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sessionId = asNonEmptyString(body["sessionId"]);
    if (!sessionId) return { status_code: 400, body: { error: "sessionId required" } };
    const maxObservations = parseOptionalPositiveInt(body["maxObservations"]);
    if (maxObservations === null) return { status_code: 400, body: { error: "maxObservations must be a positive integer" } };
    const payload: Record<string, unknown> = { sessionId };
    if (maxObservations !== undefined) payload["maxObservations"] = maxObservations;
    const result = await sdk.trigger({ function_id: "mem::slot-reflect", payload });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({
    type: "http",
    function_id: "api::slot-reflect",
    config: { api_path: "/agentmemory/slot/reflect", http_method: "POST" },
  });

  sdk.registerFunction("api::action-create",
    async (
      req: ApiRequest<{
        title: string;
        description?: string;
        priority?: number;
        createdBy?: string;
        project?: string;
        tags?: string[];
        parentId?: string;
        edges?: Array<{ type: string; targetActionId: string }>;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.title) {
        return { status_code: 400, body: { error: "title is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-create",
    config: { api_path: "/agentmemory/actions", http_method: "POST" },
  });

  sdk.registerFunction("api::action-update", 
    async (
      req: ApiRequest<{
        actionId: string;
        status?: string;
        title?: string;
        description?: string;
        priority?: number;
        result?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId) {
        return { status_code: 400, body: { error: "actionId is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-update", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-update",
    config: { api_path: "/agentmemory/actions/update", http_method: "POST" },
  });

  sdk.registerFunction("api::action-list", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::action-list", payload: {
        status: req.query_params?.["status"],
        project: req.query_params?.["project"],
        parentId: req.query_params?.["parentId"],
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-list",
    config: { api_path: "/agentmemory/actions", http_method: "GET" },
  });

  sdk.registerFunction("api::action-get", 
    async (req: ApiRequest<{ actionId: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const actionId = req.query_params?.["actionId"] as string;
      if (!actionId) {
        return { status_code: 400, body: { error: "actionId required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-get", payload: { actionId } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-get",
    config: { api_path: "/agentmemory/actions/get", http_method: "GET" },
  });

  sdk.registerFunction("api::action-edge", 
    async (
      req: ApiRequest<{
        sourceActionId: string;
        targetActionId: string;
        type: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.sourceActionId || !req.body?.targetActionId || !req.body?.type) {
        return { status_code: 400, body: { error: "sourceActionId, targetActionId, and type are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::action-edge-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::action-edge",
    config: { api_path: "/agentmemory/actions/edges", http_method: "POST" },
  });

  sdk.registerFunction("api::frontier", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
      const result = await sdk.trigger({ function_id: "mem::frontier", payload: {
        project: req.query_params?.["project"],
        agentId: req.query_params?.["agentId"],
        limit: parsedLimit,
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::frontier",
    config: { api_path: "/agentmemory/frontier", http_method: "GET" },
  });

  sdk.registerFunction("api::next", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::next", payload: {
        project: req.query_params?.["project"],
        agentId: req.query_params?.["agentId"],
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::next",
    config: { api_path: "/agentmemory/next", http_method: "GET" },
  });

  sdk.registerFunction("api::lease-acquire", 
    async (
      req: ApiRequest<{ actionId: string; agentId: string; ttlMs?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId || !req.body?.agentId) {
        return { status_code: 400, body: { error: "actionId and agentId are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::lease-acquire", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lease-acquire",
    config: { api_path: "/agentmemory/leases/acquire", http_method: "POST" },
  });

  sdk.registerFunction("api::lease-release", 
    async (
      req: ApiRequest<{ actionId: string; agentId: string; result?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId || !req.body?.agentId) {
        return { status_code: 400, body: { error: "actionId and agentId are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::lease-release", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lease-release",
    config: { api_path: "/agentmemory/leases/release", http_method: "POST" },
  });

  sdk.registerFunction("api::lease-renew", 
    async (
      req: ApiRequest<{ actionId: string; agentId: string; ttlMs?: number }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.actionId || !req.body?.agentId) {
        return { status_code: 400, body: { error: "actionId and agentId are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::lease-renew", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::lease-renew",
    config: { api_path: "/agentmemory/leases/renew", http_method: "POST" },
  });

  sdk.registerFunction("api::routine-create",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.name || !req.body?.steps) {
        return {
          status_code: 400,
          body: { error: "name and steps are required" },
        };
      }
      const result = await sdk.trigger({ function_id: "mem::routine-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-create",
    config: { api_path: "/agentmemory/routines", http_method: "POST" },
  });

  sdk.registerFunction("api::routine-list", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::routine-list", payload: {
        frozen: req.query_params?.["frozen"] === "true" ? true : undefined,
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-list",
    config: { api_path: "/agentmemory/routines", http_method: "GET" },
  });

  sdk.registerFunction("api::routine-run", 
    async (
      req: ApiRequest<{ routineId: string; project?: string; initiatedBy?: string }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.routineId) {
        return { status_code: 400, body: { error: "routineId is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::routine-run", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-run",
    config: { api_path: "/agentmemory/routines/run", http_method: "POST" },
  });

  sdk.registerFunction("api::routine-status", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const runId = req.query_params?.["runId"] as string;
      if (!runId) {
        return { status_code: 400, body: { error: "runId query param required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::routine-status", payload: { runId } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::routine-status",
    config: { api_path: "/agentmemory/routines/status", http_method: "GET" },
  });

  sdk.registerFunction("api::signal-send", 
    async (
      req: ApiRequest<{
        from: string;
        to?: string;
        content: string;
        type?: string;
        replyTo?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.from || !req.body?.content) {
        return { status_code: 400, body: { error: "from and content are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::signal-send", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::signal-send",
    config: { api_path: "/agentmemory/signals/send", http_method: "POST" },
  });

  sdk.registerFunction("api::signal-read", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const agentId = req.query_params?.["agentId"] as string;
      if (!agentId) {
        return { status_code: 400, body: { error: "agentId query param required" } };
      }
      const parsedLimit = parseOptionalInt(req.query_params?.["limit"]);
      const result = await sdk.trigger({ function_id: "mem::signal-read", payload: {
        agentId,
        unreadOnly: req.query_params?.["unreadOnly"] === "true",
        threadId: req.query_params?.["threadId"],
        limit: parsedLimit,
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::signal-read",
    config: { api_path: "/agentmemory/signals", http_method: "GET" },
  });

  // Line C: Agent→user async inbox (no agentId; single-user).
  // Whitelist InboxItem-shaped fields; never forward the raw request body.
  function inboxWriteFields(body: Record<string, unknown> | undefined) {
    const b = body || {};
    return {
      body: b["body"],
      fromAgent: b["fromAgent"],
      project: b["project"],
      priority: b["priority"],
      sourceObservationIds: b["sourceObservationIds"],
      sourceSessionId: b["sourceSessionId"],
      expiresInMs: b["expiresInMs"],
    };
  }
  sdk.registerFunction("api::inbox-ask",
    async (req: ApiRequest<{ body: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const fields = inboxWriteFields(req.body as Record<string, unknown>);
      if (typeof fields.body !== "string" || !fields.body.trim()) {
        return { status_code: 400, body: { error: "body is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::inbox-ask", payload: fields });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::inbox-ask",
    config: { api_path: "/agentmemory/inbox/ask", http_method: "POST" },
  });

  sdk.registerFunction("api::inbox-notify",
    async (req: ApiRequest<{ body: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const fields = inboxWriteFields(req.body as Record<string, unknown>);
      if (typeof fields.body !== "string" || !fields.body.trim()) {
        return { status_code: 400, body: { error: "body is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::inbox-notify", payload: fields });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::inbox-notify",
    config: { api_path: "/agentmemory/inbox/notify", http_method: "POST" },
  });

  sdk.registerFunction("api::inbox-list",
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger<unknown, { success: boolean; items?: InboxItem[] }>({ function_id: "mem::inbox-list", payload: {
        status: req.query_params?.["status"],
        kind: req.query_params?.["kind"],
        limit: parseOptionalInt(req.query_params?.["limit"]),
      } });
      // Join the delivery ledger (mem:delivery) onto each item as a read-only
      // `delivery` field so the viewer can show push status. The inbox item's
      // persisted shape is untouched — this lives only in the API response.
      const items = result.items ?? [];
      const joined = await Promise.all(items.map(async (item) => {
        const rec = await kv.get<DeliveryRecord>(KV.delivery, item.id).catch(() => null);
        if (!rec) return item;
        return {
          ...item,
          delivery: {
            channel: rec.channel,
            status: rec.status,
            messageId: rec.messageId,
            urgent: rec.urgent,
            error: rec.error,
            attempts: rec.attempts,
            deliveredAt: rec.deliveredAt,
          },
        };
      }));
      return { status_code: 200, body: { ...result, items: joined } };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::inbox-list",
    config: { api_path: "/agentmemory/inbox", http_method: "GET" },
  });

  sdk.registerFunction("api::inbox-answer",
    async (req: ApiRequest<{ id: string; answer?: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const b = (req.body || {}) as Record<string, unknown>;
      if (typeof b["id"] !== "string" || !b["id"]) {
        return { status_code: 400, body: { error: "id is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::inbox-answer", payload: { id: b["id"], answer: b["answer"] } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::inbox-answer",
    config: { api_path: "/agentmemory/inbox/answer", http_method: "POST" },
  });

  sdk.registerFunction("api::inbox-dismiss",
    async (req: ApiRequest<{ id: string }>): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const b = (req.body || {}) as Record<string, unknown>;
      if (typeof b["id"] !== "string" || !b["id"]) {
        return { status_code: 400, body: { error: "id is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::inbox-dismiss", payload: { id: b["id"] } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::inbox-dismiss",
    config: { api_path: "/agentmemory/inbox/dismiss", http_method: "POST" },
  });

  sdk.registerFunction("api::checkpoint-create", 
    async (
      req: ApiRequest<{
        name: string;
        description?: string;
        type?: string;
        linkedActionIds?: string[];
        expiresInMs?: number;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.name) {
        return { status_code: 400, body: { error: "name is required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::checkpoint-create", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::checkpoint-create",
    config: { api_path: "/agentmemory/checkpoints", http_method: "POST" },
  });

  sdk.registerFunction("api::checkpoint-resolve", 
    async (
      req: ApiRequest<{
        checkpointId: string;
        status: string;
        resolvedBy?: string;
        result?: unknown;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.checkpointId || !req.body?.status) {
        return { status_code: 400, body: { error: "checkpointId and status are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::checkpoint-resolve", payload: req.body });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::checkpoint-resolve",
    config: { api_path: "/agentmemory/checkpoints/resolve", http_method: "POST" },
  });

  sdk.registerFunction("api::checkpoint-list", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::checkpoint-list", payload: {
        status: req.query_params?.["status"],
        type: req.query_params?.["type"],
      } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::checkpoint-list",
    config: { api_path: "/agentmemory/checkpoints", http_method: "GET" },
  });

  sdk.registerFunction("api::mesh-register", 
    async (
      req: ApiRequest<{ url: string; name: string; sharedScopes?: string[] }>,
    ): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      if (!req.body?.url || !req.body?.name) {
        return { status_code: 400, body: { error: "url and name are required" } };
      }
      const result = await sdk.trigger({ function_id: "mem::mesh-register", payload: req.body });
      return { status_code: 201, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-register",
    config: { api_path: "/agentmemory/mesh/peers", http_method: "POST" },
  });

  sdk.registerFunction("api::mesh-list", 
    async (req: ApiRequest): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::mesh-list", payload: {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-list",
    config: { api_path: "/agentmemory/mesh/peers", http_method: "GET" },
  });

  sdk.registerFunction("api::mesh-sync", 
    async (
      req: ApiRequest<{ peerId?: string; direction?: string }>,
    ): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::mesh-sync", payload: req.body || {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-sync",
    config: { api_path: "/agentmemory/mesh/sync", http_method: "POST" },
  });

  sdk.registerFunction("api::mesh-receive", 
    async (req: ApiRequest): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const result = await sdk.trigger({ function_id: "mem::mesh-receive", payload: req.body || {} });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-receive",
    config: { api_path: "/agentmemory/mesh/receive", http_method: "POST" },
  });

  sdk.registerFunction("api::mesh-export", 
    async (req: ApiRequest): Promise<Response> => {
      const secretErr = requireConfiguredSecret(secret, "mesh");
      if (secretErr) return secretErr;
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const since = req.query_params?.["since"] as string;
      if (since) {
        const parsed = new Date(since).getTime();
        if (Number.isNaN(parsed)) {
          return { status_code: 400, body: { error: "Invalid 'since' date format" } };
        }
      }
      const project = req.query_params?.["project"] as string | undefined;
      const sinceTime = since ? new Date(since).getTime() : 0;
      const df = <T>(items: T[], field: "updatedAt" | "createdAt") =>
        items.filter((i) => new Date((i as Record<string, unknown>)[field] as string).getTime() > sinceTime);
      const memories = await kv.list<import("../types.js").Memory>(KV.memories);
      let actions = await kv.list<import("../types.js").Action>(KV.actions);
      if (project) {
        actions = actions.filter((a) => a.project === project);
      }
      const body: Record<string, unknown> = {
        memories: df(memories, "updatedAt"),
        actions: df(actions, "updatedAt"),
      };
      if (!project) {
        const semantic = await kv.list<import("../types.js").SemanticMemory>(KV.semantic);
        const procedural = await kv.list<import("../types.js").ProceduralMemory>(KV.procedural);
        const relations = await kv.list<import("../types.js").MemoryRelation>(KV.relations);
        const graphNodes = await kv.list<import("../types.js").GraphNode>(KV.graphNodes);
        const graphEdges = await kv.list<import("../types.js").GraphEdge>(KV.graphEdges);
        body.semantic = df(semantic, "updatedAt");
        body.procedural = df(procedural, "updatedAt");
        body.relations = df(relations, "createdAt");
        body.graphNodes = graphNodes.filter(
          (n) => new Date(n.updatedAt || n.createdAt).getTime() > sinceTime,
        );
        body.graphEdges = df(graphEdges, "createdAt");
      }
      return { status_code: 200, body };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::mesh-export",
    config: { api_path: "/agentmemory/mesh/export", http_method: "GET" },
  });

  sdk.registerFunction("api::flow-compress", 
    async (
      req: ApiRequest<{
        runId?: string;
        actionIds?: string[];
        project?: string;
      }>,
    ): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      try {
        const result = await sdk.trigger({ function_id: "mem::flow-compress", payload: req.body || {} });
        return { status_code: 200, body: result };
      } catch {
        return {
          status_code: 404,
          body: { error: "Flow compression requires a provider" },
        };
      }
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::flow-compress",
    config: { api_path: "/agentmemory/flow/compress", http_method: "POST" },
  });

  sdk.registerFunction("api::branch-detect", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const cwd = (req.query_params?.["cwd"] as string) || process.cwd();
      const result = await sdk.trigger({ function_id: "mem::detect-worktree", payload: { cwd } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::branch-detect",
    config: { api_path: "/agentmemory/branch/detect", http_method: "GET" },
  });

  sdk.registerFunction("api::branch-worktrees", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const cwd = (req.query_params?.["cwd"] as string) || process.cwd();
      const result = await sdk.trigger({ function_id: "mem::list-worktrees", payload: { cwd } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::branch-worktrees",
    config: { api_path: "/agentmemory/branch/worktrees", http_method: "GET" },
  });

  sdk.registerFunction("api::branch-sessions", 
    async (req: ApiRequest): Promise<Response> => {
      const authErr = checkAuth(req, secret);
      if (authErr) return authErr;
      const cwd = (req.query_params?.["cwd"] as string) || process.cwd();
      const result = await sdk.trigger({ function_id: "mem::branch-sessions", payload: { cwd } });
      return { status_code: 200, body: result };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::branch-sessions",
    config: { api_path: "/agentmemory/branch/sessions", http_method: "GET" },
  });

  sdk.registerFunction("api::viewer", 
    async (req: ApiRequest): Promise<Response> => {
      const denied = checkAuth(req, secret);
      if (denied) return denied;
      const rendered = renderViewerDocument();
      if (rendered.found) {
        return {
          status_code: 200,
          headers: {
            "Content-Type": "text/html",
            "Content-Security-Policy": rendered.csp,
          },
          body: rendered.html,
        };
      }
      return {
        status_code: 404,
        headers: {
          "Content-Type": "text/html",
        },
        body: "<!DOCTYPE html><html><body><h1>agentmemory</h1><p>viewer not found</p></body></html>",
      };
    },
  );
  sdk.registerTrigger({
    type: "http",
    function_id: "api::viewer",
    config: { api_path: "/agentmemory/viewer", http_method: "GET" },
  });

  sdk.registerFunction("api::sentinel-create",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.name) return { status_code: 400, body: { error: "name is required" } };
    const result = await sdk.trigger({ function_id: "mem::sentinel-create", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-create", config: { api_path: "/agentmemory/sentinels", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-trigger",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sentinelId) return { status_code: 400, body: { error: "sentinelId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sentinel-trigger", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-trigger", config: { api_path: "/agentmemory/sentinels/trigger", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-check",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const result = await sdk.trigger({ function_id: "mem::sentinel-check", payload: {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-check", config: { api_path: "/agentmemory/sentinels/check", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-cancel",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sentinelId) return { status_code: 400, body: { error: "sentinelId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sentinel-cancel", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-cancel", config: { api_path: "/agentmemory/sentinels/cancel", http_method: "POST" } });

  sdk.registerFunction("api::sentinel-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const result = await sdk.trigger({ function_id: "mem::sentinel-list", payload: { status: params.status, type: params.type } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sentinel-list", config: { api_path: "/agentmemory/sentinels", http_method: "GET" } });

  sdk.registerFunction("api::sketch-create",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.title) return { status_code: 400, body: { error: "title is required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-create", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-create", config: { api_path: "/agentmemory/sketches", http_method: "POST" } });

  sdk.registerFunction("api::sketch-add",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sketchId || !body?.title) return { status_code: 400, body: { error: "sketchId and title are required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-add", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-add", config: { api_path: "/agentmemory/sketches/add", http_method: "POST" } });

  sdk.registerFunction("api::sketch-promote",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sketchId) return { status_code: 400, body: { error: "sketchId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-promote", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-promote", config: { api_path: "/agentmemory/sketches/promote", http_method: "POST" } });

  sdk.registerFunction("api::sketch-discard",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.sketchId) return { status_code: 400, body: { error: "sketchId is required" } };
    const result = await sdk.trigger({ function_id: "mem::sketch-discard", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-discard", config: { api_path: "/agentmemory/sketches/discard", http_method: "POST" } });

  sdk.registerFunction("api::sketch-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const result = await sdk.trigger({ function_id: "mem::sketch-list", payload: { status: params.status, project: params.project } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-list", config: { api_path: "/agentmemory/sketches", http_method: "GET" } });

  sdk.registerFunction("api::sketch-gc",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const result = await sdk.trigger({ function_id: "mem::sketch-gc", payload: {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::sketch-gc", config: { api_path: "/agentmemory/sketches/gc", http_method: "POST" } });

  sdk.registerFunction("api::crystallize",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.actionIds) return { status_code: 400, body: { error: "actionIds is required" } };
    const result = await sdk.trigger({ function_id: "mem::crystallize", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::crystallize", config: { api_path: "/agentmemory/crystals/create", http_method: "POST" } });

  sdk.registerFunction("api::crystal-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const limit = parseOptionalPositiveInt(params.limit);
    if (limit === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: limit" },
      };
    }
    const result = await sdk.trigger({ function_id: "mem::crystal-list", payload: { project: params.project, sessionId: params.sessionId, limit } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::crystal-list", config: { api_path: "/agentmemory/crystals", http_method: "GET" } });

  sdk.registerFunction("api::auto-crystallize",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::auto-crystallize", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::auto-crystallize", config: { api_path: "/agentmemory/crystals/auto", http_method: "POST" } });

  sdk.registerFunction("api::diagnose",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::diagnose", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::diagnose", config: { api_path: "/agentmemory/diagnostics", http_method: "POST" } });

  sdk.registerFunction("api::heal",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::heal", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::heal", config: { api_path: "/agentmemory/diagnostics/heal", http_method: "POST" } });

  sdk.registerFunction("api::facet-tag",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.targetId || !body?.dimension || !body?.value) return { status_code: 400, body: { error: "targetId, dimension, and value are required" } };
    const result = await sdk.trigger({ function_id: "mem::facet-tag", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-tag", config: { api_path: "/agentmemory/facets", http_method: "POST" } });

  sdk.registerFunction("api::facet-untag",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.targetId || !body?.dimension) return { status_code: 400, body: { error: "targetId and dimension are required" } };
    const result = await sdk.trigger({ function_id: "mem::facet-untag", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-untag", config: { api_path: "/agentmemory/facets/remove", http_method: "POST" } });

  sdk.registerFunction("api::facet-query",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    const result = await sdk.trigger({ function_id: "mem::facet-query", payload: body || {} });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-query", config: { api_path: "/agentmemory/facets/query", http_method: "POST" } });

  sdk.registerFunction("api::facet-get",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    if (!params.targetId) return { status_code: 400, body: { error: "targetId query param is required" } };
    const result = await sdk.trigger({ function_id: "mem::facet-get", payload: { targetId: params.targetId } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-get", config: { api_path: "/agentmemory/facets", http_method: "GET" } });

  sdk.registerFunction("api::facet-stats",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const result = await sdk.trigger({ function_id: "mem::facet-stats", payload: { targetType: params.targetType } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::facet-stats", config: { api_path: "/agentmemory/facets/stats", http_method: "GET" } });

  sdk.registerFunction("api::verify",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.id || typeof body.id !== "string") return { status_code: 400, body: { error: "id is required" } };
    const result = await sdk.trigger({ function_id: "mem::verify", payload: { id: body.id } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::verify", config: { api_path: "/agentmemory/verify", http_method: "POST" } });

  sdk.registerFunction("api::cascade-update",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.supersededMemoryId || typeof body.supersededMemoryId !== "string") {
      return { status_code: 400, body: { error: "supersededMemoryId is required" } };
    }
    const result = await sdk.trigger({ function_id: "mem::cascade-update", payload: { supersededMemoryId: body.supersededMemoryId } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::cascade-update", config: { api_path: "/agentmemory/cascade-update", http_method: "POST" } });

  sdk.registerFunction("api::lesson-save",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.content || typeof body.content !== "string") return { status_code: 400, body: { error: "content is required" } };
    const tags = typeof body.tags === "string" ? (body.tags as string).split(",").map((t: string) => t.trim()).filter(Boolean) : Array.isArray(body.tags) ? body.tags : [];
    const result = (await sdk.trigger({
      function_id: "mem::lesson-save",
      payload: {
        content: body.content,
        context: body.context || "",
        confidence: typeof body.confidence === "number" ? body.confidence : undefined,
        project: typeof body.project === "string" ? body.project : undefined,
        tags,
        source: "manual",
      },
    })) as { action?: string };
    const statusCode = result?.action === "created" ? 201 : 200;
    return { status_code: statusCode, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-save", config: { api_path: "/agentmemory/lessons", http_method: "POST" } });

  sdk.registerFunction("api::lesson-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const minConfidence = parseOptionalFiniteNumber(params.minConfidence);
    if (minConfidence === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: minConfidence" },
      };
    }
    const limit = parseOptionalPositiveInt(params.limit);
    if (limit === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: limit" },
      };
    }
    const result = await sdk.trigger({ function_id: "mem::lesson-list", payload: {
      project: params.project,
      source: params.source,
      minConfidence,
      limit,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-list", config: { api_path: "/agentmemory/lessons", http_method: "GET" } });

  sdk.registerFunction("api::lesson-search",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.query || typeof body.query !== "string") return { status_code: 400, body: { error: "query is required" } };
    const result = await sdk.trigger({ function_id: "mem::lesson-recall", payload: body });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-search", config: { api_path: "/agentmemory/lessons/search", http_method: "POST" } });

  sdk.registerFunction("api::lesson-strengthen",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.lessonId || typeof body.lessonId !== "string") return { status_code: 400, body: { error: "lessonId is required" } };
    const result = await sdk.trigger({ function_id: "mem::lesson-strengthen", payload: { lessonId: body.lessonId } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::lesson-strengthen", config: { api_path: "/agentmemory/lessons/strengthen", http_method: "POST" } });

  sdk.registerFunction("api::obsidian-export", async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = (req.body as Record<string, unknown>) || {};
    const vaultDir = asNonEmptyString(body.vaultDir);
    if (!vaultDir) {
      return {
        status_code: 400,
        body: { error: "vaultDir must be a non-empty string" },
      };
    }
    const types = typeof body.types === "string" ? body.types.split(",").map((t: string) => t.trim()).filter(Boolean) : undefined;
    const result = await sdk.trigger({ function_id: "mem::obsidian-export", payload: { vaultDir, types } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::obsidian-export", config: { api_path: "/agentmemory/obsidian/export", http_method: "POST" } });

  sdk.registerFunction("api::reflect",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = (req.body as Record<string, unknown>) || {};
    const result = await sdk.trigger({ function_id: "mem::reflect", payload: {
      project: typeof body.project === "string" ? body.project : undefined,
      maxClusters: typeof body.maxClusters === "number" ? body.maxClusters : undefined,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::reflect", config: { api_path: "/agentmemory/reflect", http_method: "POST" } });

  sdk.registerFunction("api::insight-list",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const params = req.query_params || {};
    const minConfidence = parseOptionalFiniteNumber(params.minConfidence);
    if (minConfidence === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: minConfidence" },
      };
    }
    const limit = parseOptionalPositiveInt(params.limit);
    if (limit === null) {
      return {
        status_code: 400,
        body: { error: "invalid numeric parameter: limit" },
      };
    }
    const result = await sdk.trigger({ function_id: "mem::insight-list", payload: {
      project: params.project,
      minConfidence,
      limit,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::insight-list", config: { api_path: "/agentmemory/insights", http_method: "GET" } });

  sdk.registerFunction("api::insight-search",  async (req: ApiRequest) => {
    const denied = checkAuth(req, secret);
    if (denied) return denied;
    const body = req.body as Record<string, unknown>;
    if (!body?.query || typeof body.query !== "string") return { status_code: 400, body: { error: "query is required" } };
    const result = await sdk.trigger({ function_id: "mem::insight-search", payload: {
      query: body.query,
      project: typeof body.project === "string" ? body.project : undefined,
      minConfidence: typeof body.minConfidence === "number" ? body.minConfidence : undefined,
      limit: typeof body.limit === "number" ? body.limit : undefined,
    } });
    return { status_code: 200, body: result };
  });
  sdk.registerTrigger({ type: "http", function_id: "api::insight-search", config: { api_path: "/agentmemory/insights/search", http_method: "POST" } });
}
