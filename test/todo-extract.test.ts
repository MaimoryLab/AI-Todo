import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  DEFAULT_LANGEXTRACT_BASE_URL: "https://api.novita.ai/openai/v1",
  DEFAULT_TODO_EXTRACT_TIMEOUT_MS: 120_000,
  DEFAULT_TODO_EXTRACT_SINCE_DAYS: 7,
  DEFAULT_TODO_EXTRACT_MAX_INTERACTIONS: 10,
  DEFAULT_TODO_EXTRACT_MAX_SESSIONS: 8,
  getEnvVar: (key: string) => {
    const values: Record<string, string> = {
      AGENTMEMORY_TODO_EXTRACTOR: "rules",
      AGENTMEMORY_TODO_DIRECT_CONFIDENCE: "0.6",
      AGENTMEMORY_TODO_REVIEW_CONFIDENCE: "0.55",
      // Wide default window so existing time-agnostic tests are never excluded by
      // the STEP-11 sinceDays filter; scope tests set process.env explicitly.
      AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS: "3650",
    };
    return process.env[key] ?? values[key];
  },
  normalizeTodoExtractorModel: (value?: string) => value || "deepseek/deepseek-v4-flash",
  normalizeTodoExtractorProvider: (value?: string) => (value || "openai").toLowerCase(),
}));

import { cleanPollutedTodoCards, updateChangedTodoCards, cleanTodoTitle, generateTodosFromSessions, refreshTodoAction, validateTodoEvidence, runLangExtractSidecar, type ExtractedTodo } from "../src/functions/todo-extract.js";
import type { Action, CompressedObservation, ReviewQueueItem, ScanCheckpoint, Session } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { mockKV } from "./helpers/mocks.js";

const ROOT = join(import.meta.dirname, "..");

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

function generatedAction(patch: Partial<Action> = {}): Action {
  return {
    id: "act_old",
    title: "旧卡片标题",
    description: "旧卡片说明",
    status: "pending",
    priority: 5,
    createdAt: "2026-06-17T08:00:00.000Z",
    updatedAt: "2026-06-17T08:00:00.000Z",
    createdBy: "todo-extract",
    tags: ["todo-extracted", "type:follow_up"],
    sourceObservationIds: ["obs_1"],
    sourceMemoryIds: [],
    metadata: {
      todoExtraction: {
        title: "旧卡片标题",
        description: "旧卡片说明",
        confidence: 0.72,
        timeBucket: "current",
        typeBucket: "follow_up",
        sourceSessionId: "ses_1",
        sourceCheckpoint: "2026-06-17T09:00:00.000Z:1",
        evidence: {
          sourceObservationId: "obs_1",
          quote: "旧卡片说明",
        },
        dedupeKey: "old-card-title",
      },
    },
    ...patch,
  };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value).replace(/\s+/g, " ");
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

  it("extracts English unresolved todos but ignores completed English summaries", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 2 }));
    await kv.set(KV.observations("ses_1"), "obs_done", obs({
      id: "obs_done",
      narrative: "Tests passed and the PR was merged. No action needed.",
    }));
    await kv.set(KV.observations("ses_1"), "obs_real", obs({
      id: "obs_real",
      narrative: "Need to fix the failing CI and rerun tests.",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.scannedObservations).toBe(1);
    expect(result.directCreated).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0]).toMatchObject({
      sourceObservationIds: ["obs_real"],
      tags: expect.arrayContaining(["type:follow_up"]),
    });
  });

  it("does not turn bare failure reports into rule todos", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "Command failed with exit code 1.",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.scannedObservations).toBe(0);
    expect(result.directCreated).toBe(0);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(0);
  });

  it("skips LangExtract when session prefilter finds no candidate blocks", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "Tests passed and the PR was merged. No action needed.",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.scannedObservations).toBe(0);
    expect(result.directCreated).toBe(0);
    expect(result.llmFallback).toBeUndefined();
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;
  });

  it("uses scan checkpoints to skip unchanged sessions", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    await generateTodosFromSessions(kv as never, {
      force: true,
      scanSources: false,
      runLangExtractSidecar: async () => [{
        title: "修复 CI 失败并重新跑测试",
        description: "下一步请修复 CI 失败，并重新跑测试。",
        confidence: 0.95,
        timeBucket: "current",
        typeBucket: "follow_up",
        sourceSessionId: "ses_1",
        evidence: { sourceObservationId: "obs_1", quote: "下一步请修复 CI 失败，并重新跑测试。" },
        dedupeKey: "fix-ci",
      }],
    });
    const second = await generateTodosFromSessions(kv as never, { scanSources: false });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(second.scannedObservations).toBe(0);
    expect(second.directCreated).toBe(0);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(1);
  });

  it("does not write scan checkpoints when LangExtract falls back to rules", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    const first = await generateTodosFromSessions(kv as never, {
      force: true,
      scanSources: false,
      runLangExtractSidecar: async () => {
        throw new Error("langextract unavailable: No module named 'langextract'");
      },
    });
    expect(await kv.get<ScanCheckpoint>(KV.scanCheckpoints, "todo-extract:all")).toBeNull();
    const second = await generateTodosFromSessions(kv as never, {
      scanSources: false,
      runLangExtractSidecar: async () => [],
    });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(first).toMatchObject({ engine: "rules", llmFallback: true });
    expect(second.scannedObservations).toBe(1);
  });

  it("ignores legacy untagged scan checkpoints before LangExtract runs", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs());
    await kv.set<ScanCheckpoint>(KV.scanCheckpoints, "todo-extract:all", {
      sourceId: "todo-extract:all",
      cursor: JSON.stringify({ ses_1: "2026-06-17T09:00:00.000Z:1" }),
    });

    const result = await generateTodosFromSessions(kv as never, {
      scanSources: false,
      runLangExtractSidecar: async () => [],
    });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(result.scannedObservations).toBe(1);
  });

  it("discards medium-confidence rule todos instead of sending them to review", async () => {
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: "下一步请修复 CI 失败，并重新跑测试。" }));

    process.env.AGENTMEMORY_TODO_DIRECT_CONFIDENCE = "0.8";
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });
    delete process.env.AGENTMEMORY_TODO_DIRECT_CONFIDENCE;

    expect(result.directCreated).toBe(0);
    expect(result.reviewCreated).toBe(0);
    expect(result.discarded).toBe(1);
    expect(await kv.list<ReviewQueueItem>(KV.reviewQueue)).toHaveLength(0);
  });

  it("discards vague process-like rule todos instead of creating review candidates", async () => {
    await kv.set(KV.sessions, "ses_1", session());
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "TODO: 重启 Codex desktop app 后再测一次。",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.directCreated).toBe(0);
    expect(result.reviewCreated).toBe(0);
    expect(result.discarded).toBe(1);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(0);
    expect(await kv.list<ReviewQueueItem>(KV.reviewQueue)).toHaveLength(0);
  });

  it("does not persist pure agent process narration as todos", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "TODO: 做最后一次状态确认，确保工作区干净、当前分支和 PR 链接明确。",
    }));
    await kv.set(KV.observations("ses_1"), "obs_2", obs({
      id: "obs_2",
      narrative: "TODO: 启动后做健康检查，确认 Viewer 和 Health 都正常。",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.scannedObservations).toBe(0);
    expect(result.directCreated).toBe(0);
    expect(result.reviewCreated).toBe(0);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(0);
    expect(await kv.list<ReviewQueueItem>(KV.reviewQueue)).toHaveLength(0);
  });

  it("uses session task chains so continue/retry updates the prior user task instead of creating a new card", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 4 }));
    await kv.set(KV.observations("ses_1"), "u1", obs({
      id: "u1",
      title: "prompt_submit",
      narrative: "帮我把全量更新和单卡更新按钮的问题修掉。",
      timestamp: "2026-06-17T08:00:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "a1", obs({
      id: "a1",
      title: "stop",
      narrative: "全量更新会秒变已更新，单卡更新会长时间后提示没有更好卡片，后续需要调试按钮状态链路。",
      timestamp: "2026-06-17T08:01:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "u2", obs({
      id: "u2",
      title: "prompt_submit",
      narrative: "继续",
      timestamp: "2026-06-17T08:02:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "a2", obs({
      id: "a2",
      title: "stop",
      narrative: "已定位到全量更新直接返回、单卡刷新没有走 LLM；下一步需要修 sidecar 空负例。",
      timestamp: "2026-06-17T08:03:00.000Z",
    }));

    const seen: any[] = [];
    const result = await generateTodosFromSessions(kv as never, {
      force: true,
      scanSources: false,
      cleanup: "none",
      runLangExtractSidecar: async (input: any) => {
        seen.push(input);
        return [{
          title: "修复全量更新和单卡更新按钮问题",
          description: "下一步需要修 sidecar 空负例。",
          confidence: 0.9,
          timeBucket: "current",
          typeBucket: "follow_up",
          sourceSessionId: "ses_1",
          evidence: { sourceObservationId: "a2", quote: "下一步需要修 sidecar 空负例" },
          dedupeKey: "fix-update-buttons",
        }];
      },
    } as never);
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(result.directCreated).toBe(1);
    expect(seen[0].taskChains).toHaveLength(1);
    expect(seen[0].taskChains[0]).toMatchObject({
      userObservationId: "u1",
      latestStatusObservationId: "a2",
      continuedByObservationIds: ["u2"],
    });
    const action = (await kv.list<Action>(KV.actions))[0];
    expect(action.title).toBe("修复全量更新和单卡更新按钮问题");
    expect(action.metadata?.todoChain).toMatchObject({
      sourceSessionId: "ses_1",
      userObservationId: "u1",
      latestStatusObservationId: "a2",
      completionState: "in_progress",
    });
  });

  it("skips completed task chains with no next step", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 2 }));
    await kv.set(KV.observations("ses_1"), "u1", obs({
      id: "u1",
      title: "prompt_submit",
      narrative: "把修改提交 PR。",
      timestamp: "2026-06-17T08:00:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "a1", obs({
      id: "a1",
      title: "stop",
      narrative: "PR 已创建，CI 已通过，无需后续处理。",
      timestamp: "2026-06-17T08:01:00.000Z",
    }));

    const result = await generateTodosFromSessions(kv as never, {
      force: true,
      scanSources: false,
      cleanup: "none",
      runLangExtractSidecar: async () => [{
        title: "提交 PR",
        description: "PR 已创建，CI 已通过。",
        confidence: 0.95,
        timeBucket: "current",
        typeBucket: "done",
        sourceSessionId: "ses_1",
        evidence: { sourceObservationId: "a1", quote: "PR 已创建，CI 已通过" },
        dedupeKey: "submit-pr",
      }],
    } as never);
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(result.directCreated).toBe(0);
    expect(result.discarded).toBe(1);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(0);
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

  it("rejects process-check titles that are not durable user tasks", () => {
    expect(cleanTodoTitle(
      "做最后一次状态确认",
      "我会做最后一次状态确认，确保工作区干净、当前分支和 PR 链接明确。",
    )).toBeNull();
    expect(cleanTodoTitle(
      "启动后做健康检查",
      "启动后我会做健康检查，确认 Viewer 和 Health 都正常。",
    )).toBeNull();
    expect(cleanTodoTitle(
      "修复深色模式按钮对比度",
      "修复深色模式按钮对比度，避免主操作在暗色背景下不可读。",
    )).toBe("修复深色模式按钮对比度");
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

  it("sidecar examples avoid empty extraction groups that break LangExtract alignment", () => {
    const sidecar = readFileSync(join(ROOT, "src/functions/todo-extract-langextract.py"), "utf-8");
    expect(sidecar).not.toContain("extractions=[],");
    expect(sidecar).toContain("DO NOT extract completed work");
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

  it("refreshes one generated todo card from nearby source context", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 3 }));
    await kv.set(KV.observations("ses_1"), "obs_0", obs({
      id: "obs_0",
      title: "prompt_submit",
      narrative: "请检查单卡刷新。",
      timestamp: "2026-06-17T08:00:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      id: "obs_1",
      narrative: "这里只是旧卡片来源，没有明确新待办。",
      timestamp: "2026-06-17T08:05:00.000Z",
    }));
    await kv.set(KV.observations("ses_1"), "obs_2", obs({
      id: "obs_2",
      narrative: "下一步请修复单卡刷新按钮状态，并重新跑 viewer 测试。",
      timestamp: "2026-06-17T08:06:00.000Z",
    }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction());

    const result = await refreshTodoAction(kv as never, { actionId: "act_old" });

    expect(result).toMatchObject({
      success: true,
      keptOld: false,
      reason: "replaced",
      engine: "rules",
      scannedObservations: 1,
    });
    expect(result.action).toMatchObject({
      id: "act_old",
      createdAt: "2026-06-17T08:00:00.000Z",
      title: expect.stringContaining("单卡刷新按钮"),
      sourceObservationIds: ["obs_2"],
    });
    const stored = await kv.get<Action>(KV.actions, "act_old");
    expect(stored?.title).toContain("单卡刷新按钮");
    expect(stored?.metadata?.refresh).toMatchObject({
      previousTitle: "旧卡片标题",
      reason: "replaced",
    });
  });

  it("refreshes from recent interaction context when the source observation is missing", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 2 }));
    await kv.set(KV.observations("ses_1"), "obs_recent", obs({
      id: "obs_recent",
      narrative: "下一步请修复刷新回退路径，并补充回归测试。",
      timestamp: "2026-06-17T08:30:00.000Z",
    }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction({
      sourceObservationIds: ["obs_missing"],
      metadata: {
        todoExtraction: {
          sourceSessionId: "ses_1",
          evidence: { sourceObservationId: "obs_missing", quote: "旧来源" },
          dedupeKey: "old-card-title",
        },
      },
    }));

    const result = await refreshTodoAction(kv as never, { actionId: "act_old" });

    expect(result).toMatchObject({ success: true, keptOld: false, reason: "replaced" });
    expect(result.action?.sourceObservationIds).toEqual(["obs_recent"]);
    expect(result.action?.title).toContain("刷新回退路径");
  });

  it("keeps the old card for medium-confidence single-card refresh results", async () => {
    process.env.AGENTMEMORY_TODO_DIRECT_CONFIDENCE = "0.8";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "下一步请修复单卡刷新低置信度路径。",
    }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction());

    const result = await refreshTodoAction(kv as never, { actionId: "act_old" });
    delete process.env.AGENTMEMORY_TODO_DIRECT_CONFIDENCE;

    expect(result).toMatchObject({
      success: true,
      keptOld: true,
      reason: "low-confidence",
    });
    expect((await kv.get<Action>(KV.actions, "act_old"))?.title).toBe("旧卡片标题");
    expect(await kv.list<ReviewQueueItem>(KV.reviewQueue)).toHaveLength(0);
  });

  it("keeps the old card when single-card refresh finds no valid todo", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "Tests passed and the PR was merged. No action needed.",
    }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction());

    const result = await refreshTodoAction(kv as never, { actionId: "act_old" });

    expect(result).toMatchObject({
      success: true,
      keptOld: true,
      reason: "no-valid-todo",
      scannedObservations: 0,
    });
    expect((await kv.get<Action>(KV.actions, "act_old"))?.title).toBe("旧卡片标题");
  });

  it("keeps strong multi-step delivery titles that remain readable", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({
      narrative: "下一步需要修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染。",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.directCreated).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0]?.title).toBe("修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染");
  });

  it("compacts long technical identifiers out of generated card titles", async () => {
    const quote = "下一步需要推送 codex/todo-cleanup-flash-model 分支到远程仓库。";
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: quote }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.directCreated).toBe(1);
    const action = (await kv.list<Action>(KV.actions))[0];
    expect(action.title).toBe("推送当前工作分支到远程仓库");
    expect(action.title).not.toContain("codex/todo-cleanup-flash-model");
    expect(action.description).toContain("codex/todo-cleanup-flash-model");
    expect(jsonText(action.metadata?.todoQuality)).toContain("titleCompacted");
  });

  it("rejects incomplete dangling titles from single-card refresh with a specific reason", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    const quote = "准备推送分支 codex/todo-cleanup-flash-model 到";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: quote }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction({
      title: quote,
      description: quote,
      metadata: {
        todoExtraction: {
          sourceSessionId: "ses_1",
          evidence: { sourceObservationId: "obs_1", quote },
          dedupeKey: "push-branch-fragment",
        },
      },
    }));

    const result = await (refreshTodoAction as unknown as (
      kvArg: typeof kv,
      data: { actionId: string },
      deps: { runLangExtractSidecar: (input: Record<string, unknown>) => Promise<ExtractedTodo[]> },
    ) => ReturnType<typeof refreshTodoAction>)(kv, { actionId: "act_old" }, {
      runLangExtractSidecar: async () => [{
        title: quote,
        description: quote,
        confidence: 0.99,
        timeBucket: "current",
        typeBucket: "to_start",
        sourceSessionId: "ses_1",
        evidence: { sourceObservationId: "obs_1", quote },
        dedupeKey: "push-branch-fragment",
      }],
    });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(result).toMatchObject({
      success: true,
      keptOld: true,
      reason: "incomplete-title",
      engine: "langextract",
    });
    expect((await kv.get<Action>(KV.actions, "act_old"))?.title).toBe(quote);
  });

  it("repairs a dangling single-card title from existing evidence when LangExtract returns no todo", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    const quote = "网络和代理现在可用。准备推送 `codex/todo-cleanup-flash-model` 到 origin。";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: quote }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction({
      title: "准备推送分支 codex/todo-cleanup-flash-model 到",
      description: quote,
      status: "active",
      metadata: {
        todoExtraction: {
          sourceSessionId: "ses_1",
          timeBucket: "current",
          typeBucket: "in_progress",
          evidence: { sourceObservationId: "obs_1", quote },
          dedupeKey: "push-branch-fragment",
        },
      },
    }));

    const result = await (refreshTodoAction as unknown as (
      kvArg: typeof kv,
      data: { actionId: string },
      deps: { runLangExtractSidecar: (input: Record<string, unknown>) => Promise<ExtractedTodo[]> },
    ) => ReturnType<typeof refreshTodoAction>)(kv, { actionId: "act_old" }, {
      runLangExtractSidecar: async () => {
        throw new Error("LangExtract should not run for locally repairable dangling cards");
      },
    });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(result).toMatchObject({
      success: true,
      keptOld: false,
      reason: "replaced-from-existing-evidence",
      engine: "rules",
    });
    const stored = await kv.get<Action>(KV.actions, "act_old");
    expect(stored?.title).toBe("推送当前工作分支到 origin");
    expect(stored?.description).toContain("codex/todo-cleanup-flash-model");
    expect(jsonText(stored?.metadata?.todoQuality)).toContain("titleCompacted");
  });

  it("rejects single-card refresh for manual actions", async () => {
    await kv.set<Action>(KV.actions, "act_manual", generatedAction({
      id: "act_manual",
      createdBy: "manual",
      tags: [],
      metadata: {},
    }));

    const result = await refreshTodoAction(kv as never, { actionId: "act_manual" });

    expect(result).toMatchObject({
      success: false,
      keptOld: true,
      reason: "not-generated",
      scannedObservations: 0,
    });
  });

  it("passes the old card and cleanup metadata into LangExtract single-card refresh", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    let sidecarInput: Record<string, unknown> | null = null;
    const quote = "内层仓库当前基线等于 origin/main，建 codex/ 分支、提交并 push，push 前跑 secrets diff 检查。";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: quote }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction({
      title: "创建 codex 分支、提交并 push AI-Todo 仓库修改",
      description: quote,
      metadata: {
        todoExtraction: {
          sourceSessionId: "ses_1",
          evidence: { sourceObservationId: "obs_1", quote },
          dedupeKey: "old-card-title",
        },
        cleanup: {
          decision: "rewrite",
          title: "提交 AI-Todo 清理分支",
          reason: "Title is process-like; make it a concrete user-facing action.",
          previousTitle: "创建 codex 分支、提交并 push AI-Todo 仓库修改",
        },
      },
    }));

    const result = await (refreshTodoAction as unknown as (
      kvArg: typeof kv,
      data: { actionId: string },
      deps: { runLangExtractSidecar: (input: Record<string, unknown>) => Promise<ExtractedTodo[]> },
    ) => ReturnType<typeof refreshTodoAction>)(kv, { actionId: "act_old" }, {
      runLangExtractSidecar: async (input) => {
        sidecarInput = input;
        return [{
          title: "提交 AI-Todo 清理分支",
          description: "提交 AI-Todo 清理分支，并在 push 前跑 secrets diff 检查。",
          confidence: 0.95,
          timeBucket: "current",
          typeBucket: "to_start",
          sourceSessionId: "ses_1",
          evidence: { sourceObservationId: "obs_1", quote },
          dedupeKey: "submit-aitodo-cleanup-branch",
        }];
      },
    });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;

    expect(result).toMatchObject({ success: true, keptOld: false, reason: "replaced", engine: "langextract" });
    expect(sidecarInput?.refreshAction).toMatchObject({
      id: "act_old",
      title: "创建 codex 分支、提交并 push AI-Todo 仓库修改",
      cleanup: {
        title: "提交 AI-Todo 清理分支",
        reason: "Title is process-like; make it a concrete user-facing action.",
      },
    });
    expect((await kv.get<Action>(KV.actions, "act_old"))?.title).toBe("提交 AI-Todo 清理分支");
  });

  it("reports LangExtract refresh failures instead of calling them no better card", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACTOR = "langextract";
    process.env.LANGEXTRACT_PYTHON = "__missing_python__";
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs({ narrative: "Tests passed and the PR was merged. No action needed." }));
    await kv.set<Action>(KV.actions, "act_old", generatedAction());

    const result = await refreshTodoAction(kv as never, { actionId: "act_old" });
    delete process.env.AGENTMEMORY_TODO_EXTRACTOR;
    delete process.env.LANGEXTRACT_PYTHON;

    expect(result).toMatchObject({
      success: false,
      keptOld: true,
      reason: "llm-refresh-failed",
      engine: "rules",
    });
    expect(result.fallbackReason).toBeTruthy();
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

    expect(result).toMatchObject({ cleanedActions: 1, cleanedReviews: 1, completedActions: 0, completedReviews: 0 });
    const actions = await kv.list<Action>(KV.actions);
    expect(actions.find((a) => a.id === "act_bad")).toMatchObject({
      status: "cancelled",
      metadata: { cleanup: expect.objectContaining({ decision: "garbage", previousStatus: "pending" }) },
    });
    expect(actions.find((a) => a.id === "act_good")).toMatchObject({ status: "pending" });
    expect((await kv.list<ReviewQueueItem>(KV.reviewQueue))[0]).toMatchObject({
      status: "dismissed",
      payload: { cleanup: expect.objectContaining({ decision: "garbage" }) },
    });
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

    expect(result.completedActions).toBe(1);
    const actions = await kv.list<Action>(KV.actions);
    expect(actions.find((a) => a.id === "act_done")).toMatchObject({
      status: "done",
      metadata: { cleanup: expect.objectContaining({ decision: "done", previousStatus: "pending" }) },
    });
    expect(actions.find((a) => a.id === "act_keep")).toMatchObject({ status: "pending" });
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
    const actions = await kv.list<Action>(KV.actions);
    expect(actions.find((a) => a.id === "act_status")).toMatchObject({ status: "cancelled" });
    expect(actions.find((a) => a.id === "act_repair")).toMatchObject({ status: "pending" });
  });

  it("dry-runs cleanup without mutating cards", async () => {
    await kv.set<Action>(KV.actions, "act_noise", {
      id: "act_noise",
      title: "继续检查关键入口和 GitHub 状态并输出报告",
      description: "我会继续看关键入口文件和 GitHub 侧的分支、PR、issue、release、CI 配置。",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });

    const result = await cleanPollutedTodoCards(kv as never, "dry-run");

    expect(result.cleanedActions).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0]).toMatchObject({ id: "act_noise", status: "pending" });
  });

  it("todo generation does not cleanup existing cards unless requested", async () => {
    await kv.set<Action>(KV.actions, "act_noise", {
      id: "act_noise",
      title: "继续检查关键入口和 GitHub 状态并输出报告",
      description: "我会继续看关键入口文件和 GitHub 侧的分支、PR、issue、release、CI 配置。",
      status: "pending",
      priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z",
      updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract",
      tags: ["todo-extracted"],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    await kv.set(KV.sessions, "ses_1", session({ status: "active" }));
    await kv.set(KV.observations("ses_1"), "obs_1", obs());

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false });

    expect(result.cleanedActions).toBe(0);
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "act_noise")).toMatchObject({ status: "pending" });
  });

  it("update applies KEEP/DROP/DONE/REWRITE/MERGE on changed-session cards with audit (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 9 }));
    const mkAction = (id: string, title: string) =>
      kv.set<Action>(KV.actions, id, {
        id, title, description: title + " — details", status: "pending", priority: 5,
        createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
        createdBy: "todo-extract", tags: ["todo-extracted", "todo-recheck"], sourceObservationIds: [], sourceMemoryIds: [],
        metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
      });
    await mkAction("a_keep", "Fix the login bug");
    await mkAction("a_drop", "npm test output");
    await mkAction("a_done", "shipped the dashboard");
    await mkAction("a_rw", "fix");
    await mkAction("a_merge", "duplicate fix");
    const decide = async () => [
      { id: "a:a_keep", decision: "KEEP" as const },
      { id: "a:a_drop", decision: "DROP" as const, reason: "tool log" },
      { id: "a:a_done", decision: "DONE" as const, reason: "shipped" },
      { id: "a:a_rw", decision: "REWRITE" as const, newTitle: "Fix the dashboard N+1", newDescription: "fix the slow query" },
      { id: "a:a_merge", decision: "MERGE" as const, mergeIntoId: "a:a_rw" },
    ];
    const result = await updateChangedTodoCards(kv as never, { mode: "apply", decide });
    expect(result).toMatchObject({ engine: "llm", scanned: 5, kept: 1, dropped: 1, completed: 1, rewritten: 1, merged: 1 });
    const actions = await kv.list<Action>(KV.actions);
    const byId = (id: string) => actions.find((a) => a.id === id);
    expect(byId("a_keep")).toMatchObject({ status: "pending" });
    expect(byId("a_drop")).toMatchObject({ status: "cancelled", metadata: { cleanup: expect.objectContaining({ decision: "drop", llm: true }) } });
    expect(byId("a_done")).toMatchObject({ status: "done", metadata: { cleanup: expect.objectContaining({ decision: "done" }) } });
    expect(byId("a_rw")).toMatchObject({ title: "Fix the dashboard N+1", status: "pending", metadata: { cleanup: expect.objectContaining({ decision: "rewrite", previousTitle: "fix" }) } });
    expect(byId("a_merge")).toMatchObject({ status: "cancelled", metadata: { cleanup: expect.objectContaining({ decision: "merge", mergeIntoId: "a:a_rw" }) } });
    // every processed card advances its checkpoint and drops the recheck tag, so
    // it won't be reprocessed until its session changes again.
    expect(byId("a_keep")?.metadata?.todoExtraction).toMatchObject({ sourceCheckpoint: "2026-06-18T09:00:00.000Z:9", needsRecheck: false });
    expect(byId("a_keep")?.tags).not.toContain("todo-recheck");
  });

  it("update only touches cards whose source session changed (STEP-12)", async () => {
    // unchanged: stored checkpoint == current session fingerprint
    await kv.set(KV.sessions, "ses_same", session({ id: "ses_same", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 3 }));
    await kv.set<Action>(KV.actions, "a_same", {
      id: "a_same", title: "Fix the login bug", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_same", sourceCheckpoint: "2026-06-18T09:00:00.000Z:3" } },
    });
    let called = false;
    const decide = async () => { called = true; return []; };
    const result = await updateChangedTodoCards(kv as never, { mode: "apply", decide });
    expect(result.scanned).toBe(0);
    expect(called).toBe(false); // decide never runs when nothing changed
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_same")).toMatchObject({ status: "pending" });
  });

  it("update scope=all re-judges unchanged generated cards so existing vague titles can be rewritten (STEP-10)", async () => {
    await kv.set(KV.sessions, "ses_same", session({ id: "ses_same", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 3 }));
    await kv.set<Action>(KV.actions, "a_vague", {
      id: "a_vague", title: "克隆仓库并全面了解其状况", description: "需要克隆 MaimoryLab/AI-Todo 并了解项目现状。", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_same", sourceCheckpoint: "2026-06-18T09:00:00.000Z:3" } },
    });
    let captured: Array<{ titleQualityHint?: string }> = [];
    const decide = async (cards: Array<{ titleQualityHint?: string }>) => {
      captured = cards;
      return [{
        id: "a:a_vague",
        decision: "REWRITE" as const,
        newTitle: "克隆 AI-Todo 仓库",
        newDescription: "克隆 MaimoryLab/AI-Todo 仓库并确认本地可用。",
      }];
    };

    const result = await updateChangedTodoCards(kv as never, { mode: "apply", scope: "all", decide });

    expect(captured[0]?.titleQualityHint).toContain("全面了解");
    expect(result).toMatchObject({ engine: "llm", scanned: 1, rewritten: 1 });
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_vague")).toMatchObject({
      title: "克隆 AI-Todo 仓库",
      status: "pending",
      metadata: { cleanup: expect.objectContaining({ decision: "rewrite", previousTitle: "克隆仓库并全面了解其状况" }) },
    });
  });

  it("flags agent-process titles for LLM rewrite during full maintenance", async () => {
    await kv.set(KV.sessions, "ses_same", session({ id: "ses_same", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 3 }));
    await kv.set<Action>(KV.actions, "a_process", {
      id: "a_process", title: "重启 Codex desktop app 后再测一次", description: "建议处理顺序：2. 重启 Codex desktop app 后再测一次。", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_same", sourceCheckpoint: "2026-06-18T09:00:00.000Z:3" } },
    });
    let captured: Array<{ title: string; titleQualityHint?: string }> = [];
    const decide = async (cards: Array<{ title: string; titleQualityHint?: string }>) => {
      captured = cards;
      return [{
        id: "a:a_process",
        decision: "REWRITE" as const,
        newTitle: "验证重启后的 Codex 桌面端",
        newDescription: "重启 Codex desktop app 后再验证问题是否仍存在。",
      }];
    };

    const result = await updateChangedTodoCards(kv as never, { mode: "apply", scope: "all", decide });

    expect(captured[0]?.titleQualityHint).toContain("process or status-check");
    expect(result).toMatchObject({ engine: "llm", scanned: 1, rewritten: 1 });
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_process")).toMatchObject({
      title: "验证重启后的 Codex 桌面端",
      status: "pending",
      metadata: { cleanup: expect.objectContaining({ decision: "rewrite", previousTitle: "重启 Codex desktop app 后再测一次" }) },
    });
  });

  it("update sorts before maxCards so near-duplicate titles can enter the same LLM batch (STEP-10)", async () => {
    await kv.set(KV.sessions, "ses_same", session({ id: "ses_same", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 3 }));
    const mkAction = (id: string, title: string) =>
      kv.set<Action>(KV.actions, id, {
        id, title, description: title, status: "pending", priority: 5,
        createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
        createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
        metadata: { todoExtraction: { sourceSessionId: "ses_same", sourceCheckpoint: "2026-06-18T09:00:00.000Z:3" } },
      });
    await mkAction("z_first", "整理 Zeta 发布记录");
    await mkAction("clone_a", "克隆 AI-Todo 仓库并全面了解");
    await mkAction("clone_b", "克隆AI-Todo仓库并了解现状");
    let capturedIds: string[] = [];
    const decide = async (cards: Array<{ id: string }>) => {
      capturedIds = cards.map((card) => card.id);
      return [{ id: "a:clone_b", decision: "MERGE" as const, mergeIntoId: "a:clone_a" }];
    };

    const result = await updateChangedTodoCards(kv as never, { mode: "dry-run", scope: "all", maxCards: 2, decide });

    expect(capturedIds).toEqual(["a:clone_a", "a:clone_b"]);
    expect(result).toMatchObject({ scanned: 2, merged: 1 });
  });

  it("update passes the session delta to the LLM (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set(KV.observations("ses_x"), "o1", obs({ id: "o1", sessionId: "ses_x", narrative: "刚刚已经修复并合并了登录超时。" }));
    await kv.set<Action>(KV.actions, "a1", {
      id: "a1", title: "Fix login timeout", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    let captured: Array<{ sessionDelta?: string }> = [];
    const decide = async (cards: Array<{ sessionDelta?: string }>) => { captured = cards; return [{ id: "a:a1", decision: "DONE" as const }]; };
    const result = await updateChangedTodoCards(kv as never, { mode: "apply", decide });
    expect(result.completed).toBe(1);
    expect(captured[0]?.sessionDelta).toContain("登录超时");
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a1")).toMatchObject({ status: "done" });
  });

  it("update rule-filters tool dumps out of the session delta (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    // a tool-trace observation (must be filtered) + a human one (must survive)
    await kv.set(KV.observations("ses_x"), "o_tool", obs({ id: "o_tool", sessionId: "ses_x", timestamp: "2026-06-18T08:00:00.000Z", narrative: '{"cmd":"gh pr list --json number"}' }));
    await kv.set(KV.observations("ses_x"), "o_human", obs({ id: "o_human", sessionId: "ses_x", timestamp: "2026-06-18T08:01:00.000Z", narrative: "刚刚已经修复并合并了登录超时。" }));
    await kv.set<Action>(KV.actions, "a1", {
      id: "a1", title: "Fix login timeout", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    let captured: Array<{ sessionDelta?: string }> = [];
    const decide = async (cards: Array<{ sessionDelta?: string }>) => { captured = cards; return [{ id: "a:a1", decision: "KEEP" as const }]; };
    await updateChangedTodoCards(kv as never, { mode: "dry-run", decide });
    expect(captured[0]?.sessionDelta).toContain("登录超时");      // human text kept
    expect(captured[0]?.sessionDelta).not.toContain("gh pr list"); // tool dump dropped
  });

  it("update dry-run previews without mutating (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set<Action>(KV.actions, "a_drop", {
      id: "a_drop", title: "npm test output", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    const decide = async () => [{ id: "a:a_drop", decision: "DROP" as const, reason: "noise" }];
    const result = await updateChangedTodoCards(kv as never, { mode: "dry-run", decide });
    expect(result).toMatchObject({ engine: "llm", dropped: 1 });
    expect(result.preview).toHaveLength(1);
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_drop")).toMatchObject({ status: "pending" });
  });

  it("update leaves cards untouched when the LLM fails — no rule fallback (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set<Action>(KV.actions, "a_bad", {
      id: "a_bad", title: "gh pr list --json number", description: "{\"cmd\":\"gh pr list\"}", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    const decide = async (): Promise<never> => { throw new Error("LLM down"); };
    const result = await updateChangedTodoCards(kv as never, { mode: "apply", decide });
    // update is LLM-only: failure is signalled by fallbackReason, not engine.
    expect(result.fallbackReason).toContain("LLM down");
    expect(result.dropped).toBe(0);
    // update has no rule equivalent, so the card stays exactly as it was
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_bad")).toMatchObject({ status: "pending" });
  });

  it("update also re-judges changed-session review cards (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set<ReviewQueueItem>(KV.reviewQueue, "rev1", {
      id: "rev1", createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      status: "pending", kind: "action", title: "maybe fix the thing", content: "x", source: "viewer",
      payload: { tags: ["todo-extracted"], todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    } as never);
    const decide = async () => [{ id: "r:rev1", decision: "DROP" as const, reason: "noise" }];
    const result = await updateChangedTodoCards(kv as never, { mode: "apply", decide });
    expect(result.scanned).toBe(1);
    expect(result.dropped).toBe(1);
    expect((await kv.list<ReviewQueueItem>(KV.reviewQueue)).find((r) => r.id === "rev1")).toMatchObject({ status: "dismissed" });
  });

  it("update downgrades a MERGE whose target is not in the batch to KEEP (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set<Action>(KV.actions, "a_src", {
      id: "a_src", title: "real todo", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    const decide = async () => [{ id: "a:a_src", decision: "MERGE" as const, mergeIntoId: "a:ghost" }];
    const result = await updateChangedTodoCards(kv as never, { mode: "apply", decide });
    expect(result.merged).toBe(0);
    expect(result.kept).toBe(1);
    // dangling MERGE downgraded → source preserved, not cancelled
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_src")).toMatchObject({ status: "pending" });
  });

  it("update apply reuses the dry-run decisions verbatim — no LLM re-call (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set<Action>(KV.actions, "a_drop", {
      id: "a_drop", title: "noise", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    let decideCalled = false;
    const decide = async () => { decideCalled = true; return [{ id: "a:a_drop", decision: "KEEP" as const }]; };
    // The dry-run decided DROP; apply must honour that, not re-ask the LLM
    // (which here would say KEEP).
    const result = await updateChangedTodoCards(kv as never, {
      mode: "apply", decide,
      decisions: [{ id: "a:a_drop", decision: "DROP", reason: "preview said drop" }],
    });
    expect(decideCalled).toBe(false);
    expect(result.dropped).toBe(1);
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_drop")).toMatchObject({ status: "cancelled" });
  });

  it("update apply replays every supplied dry-run decision without default maxCards truncation (STEP-10)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    const decisions = [];
    for (let i = 0; i < 61; i++) {
      const id = `a_${i}`;
      await kv.set<Action>(KV.actions, id, {
        id, title: `noise ${i}`, description: "x", status: "pending", priority: 5,
        createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
        createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
        metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
      });
      decisions.push({ id: `a:${id}`, decision: "DROP" as const, reason: "preview said drop" });
    }

    const result = await updateChangedTodoCards(kv as never, { mode: "apply", maxCards: 10, decisions });

    expect(result.dropped).toBe(61);
    expect((await kv.list<Action>(KV.actions)).filter((a) => a.status === "cancelled")).toHaveLength(61);
  });

  it("update apply replays decisions for unchanged scope=all cards even when scope is omitted (STEP-10)", async () => {
    await kv.set(KV.sessions, "ses_same", session({ id: "ses_same", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 3 }));
    await kv.set<Action>(KV.actions, "a_same", {
      id: "a_same", title: "克隆仓库并全面了解其状况", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_same", sourceCheckpoint: "2026-06-18T09:00:00.000Z:3" } },
    });

    const result = await updateChangedTodoCards(kv as never, {
      mode: "apply",
      decisions: [{
        id: "a:a_same",
        decision: "REWRITE",
        newTitle: "克隆 AI-Todo 仓库",
        newDescription: "x",
      }],
    });

    expect(result.rewritten).toBe(1);
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a_same")).toMatchObject({
      title: "克隆 AI-Todo 仓库",
    });
  });

  it("update dry-run returns the decisions so apply can replay them (STEP-12)", async () => {
    await kv.set(KV.sessions, "ses_x", session({ id: "ses_x", endedAt: "2026-06-18T09:00:00.000Z", observationCount: 5 }));
    await kv.set<Action>(KV.actions, "a1", {
      id: "a1", title: "real todo", description: "x", status: "pending", priority: 5,
      createdAt: "2026-06-17T08:00:00.000Z", updatedAt: "2026-06-17T08:00:00.000Z",
      createdBy: "todo-extract", tags: ["todo-extracted"], sourceObservationIds: [], sourceMemoryIds: [],
      metadata: { todoExtraction: { sourceSessionId: "ses_x", sourceCheckpoint: "2026-06-17T09:00:00.000Z:1" } },
    });
    const decide = async () => [{ id: "a:a1", decision: "DONE" as const, reason: "done now" }];
    const dry = await updateChangedTodoCards(kv as never, { mode: "dry-run", decide });
    expect(dry.decisions).toEqual([{ id: "a:a1", decision: "DONE", reason: "done now" }]);
    expect((await kv.list<Action>(KV.actions)).find((a) => a.id === "a1")).toMatchObject({ status: "pending" }); // dry-run didn't mutate
  });

  it("extracts todos from a browser-captured session (STEP-14)", async () => {
    // Browser sessions are recorded (recordBrowserSessionFallback) as
    // type:conversation observations titled 用户发言/AI发言 — todo-extract must
    // consume them like any other session (no separate action-candidate leg).
    await kv.set(KV.sessions, "browser_sync_x", session({
      id: "browser_sync_x", project: "ChatGPT", cwd: "browser/chatgpt.com",
      status: "completed", observationCount: 2, tags: ["browser"], agentId: "ChatGPT",
    }));
    await kv.set(KV.observations("browser_sync_x"), "t_ai", obs({
      id: "t_ai", sessionId: "browser_sync_x", title: "AI发言", type: "conversation",
      narrative: "这里是页面说明。",
    }));
    await kv.set(KV.observations("browser_sync_x"), "t_user", obs({
      id: "t_user", sessionId: "browser_sync_x", title: "用户发言", type: "conversation",
      narrative: "后续需要修复登录接口的超时问题。",
    }));
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });
    expect(result.directCreated).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0]).toMatchObject({ project: "ChatGPT", sourceObservationIds: ["t_user"] });
  });

  it("filters agent progress observations before rules extraction", async () => {
    await kv.set(KV.sessions, "ses_1", session({ status: "active", observationCount: 2 }));
    await kv.set(KV.observations("ses_1"), "obs_noise", obs({
      id: "obs_noise",
      narrative: "我会继续看关键入口文件和 GitHub 侧的分支、PR、issue、release、CI 配置。",
    }));
    await kv.set(KV.observations("ses_1"), "obs_real", obs({
      id: "obs_real",
      narrative: "后续需要修复 CI 失败，并重新跑测试。",
    }));

    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });

    expect(result.scannedObservations).toBe(1);
    expect(result.directCreated).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0].sourceObservationIds).toEqual(["obs_real"]);
  });
});

describe("todo extraction scope — sinceDays + interaction window (STEP-11)", () => {
  let kv: ReturnType<typeof mockKV>;
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  beforeEach(() => {
    kv = mockKV();
  });
  afterEach(() => {
    delete process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS;
    delete process.env.AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION;
  });

  // Two completed sessions, both inside the 14d "recent" bucket (so neither is
  // hidden as history), but one older than a tight sinceDays window.
  async function seedTwoSessions() {
    await kv.set(KV.sessions, "ses_recent", session({
      id: "ses_recent", status: "completed", startedAt: daysAgo(1), endedAt: daysAgo(1), observationCount: 1,
    }));
    await kv.set(KV.sessions, "ses_mid", session({
      id: "ses_mid", status: "completed", startedAt: daysAgo(5), endedAt: daysAgo(5), observationCount: 1,
    }));
    await kv.set(KV.observations("ses_recent"), "o_recent", obs({
      id: "o_recent", sessionId: "ses_recent", timestamp: daysAgo(1),
      narrative: "后续需要修复登录接口的超时问题。",
    }));
    await kv.set(KV.observations("ses_mid"), "o_mid", obs({
      id: "o_mid", sessionId: "ses_mid", timestamp: daysAgo(5),
      narrative: "后续需要更新数据库驱动到 v5。",
    }));
  }

  it("control: extracts both sessions when the window covers both", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS = "30";
    await seedTwoSessions();
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });
    expect(result.directCreated).toBe(2);
    expect(await kv.list<Action>(KV.actions)).toHaveLength(2);
  });

  it("skips sessions whose endedAt is older than the sinceDays window", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS = "3";
    await seedTwoSessions();
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });
    const actions = await kv.list<Action>(KV.actions);
    expect(actions).toHaveLength(1);
    expect(actions[0].metadata?.todoExtraction).toMatchObject({ sourceSessionId: "ses_recent" });
  });

  it("lets a body sinceDays override the env window", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS = "30";
    await seedTwoSessions();
    const result = await generateTodosFromSessions(kv as never, {
      force: true, scanSources: false, cleanup: "none", sinceDays: 3,
    });
    expect(result.directCreated).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0].metadata?.todoExtraction).toMatchObject({ sourceSessionId: "ses_recent" });
  });

  // A user message in synthetic-compression form: type "conversation", title
  // === raw hookType "prompt_submit" (the interaction-boundary signal).
  function promptObs(id: string, narrative: string, timestamp: string): CompressedObservation {
    return obs({ id, sessionId: "ses_turns", type: "conversation", title: "prompt_submit", narrative, timestamp });
  }
  async function seedThreeInteractions() {
    await kv.set(KV.sessions, "ses_turns", session({ id: "ses_turns", status: "active", observationCount: 3 }));
    await kv.set(KV.observations("ses_turns"), "t1", promptObs("t1", "后续需要修复登录接口的超时问题。", daysAgo(3)));
    await kv.set(KV.observations("ses_turns"), "t2", promptObs("t2", "后续需要补充新用户的上手文档。", daysAgo(2)));
    await kv.set(KV.observations("ses_turns"), "t3", promptObs("t3", "后续需要更新数据库驱动到 v5。", daysAgo(1)));
  }

  it("control: extracts every interaction when the window covers them all", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS = "30";
    await seedThreeInteractions();
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });
    expect(result.directCreated).toBe(3);
  });

  it("keeps only the most recent N interaction records per session", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS = "30";
    process.env.AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION = "1";
    await seedThreeInteractions();
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });
    expect(result.directCreated).toBe(1);
    expect((await kv.list<Action>(KV.actions))[0].sourceObservationIds).toEqual(["t3"]);
  });

  it("treats a session with no user-message boundary as a single interaction", async () => {
    process.env.AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS = "30";
    process.env.AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION = "1";
    await kv.set(KV.sessions, "ses_noturn", session({ id: "ses_noturn", status: "active", observationCount: 1 }));
    await kv.set(KV.observations("ses_noturn"), "n1", obs({
      id: "n1", sessionId: "ses_noturn", title: "assistant", narrative: "后续需要修复登录接口的超时问题。",
    }));
    const result = await generateTodosFromSessions(kv as never, { force: true, scanSources: false, cleanup: "none" });
    expect(result.directCreated).toBe(1);
  });
});
