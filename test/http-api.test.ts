import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase, type Database } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { createAppServer } from "../src/server/index.js";

test("HTTP API scans sources, lists sessions, observations, runs, and updates todos", async () => {
  const fixture = createFixture();
  const paths = getAppPaths(join(fixture.root, "home"));
  const db = openDatabase(paths);
  const server = await startServer(db, paths);

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
    assert.equal((await observations.json())[0].text, "Please add HTTP API routes");

    const organize = await postJson(server.url("/todos/organize"), {});
    const organizeBody = await organize.json();
    assert.equal(organize.status, 200);
    assert.equal(organizeBody.created, 1);

    const run = await getJson(server.url(`/organize-runs/${organizeBody.runId}`));
    assert.equal(run.status, 200);
    assert.equal((await run.json()).runId, organizeBody.runId);

    const todos = await getJson(server.url("/todos"));
    const todo = (await todos.json())[0];
    const patch = await patchJson(server.url(`/todos/${todo.id}`), { status: "done" });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).status, "done");

    const evidence = await getJson(server.url(`/todos/${todo.id}/evidence`));
    assert.equal(evidence.status, 200);
    assert.equal((await evidence.json())[0].text, "Please add HTTP API routes");

    const updated = await getJson(server.url("/todos"));
    assert.equal((await updated.json())[0].status, "done");
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
    assert.equal((await patchJson(server.url("/todos/missing"), { status: "todo" })).status, 400);
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
  const db = openDatabase(getAppPaths(join(fixture.root, "home")));
  const server = await startServer(db);

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

test("HTTP source scan uses default paths with environment overrides", async () => {
  const fixture = createFixture();
  const previousCodex = process.env.AI_TODO_CODEX_HOME;
  process.env.AI_TODO_CODEX_HOME = fixture.codex;
  const db = openDatabase(getAppPaths(join(fixture.root, "home")));
  const server = await startServer(db);

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

test("HTTP settings persist source paths and scan uses config path", async () => {
  const fixture = createFixture();
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

    const saved = await putJson(server.url("/settings"), {
      sources: { codex: { path: fixture.codex }, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "custom/model",
        endpoint: "https://llm.example.test/v1",
        thinkingDepth: "high",
        pythonPath: "python3",
        timeoutMs: 30000,
        apiKey: "dummy-llm-key-value"
      }
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.sources.codex.path, fixture.codex);
    assert.equal(savedBody.llm.model, "custom/model");
    assert.equal(savedBody.llm.apiKeyConfigured, true);
    assert.equal(savedBody.llm.apiKeyMasked, "dum****alue");
    assert.equal(savedBody.llm.apiKey, undefined);
    assert.match(readFileSync(paths.secretsPath, "utf8"), /dummy-llm-key-value/);

    const scan = await postJson(server.url("/sources/scan"), { source: "codex" });
    assert.equal(scan.status, 200);
    assert.equal((await scan.json()).scanned, 1);
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
        pythonPath: "python3",
        timeoutMs: 120000,
        apiKey: "dummy-llm-key-value"
      }
    });
    assert.equal(withKey.status, 200);
    assert.ok(existsSync(paths.secretsPath));

    const cleared = await putJson(server.url("/settings"), {
      sources: { codex: {}, "claude-code": {} },
      llm: {
        enabled: true,
        provider: "openai",
        model: "deepseek/deepseek-v4-flash",
        endpoint: "https://api.novita.ai/openai/v1",
        thinkingDepth: "medium",
        pythonPath: "python3",
        timeoutMs: 120000,
        apiKey: ""
      }
    });
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).llm.apiKeyConfigured, false);
    assert.doesNotMatch(readFileSync(paths.secretsPath, "utf8"), /dummy-llm-key-value/);
  } finally {
    await server.close();
    db.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("HTTP browser ingest validates input", async () => {
  const fixture = createFixture();
  const db = openDatabase(getAppPaths(join(fixture.root, "home")));
  const server = await startServer(db);

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

test("HTTP server serves the minimal UI assets", async () => {
  const fixture = createFixture();
  const db = openDatabase(getAppPaths(join(fixture.root, "home")));
  const server = await startServer(db);

  try {
    const index = await getJson(server.url("/"));
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Source Dashboard/);

    const css = await getJson(server.url("/app.css"));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /text\/css/);

    const js = await getJson(server.url("/app.js"));
    assert.equal(js.status, 200);
    assert.match(await js.text(), /organize/);
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
  writeFileSync(join(codex, "session.jsonl"), [
    JSON.stringify({ role: "user", text: "Please add HTTP API routes", timestamp: "2026-01-01T00:00:00.000Z" })
  ].join("\n"));
  return { root, codex };
}

async function startServer(db: Database, paths = getAppPaths()) {
  const server = createAppServer({ db, paths });
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
