import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { createAppServer } from "../src/server/index.js";
import { ingestBrowserSession } from "../src/sources/browser.js";
import { listTodos, organizeTodos, scopeObservations } from "../src/todos/service.js";

test("organize without an LLM extractor creates no rule fallback cards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-no-llm-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: "Please add a CLI doctor command" },
        { role: "assistant", text: "Implemented the doctor command" }
      ]
    });

    const result = await organizeTodos(db);
    const todos = listTodos(db);
    db.close();

    assert.equal(result.engine, "llm");
    assert.deepEqual(result.warnings, ["llm_config_missing"]);
    assert.equal(result.scanned, 2);
    assert.equal(result.created, 0);
    assert.equal(result.updated, 0);
    assert.equal(todos.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize endpoint returns zero cards when LLM config is missing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-http-"));
  const paths = getAppPaths(dir);
  const db = openDatabase(paths);
  ingestBrowserSession(db, {
    id: "browser-1",
    messages: [{ role: "user", text: "Need update settings persistence" }]
  });
  const server = createAppServer({ db, paths });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/todos/organize`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.engine, "llm");
    assert.equal(result.created, 0);
    assert.equal(result.ignored, 0);
    assert.deepEqual(result.warnings, ["llm_config_missing"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize endpoint can use configured llm extraction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-http-llm-"));
  const paths = getAppPaths(dir);
  const db = openDatabase(paths);
  ingestBrowserSession(db, {
    id: "browser-1",
    messages: [{ role: "user", text: "Please add HTTP LLM cards" }]
  });
  const observationId = String((db.prepare("SELECT id FROM observations LIMIT 1").get() as any).id);
  const server = createAppServer({
    db,
    paths,
    organizeOptions: {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Add HTTP LLM cards",
          description: "Use the configured LLM path from the HTTP endpoint.",
          confidence: 0.9,
          sourceObservationId: observationId,
          quote: "Please add HTTP LLM cards",
          dedupeKey: "http-llm-cards"
        }]
      })
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/todos/organize`, { method: "POST" });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.engine, "llm");
    assert.equal(result.created, 1);
    assert.deepEqual(result.warnings, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize creates grounded cards and dedupes by model key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-llm-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: "Please add LLM settings UI" },
        { role: "assistant", text: "I will add LLM settings UI controls." }
      ]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    const extractor = async () => ({
      ok: true as const,
      todos: [{
        title: "Add LLM settings UI",
        description: "Add settings controls for the LLM provider.",
        confidence: 0.91,
        sourceObservationId: observationId,
        quote: "Please add LLM settings UI",
        dedupeKey: "add-llm-settings-ui"
      }]
    });
    const result = await organizeTodos(db, { llmExtractor: extractor });
    const second = await organizeTodos(db, { llmExtractor: extractor });
    const todos = listTodos(db);
    db.close();

    assert.equal(result.engine, "llm");
    assert.deepEqual(result.warnings, []);
    assert.equal(result.created, 1);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 1);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].title, "Add LLM settings UI");
    assert.equal(todos[0].evidenceIds.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize batches input without rules fallback for failed batches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-llm-batch-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: "Please add batched card one" },
        { role: "user", text: "Please add batched card two" },
        { role: "user", text: "Please add batched card three" }
      ]
    });
    let calls = 0;
    const result = await organizeTodos(db, {
      limits: { llmBatchSize: 2 },
      llmExtractor: async (observations) => {
        calls++;
        if (calls === 2) return { ok: false, warning: "llm_timeout" };
        const observation = observations.find((item) => item.role === "user")!;
        return {
          ok: true,
          todos: [{
            title: "LLM batched card one",
            description: "Create the first batched card through LLM.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: "batched-card-one"
          }]
        };
      }
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(calls, 2);
    assert.equal(result.engine, "llm");
    assert.deepEqual(result.warnings.sort(), ["llm_batch_failed", "llm_timeout"].sort());
    assert.equal(result.created, 1);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].title, "LLM batched card one");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize batches by session instead of mixing sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-session-batch-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: "Please add session one card" },
        { role: "assistant", text: "I will add session one card." }
      ]
    });
    ingestBrowserSession(db, {
      id: "browser-2",
      messages: [
        { role: "user", text: "Please add session two card" },
        { role: "assistant", text: "I will add session two card." }
      ]
    });
    const calls: string[][] = [];
    const result = await organizeTodos(db, {
      limits: { llmBatchSize: 20 },
      llmExtractor: async (observations) => {
        calls.push(Array.from(new Set(observations.map((item) => item.sessionId))));
        const observation = observations.find((item) => item.role === "user")!;
        return {
          ok: true,
          todos: [{
            title: observation.text.replace("Please add", "Add"),
            description: "Create the session scoped todo card.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: observation.sessionId
          }]
        };
      }
    });
    db.close();

    assert.equal(result.created, 2);
    assert.deepEqual(calls, [["browser-1"], ["browser-2"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize applies batch payload budget per LLM request instead of globally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-batch-budget-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    for (const sessionId of ["budget-1", "budget-2", "budget-3"]) {
      ingestBrowserSession(db, {
        id: sessionId,
        messages: [{ role: "user", text: `Please add ${sessionId} card` }]
      });
    }

    const sessionsSeen: string[] = [];
    const result = await organizeTodos(db, {
      limits: {
        maxTotalTextChars: 1000,
        maxBatchPayloadChars: 40,
        llmBatchSize: 20
      },
      llmExtractor: async (observations) => {
        const observation = observations.find((item) => item.role === "user")!;
        sessionsSeen.push(observation.sessionId);
        return {
          ok: true,
          todos: [{
            title: `Add ${observation.sessionId} card`,
            description: "Create the card from a separate LLM request.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: observation.sessionId
          }]
        };
      }
    });
    db.close();

    assert.equal(result.created, 3);
    assert.deepEqual(sessionsSeen.sort(), ["budget-1", "budget-2", "budget-3"]);
    assert.ok(!result.warnings.includes("organize_scope_truncated"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize extracts batches with bounded concurrency", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-concurrency-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    for (const sessionId of ["concurrent-1", "concurrent-2", "concurrent-3", "concurrent-4"]) {
      ingestBrowserSession(db, {
        id: sessionId,
        messages: [{ role: "user", text: `Please add ${sessionId} card` }]
      });
    }

    let active = 0;
    let maxActive = 0;
    const result = await organizeTodos(db, {
      limits: { llmBatchSize: 20, llmConcurrency: 2 },
      llmExtractor: async (observations) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active--;
        const observation = observations.find((item) => item.role === "user")!;
        return {
          ok: true,
          todos: [{
            title: `Add ${observation.sessionId} card`,
            description: "Create the card from a concurrent LLM request.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: observation.sessionId
          }]
        };
      }
    });
    db.close();

    assert.equal(result.created, 4);
    assert.equal(maxActive, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize limits scoped observations before LLM extraction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-limits-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: `Please add ${"x".repeat(30)} one` },
        { role: "user", text: "Please add limited block two" },
        { role: "user", text: "Please add limited block three" }
      ]
    });
    const result = await organizeTodos(db, {
      limits: {
        maxUserBlocks: 2,
        maxTotalTextChars: 80,
        maxBlockTextChars: 20,
        llmBatchSize: 20
      },
      llmExtractor: async (observations) => {
        assert.equal(observations.filter((item) => item.role === "user").length, 2);
        assert.ok(observations.every((item) => item.text.length <= 20));
        return { ok: true, todos: [] };
      }
    });
    db.close();

    assert.equal(result.engine, "llm");
    assert.ok(result.warnings.includes("llm_input_truncated"));
    assert.ok(result.warnings.includes("organize_scope_truncated"));
    assert.ok(result.warnings.includes("llm_no_valid_candidates"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize limits newest sessions before per-session extraction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-max-sessions-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    insertObservation(db, "old-obs", "old-session", "browser", "user", "Please add old card", new Date(Date.now() - 60_000).toISOString());
    insertObservation(db, "new-obs", "new-session", "browser", "user", "Please add new card", new Date(Date.now()).toISOString());

    const calls: string[] = [];
    const result = await organizeTodos(db, {
      scope: { sinceDays: 7, maxInteractionsPerSession: 10, maxSessions: 1, maxObservationsPerSession: 40 },
      llmExtractor: async (observations) => {
        const observation = observations.find((item) => item.role === "user")!;
        calls.push(observation.sessionId);
        return {
          ok: true,
          todos: [{
            title: "Add new card",
            description: "Create the newest scoped todo card.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: "new-card"
          }]
        };
      }
    });
    db.close();

    assert.deepEqual(calls, ["new-session"]);
    assert.equal(result.created, 1);
    assert.ok(result.warnings.includes("organize_scope_truncated"));
    assert.equal(result.details?.scope?.sessionsDropped, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize trims final LLM payload for user and assistant text with details", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-payload-budget-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: `Please add ${"user ".repeat(100)}card` },
        { role: "assistant", text: `Assistant status ${"assistant ".repeat(100)}remaining work` }
      ]
    });
    const result = await organizeTodos(db, {
      limits: {
        maxUserBlocks: 120,
        maxTotalTextChars: 80000,
        maxBlockTextChars: 3000,
        llmBatchSize: 20,
        maxObservationTextChars: 60,
        maxSessionPayloadChars: 160,
        maxBatchPayloadChars: 220
      },
      llmExtractor: async (observations) => {
        assert.ok(observations.some((item) => item.role === "assistant" && item.text.length <= 60));
        assert.ok(observations.every((item) => item.text.length <= 60));
        return { ok: true, todos: [] };
      }
    });
    db.close();

    assert.ok(result.warnings.includes("llm_input_truncated"));
    assert.ok(result.details?.truncations?.some((item) => item.sessionId === "browser-1" && item.role === "assistant"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize records provider failure details while other sessions succeed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-failure-details-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, { id: "failed-session", messages: [{ role: "user", text: "Please add failed card" }] });
    ingestBrowserSession(db, { id: "ok-session", messages: [{ role: "user", text: "Please add ok card" }] });

    const result = await organizeTodos(db, {
      llmExtractor: async (observations) => {
        const observation = observations.find((item) => item.role === "user")!;
        if (observation.sessionId === "failed-session") {
          return { ok: false, warning: "llm_provider_failed", reason: "http_401", retryable: true };
        }
        return {
          ok: true,
          todos: [{
            title: "Add ok card",
            description: "Create the card from the successful session.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: "ok-card"
          }]
        };
      }
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(result.created, 1);
    assert.equal(todos.length, 1);
    assert.ok(result.warnings.includes("llm_provider_failed"));
    assert.ok(result.warnings.includes("llm_batch_failed"));
    assert.deepEqual(result.details?.batchFailures?.map((item) => ({
      sessionId: item.sessionId,
      warning: item.warning,
      reason: item.reason,
      retryable: item.retryable
    })), [{
      sessionId: "failed-session",
      warning: "llm_provider_failed",
      reason: "http_401",
      retryable: true
    }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize rejects process, status, and tool-polluted candidates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-quality-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: "我会做最后一次状态确认，确保工作区干净。服务可用，健康检查已完成。" },
        { role: "assistant", text: "Bash(git status) process exited 0" }
      ]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);
    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "做最后一次状态确认",
          description: "确认工作区干净并检查服务可用。",
          confidence: 0.95,
          sourceObservationId: observationId,
          quote: "做最后一次状态确认",
          dedupeKey: "final-status-check"
        }]
      })
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(result.created, 0);
    assert.deepEqual(result.warnings, ["llm_no_valid_candidates"]);
    assert.equal(todos.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize suppresses near duplicate cards with different model keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-near-dupe-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [
        { role: "user", text: "后续需要修复 CI 失败，并重新跑测试。" },
        { role: "user", text: "需要重新跑测试并修复 CI 失败。" }
      ]
    });
    const rows = db.prepare("SELECT id, text FROM observations WHERE role = 'user' ORDER BY id").all() as Array<{ id: string; text: string }>;
    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [
          {
            title: "修复 CI 失败并重新跑测试",
            description: "后续需要修复 CI 失败，并重新跑测试。",
            confidence: 0.9,
            sourceObservationId: rows[0].id,
            quote: rows[0].text,
            dedupeKey: "fix-ci-rerun-tests"
          },
          {
            title: "重新跑测试并修复 CI 失败",
            description: "需要重新跑测试并修复 CI 失败。",
            confidence: 0.88,
            sourceObservationId: rows[1].id,
            quote: rows[1].text,
            dedupeKey: "rerun-tests-fix-ci"
          }
        ]
      })
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(result.created, 1);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].title, "修复 CI 失败并重新跑测试");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm unavailable returns warnings without creating rules cards", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-llm-unavailable-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [{ role: "user", text: "Please add fallback warnings" }]
    });

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({ ok: false, warning: "llm_config_missing" })
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(result.engine, "llm");
    assert.deepEqual(result.warnings, ["llm_config_missing"]);
    assert.equal(result.created, 0);
    assert.equal(todos.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize rejects ungrounded model output without rules fallback", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-llm-invalid-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [{ role: "user", text: "Please add grounded evidence checks" }]
    });
    const observationId = String((db.prepare("SELECT id FROM observations LIMIT 1").get() as any).id);

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Add unrelated todo",
          description: "This quote is not grounded.",
          confidence: 0.9,
          sourceObservationId: observationId,
          quote: "missing quote",
          dedupeKey: "bad"
        }]
      })
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(result.engine, "llm");
    assert.deepEqual(result.warnings, ["llm_no_valid_candidates"]);
    assert.equal(result.created, 0);
    assert.equal(todos.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize scope filters old observations and keeps recent interactions per session", () => {
  const now = Date.now();
  const observations = [
    observation("old", "s1", "user", "old", new Date(now - 10 * 86400000).toISOString()),
    observation("u1", "s1", "user", "one", new Date(now - 3000).toISOString()),
    observation("a1", "s1", "assistant", "reply one", new Date(now - 2500).toISOString()),
    observation("u2", "s1", "user", "two", new Date(now - 2000).toISOString()),
    observation("a2", "s1", "assistant", "reply two", new Date(now - 1500).toISOString()),
    observation("u3", "s1", "user", "three", new Date(now - 1000).toISOString())
  ];
  assert.deepEqual(
    scopeObservations(observations, { sinceDays: 7, maxInteractionsPerSession: 2 }).map((item) => item.id),
    ["u2", "a2", "u3"]
  );
});

function observation(id: string, sessionId: string, role: string, text: string, createdAt: string) {
  return { id, sessionId, source: "browser" as const, role, text, createdAt };
}

function insertObservation(
  db: ReturnType<typeof openDatabase>,
  id: string,
  sessionId: string,
  source: string,
  role: string,
  text: string,
  createdAt: string
) {
  db.prepare("INSERT OR REPLACE INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(sessionId, source, sessionId, createdAt);
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    sessionId,
    source,
    role,
    text,
    createdAt
  );
}
