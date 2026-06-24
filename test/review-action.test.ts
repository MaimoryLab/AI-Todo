import { describe, expect, it, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerActionsFunction } from "../src/functions/actions.js";
import { registerActionCandidateFunctions } from "../src/functions/action-candidates.js";
import { registerApiTriggers } from "../src/triggers/api.js";
import type { Action, CompressedObservation, ReviewQueueItem, Session } from "../src/types.js";
import { KV, fingerprintId } from "../src/state/schema.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function req(body: Record<string, unknown> = {}, query_params: Record<string, string> = {}) {
  return { body, query_params, headers: {} };
}

function compressedObs(id: string, patch: Partial<CompressedObservation>): CompressedObservation {
  return {
    id,
    sessionId: "ses_actions",
    timestamp: "2026-06-11T08:00:00.000Z",
    type: "conversation",
    title: id,
    narrative: "",
    facts: [],
    concepts: [],
    files: [],
    importance: 5,
    ...patch,
  };
}

describe("review action candidates", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerActionsFunction(sdk as never, kv as never);
    registerActionCandidateFunctions(sdk as never, kv as never);
    sdk.registerFunction("mem::todo-extract-generate", async (payload) => ({ success: true, ...payload }));
    sdk.registerFunction("api::session::start", async () => ({ success: true }));
    sdk.registerFunction("mem::observe", async () => ({ success: true }));
    sdk.registerFunction("mem::remember", async () => ({ success: true, memory: { id: "mem_1" } }));
    sdk.registerFunction("mem::lesson-save", async () => ({ success: true, lesson: { id: "les_1" } }));
    registerApiTriggers(sdk as never, kv as never);
  });

  it("generates action review drafts from recent session observations through the API", async () => {
    const session: Session = {
      id: "ses_actions",
      project: "agentmemory-lab",
      cwd: "/repo",
      startedAt: "2026-06-11T08:00:00.000Z",
      endedAt: "2026-06-11T08:10:00.000Z",
      status: "completed",
      observationCount: 2,
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs_1", compressedObs("obs_1", {
      sessionId: session.id,
      narrative: "下一步请修复待办页不展示未批准候选的问题。",
    }));
    await kv.set(KV.observations(session.id), "obs_2", compressedObs("obs_2", {
      sessionId: session.id,
      narrative: "请审查当前实现。",
    }));

    const response = await sdk.trigger("api::review-actions-generate", req({
      maxSessions: 10,
      maxObservationsPerSession: 20,
    })) as { status_code: number; body: { success: boolean; generated: number; items: ReviewQueueItem[]; scannedSessions: number; scannedObservations: number } };

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.generated).toBe(1);
    expect(response.body.scannedSessions).toBe(1);
    expect(response.body.scannedObservations).toBe(2);
    expect(response.body.items[0]).toMatchObject({
      kind: "action",
      status: "pending",
      source: "viewer",
      title: "修复待办页不展示未批准候选的问题",
      payload: {
        project: "agentmemory-lab",
        sourceSessionId: "ses_actions",
        sourceSessionProject: "agentmemory-lab",
        sourceSessionCwd: "/repo",
      },
    });

    const second = await sdk.trigger("api::review-actions-generate", req({
      maxSessions: 10,
      maxObservationsPerSession: 20,
    })) as { body: { generated: number; items: ReviewQueueItem[] } };
    expect(second.body.generated).toBe(0);
    expect(second.body.items).toEqual([]);
  });

  it("manually triggers todo extraction through the API", async () => {
    const response = await sdk.trigger("api::todo-extract-generate", req({
      maxSessions: 3,
      maxObservationsPerSession: 20,
      project: "agentmemory-lab",
      force: true,
      cleanup: "dry-run",
    })) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      maxSessions: 3,
      maxObservationsPerSession: 20,
      project: "agentmemory-lab",
      force: true,
      cleanup: "dry-run",
    });
  });

  it("exposes todo extractor config without returning the API key", async () => {
    const oldModel = process.env.LANGEXTRACT_MODEL;
    const oldKey = process.env.LANGEXTRACT_API_KEY;
    process.env.LANGEXTRACT_MODEL = "deepseek/deepseek-v4-flash";
    process.env.LANGEXTRACT_API_KEY = "secret";
    const response = await sdk.trigger("api::todo-extractor-config", req()) as { status_code: number; body: { success: boolean; config: Record<string, unknown>; envPath: string } };
    if (oldModel === undefined) delete process.env.LANGEXTRACT_MODEL;
    else process.env.LANGEXTRACT_MODEL = oldModel;
    if (oldKey === undefined) delete process.env.LANGEXTRACT_API_KEY;
    else process.env.LANGEXTRACT_API_KEY = oldKey;

    expect(response.status_code).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.envPath).toContain(".agentmemory");
    expect(response.body.config.LANGEXTRACT_MODEL).toBe("deepseek/deepseek-v4-flash");
    expect(response.body.config.LANGEXTRACT_API_KEY).toBeUndefined();
    expect(response.body.config.LANGEXTRACT_API_KEY_CONFIGURED).toBe(true);
  });

  it("rejects invalid todo extraction limits through the API", async () => {
    const response = await sdk.trigger("api::todo-extract-generate", req({
      maxSessions: 0,
    })) as { status_code: number; body: Record<string, unknown> };

    expect(response.status_code).toBe(400);
    expect(response.body).toMatchObject({ error: "maxSessions must be a positive integer" });
  });

  it("approves generated session action reviews into the source session project when request project is omitted", async () => {
    const session: Session = {
      id: "ses_actions",
      project: "agentmemory-lab",
      cwd: "/repo",
      startedAt: "2026-06-11T08:00:00.000Z",
      endedAt: "2026-06-11T08:10:00.000Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs_1", compressedObs("obs_1", {
      sessionId: session.id,
      narrative: "下一步请修复待办页项目归属。",
    }));

    const generated = await sdk.trigger("api::review-actions-generate", req({
      maxSessions: 10,
      maxObservationsPerSession: 20,
    })) as { status_code: number; body: { generated: number; items: ReviewQueueItem[] } };
    expect(generated.status_code).toBe(200);
    expect(generated.body.generated).toBe(1);
    expect(generated.body.items[0].payload?.project).toBe("agentmemory-lab");

    const approveResponse = await sdk.trigger("api::review-approve", req({
      id: generated.body.items[0].id,
      kind: "action",
      title: generated.body.items[0].title,
      content: generated.body.items[0].content,
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem; result: { success: boolean; action: Action } } };

    expect(approveResponse.status_code).toBe(200);
    expect(approveResponse.body.result.action).toMatchObject({
      title: "修复待办页项目归属",
      project: "agentmemory-lab",
    });
  });

  it("accepts explicit action review items", async () => {
    const response = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "修复 action review 批准流程",
      content: "下一步请修复 action review 的批准流程。",
      source: "api",
      payload: {
        actionCandidate: {
          priority: 8,
          sourceObservationIds: ["obs_1"],
          reason: "follow_up",
          confidence: 0.8,
        },
        project: "agentmemory-lab",
        tags: ["action-candidate", "follow-up"],
      },
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem } };

    expect(response.status_code).toBe(201);
    expect(response.body.item.kind).toBe("action");
    expect(response.body.item.payload?.actionCandidate).toMatchObject({
      priority: 8,
      sourceObservationIds: ["obs_1"],
    });
  });

  it("rejects non-displayable review candidates including raw action items", async () => {
    const planResponse = await sdk.trigger("api::review-create", req({
      kind: "memory",
      title: "{",
      content: "{\"plan\":[{\"status\":\"completed\",\"step\":\"npm test -- --run test/viewer-session-id.test.ts\"}]}",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(planResponse.status_code).toBe(400);
    expect(planResponse.body.error).toBe("review_content_not_displayable");

    const toolResponse = await sdk.trigger("api::review-create", req({
      kind: "lesson",
      title: "工具输出",
      content: "{\"function_id\":\"x\",\"toolInput\":{\"command\":\"npm test\"}}",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(toolResponse.status_code).toBe(400);
    expect(toolResponse.body.error).toBe("review_content_not_displayable");

    const pathResponse = await sdk.trigger("api::review-create", req({
      kind: "memory",
      title: "源码路径",
      content: "src/functions/action-candidates.ts\nnpm test -- --run test/action-candidates.test.ts",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(pathResponse.status_code).toBe(400);
    expect(pathResponse.body.error).toBe("review_content_not_displayable");

    const actionJsonResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "{",
      content: "{\"plan\":[{\"status\":\"completed\",\"step\":\"npm test\"}]}",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(actionJsonResponse.status_code).toBe(400);
    expect(actionJsonResponse.body.error).toBe("review_content_not_displayable");

    const actionMarkdownPlanResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "待办生成链路与前端展示修复计划",
      content: [
        "# 待办生成链路与前端展示修复计划",
        "## Summary",
        "本轮修复待办候选生成与展示链路。",
        "## Key Changes",
        "- 前端待办页改造。",
        "## Test Plan",
        "- npm test",
      ].join("\n"),
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(actionMarkdownPlanResponse.status_code).toBe(400);
    expect(actionMarkdownPlanResponse.body.error).toBe("review_content_not_displayable");

    const compactMarkdownPlanResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "待办生成链路与前端展示修复计划",
      content: "# 待办生成链路与前端展示修复计划 ## Summary 本轮修复待办候选生成与展示链路。 ## Key Changes - 前端待办页改造。 ## Test Plan - npm test",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(compactMarkdownPlanResponse.status_code).toBe(400);
    expect(compactMarkdownPlanResponse.body.error).toBe("review_content_not_displayable");

    const embeddedCompactMarkdownPlanResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "进行修复计划的构建 审查结果",
      content: "进行修复计划的构建 审查结果 [P1] 仍会显示计划。# 待办生成链路与前端展示修复计划 ## Summary 本轮修复链路。 ## Key Changes - 前端过滤。 ## Test Plan - npm test",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(embeddedCompactMarkdownPlanResponse.status_code).toBe(400);
    expect(embeddedCompactMarkdownPlanResponse.body.error).toBe("review_content_not_displayable");

    const summaryOnlyMarkdownPlanResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "待办生成链路与前端展示修复计划",
      content: "# 待办生成链路与前端展示修复计划 ## Summary 本轮暂不处理摘要按钮，只修待办候选生成与展示链路。",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(summaryOnlyMarkdownPlanResponse.status_code).toBe(400);
    expect(summaryOnlyMarkdownPlanResponse.body.error).toBe("review_content_not_displayable");

    const reviewFindingResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "进行修复计划的构建 审查结果",
      content: "进行修复计划的构建 审查结果 [P1] #memories/#actions 仍会把完整 Markdown 修复计划当成待审阅行动。根因在 src/functions/action-candidates.ts (line 57)。",
      source: "api",
    })) as { status_code: number; body: { error?: string } };

    expect(reviewFindingResponse.status_code).toBe(400);
    expect(reviewFindingResponse.body.error).toBe("review_content_not_displayable");
  });

  it("keeps browser review candidates but no longer spawns rule action drafts (STEP-14)", async () => {
    const normal = await sdk.trigger("api::review-create", req({
      title: "ChatGPT page",
      content: "用户希望待审阅内容保持可读。",
      source: "browser-extension",
      page: { title: "ChatGPT", host: "chatgpt.com", url: "https://chatgpt.com/c/normal" },
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem } };

    expect(normal.status_code).toBe(201);
    expect(normal.body.item.title).toBe("ChatGPT page");

    const withTurns = await sdk.trigger("api::review-create", req({
      title: "ChatGPT page",
      content: "普通记忆候选",
      source: "browser-extension",
      page: { title: "ChatGPT", host: "chatgpt.com", url: "https://chatgpt.com/c/action" },
      conversation: {
        provider: "ChatGPT",
        turns: [
          { role: "user", text: "下一步请修复待审阅污染过滤。" },
        ],
      },
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem; actionDrafts?: ReviewQueueItem[] } };

    expect(withTurns.status_code).toBe(201);
    // STEP-14: browser turns no longer spawn rule-based action drafts — they flow
    // through the todo-extract LLM pipeline. The review item is still recorded.
    expect(withTurns.body.actionDrafts).toBeUndefined();
    expect(withTurns.body.item.title).toBe("ChatGPT page");
  });

  it("approves action review items into pending Actions", async () => {
    const createResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "修复 action review 批准流程",
      content: "下一步请修复 action review 的批准流程。",
      source: "api",
      payload: {
        actionCandidate: {
          priority: 8,
          sourceObservationIds: ["obs_1"],
          reason: "follow_up",
          confidence: 0.8,
        },
        todoExtraction: {
          dedupeKey: "fix-review-action-approve",
          typeBucket: "follow_up",
        },
        project: "agentmemory-lab",
        tags: ["action-candidate", "follow-up"],
      },
    })) as { body: { item: ReviewQueueItem } };

    const approveResponse = await sdk.trigger("api::review-approve", req({
      id: createResponse.body.item.id,
      kind: "action",
      title: "修复批准流程",
      content: "确保 review action approve 调用 mem::action-create。",
      project: "agentmemory-lab",
      tags: "action-candidate,reviewed",
      priority: 9,
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem; result: { success: boolean; action: Action } } };

    expect(approveResponse.status_code).toBe(200);
    expect(approveResponse.body.item.status).toBe("approved");
    expect(approveResponse.body.item.kind).toBe("action");
    expect(approveResponse.body.result.action).toMatchObject({
      title: "修复批准流程",
      description: "确保 review action approve 调用 mem::action-create。",
      status: "pending",
      priority: 9,
      project: "agentmemory-lab",
      tags: ["action-candidate", "reviewed"],
      sourceObservationIds: ["obs_1"],
    });
    expect(approveResponse.body.result.action.id).toBe(fingerprintId("act", "todo:fix-review-action-approve"));
    expect(approveResponse.body.result.action.metadata?.todoExtraction).toMatchObject({
      dedupeKey: "fix-review-action-approve",
    });
    expect(approveResponse.body.item.resultId).toBe(approveResponse.body.result.action.id);

    const storedActions = await kv.list<Action>(KV.actions);
    expect(storedActions).toHaveLength(1);
  });

  it("keeps action review items pending when action creation fails", async () => {
    sdk.registerFunction("mem::action-create", async () => ({
      success: false,
      error: "action backend unavailable",
    }));
    const item: ReviewQueueItem = {
      id: "review_action_failure",
      createdAt: "2026-06-11T08:00:00.000Z",
      updatedAt: "2026-06-11T08:00:00.000Z",
      status: "pending",
      kind: "action",
      title: "修复审批失败保护",
      content: "下一步请修复审批失败保护。",
      source: "viewer",
      payload: {
        actionCandidate: { priority: 8, sourceObservationIds: ["obs_1"] },
        tags: ["action-candidate"],
      },
    };
    await kv.set(KV.reviewQueue, item.id, item);

    const response = await sdk.trigger("api::review-approve", req({
      id: item.id,
      kind: "action",
      priority: "not-a-number",
    })) as { status_code: number; body: { success?: boolean; error?: string } };

    expect(response.status_code).toBe(502);
    expect(response.body).toMatchObject({
      success: false,
      error: "action backend unavailable",
    });
    const stored = await kv.get<ReviewQueueItem>(KV.reviewQueue, item.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.resultId).toBeUndefined();
  });

  it("dismisses action review items without creating Actions", async () => {
    const createResponse = await sdk.trigger("api::review-create", req({
      kind: "action",
      title: "忽略这个 action",
      content: "TODO: ignore me",
      source: "api",
    })) as { body: { item: ReviewQueueItem } };

    const dismissResponse = await sdk.trigger("api::review-dismiss", req({
      id: createResponse.body.item.id,
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem } };

    expect(dismissResponse.status_code).toBe(200);
    expect(dismissResponse.body.item.status).toBe("dismissed");
    expect(await kv.list<Action>(KV.actions)).toEqual([]);
  });

  it("records the browser session but creates no action drafts — browser flows through todo-extract (STEP-14)", async () => {
    const response = await sdk.trigger("api::review-create", req({
      title: "ChatGPT page",
      content: "普通记忆候选",
      source: "browser-extension",
      page: { title: "ChatGPT", host: "chatgpt.com", url: "https://chatgpt.com/c/1" },
      conversation: {
        provider: "ChatGPT",
        turns: [
          { role: "assistant", text: "这里是页面说明。" },
          { role: "user", text: "下一步请修复 Viewer 待审阅里的行动候选展示。" },
        ],
      },
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem; actionDrafts?: ReviewQueueItem[] } };

    expect(response.status_code).toBe(201);
    expect(response.body.item.kind).toBe("memory");
    // No rule-based action drafts; only the memory review item itself.
    expect(response.body.actionDrafts).toBeUndefined();
    const pending = await kv.list<ReviewQueueItem>(KV.reviewQueue);
    expect(pending.filter((item) => item.kind === "action")).toEqual([]);
  });

  it("does not create browser action drafts from ordinary requests or assistant plans", async () => {
    const response = await sdk.trigger("api::review-create", req({
      title: "ChatGPT page",
      content: "普通记忆候选",
      source: "browser-extension",
      page: { title: "ChatGPT", host: "chatgpt.com", url: "https://chatgpt.com/c/2" },
      conversation: {
        provider: "ChatGPT",
        turns: [
          { role: "user", text: "请审查当前实现。" },
          { role: "user", text: "需要分析为何摘要为空。" },
          { role: "user", text: "希望你说明原因。" },
          { role: "assistant", text: "下一步请修复摘要按钮一直显示摘要为空的问题。" },
        ],
      },
    })) as { status_code: number; body: { success: boolean; item: ReviewQueueItem; actionDrafts?: ReviewQueueItem[] } };

    expect(response.status_code).toBe(201);
    expect(response.body.actionDrafts ?? []).toEqual([]);

    const pending = await kv.list<ReviewQueueItem>(KV.reviewQueue);
    expect(pending.filter((item) => item.kind === "action")).toEqual([]);
  });
});
