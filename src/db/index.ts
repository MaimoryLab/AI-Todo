import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppPaths } from "../paths.js";

export type Database = DatabaseSync;

const CLEAN_TRANSCRIPT_VERSION = "2";

export function openDatabase(paths: AppPaths): Database {
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  const db = new DatabaseSync(paths.dbPath);
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      project_path TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS observations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scan_checkpoints (
      source TEXT NOT NULL,
      path TEXT NOT NULL,
      mtime_ms REAL NOT NULL,
      size INTEGER NOT NULL,
      PRIMARY KEY (source, path)
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      status TEXT NOT NULL,
      chain_node_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_chains (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source TEXT NOT NULL,
      project_path TEXT,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL,
      current_node_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_chain_nodes (
      id TEXT PRIMARY KEY,
      chain_id TEXT NOT NULL,
      observation_id TEXT,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      next_step TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      todo_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organize_runs (
      id TEXT PRIMARY KEY,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  migrateSessionProjectPath(db);
  migrateTodoMetadata(db);
  migrateTodoChainNode(db);
  migrateCleanTranscript(db);
}

function migrateSessionProjectPath(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "project_path")) return;
  db.exec("ALTER TABLE sessions ADD COLUMN project_path TEXT");
}

function migrateTodoMetadata(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "metadata_json")) return;
  db.exec("ALTER TABLE todos ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
}

function migrateTodoChainNode(db: Database): void {
  const columns = db.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "chain_node_id")) return;
  db.exec("ALTER TABLE todos ADD COLUMN chain_node_id TEXT");
}

function migrateCleanTranscript(db: Database): void {
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'clean_transcript_version'").get() as { value: string } | undefined;
  if (row?.value === CLEAN_TRANSCRIPT_VERSION) return;
  db.exec(`
    DELETE FROM evidence;
    DELETE FROM organize_runs;
    DELETE FROM observations;
    DELETE FROM sessions;
    DELETE FROM scan_checkpoints;
  `);
  db.prepare(
    "INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('clean_transcript_version', ?)"
  ).run(CLEAN_TRANSCRIPT_VERSION);
}
