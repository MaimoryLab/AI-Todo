import { describe, expect, it, beforeEach } from "vitest";
import { registerSessionHighlightsFunction } from "../src/functions/session-highlights.js";
import type {
  CompressedObservation,
  RawObservation,
  Session,
  SessionHighlightsView,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    functions,
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    trigger: async (
      idOrInput: string | { function_id: string; payload: unknown },
      data?: unknown,
    ) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

function makeObs(
  id: string,
  timestamp: string,
  patch: Partial<CompressedObservation>,
): CompressedObservation {
  return {
    id,
    sessionId: "ses_highlights",
    timestamp,
    type: "other",
    title: id,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
    ...patch,
  };
}

function makeRawObs(
  id: string,
  timestamp: string,
  patch: Partial<RawObservation>,
): RawObservation {
  return {
    id,
    sessionId: "ses_highlights",
    timestamp,
    hookType: "post_tool_use",
    toolName: "Bash",
    raw: {},
    ...patch,
  };
}

describe("mem::session-highlights", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    registerSessionHighlightsFunction(sdk as never, kv as never);

    const session: Session = {
      id: "ses_highlights",
      project: "agentmemory-lab",
      cwd: "/repo/agentmemory-lab",
      startedAt: "2026-06-11T01:00:00.000Z",
      endedAt: "2026-06-11T01:30:00.000Z",
      status: "completed",
      observationCount: 7,
      firstPrompt:
        "Build a zero-LLM session highlights backend and do not modify frontend design.",
    };
    await kv.set("mem:sessions", session.id, session);

    const observations = [
      makeObs("obs_user", "2026-06-11T01:00:01.000Z", {
        type: "conversation",
        title: "prompt_submit",
        narrative:
          "Build a zero-LLM session highlights backend and exclude LLM modules.",
        importance: 8,
      }),
      makeObs("obs_agent", "2026-06-11T01:03:00.000Z", {
        type: "conversation",
        title: "assistant response",
        narrative:
          "Agent output: Proposed a REST-only highlights API and explained the implementation plan.",
        importance: 7,
      }),
      makeObs("obs_mcp", "2026-06-11T01:05:00.000Z", {
        type: "other",
        title: "memory_smart_search",
        narrative: "Called MCP memory_smart_search for prior session context.",
        importance: 6,
      }),
      makeObs("obs_cmd", "2026-06-11T01:10:00.000Z", {
        type: "command_run",
        title: "Bash",
        subtitle: '{"command":"npm test -- --run test/session-highlights.test.ts"}',
        narrative:
          "Ran command npm test -- --run test/session-highlights.test.ts. Tests: 12 passed, 0 failed.",
        importance: 8,
      }),
      makeObs("obs_fail", "2026-06-11T01:15:00.000Z", {
        type: "error",
        title: "Bash error",
        narrative: "Command failed with exit 1 because sessionId was missing.",
        importance: 9,
      }),
      makeObs("obs_file", "2026-06-11T01:20:00.000Z", {
        type: "file_edit",
        title: "Edit src/functions/session-highlights.ts",
        narrative:
          "Generated important backend file and updated the API endpoint registration.",
        files: ["src/functions/session-highlights.ts", "src/triggers/api.ts"],
        importance: 8,
      }),
      makeObs("obs_skill", "2026-06-11T01:25:00.000Z", {
        type: "task",
        title: "Skill follow-up",
        narrative:
          "TODO: promote this heuristic into a Skill if repeated across sessions.",
        importance: 7,
      }),
      makeRawObs("raw_prompt", "2026-06-11T01:26:00.000Z", {
        hookType: "prompt_submit",
        userPrompt: "把会话重点限制为用户和 Agent 在对话框里真实说过的话。",
      }),
      makeRawObs("raw_agent", "2026-06-11T01:27:00.000Z", {
        hookType: "stop",
        assistantResponse:
          "我会把 highlights 改成 conversation-only，并保留现有 REST 响应结构。",
      }),
      makeRawObs("raw_tool_pollution", "2026-06-11T01:28:00.000Z", {
        hookType: "post_tool_use",
        toolName: "exec_command",
        toolInput: {
          command: "npm test -- --run test/session-highlights.test.ts",
        },
        toolOutput: {
          stdout: "failed error apply_patch function_id toolInput toolOutput",
        },
        raw: {
          function_id: "mem::session-highlights",
          payload: { command: "apply_patch" },
        },
      }),
    ];
    for (const obs of observations) {
      await kv.set("mem:obs:ses_highlights", obs.id, obs);
    }
  });

  it("builds a conversation-only highlights view without an LLM provider", async () => {
    const result = (await sdk.trigger("mem::session-highlights", {
      sessionId: "ses_highlights",
      maxItems: 20,
    })) as SessionHighlightsView;

    expect(result.success).toBe(true);
    expect(result.session.id).toBe("ses_highlights");
    expect(result.coverage.llmUsed).toBe(false);
    expect(result.coverage.hasAssistantOutputs).toBe(true);
    expect(result.stats.observationCount).toBe(10);

    const categories = result.highlights.map((h) => h.category);
    expect(new Set(categories)).toEqual(new Set(["goal", "agent_output"]));
    expect(categories).not.toContain("mcp");
    expect(categories).not.toContain("command");
    expect(categories).not.toContain("validation");
    expect(categories).not.toContain("failure");
    expect(categories).not.toContain("file");
    expect(categories).not.toContain("skill");
    expect(categories).not.toContain("todo");
    expect(result.stats.fileCount).toBe(0);
    expect(result.stats.toolCount).toBe(0);

    const summaries = result.highlights.map((h) => h.summary).join("\n");
    expect(summaries).toContain("Build a zero-LLM session highlights backend");
    expect(summaries).toContain("把会话重点限制为用户和 Agent");
    expect(summaries).toContain("conversation-only");
    expect(summaries).not.toContain("npm test");
    expect(summaries).not.toContain("apply_patch");
    expect(summaries).not.toContain("function_id");
    expect(summaries).not.toContain("toolInput");
  });

  it("returns a stable empty view when a session has no observations", async () => {
    await kv.set("mem:sessions", "empty", {
      id: "empty",
      project: "agentmemory-lab",
      cwd: "/repo/agentmemory-lab",
      startedAt: "2026-06-11T02:00:00.000Z",
      status: "active",
      observationCount: 0,
    } satisfies Session);

    const result = (await sdk.trigger("mem::session-highlights", {
      sessionId: "empty",
    })) as SessionHighlightsView;

    expect(result.success).toBe(true);
    expect(result.highlights).toEqual([]);
    expect(result.coverage.hasAssistantOutputs).toBe(false);
    expect(result.coverage.missingAssistantOutputs).toBe(true);
  });

  it("rejects missing sessionId and reports missing sessions", async () => {
    const invalid = await sdk.trigger("mem::session-highlights", {});
    expect(invalid).toMatchObject({ success: false, error: "sessionId is required" });

    const missing = await sdk.trigger("mem::session-highlights", {
      sessionId: "missing",
    });
    expect(missing).toMatchObject({ success: false, error: "session_not_found" });
  });

  it("ignores source reads, command JSON, tool IO, and operational error words", async () => {
    await kv.set("mem:obs:ses_highlights", "obs_source_read", makeObs(
      "obs_source_read",
      "2026-06-11T01:28:00.000Z",
      {
        type: "file_read",
        title: "Read src/functions/session-highlights.ts",
        narrative:
          "function isValidationText(text) { return text.includes('failed') || text.includes('error') || text.includes('test'); }",
        files: ["src/functions/session-highlights.ts"],
        importance: 6,
      },
    ));

    await kv.set("mem:obs:ses_highlights", "obs_readonly_shell", makeObs(
      "obs_readonly_shell",
      "2026-06-11T01:29:00.000Z",
      {
        type: "command_run",
        title: "Bash",
        subtitle: '{"command":"nl -ba src/functions/session-highlights.ts | sed -n \'1,80p\'"}',
        narrative:
          "1 function isValidationText(text) { return text.includes('failed') || text.includes('error') || text.includes('test'); }",
        importance: 5,
      },
    ));

    const result = (await sdk.trigger("mem::session-highlights", {
      sessionId: "ses_highlights",
      maxItems: 50,
    })) as SessionHighlightsView;

    expect(result.highlights.map((h) => h.sourceObservationId)).not.toContain("obs_source_read");
    expect(result.highlights.map((h) => h.sourceObservationId)).not.toContain("obs_readonly_shell");
    expect(result.highlights.map((h) => h.sourceObservationId)).not.toContain("raw_tool_pollution");
    expect(new Set(result.highlights.map((h) => h.category))).toEqual(new Set(["goal", "agent_output"]));
  });

  it("filters JSON-shaped and tool-trace conversation text before adding highlights", async () => {
    await kv.set("mem:obs:ses_highlights", "obs_json_conversation", makeObs(
      "obs_json_conversation",
      "2026-06-11T01:31:00.000Z",
      {
        type: "conversation",
        title: "conversation",
        narrative: '{"command":"npm test","toolInput":{"file":"src/index.ts"}}',
      },
    ));
    await kv.set("mem:obs:ses_highlights", "raw_tool_trace_prompt", makeRawObs(
      "raw_tool_trace_prompt",
      "2026-06-11T01:32:00.000Z",
      {
        hookType: "prompt_submit",
        userPrompt: "exec_command apply_patch toolOutput function_id",
      },
    ));

    const result = (await sdk.trigger("mem::session-highlights", {
      sessionId: "ses_highlights",
      maxItems: 50,
    })) as SessionHighlightsView;

    expect(result.highlights.map((h) => h.sourceObservationId)).not.toContain("obs_json_conversation");
    expect(result.highlights.map((h) => h.sourceObservationId)).not.toContain("raw_tool_trace_prompt");
    expect(result.highlights.map((h) => h.summary).join("\n")).not.toContain('"command"');
  });
});
