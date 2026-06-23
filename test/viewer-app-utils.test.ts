import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// First frontend unit tests (PLAN-007 STEP-03). The viewer SPA is one shared-
// scope <script> with no module exports, so we load a leaf fragment's source in
// a sandbox (new Function) and exercise its pure, non-DOM helpers directly. No
// jsdom/happy-dom dependency is introduced — DOM-bound helpers (esc /
// renderMarkdownSafe) are intentionally not covered here.
const FRAGMENT = join("src", "viewer", "parts", "app", "20-format-utils.js");

function loadFormatUtils(lang = "en") {
  const src = readFileSync(FRAGMENT, "utf-8");
  // I18N_LANG is a viewer global the formatters read; inject it as a param.
  const factory = new Function(
    "I18N_LANG",
    `${src}\nreturn { formatTime, shortTime, absoluteHour, relativeTime, truncate };`,
  );
  return factory(lang);
}

describe("viewer format-utils leaf fragment", () => {
  const u = loadFormatUtils("en");

  it("truncate() clamps and ellipsizes only when longer than n", () => {
    expect(u.truncate("hello world", 5)).toBe("hello...");
    expect(u.truncate("hi", 5)).toBe("hi");
    expect(u.truncate("", 3)).toBe("");
    expect(u.truncate(null, 3)).toBe("");
  });

  it("relativeTime() bins by diff and is timezone-independent", () => {
    const now = Date.now();
    const ago = (ms) => new Date(now - ms).toISOString();
    expect(u.relativeTime("")).toBe("");
    expect(u.relativeTime(new Date(now).toISOString())).toBe("just now");
    expect(u.relativeTime(ago(5 * 3600 * 1000))).toBe("5h ago");
    expect(u.relativeTime(ago(3 * 86400 * 1000))).toBe("3d ago");
  });

  it("relativeTime() localizes when I18N_LANG is zh", () => {
    const zh = loadFormatUtils("zh");
    const now = Date.now();
    expect(zh.relativeTime(new Date(now).toISOString())).toBe("刚刚");
    expect(zh.relativeTime(new Date(now - 5 * 3600 * 1000).toISOString())).toBe("5小时前");
  });

  it("formatTime()/shortTime() return '' for falsy input", () => {
    expect(u.formatTime("")).toBe("");
    expect(u.formatTime(null)).toBe("");
    expect(u.shortTime("")).toBe("");
  });
});
