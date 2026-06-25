import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { renderViewerDocument } from "./document.js";
import type { Action, CompressedObservation, Memory, ReviewQueueItem, Session } from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { generateTodosFromSessions, refreshTodoAction, updateChangedTodoCards } from "../functions/todo-extract.js";
import {
  DEFAULT_TODO_EXTRACT_MAX_SESSIONS,
  detectEmbeddingProvider,
  detectLlmProviderKind,
  getTodoExtractorUserConfig,
  getUserEnvPath,
  isAutoCompressEnabled,
  isConsolidationEnabled,
  isContextInjectionEnabled,
  isGraphExtractionEnabled,
  writeUserEnv,
  WRITABLE_TODO_EXTRACT_KEYS,
} from "../config.js";
import { VERSION } from "../version.js";

// Self-host the viewer favicon at /favicon.svg instead of an inline
// data: URI so the viewer CSP can stay tight at `img-src 'self'`.
// Mirrors loadViewerTemplate() in document.ts — same candidate paths so
// it resolves both from source (vitest) and from dist/ (npm run start).
function loadViewerFavicon(): Buffer | null {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(base, "..", "src", "viewer", "favicon.svg"),
    join(base, "..", "viewer", "favicon.svg"),
    join(base, "viewer", "favicon.svg"),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch {}
  }
  return null;
}

function readViewerAsset(relativePath: string): Buffer | null {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(base, "..", "src", "viewer", relativePath),
    join(base, "..", "viewer", relativePath),
    join(base, "viewer", relativePath),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch {}
  }
  return null;
}

function readProjectDoc(relativePath: string): Buffer | null {
  const safeDocs = new Set(["browser-extension-ai-site-test-cards-cn.md"]);
  const name = basename(relativePath);
  if (!safeDocs.has(name)) return null;
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), "docs", name),
    join(base, "..", "..", "docs", name),
    join(base, "..", "docs", name),
  ];
  for (const path of candidates) {
    try {
      return readFileSync(path);
    } catch {}
  }
  return null;
}

function readJsonIfExists(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deliveryArtifactRoot(): string {
  const base = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    resolve(base, "..", ".."),
    resolve(base, ".."),
    resolve(base, "."),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "artifacts", "delivery-manifest.json"))) return candidate;
  }
  return process.cwd();
}

function readDeliveryStatus(): Record<string, unknown> {
  const root = deliveryArtifactRoot();
  const manifest = readJsonIfExists(join(root, "artifacts", "delivery-manifest.json"));
  const evidence = readJsonIfExists(join(root, "artifacts", "ai-validation-evidence-summary.json"));
  if (!manifest) {
    return {
      available: false,
      message: "delivery artifacts not generated",
      next: "run npm run package:browser-extension",
    };
  }
  const release = (manifest.releaseState || {}) as Record<string, unknown>;
  const realSite = (release.realSiteValidation || {}) as Record<string, unknown>;
  const requiredProducts = Array.isArray(evidence?.requiredProducts)
    ? evidence.requiredProducts.map(String)
    : Array.isArray(realSite.requiredProducts)
      ? realSite.requiredProducts.map(String)
      : ["ChatGPT", "Claude", "Gemini", "Perplexity"];
  const evidenceFiles = Array.isArray(evidence?.files) ? evidence.files as Record<string, unknown>[] : [];
  const sites = requiredProducts.map((product) => {
    const item = evidenceFiles.find((entry) => String(entry.provider || "") === product) || null;
    const missing: string[] = [];
    if (!item) {
      missing.push("未录入真实页面证据");
    } else {
      if (!item.editorFound) missing.push("输入框");
      if (!item.anchorFound) missing.push("入口锚点");
      if (!item.memoryWidgetVisible) missing.push("记忆提示");
      if (!item.memoryInsertPassed) missing.push("插入");
      if (!item.diagnosticsCopied) missing.push("诊断复制");
      if (!item.siteInputStillWorks) missing.push("原站输入");
      if (!item.editorSelector) missing.push("输入 selector");
      if (!item.anchorSelector) missing.push("锚点 selector");
      if (!item.sendSelector) missing.push("发送 selector");
      if (!item.turnSelector) missing.push("会话 selector");
    }
    return {
      product,
      status: item ? (item.passed ? "passed" : "needs-fix") : "missing",
      file: item?.file || "",
      checkedAt: item?.checkedAt || "",
      missing,
    };
  });
  return {
    available: true,
    generatedAt: manifest.generatedAt || "",
    commit: manifest.commit || "",
    dirty: !!manifest.dirty,
    extension: manifest.extension || {},
    artifacts: manifest.artifacts || {},
    releaseState: release,
    externalTesting: release.externalTesting || "not-ready",
    localDemo: release.localDemo || "not-ready",
    publicRelease: release.publicRelease || "not-ready",
    realSiteValidation: {
      passedCount: evidence?.passedCount ?? realSite.passedCount ?? 0,
      requiredCount: evidence?.requiredCount ?? realSite.requiredCount ?? 4,
      notPassed: evidence?.notPassedRequired || realSite.notPassed || [],
      source: realSite.source || "docs/browser-extension-ai-validation-cn.md",
      sites,
    },
    next: "collect real AI page diagnostics, then sync the validation table",
  };
}

function readDeliveryArtifact(relativePath: string): { body: Buffer; contentType: string; downloadName: string } | null {
  const safeArtifacts = new Map<string, string>([
    ["agent-memory-lab-extension.zip", "application/zip"],
    ["delivery-summary.md", "text/markdown; charset=utf-8"],
    ["external-tester-handout.md", "text/markdown; charset=utf-8"],
    ["external-feedback-template-cn.md", "text/markdown; charset=utf-8"],
    ["external-feedback-triage-cn.md", "text/markdown; charset=utf-8"],
    ["delivery-manifest.json", "application/json; charset=utf-8"],
    ["ai-validation-run/quickstart-cn.md", "text/markdown; charset=utf-8"],
    ["ai-validation-run/tester-pack-cn.md", "text/markdown; charset=utf-8"],
  ]);
  const normalized = relativePath.replace(/^\/+/, "");
  const contentType = safeArtifacts.get(normalized);
  if (!contentType) return null;
  const root = deliveryArtifactRoot();
  const artifactsDir = resolve(root, "artifacts");
  const docsDir = resolve(root, "docs");
  const targetRoot = normalized.startsWith("external-feedback-") ? docsDir : artifactsDir;
  const target = resolve(targetRoot, normalized);
  if (target !== targetRoot && !target.startsWith(`${targetRoot}${sep}`)) return null;
  try {
    if (!existsSync(target)) return null;
    return { body: readFileSync(target), contentType, downloadName: basename(target) };
  } catch {
    return null;
  }
}

function parseViewerQuery(qs: string): Record<string, string> {
  const params = new URLSearchParams(qs || "");
  const out: Record<string, string> = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

function walkLocalJsonl(root: string, out: Array<{ file: string; mtimeMs: number }> = []): Array<{ file: string; mtimeMs: number }> {
  if (!existsSync(root)) return out;
  let st;
  try {
    st = statSync(root);
  } catch {
    return out;
  }
  if (st.isFile() && root.endsWith(".jsonl")) {
    out.push({ file: root, mtimeMs: st.mtimeMs });
    return out;
  }
  if (!st.isDirectory()) return out;
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) walkLocalJsonl(join(root, name), out);
  return out;
}

function cleanLocalCodexText(text: unknown, max = 260): string {
  let t = String(text || "").trim();
  if (!t) return "";
  t = t.replace(/# AGENTS.md instructions[\s\S]*?<\/INSTRUCTIONS>/g, "").trim();
  t = t.replace(/<environment_context>[\s\S]*?<\/environment_context>/g, "").trim();
  const noisy = [
    "# AGENTS.md instructions",
    "Automation:",
    "<permissions instructions>",
    "<skills_instructions>",
    "<plugins_instructions>",
    "<environment_context>",
    "You are Codex",
    "Filesystem sandboxing defines",
    "Response MUST end with",
  ];
  if (noisy.some((prefix) => t.startsWith(prefix))) return "";
  t = t.replace(/^# In app browser:[\s\S]*?## My request for Codex:\s*/m, "").trim();
  t = t.replace(/^# Browser comments:[\s\S]*?## My request for Codex:\s*/m, "").trim();
  t = t.replace(/^The next image is untrusted page evidence[\s\S]*?instructions\.\s*/m, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}...` : t;
}

function localCodexTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as { type?: string; text?: string };
      if (p.type === "input_text" || p.type === "output_text") return p.text || "";
      return "";
    })
    .join("\n")
    .trim();
}

function readLocalCodexRows(file: string): unknown[] {
  try {
    return readFileSync(file, "utf8")
      .split(/\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function localCodexPrompt(row: unknown): string {
  const r = row as { type?: string; payload?: Record<string, unknown> };
  const payload = r?.payload || {};
  if (r?.type === "event_msg" && payload.type === "user_message") {
    return cleanLocalCodexText(payload.message);
  }
  if (r?.type === "response_item" && payload.type === "message" && payload.role === "user") {
    return cleanLocalCodexText(localCodexTextFromContent(payload.content));
  }
  return "";
}

function summarizeLocalCodexFile(file: string): Record<string, unknown> | null {
  const rows = readLocalCodexRows(file) as Array<{ type?: string; payload?: Record<string, unknown> }>;
  const meta = rows.find((r) => r.type === "session_meta")?.payload || {};
  if (!meta.id) return null;
  const prompts = rows.map(localCodexPrompt).filter(Boolean);
  const observationCount = rows.filter((r) => r.type === "response_item" || r.type === "event_msg").length;
  const cwd = typeof meta.cwd === "string" ? meta.cwd : "";
  const timestamp = typeof meta.timestamp === "string" ? meta.timestamp : new Date(statSync(file).mtimeMs).toISOString();
  return {
    id: `codex_local_${meta.id}`,
    project: cwd ? basename(cwd) : "Codex",
    cwd,
    title: prompts[0] || meta.originator || "Codex 会话",
    firstPrompt: prompts[0] || "",
    latestPrompt: prompts[prompts.length - 1] || prompts[0] || "",
    startedAt: timestamp,
    updatedAt: timestamp,
    status: "completed",
    agentId: "Codex",
    source: "local-codex-jsonl",
    observationCount,
    messageCount: prompts.length,
    file,
  };
}

function readLocalCodexSessions(qs: string): Record<string, unknown> {
  const params = parseViewerQuery(qs);
  const cwdFilter = params.cwd || "";
  const limit = Math.max(1, Math.min(1000, Number(params.limit || 500) || 500));
  const roots = [
    join(homedir(), ".codex", "sessions"),
    join(homedir(), ".codex", "archived_sessions"),
  ];
  const entries = roots.flatMap((root) => walkLocalJsonl(root)).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const sessions: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    const session = summarizeLocalCodexFile(entry.file);
    if (!session) continue;
    if (cwdFilter && !String(session.cwd || "").startsWith(cwdFilter)) continue;
    sessions.push(session);
    if (sessions.length >= limit) break;
  }
  return { sessions, source: roots, cwdFilter, total: sessions.length };
}

let localAgentSessionsCache: { key: string; expiresAt: number; data: Record<string, unknown> | null } = {
  key: "",
  expiresAt: 0,
  data: null,
};

function localAgentSourceDefs(home: string): Array<{
  name: string;
  roots: string[];
  summarize: (file: string) => Record<string, unknown> | null;
}> {
  return [
    { name: "codex", roots: [join(home, ".codex", "sessions"), join(home, ".codex", "archived_sessions")], summarize: summarizeLocalCodexFile },
  ];
}

function localSessionSuffix(id: unknown): string {
  return String(id || "").replace(/^(codex|claude)_local_/, "");
}

function readLocalAgentSessions(qs: string): Record<string, unknown> {
  const params = parseViewerQuery(qs);
  const home = homedir();
  const cwdFilter = params.cwd || "";
  const limit = Math.max(1, Math.min(2000, Number(params.limit || 1000) || 1000));
  const cacheKey = JSON.stringify({ cwdFilter, limit });
  const now = Date.now();
  if (localAgentSessionsCache.key === cacheKey && localAgentSessionsCache.expiresAt > now && localAgentSessionsCache.data) {
    return localAgentSessionsCache.data;
  }
  const sources = localAgentSourceDefs(home);
  const sessions: Array<Record<string, unknown>> = [];
  const roots: string[] = [];
  const entries: Array<{ file: string; mtimeMs: number; summarize: (file: string) => Record<string, unknown> | null }> = [];
  for (const source of sources) {
    roots.push(...source.roots);
    for (const entry of source.roots.flatMap((root) => walkLocalJsonl(root))) {
      entries.push({ ...entry, summarize: source.summarize });
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const entry of entries) {
    const session = entry.summarize(entry.file);
    if (!session) continue;
    if (cwdFilter && !String(session.cwd || "").startsWith(cwdFilter)) continue;
    sessions.push(session);
    if (sessions.length >= limit) break;
  }
  sessions.sort((a, b) => String(b.updatedAt || b.startedAt || "").localeCompare(String(a.updatedAt || a.startedAt || "")));
  const data = { sessions: sessions.slice(0, limit), source: roots, cwdFilter, total: sessions.length };
  localAgentSessionsCache = { key: cacheKey, expiresAt: now + 15_000, data };
  return data;
}

function localCodexEventObservation(row: unknown, index: number, session: Record<string, unknown>): Record<string, unknown> | null {
  const r = row as { type?: string; payload?: Record<string, unknown> };
  const payload = r?.payload || {};
  const timestamp = typeof payload.timestamp === "string" ? payload.timestamp : String(session.updatedAt || session.startedAt || "");
  let title = "";
  let body = "";
  if (r?.type === "event_msg") {
    const eventType = String(payload.type || "event");
    title = eventType === "user_message" ? "用户消息" : eventType === "agent_message" ? "Agent 回复" : eventType.replace(/_/g, " ");
    body = String(payload.message || payload.text || payload.content || payload.summary || "");
  } else if (r?.type === "response_item") {
    const itemType = String(payload.type || "response");
    if (itemType === "message") {
      const role = String(payload.role || "assistant");
      title = role === "user" ? "用户消息" : "Agent 回复";
      body = localCodexTextFromContent(payload.content);
    } else if (itemType === "function_call") {
      title = `调用工具：${String(payload.name || "未知工具")}`;
      body = String(payload.arguments || payload.input || "");
    } else if (itemType === "function_call_output") {
      title = "工具结果";
      body = String(payload.output || "");
    } else {
      title = itemType.replace(/_/g, " ");
      body = String(payload.text || payload.content || payload.summary || "");
    }
  }
  if (!title && !body) return null;
  return {
    id: `${String(session.id)}:local:${index}`,
    sessionId: session.id,
    timestamp,
    type: title.indexOf("工具") >= 0 ? "tool" : "conversation",
    title,
    narrative: cleanLocalCodexText(body, 10_000),
    agentId: session.agentId,
    project: session.project,
    cwd: session.cwd,
  };
}

function readLocalAgentSessionEvents(qs: string): Record<string, unknown> {
  const params = parseViewerQuery(qs);
  const sessionId = params.sessionId || params.id || "";
  if (!sessionId) return { observations: [], error: "sessionId is required" };
  const sessionSuffix = localSessionSuffix(sessionId);
  let session: Record<string, unknown> | null = null;
  for (const source of localAgentSourceDefs(homedir())) {
    const entries = source.roots.flatMap((root) => walkLocalJsonl(root)).sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries) {
      const s = source.summarize(entry.file);
      if (!s) continue;
      if (s.id === sessionId || localSessionSuffix(s.id) === sessionSuffix) {
        session = s;
        break;
      }
    }
    if (session) break;
  }
  if (!session || !session.file) return { observations: [], session: session || null };
  const rows = readLocalCodexRows(String(session.file));
  const observations = rows.map((row, index) => localCodexEventObservation(row, index, session)).filter(Boolean);
  return { observations, session };
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function parseSkillFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return out;
  for (const line of match[1].split(/\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^["']|["']$/g, "");
    out[key] = value;
  }
  return out;
}

function readLocalSkillDetail(qs: string): Record<string, unknown> {
  const params = parseViewerQuery(qs);
  const rawPath = params.path || "";
  const skillPath = resolve(expandHomePath(rawPath));
  if (!rawPath || !skillPath.endsWith(".md") || basename(skillPath).toLowerCase() !== "skill.md") {
    return { error: "invalid skill path" };
  }
  const home = homedir();
  const allowedPrefixes = [
    join(home, ".codex", "skills"),
    join(home, ".agents", "skills"),
    join(home, ".codex", "plugins", "cache"),
  ].map((p) => resolve(p) + sep);
  if (!allowedPrefixes.some((prefix) => skillPath.startsWith(prefix))) return { error: "skill path is outside local skill folders" };
  let st;
  let text;
  try {
    st = statSync(skillPath);
    if (!st.isFile()) return { error: "skill file not found" };
    text = readFileSync(skillPath, "utf8");
  } catch {
    return { error: "skill file not found" };
  }
  const frontmatter = parseSkillFrontmatter(text);
  const body = text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  const headings = Array.from(body.matchAll(/^#{1,3}\s+(.+)$/gm)).map((m) => m[1].trim()).slice(0, 8);
  return {
    path: rawPath,
    absolutePath: skillPath,
    name: frontmatter.name || basename(dirname(skillPath)),
    description: frontmatter.description || "",
    argumentHint: frontmatter["argument-hint"] || "",
    updatedAt: new Date(st.mtimeMs).toISOString(),
    size: st.size,
    headings,
    preview: body.slice(0, 4000),
  };
}

const ALLOWED_ORIGINS = (
  process.env.VIEWER_ALLOWED_ORIGINS ||
  "http://localhost:3111,http://localhost:3114,http://127.0.0.1:3111,http://127.0.0.1:3114"
)
  .split(",")
  .map((o) => o.trim());

// Hosts the viewer will accept in the Host header. Restricting this is the
// defence against DNS rebinding: a browser visiting `attacker.com` whose
// authoritative DNS rebinds to 127.0.0.1 hits the viewer's listening socket
// directly, the Origin header reads `http://attacker.com` (same-origin from
// the browser's perspective on a same-port attacker page, so no preflight
// fires), and the request body is whatever the page wants. The viewer
// proxies it to the local REST API with the AGENTMEMORY_SECRET bearer
// attached, so the response stream is fully privileged. Rejecting any Host
// not in this allowlist closes that path before the proxy runs.
//
// Explicit override via VIEWER_ALLOWED_HOSTS for the rare case of a
// reverse-proxy in front of the viewer; defaults are computed from the
// listen port at server-create time.
const ALLOWED_HOSTS_OVERRIDE = (process.env.VIEWER_ALLOWED_HOSTS || "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

export function buildAllowedHosts(
  origins: string[],
  listenPort: number,
): Set<string> {
  const hosts = new Set<string>();
  for (const o of origins) {
    try {
      const parsed = new URL(o);
      if (parsed.host) hosts.add(parsed.host.toLowerCase());
    } catch {
      // Skip invalid origin entries — the existing CORS path already
      // tolerates them by simply not matching; mirror that here.
    }
  }
  hosts.add(`localhost:${listenPort}`);
  hosts.add(`127.0.0.1:${listenPort}`);
  hosts.add(`[::1]:${listenPort}`);
  for (const h of ALLOWED_HOSTS_OVERRIDE) hosts.add(h);
  return hosts;
}

export function isHostAllowed(
  headerHost: string | string[] | undefined,
  allowed: Set<string>,
): boolean {
  if (typeof headerHost !== "string") return false;
  const lower = headerHost.toLowerCase().trim();
  if (!lower) return false;
  return allowed.has(lower);
}

function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = req.headers.origin || "";
  const allowed = ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    Vary: "Origin",
  };
}

function json(
  res: ServerResponse,
  status: number,
  data: unknown,
  req?: IncomingMessage,
): void {
  const body = JSON.stringify(data);
  const cors = req
    ? corsHeaders(req)
    : { "Access-Control-Allow-Origin": ALLOWED_ORIGINS[0], Vary: "Origin" };
  res.writeHead(status, { ...cors, "Content-Type": "application/json" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        req.destroy();
        reject(new Error("too large"));
        return;
      }
      data += chunk.toString();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

type ViewerKv = {
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  list<T = unknown>(scope: string): Promise<T[]>;
  delete(scope: string, key: string): Promise<void>;
};

const TODO_EXTRACT_STATUS_ID = "todo-extract:status";

type TodoExtractStatus = {
  status: "idle" | "running" | "done" | "error";
  startedAt?: string;
  finishedAt?: string;
  summary?: Record<string, unknown>;
  error?: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readTodoExtractStatus(kv: ViewerKv): Promise<TodoExtractStatus> {
  const item = await kv.get<{ cursor?: string }>(KV.scanCheckpoints, TODO_EXTRACT_STATUS_ID).catch(() => null);
  try {
    const parsed = item?.cursor ? JSON.parse(item.cursor) as TodoExtractStatus : null;
    if (!parsed || typeof parsed !== "object" || !parsed.status) return { status: "idle" };
    if (parsed.status !== "running") return parsed;
    const startedAt = parsed.startedAt ? Date.parse(parsed.startedAt) : NaN;
    const maxAgeMs = todoExtractRunningMaxAgeMs();
    if (!Number.isFinite(startedAt) || Date.now() - startedAt <= maxAgeMs) return parsed;
    return {
      status: "error",
      startedAt: parsed.startedAt,
      finishedAt: new Date().toISOString(),
      error: "Previous todo organization did not finish; run it again.",
    };
  } catch {
    return { status: "idle" };
  }
}

function todoExtractRunningMaxAgeMs(): number {
  const perSessionMs = proxyTimeoutMsForPath("/agentmemory/todo-extract/generate");
  const rawMaxSessions = Number(process.env.AGENTMEMORY_TODO_EXTRACT_MAX_SESSIONS);
  const maxSessions = Number.isFinite(rawMaxSessions) && rawMaxSessions > 0
    ? Math.min(100, Math.floor(rawMaxSessions))
    : DEFAULT_TODO_EXTRACT_MAX_SESSIONS;
  return perSessionMs * maxSessions + 60_000;
}

async function writeTodoExtractStatus(kv: ViewerKv, status: TodoExtractStatus): Promise<void> {
  await kv.set(KV.scanCheckpoints, TODO_EXTRACT_STATUS_ID, {
    sourceId: TODO_EXTRACT_STATUS_ID,
    cursor: JSON.stringify(status),
    ...(status.status === "done" ? { lastSuccessAt: status.finishedAt } : {}),
    ...(status.status === "error" ? { lastError: status.error || "todo extraction failed" } : {}),
  });
}

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function normalizeConcepts(values: unknown[]): string[] {
  const seen = new Set<string>();
  return values
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => asText(value))
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function validMemoryType(value: unknown): Memory["type"] {
  const raw = asText(value);
  return raw === "pattern" || raw === "preference" || raw === "architecture" || raw === "bug" || raw === "workflow" || raw === "fact"
    ? raw
    : "fact";
}

function browserSessionId(syncId: string): string {
  return `browser_${syncId}`;
}

const MAX_BROWSER_SESSION_TURNS = 240;
const MAX_BROWSER_TURN_TEXT_LENGTH = 12000;

function normalizeBrowserTurnText(value: unknown): string {
  return asText(value).replace(/\s+/g, " ").trim().slice(0, MAX_BROWSER_TURN_TEXT_LENGTH);
}

function isBrowserSyncCaptureAllowed(
  page: Record<string, unknown>,
  conversation: Record<string, unknown>,
): { ok: true; turns: { role: string; text: string }[] } | { ok: false; error: string } {
  const pageType = asText(page.type);
  const provider = asText(conversation.provider);
  const host = asText(page.host).toLowerCase();
  const rawTurns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const turns = rawTurns
    .map((turn) => turn && typeof turn === "object" ? turn as Record<string, unknown> : {})
    .map((turn) => ({ role: asText(turn.role) || "unknown", text: normalizeBrowserTurnText(turn.text) }))
    .filter((turn) => turn.text && turn.text.length >= 12)
    .slice(-MAX_BROWSER_SESSION_TURNS);
  if (host === "localhost" || host === "127.0.0.1" || host.endsWith(".localhost")) {
    return { ok: false, error: "local workbench pages are not browser conversation sources" };
  }
  if (pageType !== "ai-chat" || !provider) {
    return { ok: false, error: "browser sync requires a supported AI conversation page" };
  }
  if (!turns.length) {
    return { ok: false, error: "browser sync requires captured conversation turns" };
  }
  return { ok: true, turns };
}

async function recordBrowserSessionFallback(
  kv: ViewerKv,
  item: ReviewQueueItem,
  syncId: string,
): Promise<{ sessionId: string; observationCount: number }> {
  const page = item.page || {};
  const conversation = item.conversation || {};
  const turns = Array.isArray(conversation.turns) ? conversation.turns.slice(-MAX_BROWSER_SESSION_TURNS) : [];
  const provider = conversation.provider || page.host || "浏览器";
  const sessionId = browserSessionId(syncId);
  const now = item.updatedAt || new Date().toISOString();
  const startedAt = item.createdAt || now;
  const session: Session = {
    id: sessionId,
    project: provider,
    cwd: `browser/${page.host || provider || "web"}`,
    startedAt,
    endedAt: now,
    status: "completed",
    observationCount: Math.max(1, turns.length + 1),
    firstPrompt: page.title || item.title || "浏览器会话",
    summary: item.content,
    tags: ["browser", page.type || "", item.kind || ""].filter(Boolean),
    agentId: provider,
  };
  const observations: CompressedObservation[] = [];
  turns.forEach((turn, index) => {
    const role = turn.role === "assistant" ? "AI" : turn.role === "user" ? "用户" : "对话";
    const text = normalizeBrowserTurnText(turn.text);
    if (!text) return;
    observations.push({
      id: `${sessionId}_turn_${index + 1}`,
      sessionId,
      timestamp: new Date(Date.parse(startedAt) + index * 1000).toISOString(),
      type: "conversation",
      title: `${role}发言`,
      subtitle: page.title || item.title,
      facts: [text],
      narrative: text,
      concepts: normalizeConcepts(["browser", provider, page.host, page.type]),
      files: [],
      importance: turn.role === "user" ? 0.72 : 0.58,
      confidence: 0.75,
      agentId: provider,
    });
  });
  observations.push({
    id: `${sessionId}_summary`,
    sessionId,
    timestamp: now,
    type: "decision",
    title: item.title || page.title || "浏览器同步摘要",
    subtitle: item.status === "pending" ? "待工作台判断" : item.status === "approved" ? "已写入记忆" : "证据保留",
    facts: [item.content].filter(Boolean),
    narrative: item.content,
    concepts: normalizeConcepts(["browser", provider, page.host, page.type, item.kind]),
    files: [],
    importance: item.status === "pending" ? 0.75 : 0.45,
    confidence: item.confidence ?? 0.5,
    agentId: provider,
  });
  session.observationCount = observations.length;
  await kv.set(KV.sessions, sessionId, session);
  for (const observation of observations) {
    await kv.set(KV.observations(sessionId), observation.id, observation);
  }
  return { sessionId, observationCount: observations.length };
}

function extractBrowserFallbackContent(body: Record<string, unknown>): {
  title: string;
  content: string;
  status: "pending" | "dismissed";
  decision: "candidate" | "evidence_only";
  confidence: number;
  reason: string;
  type: Memory["type"];
} {
  const page = body.page && typeof body.page === "object" ? body.page as Record<string, unknown> : {};
  const conversation = body.conversation && typeof body.conversation === "object" ? body.conversation as Record<string, unknown> : {};
  const rawTurns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const normalizedTurns = rawTurns
    .map((turn) => turn && typeof turn === "object" ? turn as Record<string, unknown> : {})
    .map((turn) => ({ role: asText(turn.role) || "unknown", text: normalizeBrowserTurnText(turn.text) }))
    .filter((turn) => turn.text)
    .slice(-MAX_BROWSER_SESSION_TURNS);
  const userTurns = normalizedTurns
    .filter((turn) => asText(turn.role).toLowerCase() === "user")
    .map((turn) => asText(turn.text))
    .filter(Boolean);
  const firstUserTurn = userTurns[0] || normalizedTurns[0]?.text || "";
  const title = firstUserTurn
    ? firstUserTurn.slice(0, 42) + (firstUserTurn.length > 42 ? "..." : "")
    : asText(body.title) || asText(page.title) || "浏览器会话";
  return {
    title,
    content: [asText(page.title), rawTurns.length ? `已同步 ${rawTurns.length} 条网页 AI 会话。` : "已同步网页 AI 会话。"].filter(Boolean).join("\n"),
    status: "dismissed",
    decision: "evidence_only",
    confidence: 0.25,
    reason: "浏览器插件只同步原始会话；记忆和 Skill 在工作台后续整理。",
    type: "fact",
  };
}

async function handleReviewFallback(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  qs: string,
  kv: ViewerKv,
): Promise<boolean> {
  if (method === "GET") {
    const params = parseViewerQuery(qs);
    const status = params.status || "";
    const kinds = new Set((params.kind || "").split(",").map((kind) => kind.trim()).filter(Boolean));
    const limit = Math.max(1, Math.min(200, parseInt(params.limit || "50", 10) || 50));
    const items = (await kv.list<ReviewQueueItem>(KV.reviewQueue))
      .filter((item) => !status || item.status === status)
      .filter((item) => kinds.size === 0 || kinds.has(item.kind))
      .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""))
      .slice(0, limit);
    json(res, 200, { items }, req);
    return true;
  }
  if (method !== "POST") return false;
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const page = body.page && typeof body.page === "object" ? body.page as Record<string, unknown> : {};
  const conversation = body.conversation && typeof body.conversation === "object" ? body.conversation as Record<string, unknown> : {};
  if (body.mode === "sync" || body.source === "browser-sync") {
    const allowed = isBrowserSyncCaptureAllowed(page, conversation);
    if (!allowed.ok) {
      json(res, 202, { success: true, skipped: true, reason: allowed.error }, req);
      return true;
    }
  }
  const fallback = extractBrowserFallbackContent(body);
  const syncId = stableHash([
    asText(page.url) || asText(page.title) || "browser",
    asText(conversation.provider) || asText(page.host) || "browser",
    fallback.content,
  ].join("\n"));
  const normalizedConversation = {
    provider: asText(conversation.provider) || undefined,
    turns: Array.isArray(conversation.turns)
      ? conversation.turns
          .map((turn) => turn && typeof turn === "object" ? turn as Record<string, unknown> : {})
          .map((turn) => ({ role: asText(turn.role) || "unknown", text: normalizeBrowserTurnText(turn.text) }))
          .filter((turn) => turn.text)
          .slice(-MAX_BROWSER_SESSION_TURNS)
      : [],
  };
  if (body.mode === "sync" || body.source === "browser-sync") {
    const item: ReviewQueueItem = {
      id: `browser_sync_${syncId}`,
      createdAt: now,
      updatedAt: now,
      status: "dismissed",
      kind: "memory",
      title: fallback.title,
      content: asText(body.content) || fallback.content,
      source: "browser-sync",
      decision: "evidence_only",
      confidence: fallback.confidence,
      reason: fallback.reason,
      page: {
        type: asText(page.type) || undefined,
        typeLabel: asText(page.typeLabel) || undefined,
        title: asText(page.title) || undefined,
        url: asText(page.url) || undefined,
        host: asText(page.host) || undefined,
      },
      conversation: normalizedConversation,
      payload: {
        ...(body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {}),
        browserSyncId: syncId,
        decision: "evidence_only",
        confidence: fallback.confidence,
        reason: fallback.reason,
        viewerFallback: true,
      },
    };
    const browserSession = await recordBrowserSessionFallback(kv, item, syncId);
    json(res, 201, {
      success: true,
      item: {
        id: item.id,
        source: item.source,
        decision: item.decision,
        title: item.title,
        browserSessionId: browserSession.sessionId,
        browserObservationCount: browserSession.observationCount,
      },
    }, req);
    return true;
  }
  const itemId = body.mode === "sync" || body.source === "browser-sync"
    ? `browser_sync_${syncId}`
    : `review_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  const existing = await kv.get<ReviewQueueItem>(KV.reviewQueue, itemId);
  const item: ReviewQueueItem = {
    id: existing?.id || itemId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    status: existing?.status || fallback.status,
    kind: body.kind === "lesson" ? "lesson" : "memory",
    title: fallback.title,
    content: asText(body.content) || fallback.content,
    source: body.source === "browser-sync" ? "browser-sync" : "browser-extension",
    decision: fallback.decision,
    confidence: fallback.confidence,
    reason: fallback.reason,
    page: {
      type: asText(page.type) || undefined,
      typeLabel: asText(page.typeLabel) || undefined,
      title: asText(page.title) || undefined,
      url: asText(page.url) || undefined,
      host: asText(page.host) || undefined,
    },
    conversation: {
      provider: normalizedConversation.provider,
      promptDraft: asText(conversation.promptDraft) || undefined,
      turns: normalizedConversation.turns,
    },
    payload: {
      ...(body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {}),
      browserSyncId: syncId,
      decision: fallback.decision,
      confidence: fallback.confidence,
      reason: fallback.reason,
      type: fallback.type,
      viewerFallback: true,
    },
  };
  const browserSession = await recordBrowserSessionFallback(kv, item, syncId);
  item.payload = {
    ...(item.payload || {}),
    browserSessionId: browserSession.sessionId,
    browserObservationCount: browserSession.observationCount,
  };
  await kv.set(KV.reviewQueue, item.id, item);
  json(res, existing ? 200 : 201, { success: true, item }, req);
  return true;
}

async function handleInboxFallback(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  qs: string,
  kv: ViewerKv,
): Promise<boolean> {
  if (method !== "GET") return false;
  const params = parseViewerQuery(qs);
  const status = params.status || "";
  const kind = params.kind || "";
  const limit = Math.max(1, Math.min(200, parseInt(params.limit || "50", 10) || 50));
  const items = (await kv.list<Record<string, unknown>>(KV.inbox))
    .filter((item) => !status || item.status === status)
    .filter((item) => !kind || item.kind === kind)
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, limit);
  json(res, 200, { success: true, items }, req);
  return true;
}

function viewerFlagsFallback(): Record<string, unknown> {
  return {
    version: VERSION,
    provider: detectLlmProviderKind(),
    embeddingProvider: detectEmbeddingProvider() ? "embeddings" : "none",
    flags: [
      { key: "GRAPH_EXTRACTION_ENABLED", label: "Knowledge graph extraction", enabled: isGraphExtractionEnabled(), default: false },
      { key: "CONSOLIDATION_ENABLED", label: "Memory consolidation", enabled: isConsolidationEnabled(), default: false },
      { key: "AGENTMEMORY_AUTO_COMPRESS", label: "LLM-powered observation compression", enabled: isAutoCompressEnabled(), default: false },
      { key: "AGENTMEMORY_INJECT_CONTEXT", label: "In-conversation context injection", enabled: isContextInjectionEnabled(), default: false },
    ],
  };
}

async function handleReviewApproveFallback(
  req: IncomingMessage,
  res: ServerResponse,
  kv: ViewerKv,
): Promise<boolean> {
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  const id = asText(body.id);
  if (!id) {
    json(res, 400, { error: "id is required" }, req);
    return true;
  }
  const item = await kv.get<ReviewQueueItem>(KV.reviewQueue, id);
  if (!item) {
    json(res, 404, { error: "review item not found" }, req);
    return true;
  }
  if (item.status !== "pending") {
    json(res, 409, { error: "review item is not pending" }, req);
    return true;
  }
  const now = new Date().toISOString();
  const title = asText(body.title) || item.title;
  const content = asText(body.content) || item.content;
  const payload = item.payload || {};
  const tags = typeof body.tags === "string"
    ? body.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
    : Array.isArray(body.tags) ? body.tags.map((tag) => asText(tag)).filter(Boolean) : [];
  const page = item.page || {};
  const project = asText(body.project) || asText(payload.project) || "browser";
  // Parity with api::review-approve: branch on the approved kind so action
  // items become Actions, not Memories. Without this the fallback silently
  // funneled every approval (including kind: "action") into KV.memories, so
  // approved actions never reached the workbench.
  const approvedKind =
    body.kind === "lesson" || body.kind === "memory" || body.kind === "action"
      ? body.kind
      : item.kind;

  let resultId: string;
  let resultBody: Record<string, unknown>;
  let payloadType: string | undefined;

  if (approvedKind === "action") {
    const actionCandidate =
      payload.actionCandidate && typeof payload.actionCandidate === "object"
        ? (payload.actionCandidate as Record<string, unknown>)
        : {};
    const priorityRaw = Number(body.priority ?? actionCandidate.priority ?? 5);
    const priority = Number.isFinite(priorityRaw)
      ? Math.max(1, Math.min(10, Math.floor(priorityRaw)))
      : 5;
    const todoExtraction = payload.todoExtraction && typeof payload.todoExtraction === "object"
      ? payload.todoExtraction as Record<string, unknown>
      : {};
    const typeBucket = typeof todoExtraction.typeBucket === "string" ? todoExtraction.typeBucket : "";
    const dedupeKey = typeof todoExtraction.dedupeKey === "string" ? todoExtraction.dedupeKey : "";
    const actionStatus =
      typeBucket === "done" ? "done" :
      typeBucket === "in_progress" || typeBucket === "processing" ? "active" :
      "pending";
    const sourceObservationIds = Array.isArray(actionCandidate.sourceObservationIds)
      ? actionCandidate.sourceObservationIds.filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
      : [];
    const action: Action = {
      id: dedupeKey ? fingerprintId("act", `todo:${dedupeKey}`) : `act_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      title,
      description: content,
      status: actionStatus,
      priority,
      createdAt: now,
      updatedAt: now,
      createdBy: "review",
      project,
      tags,
      sourceObservationIds,
      sourceMemoryIds: [],
      metadata: Object.keys(todoExtraction).length ? { todoExtraction } : undefined,
    };
    await kv.set(KV.actions, action.id, action);
    resultId = action.id;
    resultBody = { success: true, action };
  } else {
    const memory: Memory = {
      id: `mem_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
      type: validMemoryType(asText(body.type) || payload.type),
      title: title.slice(0, 80),
      content: title ? `${title}\n\n${content}` : content,
      concepts: normalizeConcepts([
        payload.concepts,
        tags,
        "browser-context",
        page.host,
        page.type ? `browser-page:${page.type}` : "",
      ]),
      files: [],
      sessionIds: asText(payload.browserSessionId) ? [asText(payload.browserSessionId)] : [],
      strength: 7,
      version: 1,
      sourceObservationIds: [],
      isLatest: true,
      project,
    };
    await kv.set(KV.memories, memory.id, memory);
    resultId = memory.id;
    resultBody = { success: true, memory };
    payloadType = memory.type;
  }
  item.status = "approved";
  item.title = title;
  item.content = content;
  item.updatedAt = now;
  item.reviewedAt = now;
  item.resultId = resultId;
  item.payload = {
    ...payload,
    project,
    tags,
    ...(payloadType ? { type: payloadType } : {}),
    viewerFallbackApproved: true,
  };
  await kv.set(KV.reviewQueue, item.id, item);
  if (asText(payload.browserSessionId)) {
    const session = await kv.get<Session>(KV.sessions, asText(payload.browserSessionId));
    if (session) {
      session.status = "completed";
      session.endedAt = now;
      session.summary = content;
      await kv.set(KV.sessions, session.id, session);
    }
  }
  json(res, 200, { success: true, item, result: resultBody }, req);
  return true;
}

async function handleReviewDismissFallback(
  req: IncomingMessage,
  res: ServerResponse,
  kv: ViewerKv,
): Promise<boolean> {
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  const id = asText(body.id);
  if (!id) {
    json(res, 400, { error: "id is required" }, req);
    return true;
  }
  const item = await kv.get<ReviewQueueItem>(KV.reviewQueue, id);
  if (!item) {
    json(res, 404, { error: "review item not found" }, req);
    return true;
  }
  item.status = "dismissed";
  item.updatedAt = new Date().toISOString();
  await kv.set(KV.reviewQueue, item.id, item);
  json(res, 200, { success: true, item }, req);
  return true;
}

const MAX_VIEWER_PORT_RETRIES = 10;
const DEFAULT_PROXY_TIMEOUT_MS = 10_000;
const TODO_EXTRACT_PROXY_TIMEOUT_MS = 120_000;

export function proxyTimeoutMsForPath(pathname: string): number {
  if (pathname === "/agentmemory/todo-extract/generate") {
    const parsed = Number(process.env.AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : TODO_EXTRACT_PROXY_TIMEOUT_MS;
  }
  return DEFAULT_PROXY_TIMEOUT_MS;
}

let boundViewerPort: number | null = null;
let viewerSkipped = false;

export function getBoundViewerPort(): number | null {
  return boundViewerPort;
}
export function getViewerSkipped(): boolean {
  return viewerSkipped;
}

export function startViewerServer(
  port: number,
  kv: unknown,
  _sdk: unknown,
  secret?: string,
  restPort?: number,
): Server {
  // Reset exported runtime state for each start attempt.
  boundViewerPort = null;
  viewerSkipped = false;

  const resolvedRestPort = restPort ?? port - 2;
  const requestedPort = port;
  // Computed lazily on first request — `port` may be 0 here (OS-assigned)
  // or the EADDRINUSE retry loop below may bump us to a different port,
  // so we read the actual bound port from server.address() on first hit.
  let allowedHosts: Set<string> | null = null;

  const server = createServer(async (req, res) => {
    if (!allowedHosts) {
      const addr = server.address();
      const actualPort =
        addr && typeof addr === "object" && "port" in addr
          ? (addr.port as number)
          : port;
      allowedHosts = buildAllowedHosts(ALLOWED_ORIGINS, actualPort);
    }
    if (!isHostAllowed(req.headers.host, allowedHosts)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden host");
      return;
    }

    const raw = req.url || "/";
    const qIdx = raw.indexOf("?");
    const pathname = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const qs = qIdx >= 0 ? raw.slice(qIdx + 1) : "";
    const method = req.method || "GET";

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...corsHeaders(req),
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    if (
      method === "GET" &&
      (pathname === "/" ||
        pathname === "/viewer" ||
        pathname === "/agentmemory/viewer")
    ) {
      const rendered = renderViewerDocument();
      if (rendered.found) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": rendered.csp,
          "Cache-Control": "no-cache",
        });
        res.end(rendered.html);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("viewer not found");
      return;
    }

    if (method === "GET" && pathname === "/favicon.svg") {
      const favicon = loadViewerFavicon();
      if (favicon) {
        res.writeHead(200, {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(favicon);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("favicon not found");
      return;
    }

    if ((method === "GET" || method === "HEAD") && pathname === "/demo/browser-extension.html") {
      const demo = readViewerAsset(join("demo", "browser-extension.html"));
      if (demo) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(method === "HEAD" ? undefined : demo);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("demo not found");
      return;
    }

    if ((method === "GET" || method === "HEAD") && pathname === "/docs/browser-extension-ai-site-test-cards-cn.md") {
      const doc = readProjectDoc("browser-extension-ai-site-test-cards-cn.md");
      if (doc) {
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Cache-Control": "no-cache",
        });
        res.end(method === "HEAD" ? undefined : doc);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("doc not found");
      return;
    }

    if ((method === "GET" || method === "HEAD") && pathname.startsWith("/artifacts/")) {
      const artifact = readDeliveryArtifact(decodeURIComponent(pathname.slice("/artifacts/".length)));
      if (artifact) {
        res.writeHead(200, {
          "Content-Type": artifact.contentType,
          "Content-Disposition": `attachment; filename=\"${artifact.downloadName.replace(/\"/g, "")}\"`,
          "Cache-Control": "no-cache",
        });
        res.end(method === "HEAD" ? undefined : artifact.body);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("artifact not found");
      return;
    }

    if (method === "GET" && pathname.startsWith("/agent-avatars/")) {
      const assetName = basename(decodeURIComponent(pathname));
      if (!/^[a-z0-9._-]+\.png$/i.test(assetName)) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("invalid avatar asset");
        return;
      }
      const avatar = readViewerAsset(join("agent-avatars", assetName));
      if (avatar) {
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=3600",
        });
        res.end(avatar);
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("avatar not found");
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/local-codex-sessions") {
      json(res, 200, readLocalCodexSessions(qs), req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/local-agent-sessions") {
      json(res, 200, readLocalAgentSessions(qs), req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/local-agent-session-events") {
      json(res, 200, readLocalAgentSessionEvents(qs), req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/local-skill-detail") {
      const data = readLocalSkillDetail(qs);
      json(res, data.error ? 400 : 200, data, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/delivery-status") {
      json(res, 200, readDeliveryStatus(), req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/livez") {
      json(res, 200, {
        status: "ok",
        service: "agentmemory",
        viewerPort: getBoundViewerPort() || requestedPort,
        viewerSkipped: getViewerSkipped(),
        proxy: true,
      }, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/health") {
      json(res, 200, {
        status: "ok",
        service: "agentmemory",
        viewerPort: getBoundViewerPort() || requestedPort,
        viewerSkipped: getViewerSkipped(),
        proxy: true,
      }, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/config/flags") {
      json(res, 200, viewerFlagsFallback(), req);
      return;
    }

    if (pathname === "/agentmemory/review") {
      try {
        if (await handleReviewFallback(req, res, method, qs, kv as ViewerKv)) return;
      } catch (err) {
        console.error(`[viewer] review fallback error:`, err);
        json(res, 500, { error: "review fallback error" }, req);
        return;
      }
    }

    if (pathname === "/agentmemory/inbox") {
      try {
        if (await handleInboxFallback(req, res, method, qs, kv as ViewerKv)) return;
      } catch (err) {
        console.error(`[viewer] inbox fallback error:`, err);
        json(res, 500, { error: "inbox fallback error" }, req);
        return;
      }
    }

    if (pathname === "/agentmemory/review/approve" && method === "POST") {
      try {
        if (await handleReviewApproveFallback(req, res, kv as ViewerKv)) return;
      } catch (err) {
        console.error(`[viewer] review approve fallback error:`, err);
        json(res, 500, { error: "review approve fallback error" }, req);
        return;
      }
    }

    if (pathname === "/agentmemory/review/dismiss" && method === "POST") {
      try {
        if (await handleReviewDismissFallback(req, res, kv as ViewerKv)) return;
      } catch (err) {
        console.error(`[viewer] review dismiss fallback error:`, err);
        json(res, 500, { error: "review dismiss fallback error" }, req);
        return;
      }
    }

    if (method === "GET" && pathname === "/agentmemory/actions") {
      const params = parseViewerQuery(qs);
      const limit = Math.max(1, Math.min(200, parseInt(params.limit || "50", 10) || 50));
      let actions = await (kv as ViewerKv).list<Action>(KV.actions);
      const todoExtract = await readTodoExtractStatus(kv as ViewerKv);
      if (params.status) actions = actions.filter((action) => action.status === params.status);
      if (params.project) actions = actions.filter((action) => action.project === params.project);
      if (params.parentId) actions = actions.filter((action) => action.parentId === params.parentId);
      actions.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
      json(res, 200, { success: true, actions: actions.slice(0, limit), todoExtract }, req);
      return;
    }

    if (method === "POST" && pathname === "/agentmemory/actions/update") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const actionId = asText(body.actionId);
      const status = asText(body.status);
      if (!actionId) {
        json(res, 400, { error: "actionId is required" }, req);
        return;
      }
      const validStatuses = new Set(["pending", "active", "done", "blocked", "cancelled"]);
      if (status && !validStatuses.has(status)) {
        json(res, 400, { error: `invalid status: ${status}` }, req);
        return;
      }
      const action = await (kv as ViewerKv).get<Action>(KV.actions, actionId);
      if (!action) {
        json(res, 404, { success: false, error: "action not found" }, req);
        return;
      }
      if (status) action.status = status as Action["status"];
      action.updatedAt = new Date().toISOString();
      await (kv as ViewerKv).set(KV.actions, action.id, action);
      json(res, 200, { success: true, action }, req);
      return;
    }

    if (method === "POST" && pathname === "/agentmemory/todo-extract/generate") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const startedAt = new Date().toISOString();
      await writeTodoExtractStatus(kv as ViewerKv, { status: "running", startedAt });
      try {
        const result = await generateTodosFromSessions(kv as ViewerKv, body);
        await writeTodoExtractStatus(kv as ViewerKv, {
          status: "done",
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: result as unknown as Record<string, unknown>,
        });
        json(res, 200, result, req);
      } catch (err) {
        await writeTodoExtractStatus(kv as ViewerKv, {
          status: "error",
          startedAt,
          finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return;
    }

    if (method === "POST" && pathname === "/agentmemory/todo/action-refresh") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const actionId = asText(body.actionId);
      if (!actionId) {
        json(res, 400, { error: "actionId is required" }, req);
        return;
      }
      const result = await refreshTodoAction(kv as ViewerKv, { actionId });
      if (!result.success && result.reason === "action-not-found") {
        json(res, 404, result, req);
        return;
      }
      if (!result.success) {
        json(res, 400, result, req);
        return;
      }
      json(res, 200, result, req);
      return;
    }

    if (method === "POST" && pathname === "/agentmemory/todo/update") {
      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const mode = body.mode === "apply" ? "apply" : "dry-run";
      const scope = body.scope === "all" ? "all" : "changed";
      const maxCards =
        typeof body.maxCards === "number" && body.maxCards > 0 ? Math.floor(body.maxCards) : undefined;
      // On apply, the viewer passes back the dry-run decisions so they are applied
      // verbatim instead of re-calling the (non-deterministic) LLM.
      const decisions = Array.isArray(body.decisions) ? body.decisions as never : undefined;
      const result = await updateChangedTodoCards(kv as ViewerKv, { mode, maxCards, scope, decisions });
      json(res, 200, result, req);
      return;
    }

    if (pathname === "/agentmemory/config/todo-extractor" && (method === "GET" || method === "POST")) {
      if (method === "POST") {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
        const updates: Record<string, string> = {};
        // Single writable-keys source of truth (mirrors api::todo-extractor-config)
        // so a UI field (e.g. the LLM timeout) can never silently drop on save.
        WRITABLE_TODO_EXTRACT_KEYS.forEach((key) => {
          const value = asText(body[key]);
          if (value && !/[\r\n]/.test(value)) updates[key] = value;
        });
        if (Object.keys(updates).length) writeUserEnv(updates);
      }
      json(res, 200, {
        success: true,
        envPath: getUserEnvPath(),
        config: getTodoExtractorUserConfig(),
        restartRequired: false,
      }, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/frontier") {
      const params = parseViewerQuery(qs);
      const limit = Math.max(1, Math.min(200, parseInt(params.limit || "20", 10) || 20));
      const allActions = await (kv as ViewerKv).list<Action>(KV.actions);
      const frontier = allActions
        .filter((action) => action.status !== "done" && action.status !== "cancelled")
        .filter((action) => !params.project || action.project === params.project)
        .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""))
        .slice(0, limit)
        .map((action, index) => ({ action, score: limit - index, blockers: [], leased: false }));
      json(res, 200, {
        success: true,
        frontier,
        totalActions: allActions.length,
        totalUnblocked: frontier.length,
      }, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/sessions") {
      const sessions = await (kv as ViewerKv).list<Session>(KV.sessions);
      sessions.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
      json(res, 200, { sessions }, req);
      return;
    }

    if (method === "GET" && pathname === "/agentmemory/observations") {
      const params = parseViewerQuery(qs);
      const sessionId = params.sessionId || "";
      if (!sessionId) {
        json(res, 400, { error: "sessionId required" }, req);
        return;
      }
      const observations = await (kv as ViewerKv).list<CompressedObservation>(KV.observations(sessionId));
      observations.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
      json(res, 200, { observations }, req);
      return;
    }

    try {
      await proxyToRestApi(resolvedRestPort, pathname, qs, method, req, res, secret);
    } catch (err) {
      console.error(`[viewer] proxy error on ${method} ${pathname}:`, err);
      json(res, 502, { error: "upstream error" }, req);
    }
  });

  let attempt = 0;
  let currentPort = requestedPort;

  const tryListen = (): void => {
    server.listen(currentPort, "127.0.0.1");
  };

  server.on("listening", () => {
    const addr = server.address();
    boundViewerPort =
      addr && typeof addr === "object" && "port" in addr
        ? addr.port
        : currentPort;
    viewerSkipped = false;
    if (currentPort === requestedPort) {
      console.log(`[agentmemory] Viewer: http://localhost:${currentPort}`);
    } else {
      console.log(
        `[agentmemory] Viewer started on http://localhost:${currentPort} (fallback from ${requestedPort})`,
      );
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE" && attempt < MAX_VIEWER_PORT_RETRIES) {
      attempt++;
      currentPort = requestedPort + attempt;
      setImmediate(tryListen);
      return;
    }
    if (err.code === "EADDRINUSE") {
      boundViewerPort = null;
      viewerSkipped = true;
      console.warn(
        `[agentmemory] Viewer ports ${requestedPort}-${requestedPort + MAX_VIEWER_PORT_RETRIES} all in use, skipping viewer.`,
      );
    } else {
      boundViewerPort = null;
      viewerSkipped = true;
      console.error(`[agentmemory] Viewer error:`, err.message);
    }
  });

  tryListen();

  return server;
}

async function proxyToRestApi(
  restPort: number,
  pathname: string,
  qs: string,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
  secret?: string,
): Promise<void> {
  const upstreamPath = pathname.startsWith("/agentmemory/")
    ? pathname
    : `/agentmemory${pathname.startsWith("/") ? pathname : "/" + pathname}`;

  const upstreamUrl = `http://127.0.0.1:${restPort}${upstreamPath}${qs ? "?" + qs : ""}`;

  const headers: Record<string, string> = {};
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }
  const ct = req.headers["content-type"];
  if (ct) {
    headers["Content-Type"] = ct;
  }

  let body: string | undefined;
  if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
    body = await readBody(req);
  }

  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), proxyTimeoutMsForPath(upstreamPath));
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: body || undefined,
      signal: controller.signal,
    });
    clearTimeout(fetchTimeout);
  } catch (err) {
    clearTimeout(fetchTimeout);
    if (err instanceof Error && err.name === "AbortError") {
      json(res, 504, { error: "upstream timeout" }, req);
      return;
    }
    throw err;
  }

  const cors = corsHeaders(req);
  const responseBody = await upstream.text();
  const responseHeaders: Record<string, string> = {
    ...cors,
  };
  const upstreamCt = upstream.headers.get("content-type");
  if (upstreamCt) {
    responseHeaders["Content-Type"] = upstreamCt;
  }

  res.writeHead(upstream.status, responseHeaders);
  res.end(responseBody);
}
