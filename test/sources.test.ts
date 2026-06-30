import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/index.js";
import { getAppPaths } from "../src/paths.js";
import { parseJsonl } from "../src/parser/jsonl.js";
import { createAppServer } from "../src/server/index.js";
import { scanClaudeCodeSessions } from "../src/sources/claude-code.js";
import { scanCodexSessions } from "../src/sources/codex.js";
import { observationFromRecord } from "../src/sources/jsonl-source.js";

test("parseJsonl reads non-empty JSON object lines", () => {
  const records = parseJsonl("{\"text\":\"one\"}\n\n{\"text\":\"two\"}\n");
  assert.deepEqual(records.map((record) => record.value.text), ["one", "two"]);
});

test("codex and claude scanners write clean visible transcript and skip unchanged files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-"));
  try {
    mkdirSync(join(dir, "codex"));
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "codex", "session.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-session", cwd: "/tmp/project", timestamp: "2026-01-01T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Please add a CLI doctor command", timestamp: "2026-01-01T00:00:01.000Z" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"git status\"}" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "tool output should not be stored" } }),
      JSON.stringify({ type: "response_item", payload: { type: "reasoning", text: "hidden reasoning should not be stored" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Implemented doctor" }, { type: "tool_use", text: "tool text" }] } })
    ].join("\n"));
    writeFileSync(join(dir, "claude", "session.jsonl"), [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Fix the scanner checkpoint" },
            { type: "tool_result", content: "tool result should not be stored" }
          ]
        }
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", text: "private chain of thought" },
            { type: "text", text: "The checkpoint now skips unchanged files." },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } }
          ]
        }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.deepEqual(scanCodexSessions(db, join(dir, "codex")), {
      source: "codex",
      scanned: 1,
      observations: 2,
      skipped: 0
    });
    assert.deepEqual(scanCodexSessions(db, join(dir, "codex")), {
      source: "codex",
      scanned: 0,
      observations: 0,
      skipped: 1
    });
    assert.equal(scanClaudeCodeSessions(db, join(dir, "claude")).observations, 2);
    const rows = db.prepare("SELECT source, role, text FROM observations ORDER BY source, text").all();
    db.close();
    assert.equal(rows.length, 4);
    assert.ok(rows.some((row) => row.source === "claude-code" && row.text === "Fix the scanner checkpoint"));
    assert.ok(rows.some((row) => row.source === "claude-code" && row.role === "assistant" && row.text === "The checkpoint now skips unchanged files."));
    assert.ok(rows.some((row) => row.source === "codex" && row.role === "assistant" && row.text === "Implemented doctor"));
    assert.ok(!rows.some((row) => String(row.text).includes("tool")));
    assert.ok(!rows.some((row) => String(row.text).includes("reasoning")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex scanner dedupes mirrored event and response messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-dedupe-"));
  try {
    mkdirSync(join(dir, "codex"));
    writeFileSync(join(dir, "codex", "session.jsonl"), [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Please add clean transcript tests" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Please add clean transcript tests" }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Added clean transcript tests." } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Added clean transcript tests." }] } })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 2);
    const rows = db.prepare("SELECT role, text FROM observations").all();
    db.close();
    assert.equal(rows.length, 2);
    assert.ok(rows.some((row) => row.role === "user" && row.text === "Please add clean transcript tests"));
    assert.ok(rows.some((row) => row.role === "assistant" && row.text === "Added clean transcript tests."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clean transcript preserves meaningful newlines and does not drop user JSON examples", () => {
  const multiline = observationFromRecord("codex", "session", "/tmp/session.jsonl", {
    line: 1,
    value: {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Please keep this list:\n- first item\n- second item\n\n```json\n{\"exec_command\":\"example, not tool output\"}\n```"
      }
    }
  });
  assert.ok(multiline);
  assert.match(multiline.text, /first item\n- second item/);
  assert.match(multiline.text, /exec_command/);
});

test("codex scanner removes injected instruction noise before storing observations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-noise-"));
  try {
    mkdirSync(join(dir, "codex"));
    writeFileSync(join(dir, "codex", "session.jsonl"), [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: [
            "# AGENTS.md instructions",
            "<INSTRUCTIONS>do not store this</INSTRUCTIONS>",
            "<environment_context>secret local context</environment_context>",
            "<system-reminder>stale cwd reminder</system-reminder>",
            "## My request for Codex:",
            "Please keep only this visible request"
          ].join("\n"),
          timestamp: "2026-01-01T00:00:01.000Z"
        }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 1);
    const row = db.prepare("SELECT text FROM observations").get() as { text: string };
    db.close();
    assert.equal(row.text, "Please keep only this visible request");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scanner checkpoints but does not store sessions with no visible observations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-empty-session-"));
  try {
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "session.jsonl"), [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "<command-name>/effort</command-name>\n<command-message>effort</command-message>\n<command-args>ultracode</command-args>"
            }
          ]
        }
      }),
      JSON.stringify({
        type: "assistant",
        isMeta: true,
        message: { role: "assistant", content: [{ type: "text", text: "metadata should not be stored" }] }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.deepEqual(scanClaudeCodeSessions(db, join(dir, "claude")), {
      source: "claude-code",
      scanned: 1,
      observations: 0,
      skipped: 0
    });
    assert.equal((db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number }).count, 0);
    assert.equal((db.prepare("SELECT COUNT(*) as count FROM scan_checkpoints").get() as { count: number }).count, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude scanner keeps visible user and assistant text after filtering metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-claude-visible-"));
  try {
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "session.jsonl"), [
      JSON.stringify({ type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "sidechain should be skipped" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Please clean Claude visible transcript" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "I will keep only readable transcript text." }] } })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanClaudeCodeSessions(db, join(dir, "claude")).observations, 2);
    const rows = db.prepare("SELECT role, text FROM observations ORDER BY role DESC").all();
    db.close();
    assert.ok(rows.some((row) => row.role === "user" && row.text === "Please clean Claude visible transcript"));
    assert.ok(rows.some((row) => row.role === "assistant" && row.text === "I will keep only readable transcript text."));
    assert.ok(!rows.some((row) => String(row.text).includes("sidechain")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkpoint rescans when jsonl file mtime and size change", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-checkpoint-"));
  try {
    mkdirSync(join(dir, "codex"));
    const file = join(dir, "codex", "session.jsonl");
    writeFileSync(file, JSON.stringify({ role: "user", text: "Please scan once" }));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 1);
    writeFileSync(file, [
      JSON.stringify({ role: "user", text: "Please scan once" }),
      JSON.stringify({ role: "user", text: "Please scan twice now" })
    ].join("\n"));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 2);
    const row = db.prepare("SELECT COUNT(*) as count FROM observations").get();
    db.close();
    assert.ok(row);
    assert.equal(row.count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser sessions endpoint ingests observations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-browser-"));
  const db = openDatabase(getAppPaths(dir));
  const server = createAppServer({ db });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/browser/sessions`, {
      method: "POST",
      body: JSON.stringify({ id: "browser-1", messages: [{ role: "user", text: "Track this browser todo" }] })
    });
    assert.equal(response.status, 200);
    const row = db.prepare("SELECT COUNT(*) as count FROM observations WHERE source = 'browser'").get();
    assert.ok(row);
    assert.equal(row.count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
