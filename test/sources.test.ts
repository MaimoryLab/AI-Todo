import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
    const codexSession = db.prepare("SELECT project_path as projectPath FROM sessions WHERE source = 'codex'").get() as { projectPath: string };
    assert.equal(codexSession.projectPath, "/tmp/project");
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

test("codex scanner backfills project path when checkpoint is unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-codex-project-backfill-"));
  const db = openDatabase(getAppPaths(join(dir, "home")));
  try {
    const codexDir = join(dir, "codex");
    mkdirSync(codexDir);
    const file = join(codexDir, "session.jsonl");
    writeFileSync(file, [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-project-session", cwd: "/Users/demo/workspace", timestamp: "2026-01-01T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Please keep this session visible", timestamp: "2026-01-01T00:00:00.000Z" } })
    ].join("\n"));

    assert.equal(scanCodexSessions(db, codexDir).observations, 1);
    db.prepare("UPDATE sessions SET project_path = NULL WHERE source = 'codex' AND path = ?").run(file);
    assert.deepEqual(scanCodexSessions(db, codexDir), {
      source: "codex",
      scanned: 0,
      observations: 0,
      skipped: 1
    });
    const row = db.prepare("SELECT project_path as projectPath FROM sessions WHERE source = 'codex' AND path = ?").get(file) as { projectPath: string };
    assert.equal(row.projectPath, "/Users/demo/workspace");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex scanner tolerates missing project path metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-codex-no-project-"));
  const db = openDatabase(getAppPaths(join(dir, "home")));
  try {
    const codexDir = join(dir, "codex");
    mkdirSync(codexDir);
    writeFileSync(join(codexDir, "session.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "codex-no-project", timestamp: "2026-01-01T00:00:00.000Z" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Please still scan this session", timestamp: "2026-01-01T00:00:00.000Z" } })
    ].join("\n"));

    assert.equal(scanCodexSessions(db, codexDir).observations, 1);
    const row = db.prepare("SELECT project_path as projectPath FROM sessions WHERE source = 'codex'").get() as { projectPath: string | null };
    assert.equal(row.projectPath, null);
  } finally {
    db.close();
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

test("codex scanner stores readable file and image references", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-attachments-"));
  try {
    mkdirSync(join(dir, "codex"));
    const imagePath = "/var/folders/demo/codex-clipboard-a1ec.png";
    const filePath = "/Users/ppio/Documents/brief.md";
    writeFileSync(join(dir, "codex", "session.jsonl"), [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: [
            "Please inspect the attached screenshot.",
            "",
            "# Files mentioned by the user:",
            "",
            `## brief.md: ${filePath}`,
            "",
            `## codex-clipboard-a1ec.png: ${imagePath}`,
            "",
            `<image name=[Image #1] path="${imagePath}">`,
            "</image>"
          ].join("\n"),
          timestamp: "2026-01-01T00:00:01.000Z"
        }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 1);
    const row = db.prepare("SELECT text FROM observations").get() as { text: string };
    db.close();

    assert.match(row.text, /Please inspect the attached screenshot/);
    assert.match(row.text, /Files mentioned: brief\.md \(\/Users\/ppio\/Documents\/brief\.md\)/);
    assert.match(row.text, /Image: Image #1 \(\/var\/folders\/demo\/codex-clipboard-a1ec\.png\)/);
    assert.doesNotMatch(row.text, /Files mentioned: codex-clipboard-a1ec\.png/);
    assert.equal((row.text.match(/\/var\/folders\/demo\/codex-clipboard-a1ec\.png/g) ?? []).length, 1);
    assert.equal((row.text.match(/\/Users\/ppio\/Documents\/brief\.md/g) ?? []).length, 1);
    assert.doesNotMatch(row.text, /<image|<\/image>/);
    assert.doesNotMatch(row.text, /# Files mentioned by the user/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex scanner stores structured local image references without inline image tags", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-local-images-"));
  try {
    mkdirSync(join(dir, "codex"));
    writeFileSync(join(dir, "codex", "session.jsonl"), [
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Please compare this screenshot with the expected layout.",
          images: [{ path: "/tmp/layout.png", name: "layout.png" }],
          local_images: ["/tmp/layout.png", { path: "/tmp/extra.png", name: "extra.png" }],
          timestamp: "2026-01-01T00:00:01.000Z"
        }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 1);
    const row = db.prepare("SELECT text FROM observations").get() as { text: string };
    db.close();

    assert.match(row.text, /Please compare this screenshot/);
    assert.match(row.text, /Image: layout\.png \(\/tmp\/layout\.png\)/);
    assert.match(row.text, /Image: extra\.png \(\/tmp\/extra\.png\)/);
    assert.equal((row.text.match(/\/tmp\/layout\.png/g) ?? []).length, 1);
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

test("codex scanner removes subagent notifications from user observations", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-subagent-"));
  try {
    mkdirSync(join(dir, "codex"));
    const subagent = [
      "<subagent_notification>",
      JSON.stringify({ agent_path: "agent-1", status: { completed: "**Subagent report**\nShould not appear." } }),
      "</subagent_notification>"
    ].join("\n");
    writeFileSync(join(dir, "codex", "session.jsonl"), [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: subagent, timestamp: "2026-01-01T00:00:01.000Z" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `Please keep this request.\n${subagent}\nThanks.`, timestamp: "2026-01-01T00:00:02.000Z" } })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanCodexSessions(db, join(dir, "codex")).observations, 1);
    const row = db.prepare("SELECT text FROM observations").get() as { text: string };
    db.close();
    assert.equal(row.text, "Please keep this request.\n\nThanks.");
    assert.doesNotMatch(row.text, /<subagent_notification>|agent_path|completed|Subagent report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codex scanner merges linked subagent sessions into the parent session", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-subagent-merge-"));
  try {
    const root = join(dir, "codex");
    const agentDir = join(root, "agents", "agent-1");
    mkdirSync(agentDir, { recursive: true });
    const subagent = [
      "<subagent_notification>",
      JSON.stringify({ agent_path: agentDir, status: { completed: "hidden report" } }),
      "</subagent_notification>"
    ].join("\n");
    writeFileSync(join(root, "parent.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "parent-session", cwd: "/tmp/project" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: `Please audit this.\n${subagent}`, timestamp: "2026-01-01T00:00:01.000Z" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Starting audit.", timestamp: "2026-01-01T00:00:02.000Z" } })
    ].join("\n"));
    writeFileSync(join(agentDir, "child.jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: "child-session", cwd: "/tmp/project" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Subagent found the issue.", timestamp: "2026-01-01T00:00:03.000Z" } })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.deepEqual(scanCodexSessions(db, root), {
      source: "codex",
      scanned: 2,
      observations: 3,
      skipped: 0
    });
    const sessions = db.prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>;
    const observations = db.prepare("SELECT session_id as sessionId, text FROM observations ORDER BY created_at").all() as Array<{ sessionId: string; text: string }>;
    db.close();
    const parentSessionId = testId("codex", "parent-session");
    assert.deepEqual(sessions.map((session) => session.id), [parentSessionId]);
    assert.deepEqual(observations.map((row) => row.sessionId), [parentSessionId, parentSessionId, parentSessionId]);
    assert.ok(observations.some((row) => row.text === "Subagent found the issue."));
    assert.ok(!observations.some((row) => /subagent_notification|agent_path|hidden report/.test(row.text)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function testId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex");
}

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

test("claude scanner removes subagent notifications from visible text", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-claude-subagent-"));
  try {
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "session.jsonl"), [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "text",
            text: [
              "Please keep this Claude request.",
              "<subagent_notification>",
              "{\"agent_path\":\"agent-2\",\"status\":{\"completed\":\"hidden report\"}}",
              "</subagent_notification>"
            ].join("\n")
          }]
        }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanClaudeCodeSessions(db, join(dir, "claude")).observations, 1);
    const row = db.prepare("SELECT text FROM observations").get() as { text: string };
    db.close();
    assert.equal(row.text, "Please keep this Claude request.");
    assert.doesNotMatch(row.text, /<subagent_notification>|agent_path|completed|hidden report/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("claude scanner stores readable attachment references", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-todo-source-claude-attachments-"));
  try {
    mkdirSync(join(dir, "claude"));
    writeFileSync(join(dir, "claude", "session.jsonl"), [
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Please review these inputs." },
            { type: "image", name: "mockup.png", path: "/tmp/mockup.png" },
            { type: "attachment", name: "notes.md", path: "/tmp/notes.md" },
            { type: "text", text: '<image name="mockup.png" path="/tmp/mockup.png"></image>' }
          ]
        }
      })
    ].join("\n"));

    const db = openDatabase(getAppPaths(join(dir, "home")));
    assert.equal(scanClaudeCodeSessions(db, join(dir, "claude")).observations, 1);
    const row = db.prepare("SELECT text FROM observations").get() as { text: string };
    db.close();

    assert.match(row.text, /Please review these inputs/);
    assert.match(row.text, /Image: mockup\.png \(\/tmp\/mockup\.png\)/);
    assert.match(row.text, /File: notes\.md \(\/tmp\/notes\.md\)/);
    assert.equal((row.text.match(/\/tmp\/mockup\.png/g) ?? []).length, 1);
    assert.doesNotMatch(row.text, /<image|<\/image>/);
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
