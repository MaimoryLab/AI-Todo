import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, type Database } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { createAppServer, createStartupScanner } from "../src/server/index.js";
import { scanSource } from "../src/sources/scan.js";

test("HTTP API scans sources, lists sessions, observations, runs, and updates todos", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths, {
    llmExtractor: async (observations: Array<{ id: string; role: string; text: string }>) => {
      const observation = observations.find((item) => item.role === "user");
      assert.ok(observation);
      return {
        ok: true,
        todos: [{
          title: "Add HTTP API routes",
          description: "Add HTTP API routes for the local todo service.",
          metadata: {
            completionState: "blocked",
            completionSummary: "The route list is drafted; error responses still need review."
          },
          confidence: 0.9,
          sourceObservationId: observation.id,
          quote: observation.text,
          dedupeKey: "http-api-routes"
        }]
      };
    }
  });

  try {
    const scan = await postJson(server.url("/sources/scan"), {
      source: "codex",
      path: fixture.codex
    });
    assert.equal(scan.status, 200);
    assert.deepEqual(await scan.json(), {
      source: "codex",
      scanned: 1,
      observations: 1,
      skipped: 0
    });

    const sources = await getJson(server.url("/sources"));
    assert.equal(sources.status, 200);
    const sourceBody = await sources.json();
    assert.equal(sourceBody.find((source: any) => source.source === "codex").sessions, 1);

    const sessions = await getJson(server.url("/sessions"));
    assert.equal(sessions.status, 200);
    const sessionBody = await sessions.json();
    assert.equal(sessionBody.length, 1);

    const observations = await getJson(server.url(`/sessions/${sessionBody[0].id}/observations`));
    assert.equal(observations.status, 200);
    const [firstObservation] = await observations.json();
    assert.equal(firstObservation.text, "Please add HTTP API routes");

    const organize = await postJson(server.url("/todos/organize"), {});
    const organizeBody = await organize.json();
    assert.equal(organize.status, 200);
    assert.equal(organizeBody.created, 1);

    const run = await getJson(server.url(`/organize-runs/${organizeBody.runId}`));
    assert.equal(run.status, 200);
    assert.equal((await run.json()).runId, organizeBody.runId);

    const todos = await getJson(server.url("/todos"));
    const observationBody = await getJson(server.url(`/sessions/${sessionBody[0].id}/observations`));
    const sourceObservationId = (await observationBody.json())[0].id;
    const todo = (await todos.json())[0];
    assert.equal(todo.metadata.completionSummary, "The route list is drafted; error responses still need review.");
    assert.equal(todo.metadata.sourceObservationId, sourceObservationId);
    assert.deepEqual(todo.origin, {
      source: "codex",
      projectTitle: "codex",
      projectPath: fixture.codexFile,
      sessionId: sessionBody[0].id,
      sessionTitle: "Please add HTTP API routes",
      sessionTemporary: true,
      observationId: sourceObservationId,
      eventCreatedAt: firstObservation.createdAt
    });
    const patch = await patchJson(server.url(`/todos/${todo.id}`), { status: "done" });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).status, "done");
    const restore = await patchJson(server.url(`/todos/${todo.id}`), { status: "todo" });
    assert.equal(restore.status, 200);
    assert.equal((await restore.json()).status, "todo");

    const evidence = await getJson(server.url(`/todos/${todo.id}/evidence`));
    assert.equal(evidence.status, 200);
    assert.equal((await evidence.json())[0].text, "Please add HTTP API routes");

    const updated = await getJson(server.url("/todos"));
    assert.equal((await updated.json())[0].status, "todo");
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP API returns optional task chain data for structured todos", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths, {
    llmExtractor: async (observations: Array<{ id: string; role: string; text: string }>) => {
      const observation = observations.find((item) => item.role === "user");
      assert.ok(observation);
      return {
        ok: true,
        taskChains: [{
          title: "Add HTTP API routes",
          summary: "Route list exists; review remains.",
          status: "in_progress",
          completedNodes: [{
            title: "Draft route list",
            summary: "The API route list was drafted.",
            owner: "agent",
            status: "completed",
            observationId: observation.id
          }],
          currentNode: {
            title: "Review HTTP API errors",
            description: "Review HTTP API error responses before closing the route work.",
            owner: "agent",
            nextStep: "Agent should review error responses.",
            metadata: {
              completionState: "in_progress",
              completionSummary: "Route list exists; error response review remains."
            },
            confidence: 0.9,
            sourceObservationId: observation.id,
            quote: observation.text,
            dedupeKey: "review-http-api-errors"
          }
        }]
      };
    }
  });

  try {
    await postJson(server.url("/sources/scan"), { source: "codex", path: fixture.codex });
    await postJson(server.url("/todos/organize"), {});

    const response = await getJson(server.url("/todos"));
    assert.equal(response.status, 200);
    const [todo] = await response.json();
    assert.equal(todo.title, "Review HTTP API errors");
    assert.equal(todo.chain.title, "Add HTTP API routes");
    assert.equal(todo.chain.completedNodeCount, 1);
    assert.equal(todo.chain.completedNodes[0].title, "Draft route list");
    assert.equal(todo.chain.currentNode.owner, "agent");
    assert.equal(todo.chain.currentNode.nextStep, "Agent should review error responses.");
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP API clears todo cards without deleting source observations", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths, {
    llmExtractor: async (observations: Array<{ id: string; role: string; text: string }>) => {
      const observation = observations.find((item) => item.role === "user");
      assert.ok(observation);
      return {
        ok: true,
        todos: [{
          title: "Clear HTTP todo cards",
          description: "Create a card that can be cleared through the HTTP API.",
          confidence: 0.9,
          sourceObservationId: observation.id,
          quote: observation.text,
          dedupeKey: "clear-http-todo-cards"
        }]
      };
    }
  });

  try {
    await postJson(server.url("/sources/scan"), { source: "codex", path: fixture.codex });
    await postJson(server.url("/todos/organize"), {});
    assert.equal((await (await getJson(server.url("/todos"))).json()).length, 1);

    const clear = await postJson(server.url("/todos/clear"), {});
    assert.equal(clear.status, 200);
    assert.equal((await clear.json()).todos, 1);
    assert.equal((await (await getJson(server.url("/todos"))).json()).length, 0);
    assert.equal((await (await getJson(server.url("/sessions"))).json()).length, 1);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP organize rejects duplicate requests while one is running", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  let calls = 0;
  let release: (() => void) | undefined;
  const server = await startServer(db, paths, {
    llmExtractor: async () => {
      calls++;
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, todos: [] };
    }
  });

  try {
    await postJson(server.url("/sources/scan"), { source: "codex", path: fixture.codex });
    const first = postJson(server.url("/todos/organize"), {});
    await waitFor(async () => {
      const status = await (await getJson(server.url("/todos/organize/status"))).json() as { running: boolean };
      return status.running;
    });
    const duplicate = await postJson(server.url("/todos/organize"), {});
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json()).error, "organize_in_progress");
    assert.equal(calls, 1);
    release?.();
    await first;
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP attachments only serve files referenced by an observation", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const attachment = join(fixture.root, "image.png");
  writeFileSync(attachment, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(
    "attachment-session",
    "browser",
    "browser",
    "2026-01-01T00:00:00.000Z"
  );
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "attachment-observation",
    "attachment-session",
    "browser",
    "user",
    `Please review this.\nImage: Screenshot (${attachment})`,
    "2026-01-01T00:00:00.000Z"
  );
  const server = await startServer(db, paths);

  try {
    const ok = await getJson(server.url("/attachments?observationId=attachment-observation&index=0"));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    const missing = await getJson(server.url("/attachments?observationId=attachment-observation&index=1"));
    assert.equal(missing.status, 404);
    const wrongObservation = await getJson(server.url("/attachments?observationId=missing&index=0"));
    assert.equal(wrongObservation.status, 404);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP API returns small explicit errors", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    assert.equal((await postJson(server.url("/sources/scan"), { source: "browser", path: fixture.codex })).status, 400);
    assert.equal((await postJson(server.url("/sources/scan"), { source: "codex", path: join(fixture.root, "missing") })).status, 400);
    assert.equal((await getJson(server.url("/sessions/missing/observations"))).status, 404);
    assert.equal((await patchJson(server.url("/todos/missing"), { status: "done" })).status, 404);
    assert.equal((await patchJson(server.url("/todos/missing"), { status: "open" })).status, 400);
    assert.equal((await getJson(server.url("/todos/missing/evidence"))).status, 404);
    assert.equal((await getJson(server.url("/organize-runs/missing"))).status, 404);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP API reports missing database", async () => {
  const server = createAppServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = (path: string) => `http://127.0.0.1:${address.port}${path}`;

  try {
    assert.equal((await getJson(url("/sources"))).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("HTTP API reports invalid JSON", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    const badJson = await fetch(server.url("/sources/scan"), {
      method: "POST",
      body: "{"
    });
    assert.equal(badJson.status, 400);
    assert.equal((await badJson.json()).error, "invalid_json");
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP startup scan status exposes automatic scan results", async () => {
  const fixture = createFixture();
  const previousCodex = process.env.AI_TODO_CODEX_HOME;
  const previousClaude = process.env.AI_TODO_CLAUDE_HOME;
  process.env.AI_TODO_CODEX_HOME = fixture.codex;
  process.env.AI_TODO_CLAUDE_HOME = join(fixture.root, "missing-claude");
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const scanner = createStartupScanner(db, paths);
  const server = createAppServer({ db, paths, startupScan: scanner.status });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = (path: string) => `http://127.0.0.1:${address.port}${path}`;

  try {
    scanner.start();
    await waitFor(async () => ((await (await getJson(url("/startup/scan"))).json()) as any).status !== "indexing");
    const response = await getJson(url("/startup/scan"));
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.status, "failed");
    assert.equal(body.sources.find((source: any) => source.source === "codex").result.scanned, 1);
    assert.ok(body.warnings.includes("claude-code_path_not_found"));
  } finally {
    if (previousCodex === undefined) delete process.env.AI_TODO_CODEX_HOME;
    else process.env.AI_TODO_CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.AI_TODO_CLAUDE_HOME;
    else process.env.AI_TODO_CLAUDE_HOME = previousClaude;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP startup scanner discovers source paths before scanning", async () => {
  const fixture = createFixture();
  const previousHome = process.env.HOME;
  const previousCodex = process.env.AI_TODO_CODEX_HOME;
  const previousClaude = process.env.AI_TODO_CLAUDE_HOME;
  delete process.env.AI_TODO_CODEX_HOME;
  delete process.env.AI_TODO_CLAUDE_HOME;

  try {
    process.env.HOME = fixture.root;
    mkdirSync(join(fixture.root, ".codex", "sessions"), { recursive: true });
    writeFileSync(join(fixture.root, ".codex", "sessions", "session.jsonl"), [
      JSON.stringify({ role: "user", text: "Please auto-discover Codex", timestamp: new Date().toISOString() })
    ].join("\n"));
    mkdirSync(join(fixture.root, ".claude", "projects"), { recursive: true });

    const paths = getAppPaths(join(fixture.root, "home"));
    const db = openDatabase(paths);
    const scanner = createStartupScanner(db, paths);
    const server = createAppServer({ db, paths, startupScan: scanner.status });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = (path: string) => `http://127.0.0.1:${address.port}${path}`;

    try {
      scanner.start();
      await waitFor(async () => ((await (await getJson(url("/startup/scan"))).json()) as any).status !== "indexing");
      const body = await (await getJson(url("/startup/scan"))).json();
      assert.equal(body.discovery.find((source: any) => source.source === "codex").status, "discovered");
      assert.equal(body.sources.find((source: any) => source.source === "codex").result.scanned, 1);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      db.close();
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousCodex === undefined) delete process.env.AI_TODO_CODEX_HOME;
    else process.env.AI_TODO_CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.AI_TODO_CLAUDE_HOME;
    else process.env.AI_TODO_CLAUDE_HOME = previousClaude;
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP source scan uses default paths with environment overrides", async () => {
  const fixture = createFixture();
  const previousCodex = process.env.AI_TODO_CODEX_HOME;
  process.env.AI_TODO_CODEX_HOME = fixture.codex;
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    const response = await postJson(server.url("/sources/scan"), { source: "codex" });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).scanned, 1);
  } finally {
    if (previousCodex === undefined) {
      delete process.env.AI_TODO_CODEX_HOME;
    } else {
      process.env.AI_TODO_CODEX_HOME = previousCodex;
    }
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP source scan reports existing paths with no sessions", async () => {
  const fixture = createFixture();
  const emptyCodex = join(fixture.root, "empty-codex");
  mkdirSync(emptyCodex, { recursive: true });
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    const response = await postJson(server.url("/sources/scan"), { source: "codex", path: emptyCodex });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).warning, "codex_no_sessions");
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP settings persist source paths and scan uses config path", async () => {
  const fixture = createFixture();
  const missingClaudePath = join(tmpdir(), `ai-todo-missing-claude-${Date.now()}`);
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    const initial = await getJson(server.url("/settings"));
    assert.equal(initial.status, 200);
    const initialBody = await initial.json();
    assert.equal(initialBody.llm.model, "deepseek/deepseek-v4-flash");
    assert.equal(initialBody.llm.apiKeyConfigured, false);
    assert.equal(initialBody.llm.apiKeyMasked, "");
    assert.equal(initialBody.organize.sinceDays, 7);
    assert.equal(initialBody.organize.maxSessions, 16);

    const saved = await putJson(server.url("/settings"), {
      sources: { codex: { path: fixture.codex }, "claude-code": { path: missingClaudePath } },
      llm: {
        enabled: true,
        provider: "openai",
        model: "custom/model",
        endpoint: "https://llm.example.test/v1",
        thinkingDepth: "high",
        timeoutMs: 30000,
        apiKey: "dummy-llm-key-value"
      },
      organize: {
        sinceDays: 30,
        maxInteractionsPerSession: 15,
        maxSessions: 200,
        maxObservationsPerSession: 40
      }
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.sources.codex.path, fixture.codex);
    assert.equal(savedBody.sources["claude-code"].path, missingClaudePath);
    assert.equal(savedBody.llm.model, "custom/model");
    assert.equal(savedBody.llm.apiKeyConfigured, true);
    assert.equal(savedBody.llm.apiKeyMasked, "dum****alue");
    assert.equal(savedBody.llm.apiKey, undefined);
    assert.equal(savedBody.organize.sinceDays, 30);
    assert.equal(savedBody.organize.maxSessions, 200);
    assert.match(readFileSync(paths.envPath, "utf8"), /AI_TODO_LLM_API_KEY=dummy-llm-key-value/);
    assert.match(readFileSync(paths.envPath, "utf8"), /AI_TODO_ORGANIZE_MAX_SESSIONS=200/);

    const scan = await postJson(server.url("/sources/scan"), { source: "codex" });
    assert.equal(scan.status, 200);
    assert.equal((await scan.json()).scanned, 1);

    const missingClaude = await postJson(server.url("/sources/scan"), { source: "claude-code" });
    assert.equal(missingClaude.status, 400);
    assert.equal((await missingClaude.json()).error, "path_not_found");
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP settings rejects invalid config", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    assert.equal((await putJson(server.url("/settings"), { sources: { codex: {}, browser: {} } })).status, 400);
    assert.equal((await putJson(server.url("/settings"), { sources: { codex: { path: "" }, "claude-code": {} } })).status, 400);
    assert.equal((await putJson(server.url("/settings"), { sources: { codex: { path: 1 }, "claude-code": {} } })).status, 400);
    assert.equal((await putJson(server.url("/settings"), {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "",
        endpoint: "https://example.test/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000
      }
    })).status, 400);
    const badJson = await fetch(server.url("/settings"), { method: "PUT", body: "{" });
    assert.equal(badJson.status, 400);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP settings clears llm api key when requested", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    const withKey = await putJson(server.url("/settings"), {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
        endpoint: "https://api.novita.ai/openai/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000,
        apiKey: "dummy-llm-key-value"
      },
      organize: {
        sinceDays: 7,
        maxInteractionsPerSession: 10
      }
    });
    assert.equal(withKey.status, 200);
    assert.ok(existsSync(paths.envPath));

    const cleared = await putJson(server.url("/settings"), {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
        endpoint: "https://api.novita.ai/openai/v1",
        thinkingDepth: "medium",
        timeoutMs: 120000,
        apiKey: ""
      },
      organize: {
        sinceDays: 7,
        maxInteractionsPerSession: 10
      }
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).llm.apiKeyConfigured, false);
    assert.doesNotMatch(readFileSync(paths.envPath, "utf8"), /dummy-llm-key-value/);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP browser ingest validates input", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

  try {
    assert.equal((await postJson(server.url("/browser/sessions"), {})).status, 400);
    assert.equal((await postJson(server.url("/browser/sessions"), { messages: [] })).status, 400);
    assert.equal((await postJson(server.url("/browser/sessions"), { messages: [{ text: "" }] })).status, 400);
    assert.equal((await postJson(server.url("/browser/sessions"), { messages: [{ text: 1 }] })).status, 400);
    assert.equal((await postJson(server.url("/browser/sessions"), { messages: [{ text: "x", createdAt: "nope" }] })).status, 400);
    assert.equal((await postJson(server.url("/browser/sessions"), { messages: [{ role: "user", text: "Valid browser todo" }] })).status, 200);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP organize returns structured failure", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const scan = scanSource(db, "codex", fixture.codex, paths);
  assert.equal(scan.ok, true);
  const server = createAppServer({
    db,
    paths,
    organizeOptions: {
      llmExtractor: async () => {
        throw new Error("boom");
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/todos/organize`, { method: "POST" });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(body.error, "organize_failed");
    assert.deepEqual(body.warnings, ["organize_failed"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GET /todos tolerates missing origin records", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);
  db.prepare(
    "INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "todo-missing-origin",
    "Keep old todo",
    "Old cards should still list when their source observation is gone.",
    "todo",
    JSON.stringify({ sourceObservationId: "missing-observation" }),
    "2026-06-30T00:00:00.000Z"
  );

  try {
    const response = await getJson(server.url("/todos"));
    assert.equal(response.status, 200);
    const todo = (await response.json())[0];
    assert.equal(todo.title, "Keep old todo");
    assert.equal(todo.origin, undefined);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GET /todos falls back to evidence when todo metadata has no source observation", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(
    "legacy-session",
    "codex",
    fixture.codexFile,
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "legacy-observation",
    "legacy-session",
    "codex",
    "user",
    "Please restore linked sources",
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare(
    "INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "legacy-todo",
    "Restore linked sources",
    "Old cards should still resolve their origin through evidence.",
    "todo",
    "{}",
    "2026-06-30T00:00:01.000Z"
  );
  db.prepare("INSERT INTO evidence (id, todo_id, observation_id, text) VALUES (?, ?, ?, ?)").run(
    "legacy-evidence",
    "legacy-todo",
    "legacy-observation",
    "Please restore linked sources"
  );

  try {
    const response = await getJson(server.url("/todos"));
    assert.equal(response.status, 200);
    const todo = (await response.json())[0];
    assert.equal(todo.id, "legacy-todo");
    assert.equal(todo.origin.sessionId, "legacy-session");
    assert.equal(todo.origin.observationId, "legacy-observation");
    assert.equal(todo.origin.projectTitle, "codex");
    assert.equal(todo.origin.sessionTitle, "Please restore linked sources");
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GET /todos shortens encoded local project paths in origin titles", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);
  const encodedPath = join(fixture.root, "-Users-ppio-Documents-AI-TodoProject-ExampleApp", "session.jsonl");
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(
    "encoded-session",
    "codex",
    encodedPath,
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "encoded-observation",
    "encoded-session",
    "codex",
    "user",
    "Please keep cards readable",
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare(
    "INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "encoded-todo",
    "Keep cards readable",
    "Cards should show a project name instead of a local path.",
    "todo",
    JSON.stringify({ sourceObservationId: "encoded-observation" }),
    "2026-06-30T00:00:00.000Z"
  );

  try {
    const response = await getJson(server.url("/todos"));
    assert.equal(response.status, 200);
    const todo = (await response.json())[0];
    assert.equal(todo.origin.projectTitle, "ExampleApp");
    assert.equal(todo.origin.projectPath, encodedPath);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GET /todos returns source event time separately from card update time", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);
  const eventCreatedAt = "2026-06-24T09:30:00.000Z";
  const cardUpdatedAt = "2026-06-30T12:00:00.000Z";
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(
    "event-time-session",
    "codex",
    fixture.codexFile,
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "event-time-observation",
    "event-time-session",
    "codex",
    "user",
    "Please show the source event time",
    eventCreatedAt
  );
  db.prepare(
    "INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "event-time-todo",
    "Show source event time",
    "Cards should display when the source event happened.",
    "todo",
    JSON.stringify({ sourceObservationId: "event-time-observation" }),
    cardUpdatedAt
  );

  try {
    const response = await getJson(server.url("/todos"));
    assert.equal(response.status, 200);
    const todo = (await response.json())[0];
    assert.equal(todo.updatedAt, cardUpdatedAt);
    assert.equal(todo.origin.eventCreatedAt, eventCreatedAt);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("GET /todos omits meaningless date and local path fragments from origin project titles", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);
  const codexDatePath = "/Users/example/.codex/sessions/2026/06/15/rollout-2026-06-15T00-00-00.jsonl";
  const claudeLocalPath = "/Users/example/.claude/projects/-Users-example-Documents-------/6671.jsonl";
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(
    "codex-date-session",
    "codex",
    codexDatePath,
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare("INSERT INTO sessions (id, source, path, updated_at) VALUES (?, ?, ?, ?)").run(
    "claude-local-session",
    "claude-code",
    claudeLocalPath,
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "codex-date-observation",
    "codex-date-session",
    "codex",
    "user",
    "Please hide date folders",
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare("INSERT INTO observations (id, session_id, source, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "claude-local-observation",
    "claude-local-session",
    "claude-code",
    "user",
    "Please hide local path fragments",
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare(
    "INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "codex-date-todo",
    "Hide date folders",
    "Cards should not show Codex date folders as project names.",
    "todo",
    JSON.stringify({ sourceObservationId: "codex-date-observation" }),
    "2026-06-30T00:00:00.000Z"
  );
  db.prepare(
    "INSERT INTO todos (id, title, description, status, metadata_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    "claude-local-todo",
    "Hide local path fragments",
    "Cards should not show encoded home paths as project names.",
    "todo",
    JSON.stringify({ sourceObservationId: "claude-local-observation" }),
    "2026-06-30T00:00:01.000Z"
  );

  try {
    const response = await getJson(server.url("/todos"));
    assert.equal(response.status, 200);
    const body = await response.json() as Array<{ id: string; origin: { projectTitle?: string; projectPath: string } }>;
    const todos = new Map(body.map((todo) => [todo.id, todo]));
    const codexTodo = todos.get("codex-date-todo");
    const claudeTodo = todos.get("claude-local-todo");
    assert.ok(codexTodo);
    assert.ok(claudeTodo);
    assert.equal(codexTodo.origin.projectTitle, undefined);
    assert.equal(codexTodo.origin.projectPath, codexDatePath);
    assert.equal(claudeTodo.origin.projectTitle, undefined);
    assert.equal(claudeTodo.origin.projectPath, claudeLocalPath);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP server serves the React UI assets", async () => {
  const fixture = createFixture();
  const db = openDatabase(getAppPaths(join(fixture.root, "home")));
  const server = await startServer(db);

  try {
    const index = await getJson(server.url("/"));
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /AI Todo/);
    const asset = html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(asset);

    const js = await getJson(server.url(asset));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /text\/javascript/);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-todo-http-"));
  const codex = join(root, "codex");
  mkdirSync(codex);
  const codexFile = join(codex, "session.jsonl");
  writeFileSync(codexFile, [
    JSON.stringify({ role: "user", text: "Please add HTTP API routes", timestamp: new Date().toISOString() })
  ].join("\n"));
  return { root, codex, codexFile };
}

async function startServer(db: Database, paths = getAppPaths(), organizeOptions = {}) {
  const server = createAppServer({ db, paths, organizeOptions });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: (path: string) => `http://127.0.0.1:${address.port}${path}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function getJson(url: string) {
  return fetch(url);
}

function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    body: JSON.stringify(body)
  });
}

function patchJson(url: string, body: unknown) {
  return fetch(url, {
    method: "PATCH",
    body: JSON.stringify(body)
  });
}

function putJson(url: string, body: unknown) {
  return fetch(url, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}


async function waitFor(predicate: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}
