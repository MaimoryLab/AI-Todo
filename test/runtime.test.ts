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
    assert.equal(await main(["doctor"]), 0);
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
