import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

// STEP-C4「已完成」折叠区:只读 action.status==='done' 且当天 updatedAt 的项,
// 默认折叠,纯前端筛现有数据。锁定:① isUpdatedToday 当天判定 ② 折叠区只收当天 done
// ③ 展开/折叠由 state.actions.doneExpanded 驱动 ④ 无当天 done 不渲染 ⑤ 不动后端。

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function loadViewerSandbox() {
  const rendered = renderViewerDocument();
  if (!rendered.found) throw new Error("viewer document not found");
  const scriptMatch = rendered.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error("viewer script not found");

  const elements = new Map<string, any>();
  const createMockElement = (id = "") => ({
    id, innerHTML: "", textContent: "", value: "", checked: false,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getAttribute: () => null, setAttribute() {}, removeAttribute() {},
    addEventListener() {}, closest: () => null, querySelectorAll: () => [],
  });
  const getElement = (id: string) => {
    if (!elements.has(id)) elements.set(id, createMockElement(id));
    return elements.get(id);
  };
  const tabs = ["dashboard","graph","memories","timeline","sessions","lessons","actions","crystals","audit","activity","profile","replay"];
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
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, getAttribute: () => null, removeAttribute() {},
        appendChild() {}, querySelectorAll: () => [],
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
      matchMedia: () => ({ matches: false }), addEventListener() {},
    },
    history: { replaceState: () => {}, pushState: () => {} },
    location: { hash: "", pathname: "/", search: "" },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function WebSocket() {},
    navigator: { userAgent: "vitest" },
    Element: function Element() {},
    alert: () => {}, setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {},
    URLSearchParams, Date, Math, Promise, JSON, Array, Object, String, Number, parseInt, encodeURIComponent,
  };
  const scriptWithoutAutoStart = scriptMatch[1].replace(
    /\n\s*loadTab\('dashboard'\);\n\s*connectWs\(\);\n\s*startDashboardAutoRefresh\(\);\s*$/,
    "\n",
  );
  vm.createContext(sandbox);
  vm.runInContext(scriptWithoutAutoStart, sandbox);
  return { sandbox, getElement };
}

function isoToday(): string {
  return new Date().toISOString();
}
function isoDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe("STEP-C4 已完成折叠区", () => {
  it("isUpdatedToday 仅当天为真", () => {
    const { sandbox } = loadViewerSandbox();
    expect(sandbox.isUpdatedToday(isoToday())).toBe(true);
    expect(sandbox.isUpdatedToday(isoDaysAgo(1))).toBe(false);
    expect(sandbox.isUpdatedToday("")).toBe(false);
    expect(sandbox.isUpdatedToday("not-a-date")).toBe(false);
  });

  it("折叠区只收当天完成的 done,默认折叠不渲染卡片", () => {
    const { sandbox } = loadViewerSandbox();
    const frontier = new Set<string>();
    sandbox.state.actions.doneExpanded = false;
    const html = sandbox.renderDoneTodaySection(
      [
        { id: "d1", status: "done", title: "今天完成A", updatedAt: isoToday() },
        { id: "d2", status: "done", title: "今天完成B", updatedAt: isoToday() },
        { id: "old", status: "done", title: "昨天完成", updatedAt: isoDaysAgo(2) },
      ],
      frontier,
      (a: { title: string }) => "<article>" + a.title + "</article>",
    );
    expect(html).toContain("done-today-section");
    expect(html).toContain("Done <span class=\"done-today-sub\">2 items</span>"); // old 不计入
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("▸");
    // 折叠时不渲染卡片正文
    expect(html).not.toContain("今天完成A");
  });

  it("展开时渲染当天 done 卡片", () => {
    const { sandbox } = loadViewerSandbox();
    sandbox.state.actions.doneExpanded = true;
    const html = sandbox.renderDoneTodaySection(
      [{ id: "d1", status: "done", title: "今天完成A", updatedAt: isoToday() }],
      new Set<string>(),
      (a: { title: string }) => "<article>" + a.title + "</article>",
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("▾");
    expect(html).toContain("今天完成A");
  });

  it("无当天 done 不渲染区块", () => {
    const { sandbox } = loadViewerSandbox();
    const html = sandbox.renderDoneTodaySection(
      [{ id: "old", status: "done", title: "旧的", updatedAt: isoDaysAgo(3) }],
      new Set<string>(),
      (a: { title: string }) => "<article>" + a.title + "</article>",
    );
    expect(html).toBe("");
  });

  it("默认视图:done 进底部折叠区、不在常规分组里;done 筛选 chip 则照常全列", () => {
    const { sandbox, getElement } = loadViewerSandbox();
    sandbox.state.actions = {
      loaded: true, statusFilter: "", search: "", reviewItems: [], frontier: [],
      doneExpanded: false,
      items: [
        { id: "a1", status: "active", title: "进行中项", updatedAt: isoToday() },
        { id: "d1", status: "done", title: "今天完成项", updatedAt: isoToday() },
      ],
    };
    sandbox.state.inbox = { loaded: true, items: [], replyingId: null, pendingById: {} };
    sandbox.renderActions();
    const html = getElement("view-actions").innerHTML;
    expect(html).toContain("done-today-section");
    expect(html).toContain("Done <span class=\"done-today-sub\">1 items</span>");
    expect(html).toContain("Todo"); // active 合并进 Todo 分组
    // 默认折叠:done 卡正文不出现(在折叠区里、未展开)
    expect(html).not.toContain("今天完成项");
    // 切到 done 筛选:照常全列(走 inline 分组,不进折叠区)
    sandbox.state.actions.statusFilter = "done";
    sandbox.renderActions();
    const filtered = getElement("view-actions").innerHTML;
    expect(filtered).not.toContain("done-today-section");
    expect(filtered).toContain("今天完成项");
  });
});
