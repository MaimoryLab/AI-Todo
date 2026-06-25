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
  const timers: Array<() => void> = [];
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
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
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

  const runTimers = () => {
    let ran = 0;
    while (timers.length) {
      const pending = timers.splice(0);
      for (const timer of pending) {
        ran++;
        timer();
      }
    }
    return ran;
  };

  return { sandbox, getElement, dispatchDocumentClick, dispatchDocumentEvent, dispatchWindowEvent, runTimers };
}

async function flushPromises(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

async function waitFor(predicate: () => boolean, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await flushPromises(2);
  }
}

describe("viewer session rendering", () => {
  const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  it("does not throw when dashboard sessions are missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.dashboard = {
      loaded: true,
      health: { status: "healthy", health: {} },
      sessions: [{ status: "active", observationCount: 3, startedAt: "2026-05-13T12:00:00Z" }],
      memories: [],
      actions: [{ id: "act-1", title: "Ship todo", status: "pending", tags: [] }],
      actionReviews: [{ id: "review-1", status: "pending", kind: "action", title: "Confirm todo", content: "Confirm this todo." }],
      inboxAwaiting: [{ id: "q1", kind: "question", body: "Need input?", status: "awaiting" }],
      graphStats: null,
      recentAudit: [],
      lessons: [],
      crystals: [],
    };

    expect(() => sandbox.renderDashboard()).not.toThrow();
    const html = getElement("view-dashboard").innerHTML;
    expect(html).toContain("Unnamed session");
    expect(html).toContain("Todos");
    expect(html).toContain("Todos");
    expect(html).toContain("1 open · 0 done");
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("reply ·");
    expect(html).not.toContain("Reply queue");
    expect(html).not.toContain("Action candidates");
    expect(html).not.toContain("Pending actions");
    expect(html).not.toContain("Memories");
    expect(html).not.toContain("Lessons");
    expect(html).not.toContain("Graph nodes");
  });

  it("loads dashboard product data without old memory debug endpoints by default", async () => {
    const { sandbox } = loadViewerSandbox();
    const urls: string[] = [];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("sessions")) return { ok: true, json: async () => ({ sessions: [] }) };
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: [] }) };
      if (url.includes("inbox?status=awaiting")) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: true, json: async () => ({}) };
    };

    await sandbox.loadDashboard();

    expect(urls.some((url) => url.includes("actions"))).toBe(true);
    expect(urls.some((url) => url.includes("review?status=pending&kind=action"))).toBe(false);
    expect(urls.some((url) => url.includes("inbox?status=awaiting"))).toBe(true);
    expect(urls.some((url) => url.includes("memories?latest=true"))).toBe(false);
    expect(urls.some((url) => url.includes("graph/stats"))).toBe(false);
    expect(urls.some((url) => url.includes("lessons"))).toBe(false);
  });

  it("does not throw when timeline and sessions tabs receive sessions missing ids", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const sessions = [{ status: "active", observationCount: 1, startedAt: "2026-05-13T12:00:00Z" }];

    sandbox.state.timeline.sessions = sessions;
    expect(() => sandbox.renderTimelineToolbar(sessions)).not.toThrow();
    expect(getElement("view-timeline").innerHTML).toContain("Uncategorized");
    expect(getElement("view-timeline").innerHTML).not.toContain("undefined");

    sandbox.state.sessions.items = sessions;
    expect(() => sandbox.renderSessions()).not.toThrow();
    expect(getElement("view-sessions").innerHTML).toContain("Unnamed session");

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

  it("keeps long session detail content compact by default", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const longText = "这是一段很长的会话摘要。".repeat(40);
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("session/highlights")) {
        return {
          ok: true,
          json: async () => ({
            success: true,
            highlights: Array.from({ length: 6 }, (_, index) => ({
              id: `goal-${index}`,
              sessionId: "session-long",
              category: index % 2 === 0 ? "goal" : "agent_output",
              title: `重点 ${index + 1}`,
              summary: longText,
              timestamp: "2026-06-11T08:00:00Z",
              files: [],
              importance: 8,
              confidence: 0.8,
            })),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    sandbox.state.sessions.items = [
      {
        id: "session-long",
        startedAt: "2026-06-11T08:00:00Z",
        summary: longText,
        embeddedObservations: [
          {
            id: "obs-1",
            type: "conversation",
            timestamp: "2026-06-11T08:00:00Z",
            narrative: longText,
          },
        ],
      },
    ];
    sandbox.state.sessions.selectedId = "session-long";

    await sandbox.renderSessionDetail();
    const detail = getElement("session-detail").innerHTML;

    expect(detail).toContain("session-detail-preview compact");
    expect(detail).toContain("展开摘要");
    expect(detail).toContain("session-highlights-list compact");
    expect(detail).toContain("完整对话过程 · 1 条");
    expect(detail).toContain('aria-expanded="false"');
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

  it("loads actions without running LLM extraction by default", async () => {
    const { sandbox } = loadViewerSandbox();
    const urls: string[] = [];
    const posts: Array<{ url: string; body: unknown }> = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("todo-extract/generate")) {
        posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => ({ success: true, directCreated: 1, reviewCreated: 0 }) };
      }
      if (url.includes("frontier")) {
        return { ok: true, json: async () => ({ frontier: [] }) };
      }
      if (url.includes("actions")) {
        return { ok: true, json: async () => ({ actions: [], todoExtract: { status: "running", startedAt: "2026-06-25T02:00:00.000Z" } }) };
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
      extractStatus: "",
      extractMessage: "",
      extractInFlight: false,
    };
    await sandbox.loadActions();
    await flushPromises(8);

    expect(urls.some((url) => url.includes("actions"))).toBe(true);
    expect(urls.some((url) => url.includes("inbox?status=awaiting"))).toBe(true);
    expect(urls.some((url) => url.includes("inbox?status=answered"))).toBe(true);
    expect(urls.some((url) => url.includes("inbox?status=dismissed"))).toBe(true);
    expect(urls.some((url) => url.includes("review?status=pending&kind=action"))).toBe(false);
    expect(urls.some((url) => url.includes("todo-extract/generate"))).toBe(false);
    expect(urls.some((url) => url.includes("review/actions/generate"))).toBe(false);
    expect(posts).toHaveLength(0);
    expect(sandbox.state.actions.extractInFlight).toBe(true);
    expect(sandbox.state.actions.extractMessage).toBe("Latest todos are shown; still organizing...");
  });

  it("polls persisted todo extraction state after a reload", async () => {
    const { sandbox, runTimers } = loadViewerSandbox();
    let actionCalls = 0;
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) {
        actionCalls++;
        return {
          ok: true,
          json: async () => actionCalls === 1
            ? { actions: [], todoExtract: { status: "running", startedAt: "2026-06-25T02:00:00.000Z" } }
            : {
                actions: [{ id: "act-1", title: "整理单卡刷新状态", status: "pending", updatedAt: "2026-06-25T02:02:00.000Z" }],
                todoExtract: {
                  status: "done",
                  summary: { success: true, engine: "langextract", directCreated: 1, reviewCreated: 0, hiddenHistory: 0, discarded: 0 },
                },
              },
        };
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
      extractStatus: "",
      extractMessage: "",
      extractInFlight: false,
    };
    await sandbox.loadActions();
    await flushPromises(8);

    expect(sandbox.state.actions.extractInFlight).toBe(true);
    expect(runTimers()).toBeGreaterThan(0);
    await waitFor(() => sandbox.state.actions.items[0]?.title === "整理单卡刷新状态");

    expect(sandbox.state.actions.extractInFlight).toBe(false);
    expect(sandbox.state.actions.extractStatus).toBe("done");
    expect(sandbox.state.actions.items[0].title).toBe("整理单卡刷新状态");
  });

  it("runs LLM extraction only when explicitly requested", async () => {
    const { sandbox } = loadViewerSandbox();
    const posts: Array<{ url: string; body: unknown }> = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("todo-extract/generate")) {
        posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => ({ success: true, directCreated: 1, reviewCreated: 0 }) };
      }
      if (url.includes("review?status=pending")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: [] }) };
      return { ok: true, json: async () => ({}) };
    };

    sandbox.state.activeTab = "actions";
    await sandbox.loadActions();
    await flushPromises(8);
    expect(posts).toHaveLength(0);

    await sandbox.loadActions({ generate: true, force: true });
    await flushPromises(16);
    expect(posts).toHaveLength(1);
    // STEP-11: the viewer no longer hard-codes maxSessions/maxObservationsPerSession;
    // scope now comes from saved settings the backend reads from env config.
    expect(posts[0].body).toMatchObject({ force: true });
    expect(posts[0].body).not.toHaveProperty("maxSessions");
    expect(posts[0].body).not.toHaveProperty("maxObservationsPerSession");
  });

  it("does not start duplicate todo extraction while one is in flight", async () => {
    const { sandbox } = loadViewerSandbox();
    const posts: string[] = [];
    sandbox.fetch = async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.includes("todo-extract/generate")) {
        posts.push(url);
        return new Promise(() => undefined);
      }
      if (url.includes("review?status=pending")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: [] }) };
      return { ok: true, json: async () => ({}) };
    };

    await sandbox.loadActions({ generate: true });
    await flushPromises(2);
    sandbox.startTodoExtraction(false);
    sandbox.startTodoExtraction(false);

    expect(posts).toHaveLength(1);
  });

  it("does not show Updated when full card update scans no cards", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const posts: Array<{ url: string; body: unknown }> = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("todo/update")) {
        posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => ({ engine: "llm", scanned: 0, kept: 0, dropped: 0, completed: 0, rewritten: 0, merged: 0, preview: [], decisions: [] }) };
      }
      if (url.includes("review?status=pending")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: [] }) };
      return { ok: true, json: async () => ({}) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = { loaded: true, items: [], frontier: [], statusFilter: "", search: "", reviewItems: [] };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => name === "data-action" ? "update-cards" : null;
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);
    await waitFor(() => sandbox.state.actions.cleanupMessage === "No cards need updating");

    expect(posts).toHaveLength(1);
    expect(sandbox.state.actions.cleanupStatus).toBe("idle");
    expect(getElement("view-actions").innerHTML).toContain("Update");
    expect(getElement("view-actions").innerHTML).not.toContain(">Updated</button>");
  });

  it("marks actions stale instead of reloading them on websocket updates", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    let loadCalls = 0;
    sandbox.loadActions = () => {
      loadCalls++;
    };
    sandbox.state.activeTab = "actions";
    sandbox.window.pageYOffset = 200;
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "Keep scroll", status: "pending", updatedAt: daysAgo(1) }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      extractStatus: "",
      extractMessage: "",
      extractInFlight: false,
      stale: false,
    };
    sandbox.routeWsMessage({ observation: { id: "obs-1", sessionId: "s1", timestamp: "2026-06-17T10:00:00Z" } });

    expect(loadCalls).toBe(0);
    expect(sandbox.state.actions.stale).toBe(true);
    expect(getElement("view-actions").innerHTML).not.toContain("有新记录");
  });

  it("shows stale actions only on the refresh button when the list can rerender", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.window.pageYOffset = 0;
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "Keep scroll", status: "pending", updatedAt: daysAgo(1) }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      extractStatus: "",
      extractMessage: "",
      extractInFlight: false,
      stale: false,
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    sandbox.routeWsMessage({ observation: { id: "obs-1", sessionId: "s1", timestamp: "2026-06-17T10:00:00Z" } });

    expect(sandbox.state.actions.stale).toBe(true);
    expect(getElement("view-actions").innerHTML).not.toContain("有新记录");
    expect(getElement("view-actions").innerHTML).toContain("Refresh");
  });

  it("uses the explicit LLM extract button instead of refresh for generation", () => {
    const { sandbox, dispatchDocumentClick } = loadViewerSandbox();
    let started = 0;
    let loaded = 0;
    sandbox.startTodoExtraction = (force: boolean) => {
      if (force) started++;
    };
    sandbox.loadActions = () => {
      loaded++;
    };

    const extract = Object.create(sandbox.Element.prototype);
    extract.getAttribute = (name: string) => name === "data-action" ? "extract-actions" : null;
    extract.closest = (selector: string) => selector === "[data-action]" ? extract : null;
    dispatchDocumentClick(extract);

    const refresh = Object.create(sandbox.Element.prototype);
    refresh.getAttribute = (name: string) => name === "data-action" ? "refresh-actions" : null;
    refresh.closest = (selector: string) => selector === "[data-action]" ? refresh : null;
    dispatchDocumentClick(refresh);

    expect(started).toBe(1);
    expect(loaded).toBe(1);
  });

  it("renders action status controls and posts status updates", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const posts: Array<{ url: string; body: any }> = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("actions/update")) {
        posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => ({ success: true, action: { id: "act-1", status: "done" } }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "Finish me", status: "pending", tags: [], sourceObservationIds: ["obs_1"], updatedAt: daysAgo(1) }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).toContain("Complete");
    expect(getElement("view-actions").innerHTML).toContain("Archive");
    expect(getElement("view-actions").innerHTML).toContain("btn-primary-sm");
    expect(getElement("view-actions").innerHTML).toContain("action-source-link");
    expect(getElement("view-actions").innerHTML).toContain("action-refresh-link");
    expect(getElement("view-actions").innerHTML).toContain("action-archive-link");
    expect(getElement("view-actions").innerHTML).toMatch(/action-source-link[\s\S]*action-refresh-link[\s\S]*action-archive-link[\s\S]*btn-primary-sm/);
    // STEP-13: the duplicate "Delete" button (also status=cancelled) was removed.
    expect(getElement("view-actions").innerHTML).not.toContain("Delete");

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => {
      if (name === "data-action") return "action-status";
      if (name === "data-action-id") return "act-1";
      if (name === "data-status") return "done";
      return null;
    };
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);
    await waitFor(() => sandbox.state.actions.items[0].status === "done");

    expect(posts[0].body).toMatchObject({ actionId: "act-1", status: "done" });
    expect(sandbox.state.actions.items[0].status).toBe("done");
  });

  it("refreshes one action card and replaces only that card", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const posts: Array<{ url: string; body: any }> = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("todo/action-refresh")) {
        posts.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return {
          ok: true,
          json: async () => ({
            success: true,
            keptOld: false,
            reason: "replaced",
            action: {
              id: "act-1",
              title: "Fresh single-card title",
              description: "A cleaner executable card.",
              status: "pending",
              tags: [],
              sourceObservationIds: ["obs_2"],
              updatedAt: daysAgo(0),
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        { id: "act-1", title: "Old card title", status: "pending", tags: [], sourceObservationIds: ["obs_1"], updatedAt: daysAgo(1) },
        { id: "act-2", title: "Other card", status: "pending", tags: [], sourceObservationIds: ["obs_3"], updatedAt: daysAgo(1) },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => {
      if (name === "data-action") return "refresh-action-card";
      if (name === "data-action-id") return "act-1";
      return null;
    };
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);

    expect(sandbox.state.actions.cardRefreshInFlight["act-1"]).toBe(true);
    expect(getElement("view-actions").innerHTML).toContain("Updating...");
    await waitFor(() => sandbox.state.actions.items[0].title === "Fresh single-card title");

    expect(posts[0].body).toEqual({ actionId: "act-1" });
    expect(sandbox.state.actions.items[0].description).toBe("A cleaner executable card.");
    expect(sandbox.state.actions.items[1].title).toBe("Other card");
    expect(sandbox.state.actions.cardRefreshInFlight["act-1"]).toBeFalsy();
    expect(sandbox.state.actions.cardRefreshNotice).toBe("Updated from source");
  });

  it("keeps the old card when card refresh returns a non-replacing result", async () => {
    const { sandbox, dispatchDocumentClick } = loadViewerSandbox();
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("todo/action-refresh")) {
        return { ok: true, json: async () => ({ success: true, keptOld: true, reason: "low-quality" }) };
      }
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: sandbox.state.actions.items }) };
      return { ok: true, json: async () => ({}) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "Old card title", status: "pending", tags: [], sourceObservationIds: ["obs_1"], updatedAt: daysAgo(1) }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => {
      if (name === "data-action") return "refresh-action-card";
      if (name === "data-action-id") return "act-1";
      return null;
    };
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);
    await waitFor(() => !sandbox.state.actions.cardRefreshInFlight["act-1"]);

    expect(sandbox.state.actions.items[0].title).toBe("Old card title");
    expect(sandbox.state.actions.reviewItems).toEqual([]);
    expect(sandbox.state.actions.cardRefreshNotice).toBe("Candidate was too vague");
  });

  it("shows a specific card refresh reason when the old card is kept", async () => {
    const { sandbox, dispatchDocumentClick } = loadViewerSandbox();
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("todo/action-refresh")) {
        return { ok: true, json: async () => ({ success: true, keptOld: true, reason: "incomplete-title" }) };
      }
      if (url.includes("review?status=pending")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: sandbox.state.actions.items }) };
      return { ok: true, json: async () => ({}) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "准备推送分支 codex/todo-cleanup-flash-model 到", status: "pending", tags: [], sourceObservationIds: ["obs_1"], updatedAt: daysAgo(1) }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => {
      if (name === "data-action") return "refresh-action-card";
      if (name === "data-action-id") return "act-1";
      return null;
    };
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);
    await waitFor(() => sandbox.state.actions.cardRefreshNotice.length > 0);

    expect(sandbox.state.actions.items[0].title).toBe("准备推送分支 codex/todo-cleanup-flash-model 到");
    expect(sandbox.state.actions.cardRefreshNotice).toBe("Title is incomplete");
  });

  it("renders and saves todo extractor config from the global settings panel", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const posts: any[] = [];
    const extractPosts: any[] = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("config/todo-extractor") && init?.body) {
        posts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ success: true, envPath: "/tmp/.env", config: { LANGEXTRACT_MODEL: "deepseek/deepseek-v4-flash", LANGEXTRACT_API_KEY_CONFIGURED: true } }) };
      }
      if (url.includes("todo-extract/generate") && init?.body) {
        extractPosts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ success: true, engine: "langextract", directCreated: 0, reviewCreated: 0, hiddenHistory: 0, discarded: 0 }) };
      }
      if (url.includes("actions")) return { ok: true, json: async () => ({ actions: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("inbox")) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: true, json: async () => ({ success: true, envPath: "/tmp/.env", config: { LANGEXTRACT_MODEL: "deepseek/deepseek-v4-flash", LANGEXTRACT_API_KEY_CONFIGURED: false } }) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      config: { envPath: "/tmp/.env", config: { LANGEXTRACT_MODEL: "deepseek/deepseek-v4-flash", LANGEXTRACT_API_KEY_CONFIGURED: false } },
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).not.toContain("LLM extraction config");
    expect(getElement("view-actions").innerHTML).not.toContain("LANGEXTRACT_API_KEY=secret");
    sandbox.state.settings.open = true;
    sandbox.renderSettingsPanel();
    expect(getElement("settings-panel").innerHTML).toContain("LLM extraction config");
    expect(getElement("settings-panel").innerHTML).not.toContain("pa/gpt-5.5");

    getElement("todo-config-LANGEXTRACT_MODEL").value = "deepseek/deepseek-v4-flash";
    getElement("todo-config-AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS").value = "120000";
    getElement("todo-config-LANGEXTRACT_API_KEY").value = "secret";
    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => name === "data-action" ? "save-todo-config" : null;
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);
    await waitFor(() => sandbox.state.actions.extractMessage === "Config saved. The next organize run will use it now.");

    expect(posts[0]).toMatchObject({ LANGEXTRACT_MODEL: "deepseek/deepseek-v4-flash", AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS: "120000", LANGEXTRACT_API_KEY: "secret" });
    expect(sandbox.state.actions.extractMessage).toBe("Config saved. The next organize run will use it now.");
    expect(sandbox.state.actions.forceNextExtract).toBe(true);

    sandbox.startTodoExtraction(false);
    await waitFor(() => extractPosts.length === 1);
    expect(extractPosts[0]).toMatchObject({ force: true });
    expect(sandbox.state.actions.forceNextExtract).toBe(false);
  });

  it("keeps unsaved todo extractor config while the settings panel rerenders", () => {
    const { sandbox, getElement, dispatchDocumentEvent } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      config: { envPath: "/tmp/.env", config: { LANGEXTRACT_BASE_URL: "https://api.novita.ai/openai/v1", LANGEXTRACT_API_KEY_CONFIGURED: false } },
      configDraft: {},
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.state.settings.open = true;
    sandbox.renderSettingsPanel();

    getElement("todo-config-LANGEXTRACT_BASE_URL").value = "https://api.example.test/openai/v1";
    dispatchDocumentEvent("input", { target: getElement("todo-config-LANGEXTRACT_BASE_URL") });
    getElement("todo-config-LANGEXTRACT_API_KEY").value = "secret";
    dispatchDocumentEvent("input", { target: getElement("todo-config-LANGEXTRACT_API_KEY") });

    sandbox.renderSettingsPanel();

    expect(sandbox.state.actions.configDraft.LANGEXTRACT_BASE_URL).toBe("https://api.example.test/openai/v1");
    expect(sandbox.state.actions.configDraft.LANGEXTRACT_API_KEY).toBe("secret");
    expect(getElement("settings-panel").innerHTML).toContain("https://api.example.test/openai/v1");
  });

  it("shows masked API key in settings and running state on the extract button", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      extractInFlight: true,
      extractMessage: "Organizing recent sessions...",
      config: { envPath: "/tmp/.env", config: { LANGEXTRACT_API_KEY_CONFIGURED: true, LANGEXTRACT_API_KEY_MASKED: "sk_****7890" } },
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    sandbox.state.settings.open = true;
    sandbox.renderSettingsPanel();
    const html = getElement("view-actions").innerHTML;
    const settingsHtml = getElement("settings-panel").innerHTML;
    expect(html).toContain("Organizing...");
    expect(html).toContain('title="Organizing recent sessions..."');
    expect(settingsHtml).toContain("API key: sk_****7890");
  });

  it("makes rules fallback visible on the extract button", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      extractStatus: "done",
      extractFallback: true,
      extractMessage: "Rules extraction complete · reason: missing key",
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();

    const html = getElement("view-actions").innerHTML;
    expect(html).toContain("LLM unavailable");
    expect(html).toContain("missing key");
  });

  it("filters actions from Todo and Done metric cards", () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        { id: "act-1", title: "Doing", status: "active", tags: [] },
        { id: "act-2", title: "Closed", status: "done", tags: [] },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).toContain('data-status="todo"');
    expect(getElement("view-actions").innerHTML).toContain('data-status="done"');
    expect(getElement("view-actions").innerHTML).not.toContain('data-status="active"');
    expect(getElement("view-actions").innerHTML).not.toContain('data-status="attention"');

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => {
      if (name === "data-action") return "filter-actions-status";
      if (name === "data-status") return "todo";
      return null;
    };
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);

    expect(sandbox.state.actions.statusFilter).toBe("todo");
  });

  it("soft-refreshes actions while todo extraction is still running", async () => {
    const { sandbox, runTimers } = loadViewerSandbox();
    let actionCalls = 0;
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("todo-extract/generate")) return new Promise(() => undefined);
      if (url.includes("review?status=pending")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) {
        actionCalls++;
        return {
          ok: true,
          json: async () => actionCalls === 1
            ? { actions: [] }
            : { actions: [{ id: "act-1", title: "整理首版功能文档", status: "pending", updatedAt: "2026-06-17T12:00:00Z" }], todoExtract: { status: "running" } },
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    sandbox.state.activeTab = "actions";
    await sandbox.loadActions({ generate: true });
    await flushPromises(4);
    expect(runTimers()).toBeGreaterThan(0);
    await waitFor(() => !!sandbox.state.actions.items[0]);

    expect(sandbox.state.actions.extractInFlight).toBe(true);
    expect(sandbox.state.actions.extractMessage).toBe("Latest todos are shown; still organizing...");
    expect(sandbox.state.actions.items[0].title).toBe("整理首版功能文档");
  });

  it("folds legacy generated cards out of the default todo list", () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_chain",
          title: "修复整理按钮状态",
          description: "后台整理中，刷新后仍需显示状态。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "后台整理中，刷新后仍需显示状态。" } },
        },
        {
          id: "act_legacy",
          title: "旧链路卡片",
          description: "来自旧抽取链路。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          updatedAt: daysAgo(1),
          metadata: { todoExtraction: { sourceCheckpoint: `${daysAgo(1)}:1` } },
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    let html = getElement("view-actions").innerHTML;
    expect(html).toContain("修复整理按钮状态");
    expect(html).toContain("Legacy extraction backlog");
    expect(html).not.toContain("旧链路卡片");

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => name === "data-action" ? "toggle-legacy-backlog" : null;
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);

    html = getElement("view-actions").innerHTML;
    expect(html).toContain("旧链路卡片");
  });

  it("folds completed or system-context task chains out of the default todo list", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_done_chain",
          title: "创建 Day 1 专项复习文件",
          description: "创建 Day 1 专项复习文件。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:to_start"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "completed", completionSummary: "已完成 Day 1 专项复习资料。" } },
        },
        {
          id: "act_system_chain",
          title: "在 staging 前检查完整状态",
          description: "staging 前查看完整状态。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "<collaboration_mode># Plan Mode" } },
        },
        {
          id: "act_restarted_chain",
          title: "重启服务验证页面状态",
          description: "确认服务是否可访问。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:to_start"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "服务已重启，http://localhost:3114/agentmemory/livez 正常。" } },
        },
        {
          id: "act_copied_docx_chain",
          title: "处理 DOCX 正文替换",
          description: "需要继续读取当前 DOCX 的真实段落结构。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:to_start"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "已完成，原文件未覆盖，已新建副本并只改正文文本内容。" } },
        },
        {
          id: "act_real_followup",
          title: "继续分析 DOCX 段落结构",
          description: "需要继续读取当前 DOCX 的真实段落结构。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "需要继续读取当前 DOCX 的真实段落结构。" } },
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;
    expect(html).toContain("Legacy extraction backlog");
    expect(html).toContain("继续分析 DOCX 段落结构");
    expect(html).not.toContain("创建 Day 1 专项复习文件");
    expect(html).not.toContain("在 staging 前检查完整状态");
    expect(html).not.toContain("重启服务验证页面状态");
    expect(html).not.toContain("处理 DOCX 正文替换");
  });

  it("keeps the Todo filter focused on actionable cards", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_open",
          title: "修复整理按钮状态",
          description: "后台整理中，刷新后仍需显示状态。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "后台整理中，刷新后仍需显示状态。" } },
        },
        {
          id: "act_pushed",
          title: "检查 PR 的 CI 结果",
          description: "观察 PR 的新 CI 状态。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          updatedAt: daysAgo(1),
          metadata: { todoChain: { completionState: "in_progress", completionSummary: "已提交并推送 PR：#126 feat(todo): harden extraction job flow。" } },
        },
      ],
      frontier: [],
      statusFilter: "todo",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("修复整理按钮状态");
    expect(html).toContain("Legacy extraction backlog");
    expect(html).not.toContain("检查 PR 的 CI 结果");
  });

  it("renders only Todo and Done metrics and never shows awaiting as a todo class", () => {
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
    expect(html).toContain("Todo");
    expect(html).toContain("Done");
    expect(html).toContain("data-status=\"todo\"");
    expect(html).toContain("data-status=\"done\"");
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("In progress");
    expect(html).not.toContain("Follow up");
    expect(html).not.toContain("Reply");
    expect(html).not.toContain("Confirm");
    expect(html).not.toContain("to confirm");
    expect(html).not.toContain("attention-chip-row");
    expect(html).toContain("No todos yet");
    expect(html).not.toContain("awaiting-reply-section");
    expect(html).not.toContain("No awaiting replies");
    // STEP-C2 已接通后端,不再出现「尚未接通」「即将上线」
    expect(html).not.toContain("尚未接通");
    expect(html).not.toContain("即将上线");
    sandbox.state.inbox = {
      loaded: true,
      items: [{ id: "q1", kind: "question", body: "需要拍板", status: "awaiting", createdAt: "2026-06-15T10:00:00Z" }],
    };
    sandbox.renderActions();
    const withQuestion = getElement("view-actions").innerHTML;
    expect(withQuestion).not.toContain("awaiting-reply-section");
    expect(withQuestion).not.toContain("需要拍板");
  });

  it("keeps the default action view focused on recent open todos", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        { id: "act_recent", title: "Current build check", status: "pending", priority: "normal", tags: [], updatedAt: daysAgo(1) },
        { id: "act_earlier", title: "Earlier follow up", status: "pending", priority: "normal", tags: [], updatedAt: daysAgo(5) },
        { id: "act_old", title: "Old migration reminder", status: "active", priority: "normal", tags: [], updatedAt: daysAgo(12) },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [{ id: "review-1", status: "pending", kind: "action", title: "Confirm launch", content: "Confirm this todo." }],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).not.toContain("action-focus-guide");
    expect(html).not.toContain("Focus:");
    expect(html).not.toContain("Confirm launch");
    expect(html).toContain("Current build check");
    expect(html).toContain("Earlier open items");
    expect(html).toContain("Older backlog");
    expect(html).not.toContain("Earlier follow up");
    expect(html).not.toContain("Old migration reminder");
  });

  it("renders the Todo toolbar as search, Todo, Done, organize, update, refresh", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        { id: "act-1", title: "Open item", status: "pending", tags: [] },
        { id: "act-2", title: "Done item", status: "done", tags: [] },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [{ id: "review-1", status: "pending", kind: "action", title: "Confirm me", content: "Confirm this todo." }],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;
    const searchIndex = html.indexOf('id="actions-search"');
    const todoIndex = html.indexOf('data-status="todo"');
    const doneIndex = html.indexOf('data-status="done"');
    const extractIndex = html.indexOf('data-action="extract-actions"');
    const updateIndex = html.indexOf('data-action="update-cards"');
    const refreshIndex = html.indexOf('data-action="refresh-actions"');

    expect([searchIndex, todoIndex, doneIndex, extractIndex, updateIndex, refreshIndex].every((i) => i >= 0)).toBe(true);
    expect(searchIndex).toBeLessThan(todoIndex);
    expect(todoIndex).toBeLessThan(doneIndex);
    expect(doneIndex).toBeLessThan(extractIndex);
    expect(extractIndex).toBeLessThan(updateIndex);
    expect(updateIndex).toBeLessThan(refreshIndex);
    expect(html).not.toContain("action-focus-guide");
    expect(html).not.toContain("59 Todo · 0 Done");
    expect(html).not.toContain("Confirm me");
    expect(html).not.toContain("action-candidate-card");
  });

  it("uses source checkpoints instead of cleanup updatedAt for default backlog folding", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_old_source",
          title: "Old source task rewritten today",
          status: "pending",
          priority: "normal",
          tags: [],
          createdAt: daysAgo(1),
          updatedAt: daysAgo(0),
          metadata: { todoExtraction: { sourceCheckpoint: `${daysAgo(12)}:1234` } },
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("Older backlog");
    expect(html).not.toContain("Old source task rewritten today");
  });

  it("shows source age on stale backlog cards instead of cleanup updatedAt", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_old_source",
          title: "Old source task rewritten today",
          status: "pending",
          priority: "normal",
          tags: [],
          createdAt: daysAgo(1),
          updatedAt: daysAgo(0),
          metadata: { todoExtraction: { sourceCheckpoint: `${daysAgo(12)}:1234` } },
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      olderBacklogExpanded: true,
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("Old source task rewritten today");
    expect(html).toContain("12d ago");
    expect(html).not.toContain("just now");
  });

  it("surfaces old open todos when search matches them", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        { id: "act_recent", title: "Current build check", status: "pending", priority: "normal", tags: [], updatedAt: daysAgo(1) },
        { id: "act_old", title: "Old migration reminder", status: "active", priority: "normal", tags: [], updatedAt: daysAgo(12) },
      ],
      frontier: [],
      statusFilter: "",
      search: "migration",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("Old migration reminder");
    expect(html).not.toContain("Older backlog");
  });

  it("calm action card shows title without classification tags (STEP-16)", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_todo_1",
          title: "整理验收截图",
          description: "打开待办页后确认自动抽取生成的卡片。",
          status: "pending",
          priority: "normal",
          tags: ["todo-extracted", "time:current", "type:to_start"],
          sourceObservationIds: ["obs_1"],
          updatedAt: daysAgo(1),
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("整理验收截图");
    // STEP-16 calm card: classification tags (time:/type:) are no longer rendered
    // on the card — only title + description + a muted source/time meta line.
    expect(html).not.toContain("time:current");
    expect(html).not.toContain("type:to_start");
  });

  it("shows task-chain completion as the card second line", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_chain_1",
          title: "上传之前的修改到远程仓库",
          description: "旧描述不应优先展示。",
          status: "pending",
          priority: "normal",
          tags: ["todo-extracted", "time:current", "type:follow_up"],
          sourceObservationIds: ["obs_1"],
          updatedAt: daysAgo(1),
          metadata: {
            todoChain: {
              completionState: "in_progress",
              completionSummary: "已推送分支，下一步创建 PR。",
              nextStep: "创建 PR",
            },
          },
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("上传之前的修改到远程仓库");
    expect(html).toContain("→ 已推送分支，下一步创建 PR。");
    expect(html).not.toContain("旧描述不应优先展示");
  });

  it("hides legacy generated cards from the default todo view", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_bad",
          title: "json nameWithOwner",
          description: "gh pr list --json number,title --limit 20",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:to_start"],
        },
        {
          id: "act_good",
          title: "整理验收截图",
          description: "打开待办页后确认自动抽取生成的卡片。",
          status: "pending",
          priority: "normal",
          createdBy: "todo-extract",
          tags: ["todo-extracted", "time:current", "type:to_start"],
          metadata: { todoExtraction: { sourceCheckpoint: `${daysAgo(1)}:1` } },
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [
        {
          id: "review_bad",
          status: "pending",
          kind: "action",
          title: "limit 20",
          content: "{\"cmd\":\"gh pr list --json number\"}",
          source: "viewer",
          payload: { actionCandidate: { reason: "todo" }, tags: ["todo-extracted"] },
        },
      ],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("Legacy extraction backlog");
    expect(html).not.toContain("整理验收截图");
    expect(html).not.toContain("json nameWithOwner");
    expect(html).not.toContain("limit 20");
  });

  it("ignores review candidates in the Todo view", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        {
          id: "act_todo_1",
          title: "整理验收截图",
          description: "打开待办页后确认自动抽取生成的卡片。",
          status: "pending",
          priority: "normal",
          tags: ["todo-extracted", "time:current", "type:to_start"],
          sourceObservationIds: ["obs_1"],
          updatedAt: daysAgo(1),
        },
      ],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [
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
          id: "review_memory",
          status: "pending",
          kind: "memory",
          title: "记忆总结卡片",
          content: "这是一张记忆总结，不应出现在待办确认区。",
          source: "viewer",
          payload: { tags: ["browser"] },
        },
      ],
    };
    sandbox.state.inbox = { loaded: true, items: [] };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).toContain("整理验收截图");
    expect(html).not.toContain("修复待办候选展示");
    expect(html).not.toContain("action-candidate-card");
    expect(html).not.toContain("Confirm");
    expect(html).not.toContain("Ignore");
    expect(html).not.toContain("记忆总结卡片");
    expect(html).not.toContain("No todos yet");
  });

  it("does not render action reviews as Todo decision cards", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "todo",
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
        {
          id: "review_memory",
          status: "pending",
          kind: "memory",
          title: "记忆总结卡片",
          content: "这是一张记忆总结，不应出现在待办确认区。",
          source: "viewer",
          payload: { tags: ["browser"] },
        },
      ],
    };

    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;

    expect(html).not.toContain("修复待办候选展示");
    expect(html).not.toContain("action-candidate-card");
    expect(html).not.toContain("记忆总结卡片");
    expect(html).toContain("Todo");
    expect(html).not.toContain("To confirm");
    expect(html).not.toContain("Needs confirmation");
    expect(html).not.toContain("to confirm");
    expect(html).not.toContain("Confirm");
    expect(html).not.toContain("Ignore");
    expect(html).not.toContain("View original");
    expect(html).not.toContain("待办生成链路与前端展示修复计划");
    expect(html).not.toContain("## Summary");
    expect(html).not.toContain("src/functions/action-candidates.ts");
    expect(html).not.toContain(">action-candidate<");
  });

  it("folds former attention and active work into Todo without subfilters", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [
        { id: "act-1", title: "Call project owner", status: "pending", tags: [] },
        { id: "act-2", title: "Keep building", status: "active", tags: [] },
      ],
      frontier: [],
      statusFilter: "todo",
      search: "",
      reviewItems: [{ id: "review-1", status: "pending", kind: "action", title: "Confirm me", content: "Confirm this todo." }],
    };
    sandbox.state.inbox = { loaded: true, items: [{ id: "q1", kind: "question", body: "Need an answer?", status: "awaiting" }] };

    sandbox.renderActions();
    let html = getElement("view-actions").innerHTML;
    expect(html).toContain('<div class="action-overview-label">Todo</div><div class="action-overview-value">2</div>');
    expect(html).toContain('data-status="todo"');
    expect(html).not.toContain("attention-chip-row");
    expect(html).not.toContain("Need an answer?");
    expect(html).not.toContain("Confirm me");
    expect(html).toContain("Call project owner");
    expect(html).toContain("Keep building");
    expect(html).not.toContain("Needs your reply");
    expect(html).not.toContain("Needs confirmation");
    expect(html).not.toContain("Needs follow-up");
    expect(html).not.toContain("In progress");
    expect(html).not.toContain("Follow up");

    sandbox.state.actions.statusFilter = "review";
    sandbox.renderActions();
    html = getElement("view-actions").innerHTML;
    expect(html).not.toContain("action-candidate-card");
    expect(html).toContain("Call project owner");
    expect(html).toContain("Keep building");

    sandbox.state.actions.statusFilter = "pending";
    sandbox.renderActions();
    html = getElement("view-actions").innerHTML;
    expect(html).toContain("Call project owner");
    expect(html).not.toContain("Confirm me");
  });

  it("does not load memory or lesson review candidates in the frontend", async () => {
    const { sandbox, getElement } = loadViewerSandbox();
    const urls: string[] = [];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("memories?latest=true")) {
        return { ok: true, json: async () => ({ memories: [] }) };
      }
      if (url.includes("review?status=pending")) {
        return { ok: true, json: async () => ({ items: [{ id: "mem-review", kind: "memory", title: "Memory candidate" }] }) };
      }
      return { ok: true, json: async () => ({}) };
    };

    await sandbox.loadMemories();

    expect(urls.some((url) => url.includes("review?status=pending"))).toBe(false);
    expect(sandbox.state.memories.reviewItems).toEqual([]);
    expect(getElement("view-memories").innerHTML).not.toContain("Memory candidate");
  });
});
