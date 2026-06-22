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
    expect(html).toContain("Awaiting reply");
    expect(html).toContain("To confirm");
    expect(html).toContain("To follow up");
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
      if (url.includes("review?status=pending&kind=action")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("inbox?status=awaiting")) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: true, json: async () => ({}) };
    };

    await sandbox.loadDashboard();

    expect(urls.some((url) => url.includes("actions"))).toBe(true);
    expect(urls.some((url) => url.includes("review?status=pending&kind=action"))).toBe(true);
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
    expect(urls.some((url) => url.includes("review?status=pending&kind=action"))).toBe(true);
    expect(urls.some((url) => url.includes("todo-extract/generate"))).toBe(false);
    expect(urls.some((url) => url.includes("review/actions/generate"))).toBe(false);
    expect(posts).toHaveLength(0);
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
      items: [{ id: "act-1", title: "Keep scroll", status: "pending" }],
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
      items: [{ id: "act-1", title: "Keep scroll", status: "pending" }],
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
      items: [{ id: "act-1", title: "Finish me", status: "pending", tags: [] }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).toContain("Complete");
    expect(getElement("view-actions").innerHTML).toContain("Archive");
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

  it("renders and saves todo extractor config from the global settings panel", async () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    const posts: any[] = [];
    sandbox.fetch = async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.includes("config/todo-extractor") && init?.body) {
        posts.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({ success: true, envPath: "/tmp/.env", config: { LANGEXTRACT_MODEL: "deepseek/deepseek-v4-pro", LANGEXTRACT_API_KEY_CONFIGURED: true } }) };
      }
      return { ok: true, json: async () => ({ success: true, envPath: "/tmp/.env", config: { LANGEXTRACT_MODEL: "deepseek/deepseek-v4-pro", LANGEXTRACT_API_KEY_CONFIGURED: false } }) };
    };
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
      config: { envPath: "/tmp/.env", config: { LANGEXTRACT_MODEL: "deepseek/deepseek-v4-pro", LANGEXTRACT_API_KEY_CONFIGURED: false } },
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).not.toContain("LLM extraction config");
    expect(getElement("view-actions").innerHTML).not.toContain("LANGEXTRACT_API_KEY=secret");
    sandbox.state.settings.open = true;
    sandbox.renderSettingsPanel();
    expect(getElement("settings-panel").innerHTML).toContain("LLM extraction config");
    expect(getElement("settings-panel").innerHTML).not.toContain("pa/gpt-5.5");

    getElement("todo-config-LANGEXTRACT_MODEL").value = "deepseek/deepseek-v4-pro";
    getElement("todo-config-AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS").value = "120000";
    getElement("todo-config-LANGEXTRACT_API_KEY").value = "secret";
    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => name === "data-action" ? "save-todo-config" : null;
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);
    await waitFor(() => sandbox.state.actions.extractMessage === "Config saved. Restart the service to apply it.");

    expect(posts[0]).toMatchObject({ LANGEXTRACT_MODEL: "deepseek/deepseek-v4-pro", AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS: "120000", LANGEXTRACT_API_KEY: "secret" });
    expect(sandbox.state.actions.extractMessage).toBe("Config saved. Restart the service to apply it.");
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

  it("filters actions from metric cards", () => {
    const { sandbox, getElement, dispatchDocumentClick } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "Doing", status: "active", tags: [] }],
      frontier: [],
      statusFilter: "",
      search: "",
      reviewItems: [],
    };
    sandbox.state.inbox = { loaded: true, items: [] };
    sandbox.renderActions();
    expect(getElement("view-actions").innerHTML).toContain('data-status="active"');

    const target = Object.create(sandbox.Element.prototype);
    target.getAttribute = (name: string) => {
      if (name === "data-action") return "filter-actions-status";
      if (name === "data-status") return "active";
      return null;
    };
    target.closest = (selector: string) => selector === "[data-action]" ? target : null;
    dispatchDocumentClick(target);

    expect(sandbox.state.actions.statusFilter).toBe("active");
  });

  it("soft-refreshes actions while todo extraction is still running", async () => {
    const { sandbox, runTimers } = loadViewerSandbox();
    const actionResponses = [
      { actions: [] },
      { actions: [{ id: "act-1", title: "整理首版功能文档", status: "pending", updatedAt: "2026-06-17T12:00:00Z" }] },
    ];
    sandbox.fetch = async (input: unknown) => {
      const url = String(input);
      if (url.includes("todo-extract/generate")) return new Promise(() => undefined);
      if (url.includes("review?status=pending")) return { ok: true, json: async () => ({ items: [] }) };
      if (url.includes("frontier")) return { ok: true, json: async () => ({ frontier: [] }) };
      if (url.includes("actions")) {
        return { ok: true, json: async () => actionResponses.shift() || { actions: [] } };
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
    expect(html).toContain("Awaiting reply");
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
    const idxAwaiting = withQuestion.indexOf("awaiting-reply-section");
    const idxGroups = withQuestion.indexOf("action-group");
    expect(idxAwaiting).toBeGreaterThan(-1);
    expect(idxGroups === -1 || idxAwaiting < idxGroups).toBe(true);
  });

  it("renders todo extraction classification tags on approved action cards", () => {
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
          updatedAt: "2026-06-17T10:00:00Z",
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
    expect(html).toContain("todo-extracted");
    expect(html).toContain("time:current");
    expect(html).toContain("type:to_start");
  });

  it("hides generated command-log action cards from the todo view", () => {
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

    expect(html).toContain("整理验收截图");
    expect(html).not.toContain("json nameWithOwner");
    expect(html).not.toContain("limit 20");
  });

  it("keeps review candidates out of the default action view", () => {
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
          updatedAt: "2026-06-17T10:00:00Z",
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
    expect(html).toContain("1 to confirm");
    expect(html).not.toContain("action-candidate-card");
    expect(html).not.toContain("记忆总结卡片");
    expect(html).not.toContain("No todos yet");
  });

  it("renders action reviews as compact decision cards while keeping tool pollution hidden", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.actions = {
      loaded: true,
      items: [],
      frontier: [],
      statusFilter: "review",
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

    expect(html).toContain("修复待办候选展示");
    expect(html).toContain("action-candidate-card");
    expect(html).not.toContain("记忆总结卡片");
    expect(html).toContain("To confirm");
    expect(html).toContain("Confirm");
    expect(html).toContain("Ignore");
    expect(html).not.toContain("View original");
    expect(html).not.toContain("待办生成链路与前端展示修复计划");
    expect(html).not.toContain("## Summary");
    expect(html).not.toContain("src/functions/action-candidates.ts");
    expect(html).not.toContain(">action-candidate<");
  });

  it("keeps action metric filters exclusive", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.activeTab = "actions";
    sandbox.state.actions = {
      loaded: true,
      items: [{ id: "act-1", title: "Follow up", status: "pending", tags: [] }],
      frontier: [],
      statusFilter: "awaiting",
      search: "",
      reviewItems: [{ id: "review-1", status: "pending", kind: "action", title: "Confirm me", content: "Confirm this todo." }],
    };
    sandbox.state.inbox = { loaded: true, items: [{ id: "q1", kind: "question", body: "Need an answer?", status: "awaiting" }] };

    sandbox.renderActions();
    let html = getElement("view-actions").innerHTML;
    expect(html).toContain("Need an answer?");
    expect(html).not.toContain("Follow up");
    expect(html).not.toContain("action-candidate-card");

    sandbox.state.actions.statusFilter = "review";
    sandbox.renderActions();
    html = getElement("view-actions").innerHTML;
    expect(html).toContain("action-candidate-card");
    expect(html).toContain('<div class="action-overview-label">To follow up</div><div class="action-overview-value">1</div>');
    expect(html).toContain('<div class="action-overview-label">To confirm</div><div class="action-overview-value">1</div>');
    expect(html).not.toContain("Need an answer?");
    expect(html).not.toContain("Follow up");

    sandbox.state.actions.statusFilter = "pending";
    sandbox.renderActions();
    html = getElement("view-actions").innerHTML;
    expect(html).toContain("Follow up");
    expect(html).not.toContain("Need an answer?");
    expect(html).not.toContain("action-candidate-card");
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
