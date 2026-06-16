import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function loadViewerSandbox() {
  const rendered = renderViewerDocument();
  expect(rendered.found).toBe(true);
  if (!rendered.found) throw new Error("viewer document not found");

  const scriptMatch = rendered.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  expect(scriptMatch).not.toBeNull();
  if (!scriptMatch) throw new Error("viewer script not found");

  const elements = new Map<string, any>();
  const documentListeners = new Map<string, Array<(event: any) => void>>();
  const windowListeners = new Map<string, Array<(event: any) => void>>();
  const createMockElement = (id = "") => {
    const attributes = new Map<string, string>();
    const classes = new Set<string>();
    const listeners = new Map<string, Array<(event?: unknown) => void>>();
    return {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      checked: false,
      dataset: {},
      style: {},
      listeners,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
        toggle: (name: string, force?: boolean) => {
          const enabled = force ?? !classes.has(name);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
      },
      addEventListener: (type: string, handler: (event?: unknown) => void) => {
        const current = listeners.get(type) || [];
        current.push(handler);
        listeners.set(type, current);
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: unknown) => {
        attributes.set(name, String(value));
      },
      // Added in #313 — switchTab toggles aria-selected via removeAttribute
      // on the non-active tab buttons. The mock previously only had
      // get/setAttribute, so the new hash-routing path threw TypeError.
      removeAttribute: (name: string) => {
        attributes.delete(name);
      },
      closest: () => null,
      querySelectorAll: () => [],
    };
  };
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, createMockElement(id));
    return elements.get(id);
  };

  const tabs = [
    "dashboard",
    "graph",
    "memories",
    "timeline",
    "sessions",
    "lessons",
    "actions",
    "crystals",
    "audit",
    "activity",
    "profile",
    "replay",
  ];
  const tabButtons = tabs.map((tab) => ({ ...createMockElement(), dataset: { tab } }));
  const views = tabs.map((tab) => ({ ...createMockElement(`view-${tab}`), id: `view-${tab}` }));
  const checkboxes = [createMockElement(), createMockElement()].map((el) => ({ ...el, checked: false }));
  const querySelectorAll = (selector: string) => {
    if (selector === ".tab-bar button") return tabButtons;
    if (selector === ".view") return views;
    if (selector === 'input[type="checkbox"]') return checkboxes;
    return [];
  };

  const document = {
    documentElement: { dataset: {} },
    createElement: () => {
      let text = "";
      return {
        set textContent(value: unknown) {
          text = String(value ?? "");
        },
        get innerHTML() {
          return htmlEscape(text);
        },
      };
    },
    getElementById: getElement,
    querySelectorAll,
    addEventListener: (type: string, handler: (event: any) => void) => {
      const current = documentListeners.get(type) || [];
      current.push(handler);
      documentListeners.set(type, current);
    },
  };

  const sandbox: Record<string, any> = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document,
    window: {
      location: {
        search: "",
        port: "3113",
        protocol: "http:",
        hostname: "localhost",
        host: "localhost:3113",
        origin: "http://localhost:3113",
      },
      matchMedia: () => ({ matches: false }),
      addEventListener: (type: string, handler: (event: any) => void) => {
        const current = windowListeners.get(type) || [];
        current.push(handler);
        windowListeners.set(type, current);
      },
    },
    // Stubbed in #313 — the viewer now calls history.replaceState
    // inside updateTabRoute → switchTab to drive the hash-route surface.
    // The vm sandbox is otherwise zero-globals so the call would
    // throw ReferenceError. No-op is fine for the rendering tests.
    history: { replaceState: () => {}, pushState: () => {} },
    location: {
      hash: "",
      pathname: "/",
      search: "",
    },
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
    Date,
    Math,
    Promise,
    JSON,
    Array,
    Object,
    String,
    Number,
    parseInt,
    encodeURIComponent,
  };

  const scriptWithoutAutoStart = scriptMatch[1].replace(
    /\n\s*loadTab\('dashboard'\);\n\s*connectWs\(\);\n\s*startDashboardAutoRefresh\(\);\s*$/,
    "\n",
  );

  vm.createContext(sandbox);
  vm.runInContext(scriptWithoutAutoStart, sandbox);

  const dispatchDocumentClick = (target: any) => {
    for (const handler of documentListeners.get("click") || []) {
      handler({
        target,
        preventDefault: () => {},
        stopPropagation: () => {},
      });
    }
  };

  const dispatchDocumentEvent = (type: string, event: any = {}) => {
    for (const handler of documentListeners.get(type) || []) handler(event);
  };

  const dispatchWindowEvent = (type: string, event: any = {}) => {
    for (const handler of windowListeners.get(type) || []) handler(event);
  };

  return { sandbox, getElement, dispatchDocumentClick, dispatchDocumentEvent, dispatchWindowEvent };
}

async function flushPromises(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe("viewer session rendering", () => {
  it("does not throw when dashboard sessions are missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [{ status: "active", observationCount: 3, startedAt: "2026-05-13T12:00:00Z" }],
      memories: [],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
    };

    expect(() => sandbox.renderDashboard()).not.toThrow();
    expect(getElement("view-dashboard").innerHTML).toContain("未命名会话");
  });

  it("does not throw when timeline and sessions tabs receive sessions missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const sessions = [{ status: "active", observationCount: 1, startedAt: "2026-05-13T12:00:00Z" }];

    sandbox.state.timeline.sessions = sessions;
    expect(() => sandbox.renderTimelineToolbar(sessions)).not.toThrow();
    expect(getElement("view-timeline").innerHTML).toContain("未归类");
    expect(getElement("view-timeline").innerHTML).not.toContain("undefined");

    sandbox.state.sessions.items = sessions;
    expect(() => sandbox.renderSessions()).not.toThrow();
    expect(getElement("view-sessions").innerHTML).toContain("未命名会话");

    const tabButtons = sandbox.document.querySelectorAll(".tab-bar button");
    expect(tabButtons.length).toBeGreaterThan(0);
    expect(() => sandbox.switchTab("sessions")).not.toThrow();
    expect(tabButtons.some((button: any) => button.classList.contains("active"))).toBe(true);
  });

  it("renders session highlights inside the session detail panel", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const urls: string[] = [];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("session/highlights")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            highlights: [
              {
                id: "goal_obs-1",
                sessionId: "session-1",
                category: "goal",
                title: "Initial user goal",
                summary: "提交 PR 帮助项目构建",
                timestamp: "2026-06-11T08:00:00Z",
                files: [],
                importance: 9,
                confidence: 0.8,
              },
              {
                id: "agent_obs-2",
                sessionId: "session-1",
                category: "agent_output",
                title: "Agent output",
                summary: "我会整理这次会话中对话框可见的重点。",
                timestamp: "2026-06-11T08:05:00Z",
                files: [],
                importance: 8,
                confidence: 0.7,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    sandbox.state.sessions.items = [
      {
        id: "session-1",
        startedAt: "2026-06-11T08:00:00Z",
        project: "/Users/ppio/project",
        embeddedObservations: [
          {
            id: "obs-1",
            type: "conversation",
            timestamp: "2026-06-11T08:00:00Z",
            narrative: "用户提出目标",
          },
        ],
      },
    ];
    sandbox.state.sessions.selectedId = "session-1";

    await sandbox.renderSessionDetail();

    expect(urls.some((url) => url.includes("session/highlights?sessionId=session-1&maxItems=12"))).toBe(true);
    const detail = getElement("session-detail").innerHTML;
    expect(detail).toContain("会话重点");
    expect(detail).toContain("用户");
    expect(detail).toContain("Agent");
    expect(detail).toContain("提交 PR 帮助项目构建");
    expect(detail).toContain("我会整理这次会话中对话框可见的重点");
    expect(detail).not.toContain("命令");
    expect(detail).not.toContain("src/viewer/index.html");
  });

  it("keeps session detail stable when highlights are empty or unavailable", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.sessions.items = [
      {
        id: "empty-session",
        startedAt: "2026-06-11T08:00:00Z",
        embeddedObservations: [],
      },
      {
        id: "failed-session",
        startedAt: "2026-06-11T08:10:00Z",
        embeddedObservations: [],
      },
    ];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("session/highlights") && url.includes("empty-session")) {
        return {
          ok: true,
          json: async () => ({ success: true, highlights: [] }),
        };
      }
      if (url.includes("session/highlights") && url.includes("failed-session")) {
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ observations: [] }) };
    };

    sandbox.state.sessions.selectedId = "empty-session";
    await sandbox.renderSessionDetail();
    expect(getElement("session-detail").innerHTML).toContain("暂无会话重点");

    sandbox.state.sessions.selectedId = "failed-session";
    await sandbox.renderSessionDetail();
    expect(getElement("session-detail").innerHTML).toContain("会话重点暂不可用");
  });

  it("refreshes cached highlights when an active session changes", async () => {
    const { sandbox } = loadViewerSandbox();
    const highlightUrls: string[] = [];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("session/highlights")) {
        highlightUrls.push(url);
        return {
          ok: true,
          json: async () => ({
            success: true,
            highlights: [
              {
                id: `goal-${highlightUrls.length}`,
                sessionId: "active-session",
                category: "goal",
                title: "Initial user goal",
                summary: `版本 ${highlightUrls.length}`,
                timestamp: "2026-06-11T08:00:00Z",
                files: [],
                importance: 9,
                confidence: 0.8,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ observations: [] }) };
    };

    sandbox.state.sessions.items = [
      {
        id: "active-session",
        status: "active",
        observationCount: 1,
        updatedAt: "2026-06-11T08:00:00Z",
        startedAt: "2026-06-11T08:00:00Z",
        embeddedObservations: [],
      },
    ];
    sandbox.state.sessions.selectedId = "active-session";
    await sandbox.renderSessionDetail();

    sandbox.state.sessions.items = [
      {
        id: "active-session",
        status: "active",
        observationCount: 2,
        updatedAt: "2026-06-11T08:01:00Z",
        startedAt: "2026-06-11T08:00:00Z",
        embeddedObservations: [],
      },
    ];
    await sandbox.renderSessionDetail();

    expect(highlightUrls).toHaveLength(2);
  });

  it("toggles session highlights and full process sections independently per session", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("session/highlights")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            highlights: [
              {
                id: "goal-1",
                sessionId: "session-a",
                category: "goal",
                title: "Initial user goal",
                summary: "用户可见的目标文字",
                timestamp: "2026-06-11T08:00:00Z",
                files: [],
                importance: 9,
                confidence: 0.8,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ observations: [] }) };
    };
    sandbox.state.sessions.items = [
      {
        id: "session-a",
        startedAt: "2026-06-11T08:00:00Z",
        embeddedObservations: [
          {
            id: "obs-a",
            type: "command_run",
            title: "Process detail",
            timestamp: "2026-06-11T08:00:00Z",
            narrative: "完整过程里的观察内容",
          },
        ],
      },
      {
        id: "session-b",
        startedAt: "2026-06-11T09:00:00Z",
        embeddedObservations: [
          {
            id: "obs-b",
            type: "command_run",
            title: "Process detail",
            timestamp: "2026-06-11T09:00:00Z",
            narrative: "另一个会话的完整过程",
          },
        ],
      },
    ];
    sandbox.state.sessions.selectedId = "session-a";
    await sandbox.renderSessionDetail();

    let detail = getElement("session-detail").innerHTML;
    expect(detail).toContain('data-section="highlights"');
    expect(detail).toContain('aria-expanded="true"');
    expect(detail).toContain("用户可见的目标文字");
    expect(detail).toContain('data-section="process"');
    expect(detail).toContain('aria-expanded="false"');
    expect(detail).not.toContain("完整过程里的观察内容");

    const toggle = (section: string) => {
      const target = Object.create(sandbox.Element.prototype);
      target.getAttribute = (name: string) => {
        if (name === "data-action") return "toggle-session-detail-section";
        if (name === "data-section") return section;
        if (name === "data-session-id") return sandbox.state.sessions.selectedId;
        return null;
      };
      target.closest = (selector: string) =>
        selector === "[data-action]" || selector === '[data-action="toggle-session-detail-section"]' ? target : null;
      dispatchDocumentClick(target);
    };

    toggle("highlights");
    await Promise.resolve();
    detail = getElement("session-detail").innerHTML;
    expect(detail).toContain('data-section="highlights"');
    expect(detail).toContain('aria-expanded="false"');
    expect(detail).not.toContain("用户可见的目标文字");

    toggle("highlights");
    await Promise.resolve();
    detail = getElement("session-detail").innerHTML;
    expect(detail).toContain('data-section="highlights"');
    expect(detail).toContain('aria-expanded="true"');
    expect(detail).toContain("用户可见的目标文字");

    toggle("process");
    await Promise.resolve();
    detail = getElement("session-detail").innerHTML;
    expect(detail).toContain('data-section="process"');
    expect(detail).toContain('aria-expanded="true"');
    expect(detail).toContain("完整过程里的观察内容");

    sandbox.state.sessions.selectedId = "session-b";
    await sandbox.renderSessionDetail();
    detail = getElement("session-detail").innerHTML;
    expect(detail).toContain('data-section="highlights"');
    expect(detail).toContain('aria-expanded="true"');
    expect(detail).toContain('data-section="process"');
    expect(detail).toContain('aria-expanded="false"');
    expect(detail).not.toContain("另一个会话的完整过程");
  });

  it("marks open session detail stale instead of replacing it during automatic refreshes", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const view = getElement("view-sessions");
    let sessionRequests = 0;
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/sessions")) {
        sessionRequests++;
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                id: "stable-session",
                startedAt: "2026-06-11T08:00:00Z",
                updatedAt: "2026-06-11T08:00:00Z",
                observationCount: 1,
                embeddedObservations: [
                  {
                    id: "obs-stable",
                    type: "conversation",
                    timestamp: "2026-06-11T08:00:00Z",
                    narrative: "用户正在阅读的详情",
                  },
                ],
              },
            ],
          }),
        };
      }
      if (url.includes("session/highlights")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            highlights: [
              {
                id: "goal-1",
                sessionId: "stable-session",
                category: "goal",
                title: "Initial user goal",
                summary: "用户正在阅读的重点",
                files: [],
                importance: 9,
                confidence: 0.8,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ items: [], observations: [] }) };
    };

    await sandbox.loadSessions({ showLoading: true, reason: "manual" });
    sandbox.state.sessions.selectedId = "stable-session";
    await sandbox.renderSessionDetail();
    view.innerHTML = view.innerHTML.replace("历史会话", "历史会话");
    const before = view.innerHTML;

    sandbox.state.activeTab = "sessions";
    sandbox.refreshActiveTab("timer");
    await flushPromises();

    expect(sessionRequests).toBe(1);
    expect(sandbox.state.sessions.stale).toBe(true);
    expect(getElement("sessions-stale-notice").innerHTML).toContain("有新记录");
    expect(view.innerHTML).toBe(before);
    expect(view.innerHTML).not.toContain("加载会话中");

    sandbox.routeWsMessage({
      observation: {
        id: "obs-new",
        sessionId: "stable-session",
        timestamp: "2026-06-11T08:01:00Z",
      },
    });
    await flushPromises();

    expect(sessionRequests).toBe(1);
    expect(sandbox.state.sessions.stale).toBe(true);
    expect(view.innerHTML).toBe(before);
    expect(getElement("sessions-stale-notice").innerHTML).toContain("有新记录");
    expect(view.innerHTML).not.toContain("加载会话中");
  });

  it("manually refreshes stale sessions and clears the stale marker", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    let sessionRequests = 0;
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("/sessions")) {
        sessionRequests++;
        return {
          ok: true,
          json: async () => ({
            sessions: [
              {
                id: "manual-session",
                startedAt: "2026-06-11T08:00:00Z",
                updatedAt: `2026-06-11T08:0${sessionRequests}:00Z`,
                observationCount: sessionRequests,
                embeddedObservations: [],
              },
            ],
          }),
        };
      }
      if (url.includes("session/highlights")) {
        return { ok: true, json: async () => ({ success: true, highlights: [] }) };
      }
      return { ok: true, json: async () => ({ items: [], observations: [] }) };
    };

    await sandbox.loadSessions({ showLoading: true, reason: "manual" });
    sandbox.state.sessions.selectedId = "manual-session";
    sandbox.state.sessions.stale = true;
    sandbox.renderSessions();
    expect(getElement("view-sessions").innerHTML).toContain("有新记录");

    await sandbox.loadSessions({ showLoading: true, reason: "manual" });
    await flushPromises();

    expect(sessionRequests).toBe(2);
    expect(sandbox.state.sessions.stale).toBe(false);
  });

  it("toggles session detail sections from cache without fetching or showing loading", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const urls: string[] = [];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("session/highlights")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            highlights: [
              {
                id: "goal-cache",
                sessionId: "cache-session",
                category: "goal",
                title: "Initial user goal",
                summary: "缓存中的重点",
                files: [],
                importance: 9,
                confidence: 0.8,
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ observations: [] }) };
    };
    sandbox.state.sessions.items = [
      {
        id: "cache-session",
        startedAt: "2026-06-11T08:00:00Z",
        embeddedObservations: [
          {
            id: "obs-cache",
            type: "conversation",
            title: "过程标题",
            timestamp: "2026-06-11T08:00:00Z",
            narrative: "缓存中的完整过程",
          },
        ],
      },
    ];
    sandbox.state.sessions.selectedId = "cache-session";
    await sandbox.renderSessionDetail();
    const fetchCountAfterFirstRender = urls.length;

    const toggle = (section: string) => {
      const target = Object.create(sandbox.Element.prototype);
      target.getAttribute = (name: string) => {
        if (name === "data-action") return "toggle-session-detail-section";
        if (name === "data-section") return section;
        if (name === "data-session-id") return "cache-session";
        return null;
      };
      target.closest = (selector: string) => (selector === "[data-action]" ? target : null);
      dispatchDocumentClick(target);
    };

    toggle("process");
    await Promise.resolve();

    const detail = getElement("session-detail").innerHTML;
    expect(urls).toHaveLength(fetchCountAfterFirstRender);
    expect(detail).toContain("缓存中的完整过程");
    expect(detail).not.toContain("加载会话详情中");
  });

  it("manually refreshes actions and regenerates action candidates", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const urls: string[] = [];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("review/actions/generate")) {
        return { ok: true, json: async () => ({ success: true, count: 1 }) };
      }
      if (url.includes("review?status=pending")) {
        return { ok: true, json: async () => ({ items: [] }) };
      }
      if (url.includes("frontier")) {
        return { ok: true, json: async () => ({ frontier: [] }) };
      }
      if (url.includes("actions")) {
        return { ok: true, json: async () => ({ actions: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).toContain('data-action="refresh-actions"');

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => (name === "data-action" ? "refresh-actions" : null);
    target.closest = (selector: string) => (selector === "[data-action]" ? target : null);
    dispatchDocumentClick(target);
    await flushPromises(8);

    expect(urls.some((url) => url.includes("actions"))).toBe(true);
    expect(urls.some((url) => url.includes("inbox?status=awaiting"))).toBe(true);
    expect(urls.some((url) => url.includes("inbox?status=answered"))).toBe(true);
    expect(urls.some((url) => url.includes("inbox?status=dismissed"))).toBe(true);
    expect(urls.some((url) => url.includes("review/actions/generate"))).toBe(true);
    expect(getElement("view-actions").innerHTML).toContain("正在整理待办");
  });

  it("renders the action classification metrics without a false waiting section when inbox is empty", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;
    expect(html).toContain("待回应");
    expect(html).toContain("还没有待办");
    expect(html).not.toContain("awaiting-reply-section");
    expect(html).not.toContain("暂无待回应");
    // STEP-C2 已接通后端,不再出现「尚未接通」「即将上线」
    expect(html).not.toContain("尚未接通");
    expect(html).not.toContain("即将上线");
    sandbox.state.inbox = {
      loaded: true,
      items: [{ id: "q1", kind: "question", body: "需要拍板", status: "awaiting", createdAt: "2026-06-15T10:00:00Z" }],
    };
    sandbox.renderActions();
    const withQuestion = getElement("view-actions").innerHTML;
    const idxAwaiting = withQuestion.indexOf("awaiting-reply-section");
    const idxGroups = withQuestion.indexOf("action-group");
    expect(idxAwaiting).toBeGreaterThan(-1);
    expect(idxGroups === -1 || idxAwaiting < idxGroups).toBe(true);
  });

  it("renders action reviews as compact decision cards while keeping tool pollution hidden", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [
        {
          id: "review_plan",
          status: "pending",
          kind: "action",
          title: "进行修复计划的构建 审查结果",
          content: "进行修复计划的构建 审查结果 [P1] 仍会显示计划。# 待办生成链路与前端展示修复计划 ## Summary 本轮修复链路。 ## Key Changes - 前端过滤。 ## Test Plan - npm test",
          source: "viewer",
          payload: { actionCandidate: { reason: "todo" }, tags: ["action-candidate"] },
        },
        {
          id: "review_readable",
          status: "pending",
          kind: "action",
          title: "修复待办候选展示",
          content: "下一步请修复待办候选展示。",
          source: "viewer",
          payload: { actionCandidate: { reason: "follow_up" }, tags: ["action-candidate"] },
        },
        {
          id: "review_summary_only_plan",
          status: "pending",
          kind: "action",
          title: "待办生成链路与前端展示修复计划",
          content: "# 待办生成链路与前端展示修复计划 ## Summary 本轮暂不处理摘要按钮，只修待办候选生成与展示链路。",
          source: "viewer",
          payload: { actionCandidate: { reason: "todo" }, tags: ["action-candidate"] },
        },
        {
          id: "review_code_finding",
          status: "pending",
          kind: "action",
          title: "进行修复计划的构建 审查结果",
          content: "进行修复计划的构建 审查结果 [P1] 仍会显示污染候选。根因在 src/functions/action-candidates.ts (line 57)。",
          source: "viewer",
          payload: { actionCandidate: { reason: "todo" }, tags: ["action-candidate"] },
        },
      ],
    };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("修复待办候选展示");
    expect(html).toContain("action-candidate-card");
    expect(html).toContain("待确认");
    expect(html).toContain("确认");
    expect(html).toContain("忽略");
    expect(html).toContain("查看原文");
    expect(html).toContain("待办生成链路与前端展示修复计划");
    expect(html.indexOf("## Summary")).toBeGreaterThan(html.indexOf("<summary>查看原文</summary>"));
    expect(html).not.toContain("src/functions/action-candidates.ts");
    expect(html).not.toContain(">action-candidate<");
  });
});
