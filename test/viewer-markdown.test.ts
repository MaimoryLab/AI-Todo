import * as vm from "node:vm";
import { describe, expect, it } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

// STEP-04: 手写安全子集 Markdown 渲染器。头号风险是 XSS——
// renderMarkdownSafe 必须「先 esc() 全文转义、再受控加白名单标签」。
// 这些用例锁定:① 恶意输入渲染后无可执行标签 ② 合法 MD 正确成标签
// ③ 危险协议链接被拒。

function loadRenderer() {
  const rendered = renderViewerDocument();
  if (!rendered.found) throw new Error("viewer document not found");
  const scriptMatch = rendered.html.match(
    /<script nonce="[^"]+">([\s\S]*?)<\/script>/,
  );
  if (!scriptMatch) throw new Error("viewer script not found");

  // renderMarkdownSafe 只依赖 document.createElement(...).textContent→innerHTML
  // (esc 的实现),用一个最小 DOM 桩即可在 vm 沙箱里跑通整段脚本。
  const makeEl = () => {
    let text = "";
    return {
      set textContent(v: unknown) {
        text = String(v ?? "");
      },
      get innerHTML() {
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      },
      style: {},
      dataset: {},
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute() {},
      getAttribute: () => null,
      removeAttribute() {},
      addEventListener() {},
      appendChild() {},
      querySelectorAll: () => [],
    };
  };
  const sandbox: Record<string, any> = {
    console: { log() {}, warn() {}, error() {} },
    document: {
      documentElement: { dataset: {} },
      body: makeEl(),
      createElement: () => makeEl(),
      getElementById: () => makeEl(),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: {
      location: { search: "", port: "3113", protocol: "http:", hostname: "localhost", host: "localhost:3113", origin: "http://localhost:3113" },
      matchMedia: () => ({ matches: false }),
      addEventListener() {},
    },
    history: { replaceState() {}, pushState() {} },
    location: { hash: "", pathname: "/", search: "" },
    localStorage: { getItem: () => null, setItem() {} },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    WebSocket: function () {},
    navigator: { userAgent: "vitest" },
    Element: function () {},
    alert() {},
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
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
  return sandbox.renderMarkdownSafe as (t: string) => string;
}

describe("renderMarkdownSafe — XSS gate (STEP-04)", () => {
  it("escapes a raw <script> payload so no executable tag survives", () => {
    const render = loadRenderer();
    const out = render('<script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
  });

  it("neutralizes an inline event-handler / img onerror payload", () => {
    const render = loadRenderer();
    const out = render('<img src=x onerror="alert(1)">');
    // 整段被转义为纯文本展示(无活动 <img> 标签、无未转义引号),onerror 仅作为字面文字存在
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain('onerror="alert');
    expect(out).toContain("onerror=&quot;alert(1)&quot;");
  });

  it("does not emit a javascript: link even in [text](...) form", () => {
    const render = loadRenderer();
    const out = render("[click](javascript:alert(1))");
    // 非 http(s) → 不放行为 <a>;原文被转义保留,无可执行链接
    expect(out).not.toContain('href="javascript:');
    expect(out).not.toContain("<a ");
  });

  it("escapes HTML inside fenced code blocks instead of executing it", () => {
    const render = loadRenderer();
    const out = render("```\n<script>x</script>\n```");
    expect(out).toContain("<pre");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>x");
  });
});

describe("renderMarkdownSafe — correct rendering (STEP-04)", () => {
  it("renders headings as bounded <h3>-<h5> (not h1/h2)", () => {
    const render = loadRenderer();
    expect(render("# Title")).toContain("<h3");
    expect(render("### Deep")).toContain("<h5");
  });

  it("renders fenced code blocks and inline code", () => {
    const render = loadRenderer();
    expect(render("```\nconst a = 1;\n```")).toContain("<pre");
    expect(render("use `npm test` now")).toContain('<code class="md-code">npm test</code>');
  });

  it("renders unordered lists", () => {
    const render = loadRenderer();
    const out = render("- one\n- two");
    expect(out).toContain("<ul");
    expect((out.match(/<li>/g) || []).length).toBe(2);
  });

  it("renders bold, italic, and safe http links", () => {
    const render = loadRenderer();
    expect(render("**bold**")).toContain("<strong>bold</strong>");
    expect(render("a *word* b")).toContain("<em>word</em>");
    const link = render("[docs](https://example.com/x)");
    expect(link).toContain('href="https://example.com/x"');
    expect(link).toContain('rel="noopener noreferrer"');
  });

  it("returns empty string for blank input", () => {
    const render = loadRenderer();
    expect(render("")).toBe("");
    expect(render("   ")).toBe("");
  });
});