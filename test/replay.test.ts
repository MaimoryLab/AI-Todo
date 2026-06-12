import { describe, expect, it, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonlText } from "../src/replay/jsonl-parser.js";
import { projectTimeline } from "../src/replay/timeline.js";
import { registerReplayFunctions } from "../src/functions/replay.js";
import { getSearchIndex } from "../src/functions/search.js";
import { buildSyntheticCompression } from "../src/functions/compress-synthetic.js";
import type { RawObservation, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  safeAudit: vi.fn(),
}));

const fx = (name: string) =>
  readFileSync(join(__dirname, "fixtures/jsonl", name), "utf-8");

const fxPath = (name: string) => join(__dirname, "fixtures/jsonl", name);

beforeEach(() => {
  getSearchIndex().clear();
});

describe("parseJsonlText", () => {
  it("parses basic user/assistant exchange", () => {
    const out = parseJsonlText(fx("basic.jsonl"));
    expect(out.sessionId).toBe("sess-basic");
    expect(out.project).toBe("project");
    expect(out.cwd).toBe("/Users/alice/project");
    expect(out.observations).toHaveLength(2);
    expect(out.observations[0].hookType).toBe("prompt_submit");
    expect(out.observations[0].userPrompt).toBe("Fix the login bug");
    expect(out.observations[1].hookType).toBe("stop");
    expect(out.observations[1].assistantResponse).toBe("Looking into it now.");
  });

  it("parses tool_use + tool_result pairs", () => {
    const out = parseJsonlText(fx("tool-use.jsonl"));
    expect(out.sessionId).toBe("sess-tool");
    const kinds = out.observations.map((o) => o.hookType);
    expect(kinds).toEqual([
      "prompt_submit",
      "pre_tool_use",
      "post_tool_use",
      "stop",
    ]);
    const toolCall = out.observations[1];
    expect(toolCall.toolName).toBe("Bash");
    expect((toolCall.toolInput as { command: string }).command).toBe("ls");
    const toolResult = out.observations[2];
    expect(toolResult.toolOutput).toBe("README.md\nsrc\n");
  });

  it("tolerates malformed lines and marks tool errors", () => {
    const out = parseJsonlText(fx("errors.jsonl"));
    const errObs = out.observations.find((o) => o.hookType === "post_tool_failure");
    expect(errObs).toBeDefined();
    expect(errObs?.toolOutput).toBe("exit 1");
  });

  it("falls back to generated sessionId when missing", () => {
    const text = JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const out = parseJsonlText(text);
    expect(out.sessionId).toMatch(/^sess_/);
  });

  it("returns empty observations for blank input", () => {
    const out = parseJsonlText("");
    expect(out.observations).toHaveLength(0);
  });

  it("prefers the file's sessionId over the fallback", () => {
    const text = [
      JSON.stringify({
        type: "user",
        sessionId: "real-session-from-file",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
    ].join("\n");
    const out = parseJsonlText(text, "fallback-should-be-ignored");
    expect(out.sessionId).toBe("real-session-from-file");
    for (const obs of out.observations) {
      expect(obs.sessionId).toBe("real-session-from-file");
    }
  });

  it("returns the same sessionId across repeated parses of one file", () => {
    const text = JSON.stringify({
      type: "user",
      sessionId: "stable-id",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const a = parseJsonlText(text, "fb-1");
    const b = parseJsonlText(text, "fb-2");
    expect(a.sessionId).toBe("stable-id");
    expect(b.sessionId).toBe("stable-id");
  });

  it("uses the fallback only when the file has no sessionId", () => {
    const text = JSON.stringify({
      type: "user",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const out = parseJsonlText(text, "fb-used");
    expect(out.sessionId).toBe("fb-used");
  });

  it("parses Codex session_meta/event_msg/response_item transcripts", () => {
    const out = parseJsonlText(fx("codex-session.jsonl"), "fallback-ignored");

    expect(out.sessionId).toBe("codex-real-session");
    expect(out.project).toBe("codex-project");
    expect(out.cwd).toBe("/Users/alice/codex-project");
    expect(out.startedAt).toBe("2026-06-11T08:00:00.000Z");
    expect(out.endedAt).toBe("2026-06-11T08:00:04.000Z");
    expect(out.observations.map((o) => o.hookType)).toEqual([
      "prompt_submit",
      "stop",
      "pre_tool_use",
      "post_tool_use",
    ]);
    expect(out.observations[0].userPrompt).toBe("生成摘要按钮点击必定失败，请修复");
    expect(out.observations[1].assistantResponse).toBe("我会先复现并定位摘要链路。");
    expect(out.observations[2].toolName).toBe("exec_command");
    expect(out.observations[2].toolInput).toEqual({
      cmd: "rg summarize src/viewer/index.html",
    });
    expect(out.observations[3].toolOutput).toBe("src/viewer/index.html:6866 summarizeSession");
    expect(out.observations.every((o) => o.sessionId === "codex-real-session")).toBe(true);
  });

  it("generates stable observation ids across repeated parses of one JSONL", () => {
    const first = parseJsonlText(fx("codex-session.jsonl"), "fallback-ignored");
    const second = parseJsonlText(fx("codex-session.jsonl"), "fallback-ignored");

    expect(first.observations.map((o) => o.id)).toEqual(second.observations.map((o) => o.id));
  });
});

describe("projectTimeline", () => {
  it("preserves ordering and computes offsets from real timestamps", () => {
    const parsed = parseJsonlText(fx("tool-use.jsonl"));
    const tl = projectTimeline(parsed.observations);
    expect(tl.eventCount).toBe(4);
    expect(tl.events[0].kind).toBe("prompt");
    expect(tl.events[1].kind).toBe("tool_call");
    expect(tl.events[2].kind).toBe("tool_result");
    expect(tl.events[3].kind).toBe("response");
    expect(tl.events[0].offsetMs).toBe(0);
    expect(tl.events[3].offsetMs).toBeGreaterThan(0);
  });

  it("synthesizes pacing when all timestamps identical", () => {
    const parsed = parseJsonlText(fx("basic.jsonl"));
    for (const obs of parsed.observations) obs.timestamp = "2026-04-17T10:00:00.000Z";
    const tl = projectTimeline(parsed.observations);
    expect(tl.events[0].offsetMs).toBe(0);
    expect(tl.events[1].offsetMs).toBeGreaterThanOrEqual(300);
  });

  it("returns empty timeline for no observations", () => {
    const tl = projectTimeline([]);
    expect(tl.eventCount).toBe(0);
    expect(tl.totalDurationMs).toBe(0);
    expect(tl.events).toHaveLength(0);
  });

  it("marks errored tool results as tool_error kind", () => {
    const parsed = parseJsonlText(fx("errors.jsonl"));
    const tl = projectTimeline(parsed.observations);
    expect(tl.events.some((e) => e.kind === "tool_error")).toBe(true);
  });

  it("uses one shared fallback timestamp when metadata missing", () => {
    const text = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    });
    const out = parseJsonlText(text);
    expect(out.startedAt).toBe(out.endedAt);
  });
});

describe("buildSyntheticCompression replay coverage", () => {
  it("preserves assistant responses in the zero-LLM narrative", () => {
    const parsed = parseJsonlText(fx("basic.jsonl"));
    const response = parsed.observations.find((o) => o.assistantResponse);
    expect(response).toBeDefined();

    const compressed = buildSyntheticCompression(response!);

    expect(compressed.type).toBe("conversation");
    expect(compressed.narrative).toContain("Looking into it now.");
  });
});

describe("mem::replay::import-jsonl", () => {
  it("is idempotent when importing the same Codex JSONL repeatedly", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerReplayFunctions(sdk as never, kv as never);

    const first = await sdk.trigger("mem::replay::import-jsonl", {
      path: fxPath("codex-session.jsonl"),
      maxFiles: 1,
    }) as { success: boolean; sessionIds: string[]; observations: number };
    const second = await sdk.trigger("mem::replay::import-jsonl", {
      path: fxPath("codex-session.jsonl"),
      maxFiles: 1,
    }) as { success: boolean; sessionIds: string[]; observations: number };

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.sessionIds).toEqual(["codex-real-session"]);
    expect(second.sessionIds).toEqual(["codex-real-session"]);
    expect(first.observations).toBe(4);
    expect(second.observations).toBe(0);

    const stored = await kv.list<RawObservation>(KV.observations("codex-real-session"));
    expect(stored).toHaveLength(4);
    const session = await kv.get<Session>(KV.sessions, "codex-real-session");
    expect(session?.observationCount).toBe(4);
  });
});
