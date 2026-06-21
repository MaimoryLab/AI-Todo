import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  DEFAULT_LANGEXTRACT_BASE_URL: "https://api.novita.ai/openai/v1",
  DEFAULT_TODO_EXTRACT_TIMEOUT_MS: 120_000,
  getEnvVar: (key: string) => {
    const values: Record<string, string> = {
      AGENTMEMORY_TODO_EXTRACTOR: "rules",
      AGENTMEMORY_TODO_DIRECT_CONFIDENCE: "0.6",
      AGENTMEMORY_TODO_REVIEW_CONFIDENCE: "0.55",
    };
    return process.env[key] ?? values[key];
  },
  normalizeTodoExtractorModel: (value?: string) => value || "deepseek/deepseek-v4-pro",
  normalizeTodoExtractorProvider: (value?: string) => (value || "openai").toLowerCase(),
}));

import { cleanPollutedTodoCards, cleanTodoTitle, generateTodosFromSessions, validateTodoEvidence, runLangExtractSidecar, type ExtractedTodo } from "../src/functions/todo-extract.js";
import type { Action, CompressedObservation, ReviewQueueItem, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "ses_1",
    project: "agentmemory-lab",
    cwd: "/repo",
    startedAt: "2026-06-17T08:00:00.000Z",
    endedAt: "2026-06-17T09:00:00.000Z",
    status: "completed",
    observationCount: 1,
    ...patch,
  };
}

function obs(patch: Partial<CompressedObservation> = {}): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: "2026-06-17T08:10:00.000Z",
    type: "conversation",
    title: "assistant",
    subtitle: "",
    facts: [],
    narrative: "下一步请修复 CI 失败，并重新跑测试。",
    concepts: [],
    files: [],
    importance: 5,
    ...patch,
  };
}

describe("todo extraction", () => {
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    kv = mockKV();
  });

  it("falls back to rules and directly creates high-confidence todos with evidence metadata", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.llmFallback).toBeUndefined();
    expect(result.directCreated).toBe(1);
    expect(result.reviewCreated).toBe(0);
    const actions = await kv.list<Action>(KV.actions);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      status: "pending",
      project: "agentmemory-lab",
      tags: expect.arrayContaining(["todo-extracted", "time:current", "type:follow_up"]),
      sourceObservationIds: ["obs_1"],
    });
    expect(actions[0].metadata?.todoExtraction).toMatchObject({
      sourceSessionId: "ses_1",
      sourceCheckpoint: "2026-06-17T09:00:00.000Z:1",
      evidence: { sourceObservationId: "obs_1" },
    });
  });

  it("uses scan checkpoints to skip unchanged sessions", async () => {
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    await generateTodosFromSessions(kv as never, { force: true, scanSources: false });
    const second = await generateTodosFromSessions(kv as never, { scanSources: false });

    expect(second.scannedObservations).toBe(0);
    expect(second.directCreated).toBe(0);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(1);
  });

  it("sends medium-confidence rule todos to review", async () => {
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: "下一步请修复 CI 失败，并重新跑测试。" }));

    process.env.AGENTMEMORY_TODO_DIRECT_CONFIDENCE = "0.8";
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });
    delete process.env.AGENTMEMORY_TODO_DIRECT_CONFIDENCE;

    expect(result.directCreated).toBe(0);
    expect(result.reviewCreated).toBe(1);
    const reviews = await kv.list<ReviewQueueItem>(KV.reviewQueue);
    expect(reviews[0]).toMatchObject({
      kind: "action",
      payload: {
        todoExtraction: expect.objectContaining({ sourceSessionId: "ses_1" }),
      },
    });
  });

  it("keeps history todos hidden instead of writing them to actions", async () => {
    await kv.set(KV.sessions, "ses_1", session({
      startedAt: "2026-05-01T08:00:00.000Z",
      endedAt: "2026-05-01T09:00:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.hiddenHistory).toBe(1);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(0);
    const reviews = await kv.list<ReviewQueueItem>(KV.reviewQueue);
    expect(reviews[0]).toMatchObject({
      status: "dismissed",
      payload: {
        hiddenHistory: true,
        todoExtraction: expect.objectContaining({ timeBucket: "history" }),
      },
    });
  });

  it("marks extracted actions for recheck when the source session changes", async () => {
    await kv.set(KV.sessions, "ses_1", session({ observationCount: 2 }));
    await kv.set<Action>(KV.actions, "act_1", {
      id: "act_1",
      title: "整理待办",
      description: "整理待办",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T09:00:00.000Z",
      updatedAt: "2026-06-17T09:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted", "time:current", "type:to_start"],
      sourceObservationIds: ["obs_1"],
      sourceMemoryIds: [],
      metadata: {
        todoExtraction: {
          sourceSessionId: "ses_1",
          sourceCheckpoint: "2026-06-17T09:00:00.000Z:1",
        },
      },
    });

    const result = await generateTodosFromSessions(kv as never, { scanSources: false });

    expect(result.recheckMarked).toBe(1);
    const actions = await kv.list<Action>(KV.actions);
    expect(actions[0].tags).toContain("todo-recheck");
    expect(actions[0].metadata?.todoExtraction).toMatchObject({
      needsRecheck: true,
      latestSourceCheckpoint: "2026-06-17T09:00:00.000Z:2",
    });
  });

  it("suppresses todos that near-duplicate an existing open action but not a done one (STEP-08 PR4)", async () => {
    const seedExisting = async (status: Action["status"]) => {
      await kv.set<Action>(KV.actions, "act_seed", {
        id: "act_seed",
        title: "克隆上游项目到子目录中",
        description: "克隆上游项目到子目录中",
        status,
        priority: 5,
        createdAt: "2026-06-17T08:00:00.000Z",
        updatedAt: "2026-06-17T08:00:00.000Z",
        createdBy: "test",
        tags: [],
        sourceObservationIds: [],
        sourceMemoryIds: [],
      });
    };

    // Open action present → the near-dup todo is suppressed.
    await seedExisting("pending");
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: "TODO: 克隆上游项目到子目录。" }));
    const suppressed = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });
    expect(suppressed.directCreated).toBe(0);
    expect((await kv.list<Action>(KV.actions)).map((a) => a.id)).toEqual(["act_seed"]);

    // Same title but the existing action is done → the work may have regressed,
    // so the todo is created again.
    kv = mockKV();
    await seedExisting("done");
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: "TODO: 克隆上游项目到子目录。" }));
    const created = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });
    expect(created.directCreated).toBe(1);
  });

  it("rejects extracted todos when evidence quote is not grounded", () => {
    expect(validateTodoEvidence({
      title: "修复不存在的问题",
      description: "修复不存在的问题",
      confidence: 0.95,
      timeBucket: "current",
      typeBucket: "pending",
      sourceSessionId: "ses_1",
      evidence: { sourceObservationId: "obs_1", quote: "不存在的 quote" },
      dedupeKey: "bad-evidence",
    }, new Map([["obs_1", { text: "普通总结，没有行动。" }]]))).toBe(false);
  });

  it("requires the evidence quote to be grounded IN the observation, not merely to contain it (STEP-08)", () => {
    const base = {
      title: "修复 CI 失败",
      description: "修复 CI 失败",
      confidence: 0.95,
      timeBucket: "current" as const,
      typeBucket: "pending" as const,
      sourceSessionId: "ses_1",
      dedupeKey: "k",
    };
    const blocks = new Map([["obs_1", { text: "后续需要修复 CI 失败。" }]]);
    // grounded: the quote is a substring of the observation
    expect(validateTodoEvidence({ ...base, evidence: { sourceObservationId: "obs_1", quote: "修复 CI 失败" } }, blocks)).toBe(true);
    // ungrounded: the quote wraps the whole observation + hallucinated extra —
    // it CONTAINS the block text but is not grounded in it, so must be rejected
    expect(validateTodoEvidence({
      ...base,
      evidence: { sourceObservationId: "obs_1", quote: "后续需要修复 CI 失败。还要重写整个部署流水线。" },
    }, blocks)).toBe(false);
  });

  it("cleans bad tool-log titles before writing todos", async () => {
    const cleaned = cleanTodoTitle(
      "langextract-demo/...`",
      "因为用户明确要截图，我会读取截图专项说明，然后保存到 `/tmp/ai-todo-langextract-demo/...`。",
    );
    expect(cleaned).toContain("读取截图专项说明");
    expect(cleaned).not.toContain("langextract-demo");
    expect(cleaned).not.toContain("保存到");
    expect(cleanTodoTitle(
      "{\"cmd\":\"gh pr list --json number,title\"}",
      "{\"cmd\":\"gh pr list --json number,title\"}",
    )).toBeNull();
  });

  it("compacts long assistant-progress sentences into readable card titles", () => {
    const cleaned = cleanTodoTitle(
      "我会再等一轮；若仍未完成，我会中断这次安装，转用仓库结构和脚本级检查继续评估，不让验证步骤卡住整体结论",
      "npm install 长时间无输出；计划再等待一轮，如仍未完成则中断安装，改用仓库结构和脚本级检查继续评估。",
    );
    expect(cleaned).toBe("再等一轮");
  });

  it("anti-truncation: skips fragment titles and trims on a boundary (STEP-08)", () => {
    // HTTP-status cut "返回 4" is a truncation fragment → fall through to the
    // clean description rather than emitting it as a card title.
    expect(cleanTodoTitle("返回 4", "修复老路由返回 404 的问题。")).toBe(
      "修复老路由返回 404 的问题",
    );
    // a list cut to "…、/he" is a fragment → fall through.
    expect(cleanTodoTitle("老的 /actions、/sessions、/he", "修复老路由 404。")).toBe(
      "修复老路由 404",
    );
    // a long no-comma title trims to <=42 chars without a dangling boundary char
    // and without splitting a word.
    const t = cleanTodoTitle(
      "investigate the failing classification boundary detector here now please",
      "",
    );
    expect(t).toBeTruthy();
    expect(Array.from(t!).length).toBeLessThanOrEqual(42);
    expect(t).not.toMatch(/[，,；;、\s]$/u);
  });

  it("sidecar failures are explicit so auto mode can fall back", async () => {
    process.env.LANGEXTRACT_PYTHON = "__missing_python__";
    await expect(runLangExtractSidecar({ blocks: [{ text: "后续需要修复 CI。", sourceObservationId: "obs_1" }] }, { timeoutMs: 500 }))
      .rejects.toBeTruthy();
    delete process.env.LANGEXTRACT_PYTHON;
  });

  it("reports when auto mode fell back from LangExtract to rules", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "auto";
    process.env.LANGEXTRACT_PYTHON = "__missing_python__";
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.engine).toBe("rules");
    expect(result.llmFallback).toBe(true);
    expect(result.fallbackReason).toBeTruthy();
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;
    delete process.env.LANGEXTRACT_PYTHON;
  });

  it("cleans generated command-log cards from actions and review queue", async () => {
    await kv.set<Action>(KV.actions, "act_bad", {
      id: "act_bad",
      title: "json nameWithOwner",
      description: "gh pr list --json number,title --limit 20",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    await kv.set<Action>(KV.actions, "act_good", {
      id: "act_good",
      title: "整理首版功能文档",
      description: "整理首版功能文档并给 Steve review。",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    await kv.set<ReviewQueueItem>(KV.reviewQueue, "review_bad", {
      id: "review_bad",
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      status: "pending",
      kind: "action",
      title: "limit 20",
      content: "{\"cmd\":\"gh pr list --json number\"}",
      source: "viewer",
      payload: { tags: ["todo-extracted"], actionCandidate: { reason: "todo" } },
    });

    const result = await cleanPollutedTodoCards(kv as never);

    expect(result).toEqual({ cleanedActions: 1, cleanedReviews: 1 });
    expect((await kv.list<Action>(KV.actions)).map((a) => a.id)).toEqual(["act_good"]);
    expect(await kv.list<ReviewQueueItem>(KV.reviewQueue)).toEqual([]);
  });

  it("cleans completed-work narration cards but keeps genuine repairs (STEP-08 Layer 2)", async () => {
    await kv.set<Action>(KV.actions, "act_done", {
      id: "act_done",
      title: "三个抽取标签都能显示",
      description: "三个抽取标签都能显示，同时保持卡片不会被无关标签撑开。",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    await kv.set<Action>(KV.actions, "act_keep", {
      id: "act_keep",
      title: "修复登录态失效后摘要不显示的问题",
      description: "修复登录态失效后摘要不显示的问题。",
      status: "pending",
      priority: 6,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });

    const result = await cleanPollutedTodoCards(kv as never);

    expect(result.cleanedActions).toBe(1);
    expect((await kv.list<Action>(KV.actions)).map((a) => a.id)).toEqual(["act_keep"]);
  });

  it("cleans status-report cards but keeps repairs that mention a status phrase (STEP-08)", async () => {
    await kv.set<Action>(KV.actions, "act_status", {
      id: "act_status",
      title: "服务可用",
      description: "服务可用：Viewer 状态正常，无需处理。",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    // contains "服务可用" but is a real repair — must NOT be filtered (regression
    // guard for the previously-unconditional 服务可用 pollution rule)
    await kv.set<Action>(KV.actions, "act_repair", {
      id: "act_repair",
      title: "修复服务可用性回归",
      description: "修复服务可用性回归，排查压测下偶发 5xx。",
      status: "pending",
      priority: 6,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });

    const result = await cleanPollutedTodoCards(kv as never);

    expect(result.cleanedActions).toBe(1);
    expect((await kv.list<Action>(KV.actions)).map((a) => a.id)).toEqual(["act_repair"]);
  });
});
