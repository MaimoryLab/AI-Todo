import type { ObservationRecord, SessionRecord, SourceKind } from "../contracts.js";
import type { Database } from "../db/index.js";

const SOURCES: SourceKind[] = ["codex", "claude-code", "browser"];
export interface ListSessionsOptions {
  source?: SourceKind;
  sessionId?: string;
  limit?: number;
  offset?: number;
}

export function listSources(db: Database) {
  return SOURCES.map((source) => ({
    source,
    sessions: count(db, "sessions", source),
    checkpoints: count(db, "scan_checkpoints", source)
  }));
}

export function listSessions(db: Database, options: ListSessionsOptions = {}): SessionRecord[] {
  const conditions = [];
  const params: Array<string | number> = [];
  if (options.source) {
    conditions.push("sessions.source = ?");
    params.push(options.source);
  }
  if (options.sessionId) {
    conditions.push("sessions.id = ?");
    params.push(options.sessionId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = options.limit ?? -1;
  const offset = options.offset ?? 0;
  params.push(limit, offset);
  return db.prepare(
    `SELECT
      sessions.id,
      sessions.source,
      sessions.path,
      sessions.updated_at as updatedAt,
      COUNT(observations.id) as observationCount,
      COALESCE((
        SELECT text
        FROM observations preview
        WHERE preview.session_id = sessions.id
          AND preview.role IN ('user', 'assistant')
        ORDER BY preview.created_at, preview.id
        LIMIT 1
      ), '') as preview
    FROM sessions
    JOIN observations ON observations.session_id = sessions.id
    ${where}
    GROUP BY sessions.id
    HAVING observationCount > 0
    ORDER BY sessions.updated_at DESC
    LIMIT ? OFFSET ?`
  ).all(...params).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      source: record.source as SessionRecord["source"],
      path: String(record.path),
      updatedAt: String(record.updatedAt),
      observationCount: Number(record.observationCount),
      preview: String(record.preview)
    };
  });
}

export function listSessionObservations(db: Database, sessionId: string): ObservationRecord[] | null {
  const session = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!session) return null;
  return db.prepare(
    `SELECT
      id,
      session_id as sessionId,
      source,
      role,
      text,
      created_at as createdAt
    FROM observations
    WHERE session_id = ?
    ORDER BY created_at, id`
  ).all(sessionId).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      sessionId: String(record.sessionId),
      source: record.source as ObservationRecord["source"],
      role: String(record.role),
      text: String(record.text),
      createdAt: String(record.createdAt)
    };
  });
}

function count(db: Database, table: "sessions" | "scan_checkpoints", source: SourceKind): number {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE source = ?`).get(source) as { count: number };
  return row.count;
}
