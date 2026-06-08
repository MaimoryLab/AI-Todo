import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { renderViewerDocument } from "./document.js";

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
  "http://localhost:3111,http://localhost:3113,http://127.0.0.1:3111,http://127.0.0.1:3113"
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

const MAX_VIEWER_PORT_RETRIES = 10;

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
  _kv: unknown,
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
  const fetchTimeout = setTimeout(() => controller.abort(), 10000);
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
