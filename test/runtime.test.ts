import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";
import { openDatabase } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { createAppServer } from "../src/server/index.js";

test("doctor creates config, data, and database paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-"));
  const previous = process.env.AI_TODO_HOME;
  process.env.AI_TODO_HOME = dir;

  try {
    const doctor = await capture(() => main(["doctor"]));
    assert.equal(doctor.code, 0);
    assert.match(doctor.stdout, /llm enabled: true/);
    assert.match(doctor.stdout, /env status: missing; run ai-todo init/);
    assert.match(doctor.stdout, /llm key: missing/);
    assert.match(doctor.stdout, /llm model: deepseek\/deepseek-v4-flash/);
    assert.match(doctor.stdout, /llm endpoint: https:\/\/api\.novita\.ai\/openai\/v1/);
    assert.doesNotMatch(doctor.stdout, /llm python|llm runtime/);
    const db = openDatabase(getAppPaths(dir));
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    db.close();
    assert.ok(rows.some((row) => row.name === "sessions"));
  } finally {
    process.env.AI_TODO_HOME = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("healthz returns ok", async () => {
  const server = createAppServer();

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("sessions endpoint omits zero-observation sessions and returns preview metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-session-list-"));
  const db = openDatabase(getAppPaths(dir));
  const server = createAppServer({ db });

  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES ('empty', 'claude-code', 'empty.jsonl', '2026-01-01T00:00:00.000Z')").run();
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES ('visible', 'codex', 'visible.jsonl', '2026-01-02T00:00:00.000Z')").run();
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES ('obs1', 'visible', 'codex', 'user', 'Please show this preview', '2026-01-02T00:00:00.000Z')").run();

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/sessions`);
    assert.equal(response.status, 200);
    const sessions = await response.json();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, "visible");
    assert.equal(sessions[0].observationCount, 1);
    assert.equal(sessions[0].preview, "Please show this preview");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("database migration clears noisy pre-clean transcript data once", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-clean-migration-"));
  const paths = getAppPaths(dir);
  try {
    let db = openDatabase(paths);
    db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES ('s1', 'codex', 'old.jsonl', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES ('o1', 's1', 'codex', 'user', 'old noisy text', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO scan_checkpoints (source, path, mtime_ms, size) VALUES ('codex', 'old.jsonl', 1, 1)").run();
    db.prepare("INSERT INTO todos (id, title, description, status, updated_at) VALUES ('t1', 'Old', 'Old noisy todo', 'done', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO todos (id, title, description, status, updated_at) VALUES ('t-ignore', 'Ignored', 'Ignored noisy todo', 'ignored', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO evidence (id, todo_id, observation_id, text) VALUES ('e1', 't1', 'o1', 'old evidence')").run();
    db.prepare("INSERT INTO organize_runs (id, result_json, created_at) VALUES ('r1', '{}', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("UPDATE schema_meta SET value = '0' WHERE key = 'clean_transcript_version'").run();
    db.close();

    db = openDatabase(paths);
    for (const table of ["sessions", "observations", "scan_checkpoints", "evidence", "organize_runs"]) {
      const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 0, table);
    }
    const keptTodo = db.prepare("SELECT title, description, status FROM todos WHERE id = 't1'").get() as { title: string; description: string; status: string };
    assert.equal(keptTodo.title, "Old");
    assert.equal(keptTodo.description, "Old noisy todo");
    assert.equal(keptTodo.status, "done");
    assert.equal((db.prepare("SELECT status FROM todos WHERE id = 't-ignore'").get() as { status: string }).status, "ignored");
    db.prepare("INSERT INTO todos (id, title, description, status, updated_at) VALUES ('t2', 'Fresh', 'Fresh LLM todo', 'todo', '2026-01-02T00:00:00.000Z')").run();
    db.close();

    db = openDatabase(paths);
    const row = db.prepare("SELECT COUNT(*) as count FROM todos").get() as { count: number };
    db.close();
    assert.equal(row.count, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function capture(fn: () => Promise<number>) {
  let stdout = "";
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    stdout += `${args.join(" ")}\n`;
  };
  try {
    return { code: await fn(), stdout };
  } finally {
    console.log = originalLog;
  }
}
