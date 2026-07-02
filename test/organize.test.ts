import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { createAppServer } from "../src/server/index.js";
import { ingestBrowserSession } from "../src/sources/browser.js";
import { markAgentContext } from "../src/agent-context.js";
import { clearTodoData, listTodos, organizeTodos, scopeObservations } from "../src/todos/service.js";

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

test("clearTodoData removes todo-derived rows and preserves source observations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-clear-todos-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [{ role: "user", text: "Please keep source observations" }]
    });
    db.prepare(
      "INSERT INTO task_chains (id, session_id, source, title, summary, status, current_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("chain-1", "browser-1", "browser", "Chain", "Summary", "in_progress", "node-1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO task_chain_nodes (id, chain_id, observation_id, position, title, summary, owner, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("node-1", "chain-1", "browser-1:0", 0, "Current", "Summary", "agent", "current", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO todos (id, title, description, status, chain_node_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("todo-1", "Clear old card", "Old generated card", "todo", "node-1", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO evidence (id, todo_id, observation_id, text) VALUES (?, ?, ?, ?)"
    ).run("evidence-1", "todo-1", "browser-1:0", "Please keep source observations");
    db.prepare(
      "INSERT INTO organize_runs (id, result_json, created_at) VALUES (?, ?, ?)"
    ).run("run-1", "{}", "2026-01-01T00:00:00.000Z");
    db.prepare(
      "INSERT INTO organize_checkpoints (session_id, checkpoint, updated_at) VALUES (?, ?, ?)"
    ).run("browser-1", "checkpoint-1", "2026-01-01T00:00:00.000Z");

    const cleared = clearTodoData(db);

    assert.deepEqual(cleared, {
      todos: 1,
      evidence: 1,
      taskChains: 1,
      taskChainNodes: 1,
      organizeRuns: 1,
      organizeCheckpoints: 1
    });
    for (const table of ["todos", "evidence", "task_chains", "task_chain_nodes", "organize_runs", "organize_checkpoints"]) {
      assert.equal((db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number }).count, 0);
    }
    assert.equal((db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count, 1);
    assert.equal((db.prepare("SELECT COUNT(*) as count FROM observations").get() as { count: number }).count, 1);
    db.close();
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
        metadata: {
          completionState: "in_progress",
          completionSummary: "The settings UI controls are drafted; save wiring remains.",
          nextStep: "Wire the save action."
        },
        confidence: 0.91,
        sourceObservationId: observationId,
        quote: "Please add LLM settings UI",
        dedupeKey: "add-llm-settings-ui"
      }]
    });
    const result = await organizeTodos(db, { llmExtractor: extractor });
    db.prepare("UPDATE sessions SET updated_at = '2026-01-01T00:01:00.000Z' WHERE id = 'browser-1'").run();
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
    assert.equal(todos[0].metadata.completionSummary, "The settings UI controls are drafted; save wiring remains.");
    assert.equal(todos[0].metadata.nextStep, "Wire the save action.");
    assert.equal(todos[0].metadata.sourceObservationId, observationId);
    assert.equal(todos[0].metadata.confidence, 0.91);
    assert.equal(todos[0].evidenceIds.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize keeps provenance anchored to the validated source observation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-provenance-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-1",
      messages: [{ role: "user", text: "Please keep the trusted source id" }]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Keep trusted source id",
          description: "Use the validated top-level source observation for provenance.",
          metadata: {
            sourceObservationId: "llm-supplied-wrong-id"
          },
          confidence: 0.9,
          sourceObservationId: observationId,
          quote: "Please keep the trusted source id",
          dedupeKey: "trusted-source-id"
        }]
      })
    });
    const [todo] = listTodos(db);
    db.close();

    assert.equal(todo.metadata.sourceObservationId, observationId);
    assert.equal(todo.origin?.observationId, observationId);
    assert.equal(todo.origin?.projectTitle, "browser");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("todo origin trims browser project titles derived from slash paths", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-browser-origin-title-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-e2e",
      path: "Browser / E2E Check",
      messages: [{ role: "user", text: "Please keep a clean browser project title" }]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);
    await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Keep clean browser project title",
          description: "Source labels should not keep separator whitespace.",
          confidence: 0.9,
          sourceObservationId: observationId,
          quote: "Please keep a clean browser project title",
          dedupeKey: "clean-browser-project-title"
        }]
      })
    });

    const [todo] = listTodos(db);
    db.close();

    assert.equal(todo.origin?.projectTitle, "E2E Check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("todo origin prefers codex session project path over transcript path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-codex-origin-project-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    db.prepare("INSERT INTO sessions (id, source, path, project_path, updated_at) VALUES (?, 'codex', ?, ?, '2026-01-01T00:00:00.000Z')")
      .run("codex-session", "/Users/demo/.codex/sessions/2026/01/01/session.jsonl", "/Users/demo/AI-Todo");
    db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES ('obs-codex', 'codex-session', 'codex', 'user', 'Please keep Codex project names', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES ('todo-codex', 'Codex project todo', 'Project names should come from session metadata.', 'todo', ?, '2026-01-01T00:00:00.000Z')")
      .run(JSON.stringify({ sourceObservationId: "obs-codex" }));
    db.prepare("INSERT INTO evidence (id, todo_id, observation_id, text) VALUES ('evidence-codex', 'todo-codex', 'obs-codex', 'Please keep Codex project names')").run();

    const [todo] = listTodos(db);
    db.close();

    assert.equal(todo.origin?.projectPath, "/Users/demo/AI-Todo");
    assert.equal(todo.origin?.projectTitle, "AI-Todo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("todo origin falls back to session path when project path is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-origin-project-fallback-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES ('legacy-session', 'browser', 'Browser / Legacy Project', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES ('obs-legacy', 'legacy-session', 'browser', 'user', 'Please keep fallback project names', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES ('todo-legacy', 'Legacy project todo', 'Fallback path should still work.', 'todo', ?, '2026-01-01T00:00:00.000Z')")
      .run(JSON.stringify({ sourceObservationId: "obs-legacy" }));
    db.prepare("INSERT INTO evidence (id, todo_id, observation_id, text) VALUES ('evidence-legacy', 'todo-legacy', 'obs-legacy', 'Please keep fallback project names')").run();

    const [todo] = listTodos(db);
    db.close();

    assert.equal(todo.origin?.projectPath, "Browser / Legacy Project");
    assert.equal(todo.origin?.projectTitle, "Legacy Project");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("database migration adds task chain tables and keeps legacy todos listable", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-task-chain-migration-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const todoColumns = db.prepare("PRAGMA table_info(todos)").all() as Array<{ name: string }>;

    db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES ('legacy-session', 'browser', 'Browser / Legacy Chain', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES ('legacy-obs', 'legacy-session', 'browser', 'user', 'Please keep legacy cards visible', '2026-01-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES ('legacy-todo', 'Keep legacy cards visible', 'Legacy cards should not require chain data.', 'todo', ?, '2026-01-01T00:00:00.000Z')")
      .run(JSON.stringify({ sourceObservationId: "legacy-obs" }));
    db.prepare("INSERT INTO evidence (id, todo_id, observation_id, text) VALUES ('legacy-evidence', 'legacy-todo', 'legacy-obs', 'Please keep legacy cards visible')").run();

    const [todo] = listTodos(db);
    db.close();

    assert.ok(tables.some((table) => table.name === "task_chains"));
    assert.ok(tables.some((table) => table.name === "task_chain_nodes"));
    assert.ok(todoColumns.some((column) => column.name === "chain_node_id"));
    assert.equal(todo.title, "Keep legacy cards visible");
    assert.equal(todo.chain, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize persists task chains and returns current node cards with collapsed completed nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-task-chain-write-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-chain",
      path: "Browser / Chain Project",
      messages: [
        { role: "user", text: "Please redesign the todo card structure" },
        { role: "assistant", text: "Completed the data audit. Remaining work is wiring the chain view." }
      ]
    });
    const userObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);
    const assistantObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'assistant' LIMIT 1").get() as any).id);

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          chainId: "browser-chain:todo-card-structure",
          title: "Redesign todo card structure",
          summary: "The data audit is complete; the UI still needs chain containers.",
          status: "in_progress",
          completedNodes: [{
            title: "Audit existing card data",
            summary: "Confirmed legacy cards only have coarse metadata.",
            owner: "agent",
            status: "completed",
            observationId: assistantObservationId
          }],
          currentNode: {
            title: "Redesign todo card structure",
            description: "The user wanted the todo card structure redesigned, but the chain container still needs to be rendered.",
            nodeTitle: "Wire chain containers into Todo",
            owner: "agent",
            nextStep: "Agent should render the chain container and collapsed summary.",
            metadata: {
              completionState: "in_progress",
              completionSummary: "The audit is done; chain container rendering remains."
            },
            confidence: 0.92,
            sourceObservationId: userObservationId,
            quote: "Please redesign the todo card structure",
            dedupeKey: "redesign-todo-card-structure"
          }
        }]
      })
    });
    const [todo] = listTodos(db);
    const chainRows = db.prepare("SELECT id, current_node_id as currentNodeId FROM task_chains").all() as Array<{ id: string; currentNodeId: string }>;
    const nodeRows = (db.prepare("SELECT status, owner FROM task_chain_nodes ORDER BY position").all() as Array<{ status: string; owner: string }>)
      .map((row) => ({ status: row.status, owner: row.owner }));
    db.close();

    assert.equal(result.created, 1);
    assert.equal(todo.title, "Redesign todo card structure");
    assert.equal(todo.description, "The user wanted the todo card structure redesigned, but the chain container still needs to be rendered.");
    assert.equal(todo.chain?.title, "Redesign todo card structure");
    assert.equal(todo.chain?.summary, "The data audit is complete; the UI still needs chain containers.");
    assert.equal(todo.chain?.currentNode.title, "Wire chain containers into Todo");
    assert.equal(todo.chain?.currentNode.owner, "agent");
    assert.equal(todo.chain?.currentNode.nextStep, "Agent should render the chain container and collapsed summary.");
    assert.equal(todo.chain?.completedNodeCount, 1);
    assert.deepEqual(todo.chain?.completedNodes.map((node) => ({
      title: node.title,
      status: node.status,
      owner: node.owner
    })), [{
      title: "Audit existing card data",
      status: "completed",
      owner: "agent"
    }]);
    assert.equal(chainRows.length, 1);
    assert.equal(chainRows[0].currentNodeId, todo.chain?.currentNode.id);
    assert.deepEqual(nodeRows, [
      { status: "completed", owner: "agent" },
      { status: "current", owner: "agent" }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize preserves existing task chain links when a later legacy todo update arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-task-chain-preserve-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-chain-preserve",
      messages: [
        { role: "user", text: "Please preserve the task chain link" },
        { role: "assistant", text: "The chain exists; update the card text only." }
      ]
    });
    const userObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          title: "Preserve task chain link",
          summary: "The card belongs to a structured chain.",
          status: "in_progress",
          currentNode: {
            title: "Preserve chain link",
            description: "Keep chain data attached to the todo.",
            owner: "agent",
            confidence: 0.9,
            sourceObservationId: userObservationId,
            quote: "Please preserve the task chain link",
            dedupeKey: "preserve-chain-link"
          }
        }]
      })
    });

    db.prepare("UPDATE sessions SET updated_at = '2026-01-01T00:01:00.000Z' WHERE id = 'browser-chain-preserve'").run();
    await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Preserve chain link",
          description: "Update the card without dropping chain data.",
          confidence: 0.9,
          sourceObservationId: userObservationId,
          quote: "Please preserve the task chain link",
          dedupeKey: "preserve-chain-link"
        }]
      })
    });
    const [todo] = listTodos(db);
    db.close();

    assert.equal(todo.description, "Update the card without dropping chain data.");
    assert.equal(todo.chain?.title, "Preserve task chain link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize stores user-owned blocked current nodes from task chains", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-task-chain-user-owner-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-blocked-chain",
      messages: [
        { role: "user", text: "Deploy the integration when credentials are available" },
        { role: "assistant", text: "Blocked until the user provides the API key." }
      ]
    });
    const userObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          title: "Deploy the integration",
          summary: "Deployment is blocked on missing credentials.",
          status: "blocked",
          currentNode: {
            title: "Provide integration API key",
            description: "The user needs to provide the API key before deployment can continue.",
            owner: "user",
            nextStep: "User should provide the API key.",
            metadata: { completionState: "blocked" },
            confidence: 0.9,
            sourceObservationId: userObservationId,
            quote: "Deploy the integration when credentials are available",
            dedupeKey: "provide-integration-api-key"
          }
        }]
      })
    });
    const [todo] = listTodos(db);
    db.close();

    assert.equal(todo.chain?.status, "blocked");
    assert.equal(todo.chain?.currentNode.owner, "user");
    assert.equal(todo.chain?.currentNode.nextStep, "User should provide the API key.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize rejects agent-only execution current nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-agent-only-current-node-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-agent-only",
      messages: [
        { role: "user", text: "Please improve the local dashboard review flow" },
        { role: "assistant", text: "The code is ready; next I will restart the service and verify the build." }
      ]
    });
    const userObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          title: "Improve the local dashboard review flow",
          summary: "The dashboard work is ready for agent verification.",
          status: "in_progress",
          currentNode: {
            title: "Improve the local dashboard review flow",
            description: "The user wanted the dashboard review flow improved, but the agent still needs to restart the service and verify the build.",
            nodeTitle: "Restart service and verify build",
            owner: "agent",
            nextStep: "Restart the service and verify the build.",
            metadata: { completionState: "in_progress" },
            confidence: 0.9,
            sourceObservationId: userObservationId,
            quote: "Please improve the local dashboard review flow",
            dedupeKey: "improve-dashboard-review-flow"
          }
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

test("llm organize keeps agent nodes that explicitly need user confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-agent-user-confirmation-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-agent-confirm",
      messages: [
        { role: "user", text: "Please clean up the leftover stash backup after the merge" },
        { role: "assistant", text: "The merge is complete; before deleting the stash backup I need user confirmation." }
      ]
    });
    const userObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          title: "Clean up leftover stash backup",
          summary: "The merge is complete; deleting the backup requires user confirmation.",
          status: "blocked",
          currentNode: {
            title: "Confirm deleting the leftover stash backup",
            description: "The user wanted the stash backup cleaned up, but deletion is waiting for explicit user confirmation.",
            nodeTitle: "Get user confirmation before deleting stash backup",
            owner: "agent",
            nextStep: "Ask the user to confirm deleting the stash backup.",
            metadata: {
              completionState: "blocked",
              completionSummary: "The merge is done; cleanup is blocked on user confirmation."
            },
            confidence: 0.9,
            sourceObservationId: userObservationId,
            quote: "Please clean up the leftover stash backup after the merge",
            dedupeKey: "confirm-delete-stash-backup"
          }
        }]
      })
    });
    const [todo] = listTodos(db);
    db.close();

    assert.equal(result.created, 1);
    assert.equal(todo.title, "Confirm deleting the leftover stash backup");
    assert.equal(todo.chain?.currentNode.owner, "agent");
    assert.equal(todo.chain?.currentNode.nextStep, "Ask the user to confirm deleting the stash backup.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize ignores fully completed task chains without current nodes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-task-chain-completed-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-completed-chain",
      messages: [
        { role: "user", text: "Please finish the release checklist" },
        { role: "assistant", text: "The release checklist is complete." }
      ]
    });
    const assistantObservationId = String((db.prepare("SELECT id FROM observations WHERE role = 'assistant' LIMIT 1").get() as any).id);

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          title: "Finish the release checklist",
          summary: "The release checklist is complete.",
          status: "completed",
          completedNodes: [{
            title: "Finish release checklist",
            summary: "Agent completed the checklist.",
            owner: "agent",
            status: "completed",
            observationId: assistantObservationId
          }]
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

test("organize keeps newest sessions when payload user block budget is smaller than scoped sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-newest-budget-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    insertObservation(db, "old-obs", "old-session", "browser", "user", "Please add old budget card", new Date(Date.now() - 60_000).toISOString());
    insertObservation(db, "new-obs", "new-session", "browser", "user", "Please add new budget card", new Date(Date.now()).toISOString());

    const calls: string[] = [];
    await organizeTodos(db, {
      scope: { sinceDays: 7, maxInteractionsPerSession: 10, maxSessions: 2, maxObservationsPerSession: 40 },
      limits: { maxUserBlocks: 1 },
      llmExtractor: async (observations) => {
        const observation = observations.find((item) => item.role === "user")!;
        calls.push(observation.sessionId);
        return {
          ok: true,
          todos: [{
            title: "Add new budget card",
            description: "Create the newest card when user block budget is tight.",
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: "new-budget-card"
          }]
        };
      }
    });
    db.close();

    assert.deepEqual(calls, ["new-session"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize rejects task-chain cards anchored to assistant when user intent exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-assistant-card-source-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    insertObservation(db, "user-obs", "session-1", "browser", "user", "Please fix settings save", "2026-01-01T00:00:00.000Z");
    insertObservation(db, "assistant-obs", "session-1", "browser", "assistant", "Saving is blocked by validation.", "2026-01-01T00:01:00.000Z");

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          chainId: "session-1:user-obs",
          userObservationId: "user-obs",
          title: "Fix settings save",
          currentNode: {
            title: "Fix settings save",
            description: "The user wants settings save fixed, but validation still blocks saving.",
            confidence: 0.9,
            sourceObservationId: "assistant-obs",
            quote: "Saving is blocked by validation.",
            dedupeKey: "fix-settings-save"
          }
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

test("llm organize accepts user card source with assistant metadata progress source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-progress-source-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    insertObservation(db, "user-obs", "session-1", "browser", "user", "Please fix settings save", "2026-01-01T00:00:00.000Z");
    insertObservation(db, "assistant-obs", "session-1", "browser", "assistant", "Saving is blocked by validation.", "2026-01-01T00:01:00.000Z");

    const result = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        taskChains: [{
          chainId: "session-1:user-obs",
          userObservationId: "user-obs",
          title: "Fix settings save",
          currentNode: {
            title: "Fix settings save",
            description: "The user wants settings save fixed, but validation still blocks saving.",
            metadata: {
              completionState: "blocked",
              completionSummary: "Saving is blocked by validation.",
              sourceObservationId: "assistant-obs"
            },
            confidence: 0.9,
            sourceObservationId: "user-obs",
            quote: "Please fix settings save",
            dedupeKey: "fix-settings-save"
          }
        }]
      })
    });
    const [todo] = listTodos(db);
    db.close();

    assert.equal(result.created, 1);
    assert.equal(todo.metadata.sourceObservationId, "user-obs");
    assert.equal(todo.metadata.completionState, "blocked");
    assert.equal(todo.metadata.completionSummary, "Saving is blocked by validation.");
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

test("llm organize updates an active near-duplicate card when the model key changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-update-drifted-key-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-drift",
      messages: [
        { role: "user", text: "Please fix settings save validation" },
        { role: "assistant", text: "Validation still blocks saving settings." }
      ]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);

    await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Fix settings save validation",
          description: "Settings save is blocked by validation.",
          confidence: 0.9,
          sourceObservationId: observationId,
          quote: "Please fix settings save validation",
          dedupeKey: "fix-settings-save-validation"
        }]
      })
    });

    db.prepare("UPDATE sessions SET updated_at = '2026-01-01T00:01:00.000Z' WHERE id = 'browser-drift'").run();
    const second = await organizeTodos(db, {
      llmExtractor: async () => ({
        ok: true,
        todos: [{
          title: "Fix settings save validation",
          description: "Settings save validation is still failing after the latest pass.",
          metadata: { completionSummary: "The latest agent progress still reports a validation blocker." },
          confidence: 0.92,
          sourceObservationId: observationId,
          quote: "Please fix settings save validation",
          dedupeKey: "repair-settings-validation-save"
        }]
      })
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(second.created, 0);
    assert.equal(second.updated, 1);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].description, "Settings save validation is still failing after the latest pass.");
    assert.equal(todos[0].metadata.completionSummary, "The latest agent progress still reports a validation blocker.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize skips sessions whose checkpoint was already processed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-checkpoint-skip-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-checkpoint",
      messages: [{ role: "user", text: "Please add checkpointed card" }]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);
    let calls = 0;
    const extractor = async () => {
      calls++;
      return {
        ok: true as const,
        todos: [{
          title: "Add checkpointed card",
          description: "Create the card once for this unchanged session.",
          confidence: 0.9,
          sourceObservationId: observationId,
          quote: "Please add checkpointed card",
          dedupeKey: "checkpointed-card"
        }]
      };
    };

    const first = await organizeTodos(db, { llmExtractor: extractor });
    const second = await organizeTodos(db, { llmExtractor: extractor });
    const todos = listTodos(db);
    db.close();

    assert.equal(calls, 1);
    assert.equal(first.created, 1);
    assert.equal(second.scanned, 0);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 0);
    assert.equal(todos.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize retries sessions whose previous LLM batch failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-checkpoint-retry-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-retry",
      messages: [{ role: "user", text: "Please add retryable card" }]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);
    let calls = 0;

    const first = await organizeTodos(db, {
      llmExtractor: async () => {
        calls++;
        return { ok: false, warning: "llm_timeout", retryable: true };
      }
    });
    const second = await organizeTodos(db, {
      llmExtractor: async () => {
        calls++;
        return {
          ok: true,
          todos: [{
            title: "Add retryable card",
            description: "Create the card after the failed batch retries.",
            confidence: 0.9,
            sourceObservationId: observationId,
            quote: "Please add retryable card",
            dedupeKey: "retryable-card"
          }]
        };
      }
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(calls, 2);
    assert.ok(first.warnings.includes("llm_timeout"));
    assert.equal(second.created, 1);
    assert.equal(todos.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("organize retries sessions whose previous candidates were rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-checkpoint-invalid-retry-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    ingestBrowserSession(db, {
      id: "browser-invalid-retry",
      messages: [{ role: "user", text: "Please add rejected candidate retry" }]
    });
    const observationId = String((db.prepare("SELECT id FROM observations WHERE role = 'user' LIMIT 1").get() as any).id);
    let calls = 0;

    const first = await organizeTodos(db, {
      llmExtractor: async () => {
        calls++;
        return {
          ok: true,
          todos: [{
            title: "Add rejected candidate retry",
            description: "This invalid candidate should not checkpoint the session.",
            confidence: 0.9,
            sourceObservationId: observationId,
            quote: "not present in the source observation",
            dedupeKey: "rejected-candidate-retry"
          }]
        };
      }
    });
    const second = await organizeTodos(db, {
      llmExtractor: async () => {
        calls++;
        return {
          ok: true,
          todos: [{
            title: "Add rejected candidate retry",
            description: "Create the card after the rejected candidate retries.",
            confidence: 0.9,
            sourceObservationId: observationId,
            quote: "Please add rejected candidate retry",
            dedupeKey: "rejected-candidate-retry"
          }]
        };
      }
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(calls, 2);
    assert.deepEqual(first.warnings, ["llm_no_valid_candidates"]);
    assert.equal(second.created, 1);
    assert.equal(todos.length, 1);
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

test("llm organize ignores agent context as user demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-agent-context-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    const createdAt = "2026-01-01T00:00:00.000Z";
    insertObservation(db, "agent-context", "session-1", "codex", "user", markAgentContext("## Subagent report\nPlease rewrite the dashboard."), createdAt);
    let called = false;

    const result = await organizeTodos(db, {
      llmExtractor: async () => {
        called = true;
        return { ok: true, todos: [] };
      }
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(called, false);
    assert.deepEqual(result.warnings, ["llm_no_valid_candidates"]);
    assert.equal(todos.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("llm organize ignores interrupted-turn events as user demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-organize-turn-aborted-"));
  try {
    const db = openDatabase(getAppPaths(dir));
    insertObservation(
      db,
      "turn-aborted",
      "session-1",
      "codex",
      "user",
      "<turn_aborted> The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. </turn_aborted>",
      "2026-01-01T00:00:00.000Z"
    );
    let called = false;

    const result = await organizeTodos(db, {
      llmExtractor: async () => {
        called = true;
        return { ok: true, todos: [] };
      }
    });
    const todos = listTodos(db);
    db.close();

    assert.equal(called, false);
    assert.deepEqual(result.warnings, ["llm_no_valid_candidates"]);
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
