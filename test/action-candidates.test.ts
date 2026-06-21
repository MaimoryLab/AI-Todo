import { describe, expect, it } from "vitest";
import { registerActionCandidateFunctions } from "../src/functions/action-candidates.js";
import {
  extractActionCandidatesFromObservations,
  extractActionCandidatesFromTurns,
} from "../src/functions/action-candidates.js";
import { KV } from "../src/state/schema.js";
import type { Action, CompressedObservation, ReviewQueueItem, Session } from "../src/types.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

function obs(
  id: string,
  patch: Partial<CompressedObservation>,
): CompressedObservation {
  return {
    id,
    sessionId: "ses_actions",
    timestamp: `2026-06-11T09:${String(Math.max(0, Number(id.replace(/\D/g, "")) || 0)).padStart(2, "0")}:00.000Z`,
    type: "conversation",
    title: id,
    facts: [],
    narrative: "",
    concepts: [],
    files: [],
    importance: 5,
    confidence: 0.6,
    ...patch,
  };
}

describe("zero-LLM action candidates", () => {
  it("extracts explicit Chinese and English todo/follow-up candidates", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        narrative: "下一步请修复摘要按钮一直显示摘要为空的问题。",
        files: ["src/functions/session-highlights.ts"],
      }),
      obs("obs_2", {
        narrative: "TODO: 补充摘要按钮回归测试。",
        files: ["test/action-candidates.test.ts"],
      }),
      obs("obs_3", {
        narrative: "TODO: 修复 exec_command 自然语言误判。",
      }),
      obs("obs_4", {
        narrative: "下一步请修复 apply_patch 相关的待办抽取。",
      }),
    ]);

    expect(candidates).toHaveLength(4);
    expect(candidates[0]).toMatchObject({
      title: "修复摘要按钮一直显示摘要为空的问题",
      priority: expect.any(Number),
      source: "observation",
      sourceObservationIds: ["obs_1"],
    });
    expect(candidates[0].tags).toEqual(expect.arrayContaining(["action-candidate", "follow-up"]));
    expect(candidates[1].title).toBe("补充摘要按钮回归测试");
    expect(candidates[1].sourceObservationIds).toEqual(["obs_2"]);
    expect(candidates.map((c) => c.title)).toEqual(expect.arrayContaining([
      "修复 exec_command 自然语言误判",
      "修复 apply_patch 相关的待办抽取",
    ]));
  });

  it("filters tool-output, status reports, and git-ref fragments (STEP-08)", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        type: "command_run",
        narrative: '⏺ Bash(pwd && echo "--- branch ---" && git branch --show-current)',
      }),
      obs("obs_2", {
        narrative:
          "服务可用： - Viewer: [http://localhost:3115](http://localhost:3115) - Health: [http://localhost:3115/agentmemory/livez]",
      }),
      obs("obs_3", { narrative: "origin-main-e7f5ca2`" }),
      obs("obs_4", { narrative: "下一步请修复分类边界判定错误。" }),
    ]);
    const titles = candidates.map((c) => c.title);
    expect(titles.some((t) => /⏺|Bash\(/.test(t))).toBe(false);
    expect(titles.some((t) => /服务可用|Viewer:|Health:/.test(t))).toBe(false);
    expect(titles.some((t) => /^origin-main/.test(t))).toBe(false);
    expect(titles).toContain("修复分类边界判定错误");
  });

  it("extracts repair candidates from failures, blocked work, and failed validation", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        type: "command_run",
        title: "Bash",
        narrative: "Command failed with exit code 1: npm test failed.",
      }),
      obs("obs_2", {
        type: "task",
        narrative: "blocked: review approval path still needs sourceObservationIds.",
      }),
      obs("obs_3", {
        type: "conversation",
        narrative: "验证未通过，需要修复 action review 的 priority 映射。",
      }),
      obs("obs_4", {
        type: "conversation",
        narrative: "测试失败，需要修复 replay import 幂等性。",
      }),
    ]);

    expect(candidates.map((c) => c.reason)).toEqual(expect.arrayContaining([
      "command_failed",
      "blocked",
      "validation_failed",
    ]));
    expect(candidates.map((c) => c.title)).toEqual(expect.arrayContaining([
      "修复 replay import 幂等性",
    ]));
    expect(candidates.every((c) => c.priority >= 6)).toBe(true);
  });

  it("does not extract from normal explanations or read-only source observations", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        type: "conversation",
        narrative: "我会先审查当前链路，并说明实现计划。",
      }),
      obs("obs_2", {
        type: "file_read",
        title: "Read src/functions/actions.ts",
        narrative: "function run() { /* TODO failed test blocked */ }",
      }),
      obs("obs_3", {
        type: "search",
        narrative: "src/file.ts: TODO: old source text",
      }),
      obs("obs_4", {
        type: "web_fetch",
        narrative: "Docs mention follow up tasks and failed validation.",
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("does not treat bare polite requests as action candidates", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", { narrative: "请审查当前实现。" }),
      obs("obs_2", { narrative: "需要分析为何摘要为空。" }),
      obs("obs_3", { narrative: "希望你说明原因。" }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("filters structured tool traces without rejecting natural-language tool names", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        narrative: "{\"function_id\":\"x\",\"toolInput\":{\"command\":\"npm test\"}}",
      }),
      obs("obs_2", {
        narrative: "toolOutput function_id \"command\": npm test",
      }),
      obs("obs_3", {
        narrative: "TODO: 修复 exec_command 自然语言误判。",
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      title: "修复 exec_command 自然语言误判",
      sourceObservationIds: ["obs_3"],
    });
  });

  it("does not turn Markdown implementation plans into action candidates", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        narrative: [
          "# 待办生成链路与前端展示修复计划",
          "",
          "## Summary",
          "本轮修复待办候选生成与展示链路。",
          "",
          "## Key Changes",
          "- 前端待办页改造：打开待办页时自动整理最近会话。",
          "- 后端补齐会话待办候选生成。",
          "",
          "## Test Plan",
          "- npm test -- --run test/action-candidates.test.ts",
        ].join("\n"),
      }),
      obs("obs_2", {
        narrative: "# 待办生成链路与前端展示修复计划 ## Summary 本轮修复待办候选生成与展示链路。 ## Key Changes - 前端待办页改造。 ## Test Plan - npm test",
      }),
      obs("obs_3", {
        narrative: "进行修复计划的构建 审查结果 [P1] 仍会显示计划。# 待办生成链路与前端展示修复计划 ## Summary 本轮修复链路。 ## Key Changes - 前端过滤。 ## Test Plan - npm test",
      }),
      obs("obs_4", {
        narrative: "# 待办生成链路与前端展示修复计划 ## Summary 本轮暂不处理摘要按钮，只修待办候选生成与展示链路。",
      }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("uses only the extracted action sentence as candidate description", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", {
        narrative: [
          "背景：待办页候选生成目前会混入大段上下文，这些内容不应进入描述。",
          "下一步请修复待办页展示问题，并补充必要回归测试。",
          "Summary / Key Changes / Test Plan 这些文档段落不应该出现在候选里。",
        ].join("\n"),
      }),
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("修复待办页展示问题，并补充必要回归测试");
    expect(candidates[0].description).toBe("下一步请修复待办页展示问题，并补充必要回归测试。");
    expect(candidates[0].description).not.toContain("Summary");
    expect(candidates[0].description.length).toBeLessThanOrEqual(180);
  });

  it("deduplicates candidates from the same batch and skips existing pending work", () => {
    const existingAction: Action = {
      id: "act_existing",
      title: "修复会话重点里 Agent 回复缺失的问题",
      description: "old",
      status: "pending",
      priority: 6,
      createdAt: "2026-06-11T08:00:00.000Z",
      updatedAt: "2026-06-11T08:00:00.000Z",
      createdBy: "test",
      tags: [],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    };
    const existingReview: ReviewQueueItem = {
      id: "review_existing",
      createdAt: "2026-06-11T08:00:00.000Z",
      updatedAt: "2026-06-11T08:00:00.000Z",
      status: "pending",
      kind: "action",
      title: "补充 action review 测试",
      content: "old",
      source: "api",
    };

    const candidates = extractActionCandidatesFromObservations(
      [
        obs("obs_1", { narrative: "下一步请修复会话重点里 Agent 回复缺失的问题。" }),
        obs("obs_2", { narrative: "下一步请修复会话重点里 Agent 回复缺失的问题。" }),
        obs("obs_3", { narrative: "TODO: 补充 action review 测试。" }),
        obs("obs_4", { narrative: "TODO: 新增 Viewer 行动候选展示。" }),
      ],
      { existingActions: [existingAction], existingReviewItems: [existingReview] },
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("新增 Viewer 行动候选展示");
  });

  it("collapses CJK rewordings of one task across a batch but keeps distinct work (STEP-08 PR4)", () => {
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", { narrative: "TODO: 克隆上游项目到子目录。" }),
      obs("obs_2", { narrative: "TODO: 克隆上游项目到子目录中。" }), // insertion
      obs("obs_3", { narrative: "TODO: 把上游项目克隆到子目录。" }), // word-order
      obs("obs_4", { narrative: "TODO: 克隆上游项目到子目录下。" }), // insertion
      obs("obs_5", { narrative: "TODO: 修复登录态失效后摘要不显示。" }), // distinct
    ]);

    expect(candidates.map((c) => c.title)).toEqual([
      "克隆上游项目到子目录",
      "修复登录态失效后摘要不显示",
    ]);
  });

  it("keeps semantically distinct candidates that only look similar (STEP-08 PR4)", () => {
    // negation flip, version bump, and a two-char substitution must NOT collapse
    const candidates = extractActionCandidatesFromObservations([
      obs("obs_1", { narrative: "TODO: 支持离线缓存模式。" }),
      obs("obs_2", { narrative: "TODO: 不支持离线缓存模式。" }),
      obs("obs_3", { narrative: "TODO: 升级依赖到 v2。" }),
      obs("obs_4", { narrative: "TODO: 升级依赖到 v3。" }),
      obs("obs_5", { narrative: "TODO: 克隆上游仓库到子目录。" }),
      obs("obs_6", { narrative: "TODO: 克隆上游项目到子目录。" }),
    ]);

    expect(candidates).toHaveLength(6);
  });

  it("near-dup guard is seeded from open work only, never from done work (STEP-08 PR4)", () => {
    const seedNearDup = (status: Action["status"]): Action => ({
      id: `act_${status}`,
      title: "克隆上游项目到子目录中",
      description: "old",
      status,
      priority: 6,
      createdAt: "2026-06-11T08:00:00.000Z",
      updatedAt: "2026-06-11T08:00:00.000Z",
      createdBy: "test",
      tags: [],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    });
    const observation = obs("obs_1", { narrative: "TODO: 克隆上游项目到子目录。" });

    // A near-dup of an open action is suppressed...
    expect(
      extractActionCandidatesFromObservations([observation], {
        existingActions: [seedNearDup("pending")],
      }),
    ).toHaveLength(0);

    // ...but a near-dup of a done action may reappear (work could have regressed).
    expect(
      extractActionCandidatesFromObservations([observation], {
        existingActions: [seedNearDup("done")],
      }),
    ).toHaveLength(1);
  });

  it("seeds the near-dup guard from pending action reviews but not approved/dismissed ones (STEP-08 PR4)", () => {
    const seedReview = (status: ReviewQueueItem["status"]): ReviewQueueItem => ({
      id: `review_${status}`,
      createdAt: "2026-06-11T08:00:00.000Z",
      updatedAt: "2026-06-11T08:00:00.000Z",
      status,
      kind: "action",
      title: "克隆上游项目到子目录中",
      content: "old",
      source: "viewer",
    });
    const observation = obs("obs_1", { narrative: "TODO: 克隆上游项目到子目录。" });

    expect(
      extractActionCandidatesFromObservations([observation], {
        existingReviewItems: [seedReview("pending")],
      }),
    ).toHaveLength(0);
    expect(
      extractActionCandidatesFromObservations([observation], {
        existingReviewItems: [seedReview("dismissed")],
      }),
    ).toHaveLength(1);
  });

  it("collapses near-duplicate browser turns of one task into a single draft (STEP-08 PR4)", () => {
    const candidates = extractActionCandidatesFromTurns([
      { role: "user", text: "下一步请修复登录页面的样式问题。" },
      { role: "user", text: "下一步请修复登录页面的样式问题啊。" }, // insertion reword
      { role: "user", text: "下一步请修复 issue 123。" },
      { role: "user", text: "下一步请修复 issue 456。" }, // different issue → kept
    ]);

    expect(candidates.map((c) => c.title)).toEqual([
      "修复登录页面的样式问题",
      "修复 issue 123",
      "修复 issue 456",
    ]);
  });

  it("extracts browser conversation turns with explicit next-step language", () => {
    const candidates = extractActionCandidatesFromTurns([
      { role: "assistant", text: "我会先解释这个页面。" },
      { role: "user", text: "下一步请修复 action review 的批准流程。" },
      { role: "assistant", text: "普通总结，不应生成待办。" },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      title: "修复 action review 的批准流程",
      source: "browser-review",
      sourceObservationIds: [],
    });
  });

  it("only extracts browser action drafts from user turns", () => {
    const candidates = extractActionCandidatesFromTurns([
      { role: "assistant", text: "下一步请修复摘要按钮一直显示摘要为空的问题。" },
      { role: "user", text: "请审查当前实现。" },
      { role: "user", text: "需要分析为何摘要为空。" },
      { role: "user", text: "希望你说明原因。" },
      { role: "user", text: "下一步请修复摘要按钮一直显示摘要为空的问题。" },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].title).toBe("修复摘要按钮一直显示摘要为空的问题");
  });
});

describe("mem::action-candidates-generate", () => {
  function setup() {
    const sdk = mockSdk();
    const kv = mockKV();
    registerActionCandidateFunctions(sdk as never, kv as never);
    return { sdk, kv };
  }

  async function seedSession(kv: ReturnType<typeof mockKV>) {
    const session: Session = {
      id: "ses_actions",
      project: "agentmemory-lab",
      cwd: "/repo",
      startedAt: "2026-06-11T08:00:00.000Z",
      endedAt: "2026-06-11T08:10:00.000Z",
      status: "completed",
      observationCount: 4,
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs_1", obs("obs_1", {
      sessionId: session.id,
      narrative: "TODO: 补充待办页候选回归测试。",
      timestamp: "2026-06-11T08:01:00.000Z",
    }));
    await kv.set(KV.observations(session.id), "obs_2", obs("obs_2", {
      sessionId: session.id,
      narrative: "下一步请修复待办页不展示未批准候选的问题。",
      timestamp: "2026-06-11T08:02:00.000Z",
    }));
    await kv.set(KV.observations(session.id), "obs_3", obs("obs_3", {
      sessionId: session.id,
      narrative: "测试失败，需要修复 review approve 的错误处理。",
      timestamp: "2026-06-11T08:03:00.000Z",
    }));
    await kv.set(KV.observations(session.id), "obs_4", obs("obs_4", {
      sessionId: session.id,
      narrative: "请审查当前实现。",
      timestamp: "2026-06-11T08:04:00.000Z",
    }));
  }

  it("generates pending action review items from recent session observations", async () => {
    const { sdk, kv } = setup();
    await seedSession(kv);
    const duplicateSession: Session = {
      id: "ses_actions_duplicate",
      project: "agentmemory-lab",
      cwd: "/repo",
      startedAt: "2026-06-11T08:20:00.000Z",
      endedAt: "2026-06-11T08:30:00.000Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, duplicateSession.id, duplicateSession);
    await kv.set(KV.observations(duplicateSession.id), "obs_dup", obs("obs_dup", {
      sessionId: duplicateSession.id,
      narrative: "TODO: 补充待办页候选回归测试。",
      timestamp: "2026-06-11T08:21:00.000Z",
    }));

    const result = await sdk.trigger("mem::action-candidates-generate", {
      maxSessions: 5,
      maxObservationsPerSession: 20,
    }) as { success: true; generated: number; items: ReviewQueueItem[]; scannedSessions: number; scannedObservations: number };

    expect(result.success).toBe(true);
    expect(result.scannedSessions).toBe(2);
    expect(result.scannedObservations).toBe(5);
    expect(result.generated).toBe(3);
    expect(result.items.map((item) => item.kind)).toEqual(["action", "action", "action"]);
    expect(result.items.map((item) => item.title)).toEqual(expect.arrayContaining([
      "补充待办页候选回归测试",
      "修复待办页不展示未批准候选的问题",
      "修复 review approve 的错误处理",
    ]));
    expect(result.items.every((item) => item.payload?.project === "agentmemory-lab")).toBe(true);
    const sessionOnlyItem = result.items.find((item) => item.title === "修复待办页不展示未批准候选的问题");
    expect(sessionOnlyItem).toMatchObject({
      status: "pending",
      source: "viewer",
      payload: {
        project: "agentmemory-lab",
        sourceSessionId: "ses_actions",
        sourceSessionProject: "agentmemory-lab",
        sourceSessionCwd: "/repo",
        actionCandidate: {
          sourceObservationIds: expect.any(Array),
        },
      },
    });
  });

  it("falls back to session cwd when source session project is missing", async () => {
    const { sdk, kv } = setup();
    const session: Session = {
      id: "ses_cwd_project",
      project: "",
      cwd: "/repo/no-project",
      startedAt: "2026-06-11T08:00:00.000Z",
      endedAt: "2026-06-11T08:10:00.000Z",
      status: "completed",
      observationCount: 1,
    };
    await kv.set(KV.sessions, session.id, session);
    await kv.set(KV.observations(session.id), "obs_cwd", obs("obs_cwd", {
      sessionId: session.id,
      narrative: "TODO: 补充 cwd project fallback 测试。",
      timestamp: "2026-06-11T08:01:00.000Z",
    }));

    const result = await sdk.trigger("mem::action-candidates-generate", {
      maxSessions: 5,
      maxObservationsPerSession: 20,
    }) as { success: true; generated: number; items: ReviewQueueItem[] };

    expect(result.success).toBe(true);
    expect(result.generated).toBe(1);
    expect(result.items[0]).toMatchObject({
      title: "补充 cwd project fallback 测试",
      payload: {
        project: "/repo/no-project",
        sourceSessionId: "ses_cwd_project",
        sourceSessionCwd: "/repo/no-project",
      },
    });
    expect(result.items[0].payload?.sourceSessionProject).toBeUndefined();
  });

  it("collapses title-drifted candidates across sessions via the generate loop (STEP-08 PR4)", async () => {
    const { sdk, kv } = setup();
    const mkSession = (id: string, ended: string): Session => ({
      id,
      project: "agentmemory-lab",
      cwd: "/repo",
      startedAt: ended,
      endedAt: ended,
      status: "completed",
      observationCount: 1,
    });
    // Two sessions, same task reworded (insertion) — exact-key dedup misses it,
    // the cross-session near-dup guard must collapse it.
    await kv.set(KV.sessions, "ses_a", mkSession("ses_a", "2026-06-11T08:10:00.000Z"));
    await kv.set(KV.observations("ses_a"), "obs_a", obs("obs_a", {
      sessionId: "ses_a",
      narrative: "TODO: 克隆上游项目到子目录。",
      timestamp: "2026-06-11T08:11:00.000Z",
    }));
    await kv.set(KV.sessions, "ses_b", mkSession("ses_b", "2026-06-11T08:20:00.000Z"));
    await kv.set(KV.observations("ses_b"), "obs_b", obs("obs_b", {
      sessionId: "ses_b",
      narrative: "TODO: 克隆上游项目到子目录中。",
      timestamp: "2026-06-11T08:21:00.000Z",
    }));

    const result = await sdk.trigger("mem::action-candidates-generate", {}) as { generated: number; items: ReviewQueueItem[] };

    expect(result.generated).toBe(1);
    expect(result.items[0].title).toMatch(/^克隆上游项目到子目录/);
  });

  it("does not regenerate duplicates after pending, dismissed, approved, or existing actions", async () => {
    const { sdk, kv } = setup();
    await seedSession(kv);

    const first = await sdk.trigger("mem::action-candidates-generate", {}) as { generated: number; items: ReviewQueueItem[] };
    expect(first.generated).toBe(3);
    const pendingDuplicate = await sdk.trigger("mem::action-candidates-generate", {}) as { generated: number };
    expect(pendingDuplicate.generated).toBe(0);

    const items = await kv.list<ReviewQueueItem>(KV.reviewQueue);
    await kv.set(KV.reviewQueue, items[0].id, { ...items[0], status: "dismissed", reviewedAt: "2026-06-11T08:11:00.000Z" });
    await kv.set(KV.reviewQueue, items[1].id, { ...items[1], status: "approved", reviewedAt: "2026-06-11T08:12:00.000Z" });
    await kv.delete(KV.reviewQueue, items[2].id);
    const existingAction: Action = {
      id: "act_existing",
      title: items[2].title,
      description: items[2].content,
      status: "pending",
      priority: 8,
      createdAt: "2026-06-11T08:13:00.000Z",
      updatedAt: "2026-06-11T08:13:00.000Z",
      createdBy: "test",
      tags: [],
      sourceObservationIds: [],
      sourceMemoryIds: [],
    };
    await kv.set(KV.actions, existingAction.id, existingAction);

    const afterTerminalStates = await sdk.trigger("mem::action-candidates-generate", {}) as { generated: number };
    expect(afterTerminalStates.generated).toBe(0);
  });
});
