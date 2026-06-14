import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

// STEP-C2: 待回应分区接真实 inbox 数据。这些用例锁定 renderAwaitingReplySection()
// 的纯渲染契约——给定 state.inbox.items,产出 question/briefing 两类卡片、
// 复用「看原文 →」跳证据、空态去掉「尚未接通」。不依赖运行中的 daemon。

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadViewerSandbox() {
  const rendered = renderViewerDocument();
  if (!rendered.found) throw new Error("viewer document not found");
  const scriptMatch = rendered.html.match(
    /<script nonce="[^"]+">([\s\S]*?)<\/script>/,
  );
  if (!scriptMatch) throw new Error("viewer script not found");

  const elements = new Map<string, any>();
  const createMockElement = (id = "") => ({
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    checked: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute: () => null,
    setAttribute() {},
    removeAttribute() {},
    addEventListener() {},
    closest: () => null,
    querySelectorAll: () => [],
  });
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, createMockElement(id));
    return elements.get(id);
  };

  const tabs = [
    "dashboard", "graph", "memories", "timeline", "sessions", "lessons",
    "actions", "crystals", "audit", "activity", "profile", "replay",
  ];
  const tabButtons = tabs.map((tab) => ({ ...createMockElement(), dataset: { tab } }));
  const views = tabs.map((tab) => ({ ...createMockElement(`view-${tab}`), id: `view-${tab}` }));
  const querySelectorAll = (selector: string) => {
    if (selector === ".tab-bar button") return tabButtons;
    if (selector === ".view") return views;
    return [];
  };

  const document = {
    documentElement: { dataset: {} },
    createElement: () => {
      let text = "";
      return {
        set textContent(value: unknown) { text = String(value ?? ""); },
        get innerHTML() { return htmlEscape(text); },
        style: {},
        dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {},
        getAttribute: () => null,
        removeAttribute() {},
        appendChild() {},
        querySelectorAll: () => [],
      };
    },
    getElementById: getElement,
    querySelectorAll,
    addEventListener() {},
  };

  const sandbox: Record<string, any> = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document,
    window: {
      location: { search: "", port: "3113", protocol: "http:", hostname: "localhost", host: "localhost:3113", origin: "http://localhost:3113" },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
    },
    history: { replaceState: () => {}, pushState: () => {} },
    location: { hash: "", pathname: "/", search: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function WebSocket() {},
    navigator: { userAgent: "vitest" },
    Element: function Element() {},
    alert: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    URLSearchParams,
    Date, Math, Promise, JSON, Array, Object, String, Number,
    parseInt, encodeURIComponent,
  };

  const scriptWithoutAutoStart = scriptMatch[1].replace(
    /\n\s*loadTab\('dashboard'\);\n\s*connectWs\(\);\n\s*startDashboardAutoRefresh\(\);\s*$/,
    "\n",
  );
  vm.createContext(sandbox);
  vm.runInContext(scriptWithoutAutoStart, sandbox);
  return { sandbox };
}

describe("STEP-C2 viewer 待回应分区接真数据", () => {
  it("空 inbox 渲染诚实空态,且不再出现「尚未接通」", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = { loaded: true, items: [] };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain("暂无待回应");
    expect(html).not.toContain("尚未接通");
    expect(html).not.toContain("即将上线");
    expect(html).not.toContain("inbox-card");
  });

  it("question 渲染为 🔴 卡片,带「来自」与计数", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [
        { id: "inbox_1", kind: "question", body: "要不要给 `/admin/*` 加鉴权?", fromAgent: "auth-refactor", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" },
      ],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain("inbox-card-question");
    expect(html).toContain("待回应 (1)");
    expect(html).toContain("来自 auth-refactor");
    expect(html).toContain("Agent 在等你回");
    // body 走 renderMarkdownSafe:反引号代码片段成 <code class="md-code">
    expect(html).toContain('<code class="md-code">');
    expect(html).not.toContain("inbox-card-briefing");
  });

  it("briefing 渲染为 📋 子区卡片,不计入待回应计数", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [
        { id: "inbox_b", kind: "briefing", body: "今天完成了 3 件", fromAgent: "line-c", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" },
      ],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain("inbox-card-briefing");
    expect(html).toContain("Agent 整理 (1)");
    expect(html).toContain("知悉即可");
    // 没有 question 时,标题不带 (n) 计数、不显示「在等你回」徽标
    expect(html).not.toContain("待回应 (");
    expect(html).not.toContain("Agent 在等你回");
  });

  it("有 sourceObservationIds 时渲染「看原文 →」按钮,复用 jump-to-evidence", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [
        { id: "inbox_e", kind: "question", body: "看证据", status: "awaiting", createdAt: "2026-06-13T09:00:00Z", sourceObservationIds: ["obs_xyz"] },
      ],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain('data-action="jump-to-evidence"');
    expect(html).toContain('data-obs-id="obs_xyz"');
    expect(html).toContain("看原文");
  });

  it("无 sourceObservationIds 时不渲染「看原文 →」", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [{ id: "inbox_n", kind: "question", body: "无证据", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).not.toContain("jump-to-evidence");
    expect(html).not.toContain("看原文");
  });

  it("question 与 briefing 混合:各自分区,question 在前", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [
        { id: "b1", kind: "briefing", body: "汇报", status: "awaiting", createdAt: "2026-06-13T09:05:00Z" },
        { id: "q1", kind: "question", body: "问题", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" },
      ],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain("inbox-card-question");
    expect(html).toContain("inbox-card-briefing");
    // question 子区在 briefing 子区之前
    expect(html.indexOf("inbox-card-question")).toBeLessThan(html.indexOf("Agent 整理 ("));
  });

  it("body 经 renderMarkdownSafe 转义,杜绝 XSS 注入", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [{ id: "x", kind: "question", body: "<img src=x onerror=alert(1)>", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).not.toContain("<img src=x onerror");
    expect(html).toContain("&lt;img");
  });

  // --- STEP-C3 动作按钮 + 行内回应 ---

  it("question 卡渲染 回应/转待处理/知道了 三动作,绑定 data-inbox-id", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null,
      items: [{ id: "q9", kind: "question", body: "要加鉴权吗?", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain('data-action="inbox-reply"');
    expect(html).toContain('data-action="inbox-to-todo"');
    expect(html).toContain('data-action="inbox-ack"');
    expect(html).toContain('data-inbox-id="q9"');
  });

  it("briefing 卡只有 知道了/转待处理,无 回应", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null,
      items: [{ id: "b9", kind: "briefing", body: "完成 3 件", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const html = sandbox.renderAwaitingReplySection();
    expect(html).toContain('data-action="inbox-ack"');
    expect(html).toContain('data-action="inbox-to-todo"');
    expect(html).not.toContain('data-action="inbox-reply"');
  });

  it("回应输入框仅在 replyingId 命中该卡时渲染", () => {
    const { sandbox } = loadViewerSandbox();
    const base = { id: "q5", kind: "question", body: "问", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" };
    sandbox.state.inbox = { loaded: true, replyingId: null, items: [base] };
    expect(sandbox.renderAwaitingReplySection()).not.toContain("inbox-reply-input-q5");
    sandbox.state.inbox.replyingId = "q5";
    const opened = sandbox.renderAwaitingReplySection();
    expect(opened).toContain('id="inbox-reply-input-q5"');
    expect(opened).toContain('data-action="inbox-reply-submit"');
    expect(opened).toContain('data-action="inbox-reply-cancel"');
  });

  it("removeInboxItemLocal 本地剔除该项并清回应态", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: "q1",
      items: [
        { id: "q1", kind: "question", body: "a", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" },
        { id: "q2", kind: "question", body: "b", status: "awaiting", createdAt: "2026-06-13T09:01:00Z" },
      ],
    };
    sandbox.removeInboxItemLocal("q1");
    expect(sandbox.state.inbox.items.map((i: { id: string }) => i.id)).toEqual(["q2"]);
    expect(sandbox.state.inbox.replyingId).toBeNull();
  });

  // --- STEP-C3 异步动作:mock apiPost 锁住 API 调用与失败/防重入分支 ---

  type PostCall = { path: string; body: Record<string, unknown> };
  function withMockApiPost(
    sandbox: Record<string, any>,
    responder: (path: string, body: Record<string, unknown>) => unknown,
  ) {
    const calls: PostCall[] = [];
    sandbox.apiPost = async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body: body || {} });
      return responder(path, body || {});
    };
    return calls;
  }
  // Make getElementById id-aware: the reply textarea for inbox-reply-input-*,
  // a generic style-bearing element otherwise (flashHint touches el.style).
  function stubReplyInput(sandbox: Record<string, any>, value: string) {
    const orig = sandbox.document.getElementById;
    sandbox.document.getElementById = (id: string) => {
      if (typeof id === "string" && id.indexOf("inbox-reply-input-") === 0) {
        return { value, focus() {} };
      }
      return orig ? orig(id) : { style: {}, focus() {} };
    };
  }

  it("回应 调用 inbox/answer 带 answer,成功后剔除该项", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: "q1", pendingById: {},
      items: [{ id: "q1", kind: "question", body: "问", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    stubReplyInput(sandbox, "  加,和 /api/* 一致  ");
    const calls = withMockApiPost(sandbox, () => ({ success: true, item: {} }));

    await sandbox.submitInboxReply("q1");

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("inbox/answer");
    expect(calls[0].body).toMatchObject({ id: "q1", answer: "加,和 /api/* 一致" });
    expect(sandbox.state.inbox.items).toHaveLength(0);
    expect(sandbox.state.inbox.pendingById.q1).toBeUndefined();
  });

  it("空回应不发请求", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: "q1", pendingById: {},
      items: [{ id: "q1", kind: "question", body: "问", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    stubReplyInput(sandbox, "   ");
    const calls = withMockApiPost(sandbox, () => ({ success: true }));
    await sandbox.submitInboxReply("q1");
    expect(calls).toHaveLength(0);
    expect(sandbox.state.inbox.items).toHaveLength(1);
  });

  it("知道了 调用 inbox/answer 不带 answer(空 = 已读)", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null, pendingById: {},
      items: [{ id: "b1", kind: "briefing", body: "汇报", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const calls = withMockApiPost(sandbox, () => ({ success: true, item: {} }));
    await sandbox.ackInboxItem("b1");
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("inbox/answer");
    expect(calls[0].body.answer).toBeUndefined();
    expect(sandbox.state.inbox.items).toHaveLength(0);
  });

  it("转待处理 先 create 成功再 dismiss,两步都调用后剔除", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null, pendingById: {},
      items: [{ id: "q9", kind: "question", body: "把这个变成待办", status: "awaiting", createdAt: "2026-06-13T09:00:00Z", project: "/repo" }],
    };
    const calls = withMockApiPost(sandbox, () => ({ success: true, item: {}, action: {} }));
    await sandbox.convertInboxToTodo("q9");
    expect(calls.map((c) => c.path)).toEqual(["actions", "inbox/dismiss"]);
    expect(calls[0].body).toMatchObject({ title: "把这个变成待办", createdBy: "inbox", project: "/repo" });
    expect(calls[1].body).toMatchObject({ id: "q9" });
    expect(sandbox.state.inbox.items).toHaveLength(0);
  });

  it("转待处理 create 失败则不 dismiss、不剔除 inbox 项", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null, pendingById: {},
      items: [{ id: "q9", kind: "question", body: "x", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const calls = withMockApiPost(sandbox, (path) => (path === "actions" ? { success: false } : { success: true }));
    await sandbox.convertInboxToTodo("q9");
    expect(calls.map((c) => c.path)).toEqual(["actions"]); // dismiss never called
    expect(sandbox.state.inbox.items).toHaveLength(1); // item preserved
  });

  it("转待处理 dismiss 失败则保留 inbox 项(绝不丢条目)", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null, pendingById: {},
      items: [{ id: "q9", kind: "question", body: "x", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    const calls = withMockApiPost(sandbox, (path) => (path === "inbox/dismiss" ? { success: false } : { success: true }));
    await sandbox.convertInboxToTodo("q9");
    expect(calls.map((c) => c.path)).toEqual(["actions", "inbox/dismiss"]);
    expect(sandbox.state.inbox.items).toHaveLength(1); // dismiss failed → item kept
  });

  it("防重入:动作进行中再次调用直接返回,不重复发请求", async () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true, replyingId: null, pendingById: {},
      items: [{ id: "q9", kind: "question", body: "x", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const calls: string[] = [];
    sandbox.apiPost = async (path: string) => {
      calls.push(path);
      if (path === "actions") await gate; // hold the first create in-flight
      return { success: true, item: {}, action: {} };
    };
    const first = sandbox.convertInboxToTodo("q9"); // enters, marks pending, awaits create
    await Promise.resolve();
    const second = sandbox.convertInboxToTodo("q9"); // should bail on isInboxPending
    await second;
    expect(calls).toEqual(["actions"]); // second made no call
    release();
    await first;
    expect(calls).toEqual(["actions", "inbox/dismiss"]);
    expect(sandbox.state.inbox.pendingById.q9).toBeUndefined();
  });
});
