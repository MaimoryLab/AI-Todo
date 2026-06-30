import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadSecrets, parseSettingsUpdate, publicConfig, saveEnvConfig, settingsToEnv } from "../config.js";
import type { Database } from "../db/index.js";
import { getAppPaths, type AppPaths } from "../paths.js";
import { ingestBrowserSession, validateBrowserSessionInput } from "../sources/browser.js";
import { scanConfiguredSources, scanSource as scanSourceSessions, type ConfiguredScanSummary } from "../sources/scan.js";
import { listSessionObservations, listSessions, listSources } from "../sources/service.js";
import { organizeConfiguredTodos } from "../todos/configured.js";
import { getOrganizeRun, listTodoEvidence, listTodos, type OrganizeOptions, updateTodoStatus } from "../todos/service.js";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public/", import.meta.url));

export type StartupScanStatus = {
  status: "idle" | "indexing" | "ready" | "failed";
  startedAt?: string;
  finishedAt?: string;
  sources: ConfiguredScanSummary["sources"];
  warnings: string[];
};

export function createStartupScanner(db: Database, paths: AppPaths): { status: StartupScanStatus; start: () => void } {
  const status: StartupScanStatus = { status: "idle", sources: [], warnings: [] };
  let running = false;
  return {
    status,
    start: () => {
      if (running || status.status === "ready") return;
      running = true;
      status.status = "indexing";
      status.startedAt = new Date().toISOString();
      setImmediate(() => {
        try {
          const result = scanConfiguredSources(db, paths);
          status.sources = result.sources;
          status.warnings = result.warnings;
          status.status = result.warnings.length > 0 ? "failed" : "ready";
        } catch (error) {
          status.warnings = [(error as Error).message || "startup_scan_failed"];
          status.status = "failed";
        } finally {
          status.finishedAt = new Date().toISOString();
          running = false;
        }
      });
    }
  };
}

export function createAppServer(options: {
  db?: Database;
  paths?: AppPaths;
  organizeOptions?: OrganizeOptions;
  startupScan?: StartupScanStatus;
} = {}) {
  const paths = options.paths ?? getAppPaths();
  return createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (req.method === "GET" && (path === "/" || path.startsWith("/app."))) {
      if (serveStatic(res, path)) return;
    }

    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && path === "/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && path === "/startup/scan") {
      writeJson(res, 200, options.startupScan ?? { status: "idle", sources: [], warnings: [] });
      return;
    }

    if (req.method === "GET" && path === "/settings") {
      try {
        writeJson(res, 200, publicConfig(loadConfig(paths), loadSecrets(paths)));
      } catch {
        writeJson(res, 500, { error: "config_invalid" });
      }
      return;
    }

    if (req.method === "PUT" && path === "/settings") {
      const body = await readJson(req, res);
      if (!body) return;
      try {
        const currentSecrets = loadSecrets(paths);
        const { config, apiKey } = parseSettingsUpdate(body);
        saveEnvConfig(paths, settingsToEnv(config, currentSecrets, apiKey));
        writeJson(res, 200, publicConfig(config, loadSecrets(paths)));
      } catch {
        writeJson(res, 400, { error: "config_invalid" });
      }
      return;
    }

    if (req.method === "GET" && path === "/sources") {
      const db = requireDb(res, options.db);
      if (!db) return;
      writeJson(res, 200, listSources(db));
      return;
    }

    if (req.method === "POST" && path === "/sources/scan") {
      const db = requireDb(res, options.db);
      if (!db) return;
      const body = await readJson(req, res);
      if (!body) return;
      const result = scanSource(db, body, paths);
      writeJson(res, result.status, result.body);
      return;
    }

    if (req.method === "GET" && path === "/sessions") {
      const db = requireDb(res, options.db);
      if (!db) return;
      writeJson(res, 200, listSessions(db));
      return;
    }

    const sessionObservationsMatch = path.match(/^\/sessions\/([^/]+)\/observations$/);
    if (req.method === "GET" && sessionObservationsMatch) {
      const db = requireDb(res, options.db);
      if (!db) return;
      const observations = listSessionObservations(db, decodeURIComponent(sessionObservationsMatch[1]));
      if (!observations) {
        writeJson(res, 404, { error: "session_not_found" });
        return;
      }
      writeJson(res, 200, observations);
      return;
    }

    if (req.method === "POST" && path === "/browser/sessions") {
      const db = requireDb(res, options.db);
      if (!db) return;
      const body = await readJson(req, res);
      if (!body) return;
      const validated = validateBrowserSessionInput(body);
      if (!validated.ok) {
        writeJson(res, 400, { error: validated.error });
        return;
      }
      writeJson(res, 200, ingestBrowserSession(db, validated.input));
      return;
    }

    if (req.method === "POST" && path === "/todos/organize") {
      const db = requireDb(res, options.db);
      if (!db) return;
      try {
        writeJson(res, 200, await organizeConfiguredTodos(db, paths, options.organizeOptions));
      } catch (error) {
        writeJson(res, 500, {
          error: "organize_failed",
          warnings: ["organize_failed"],
          message: (error as Error).message
        });
      }
      return;
    }

    if (req.method === "GET" && path === "/todos") {
      const db = requireDb(res, options.db);
      if (!db) return;
      writeJson(res, 200, listTodos(db));
      return;
    }

    const todoEvidenceMatch = path.match(/^\/todos\/([^/]+)\/evidence$/);
    if (req.method === "GET" && todoEvidenceMatch) {
      const db = requireDb(res, options.db);
      if (!db) return;
      const evidence = listTodoEvidence(db, decodeURIComponent(todoEvidenceMatch[1]));
      if (!evidence) {
        writeJson(res, 404, { error: "todo_not_found" });
        return;
      }
      writeJson(res, 200, evidence);
      return;
    }

    const todoMatch = path.match(/^\/todos\/([^/]+)$/);
    if (req.method === "PATCH" && todoMatch) {
      const db = requireDb(res, options.db);
      if (!db) return;
      const body = await readJson(req, res);
      if (!body) return;
      if (body.status !== "done" && body.status !== "ignored") {
        writeJson(res, 400, { error: "invalid_status" });
        return;
      }
      const id = decodeURIComponent(todoMatch[1]);
      if (!updateTodoStatus(db, id, body.status)) {
        writeJson(res, 404, { error: "todo_not_found" });
        return;
      }
      writeJson(res, 200, listTodos(db).find((todo) => todo.id === id));
      return;
    }

    const organizeRunMatch = path.match(/^\/organize-runs\/([^/]+)$/);
    if (req.method === "GET" && organizeRunMatch) {
      const db = requireDb(res, options.db);
      if (!db) return;
      const run = getOrganizeRun(db, decodeURIComponent(organizeRunMatch[1]));
      if (!run) {
        writeJson(res, 404, { error: "organize_run_not_found" });
        return;
      }
      writeJson(res, 200, run);
      return;
    }

    writeJson(res, 404, { error: "not_found" });
  });
}

function serveStatic(res: ServerResponse<IncomingMessage>, path: string): boolean {
  const filename = path === "/" ? "index.html" : path.slice(1);
  if (!/^(index\.html|app\.css|app\.js)$/.test(filename)) return false;
  const file = join(PUBLIC_DIR, filename);
  if (!existsSync(file)) return false;
  res.writeHead(200, { "content-type": contentType(file) });
  createReadStream(file).pipe(res);
  return true;
}

function contentType(file: string): string {
  if (extname(file) === ".css") return "text/css; charset=utf-8";
  if (extname(file) === ".js") return "text/javascript; charset=utf-8";
  return "text/html; charset=utf-8";
}

function writeJson(res: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireDb(res: ServerResponse<IncomingMessage>, db: Database | undefined): Database | null {
  if (db) return db;
  writeJson(res, 503, { error: "database_unavailable" });
  return null;
}

async function readJson(req: IncomingMessage, res: ServerResponse<IncomingMessage>): Promise<any | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    writeJson(res, 400, { error: "invalid_json" });
    return null;
  }
}

function scanSource(db: Database, body: any, paths: AppPaths) {
  const scan = scanSourceSessions(db, body?.source, body?.path, paths);
  if (!scan.ok) return { status: scan.status, body: { error: scan.error } };
  return { status: 200, body: scan.result };
}
