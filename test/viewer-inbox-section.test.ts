import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

// STEP-C2/C3: inbox actions are still supported, but Todo no longer renders
// a separate awaiting-reply candidate section.

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
  it("Todo 页不再渲染待回应 inbox 分区", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      statusFilter: "",
      search: "",
      reviewItems: [],
      frontier: [],
      items: [{ id: "a1", status: "pending", title: "处理真实待办", updatedAt: new Date().toISOString() }],
    };
    sandbox.state.inbox = {
      loaded: true,
      items: [{ id: "q1", kind: "question", body: "要不要加鉴权", status: "awaiting", createdAt: "2026-06-13T09:00:00Z" }],
    };

    sandbox.renderActions();
    const html = sandbox.document.getElementById("view-actions").innerHTML;
    expect(html).toContain("处理真实待办");
    expect(html).not.toContain("awaiting-reply-section");
    expect(html).not.toContain("要不要加鉴权");
    expect(html).not.toContain("inbox-card");
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

  it("answered question 进入已回应归档并显示用户回复", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [],
      answeredItems: [
        {
          id: "answered-q",
          kind: "question",
          body: "演示验证：请直接在飞书里回复这条消息",
          answer: "auto-ok",
          fromAgent: "reply-loop-check",
          status: "answered",
          answeredAt: "2026-06-15T10:00:00Z",
        },
      ],
      dismissedItems: [],
      answeredExpanded: true,
    };
    const html = sandbox.renderInboxArchiveSection();
    expect(html).toContain("已回应 1 条");
    expect(html).toContain("演示验证");
    expect(html).toContain("你已回复：");
    expect(html).toContain("auto-ok");
    expect(html).toContain("来自 reply-loop-check");
  });

  it("answered/dismissed briefing 进入已知悉归档,不出现在待回应", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [],
      answeredItems: [
        { id: "brief-ack", kind: "briefing", body: "本次整理完成", status: "answered", answeredAt: "2026-06-15T10:00:00Z" },
      ],
      dismissedItems: [
        { id: "brief-dismissed", kind: "briefing", body: "旧简报已消解", status: "dismissed", dismissedAt: "2026-06-15T10:01:00Z" },
      ],
      answeredExpanded: true,
    };
    const html = sandbox.renderInboxArchiveSection();
    expect(html).toContain("已知悉 (2)");
    expect(html).toContain("本次整理完成");
    expect(html).toContain("旧简报已消解");
    expect(html).not.toContain("data-action=\"inbox-ack\"");
    expect(html).not.toContain("data-action=\"inbox-to-todo\"");
  });

  it("搜索可命中已回应 answer 与已知悉 briefing", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.inbox = {
      loaded: true,
      items: [],
      answeredItems: [
        { id: "q", kind: "question", body: "飞书同步验证", answer: "auto-ok", status: "answered", answeredAt: "2026-06-15T10:00:00Z" },
      ],
      dismissedItems: [
        { id: "b", kind: "briefing", body: "Agent 整理归档", status: "dismissed", dismissedAt: "2026-06-15T10:01:00Z" },
      ],
      answeredExpanded: false,
    };
    sandbox.state.actions.search = "auto-ok";
    let html = sandbox.renderInboxArchiveSection();
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("飞书同步验证");
    expect(html).not.toContain("Agent 整理归档");

    sandbox.state.actions.search = "整理";
    html = sandbox.renderInboxArchiveSection();
    expect(html).toContain("Agent 整理归档");
    expect(html).not.toContain("飞书同步验证");
  });
});
