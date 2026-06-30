import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { callMcpTool, listMcpTools } from "../src/mcp/index.js";
import { handleJsonRpcLine } from "../src/mcp/stdio.js";

test("MCP exposes the minimal todo tools", () => {
  assert.deepEqual(listMcpTools().map((tool) => tool.name), [
    "todo_scan",
    "todo_organize",
    "todo_list",
    "todo_update",
    "todo_open"
  ]);
});

test("MCP tools scan, organize, list, update, and open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-mcp-"));
  try {
    const sessions = join(dir, "codex");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "session.jsonl"), [
      JSON.stringify({ role: "user", text: "Please add MCP tool support", timestamp: new Date().toISOString() })
    ].join("\n"));

    const paths = getAppPaths(join(dir, "home"));
    const db = openDatabase(paths);
    const scan = await callMcpTool(db, "todo_scan", { source: "codex", path: sessions }, paths);
    assert.equal(scan.source, "codex");
    assert.equal(scan.scanned, 1);

    const organize = await callMcpTool(db, "todo_organize", {}, paths);
    assert.equal(organize.created, 0);
    assert.equal(organize.engine, "llm");
    assert.deepEqual(organize.warnings, ["llm_config_missing"]);

    const listed = await callMcpTool(db, "todo_list", {}, paths);
    assert.equal(listed.length, 0);

    const open = await callMcpTool(db, "todo_open", {}, paths);
    db.close();
    assert.deepEqual(open, { opened: false, message: "run ai-todo open to start the local UI" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP organize can use configured llm extraction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-mcp-llm-"));
  try {
    const paths = getAppPaths(join(dir, "home"));
    const db = openDatabase(paths);
    const sessions = join(dir, "codex");
    mkdirSync(sessions);
    writeFileSync(join(sessions, "session.jsonl"), JSON.stringify({ role: "user", text: "Please add MCP LLM cards", timestamp: new Date().toISOString() }));
    await callMcpTool(db, "todo_scan", { source: "codex", path: sessions }, paths);
    const observationId = String((db.prepare("SELECT id FROM observations LIMIT 1").get() as any).id);

    const organize = await callMcpTool(db, "todo_organize", {}, paths, {
      organizeOptions: {
        llmExtractor: async () => ({
          ok: true,
          todos: [{
            title: "Add MCP LLM cards",
            description: "Use the configured LLM path from MCP.",
            confidence: 0.9,
            sourceObservationId: observationId,
            quote: "Please add MCP LLM cards",
            dedupeKey: "mcp-llm-cards"
          }]
        })
      }
    });

    assert.equal(organize.engine, "llm");
    assert.equal(organize.created, 1);
    const listed = await callMcpTool(db, "todo_list", {}, paths);
    assert.equal(listed.length, 1);
    const updated = await callMcpTool(db, "todo_update", { id: listed[0].id, status: "done" }, paths);
    assert.equal(updated.status, "done");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP tools return small explicit errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-mcp-errors-"));
  try {
    const paths = getAppPaths(join(dir, "home"));
    const db = openDatabase(paths);
    await assert.rejects(() => callMcpTool(db, "missing", {}, paths), /unknown tool/);
    await assert.rejects(() => callMcpTool(db, "todo_scan", { source: "browser" }, paths), /unsupported source/);
    await assert.rejects(() => callMcpTool(db, "todo_update", { id: "missing", status: "todo" }, paths), /invalid status/);
    await assert.rejects(() => callMcpTool(db, "todo_update", { id: "missing", status: "done" }, paths), /todo not found/);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MCP JSON-RPC handles list, call, and errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-mcp-rpc-"));
  try {
    const paths = getAppPaths(join(dir, "home"));
    const db = openDatabase(paths);
    const list = await handleJsonRpcLine(db, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), paths) as any;
    assert.equal(list.result.tools.length, 5);

    const call = await handleJsonRpcLine(db, JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "todo_open", arguments: {} }
    }), paths) as any;
    assert.equal(JSON.parse(call.result.content[0].text).opened, false);

    const unknown = await handleJsonRpcLine(db, JSON.stringify({ jsonrpc: "2.0", id: 3, method: "missing" }), paths) as any;
    assert.equal(unknown.error.code, -32601);

    const bad = await handleJsonRpcLine(db, "{", paths) as any;
    db.close();
    assert.equal(bad.error.code, -32700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
