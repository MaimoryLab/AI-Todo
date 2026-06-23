import { describe, it, expect } from "vitest";
import { renderViewerDocument } from "../src/viewer/document.js";

// PLAN-001 STEP-01: viewer i18n base. We pull the rendered HTML, extract the
// DOM-free i18n core (between the /* i18n-core:* */ markers) and eval it so the
// assertions run the *real* t()/statusLabel(), not a reimplementation.
function loadI18nCore() {
  const rendered = renderViewerDocument();
  expect(rendered.found).toBe(true);
  const html = rendered.html;
  const core = html.split("/* i18n-core:start */")[1]?.split("/* i18n-core:end */")[0];
  expect(core, "i18n-core markers present in viewer HTML").toBeTruthy();
  const factory = new Function(
    `${core}\n return { messages: I18N_MESSAGES, t: t, statusLabel: statusLabel, setLang: function (l) { I18N_LANG = l; } };`,
  );
  return factory() as {
    messages: { en: Record<string, string>; zh: Record<string, string> };
    t: (key: string, fallback?: string) => string;
    statusLabel: (s: string) => string;
    setLang: (l: string) => void;
  };
}

describe("viewer i18n base", () => {
  it("t() resolves the active locale, defaulting to en with zh still available", () => {
    const i18n = loadI18nCore();
    expect(i18n.t("tab.dashboard")).toBe("Overview");
    i18n.setLang("zh");
    expect(i18n.t("tab.dashboard")).toBe("总览");
  });

  it("t() falls back to en for a key missing in the active locale, then to the key itself", () => {
    const i18n = loadI18nCore();
    i18n.messages.en["__test.only"] = "EnOnly"; // present in en, absent in zh
    i18n.setLang("zh");
    expect(i18n.t("__test.only")).toBe("EnOnly"); // fallback: zh -> en
    expect(i18n.t("does.not.exist")).toBe("does.not.exist"); // fallback: -> key
    expect(i18n.t("does.not.exist", "Custom")).toBe("Custom"); // explicit fallback wins
  });

  it("switching language never changes the stored enum literals (labels are keyed BY enum)", () => {
    const i18n = loadI18nCore();
    const enums = ["pending", "active", "done", "blocked", "cancelled"];
    // statusLabel maps an enum -> display string; the enum it is given back out is unchanged.
    for (const s of enums) {
      i18n.setLang("zh");
      const zh = i18n.statusLabel(s);
      i18n.setLang("en");
      const en = i18n.statusLabel(s);
      expect(zh).not.toBe(s); // a real label, not the bare key
      expect(en).not.toBe(s);
      expect(zh).not.toBe(en); // locale actually differs
    }
    // an unknown status degrades to the raw value (no crash, no bare i18n key)
    expect(i18n.statusLabel("totally_unknown")).toBe("totally_unknown");
  });

  it("the merged catalog has one consistent label per status — no synonym split, full en/zh parity", () => {
    const i18n = loadI18nCore();
    delete i18n.messages.en["__test.only"]; // ignore any cross-test mutation
    expect(Object.keys(i18n.messages.en).sort()).toEqual(Object.keys(i18n.messages.zh).sort());
    for (const s of ["pending", "active", "done", "blocked", "cancelled"]) {
      expect(i18n.messages.en).toHaveProperty(`status.${s}`);
      expect(i18n.messages.zh).toHaveProperty(`status.${s}`);
    }
    for (const k of ["filter.review", "filter.all"]) {
      expect(i18n.messages.zh).toHaveProperty(k);
    }
  });

  it("the three legacy inline label maps are gone and tabs route through the catalog", () => {
    const { html } = renderViewerDocument();
    expect(html).not.toMatch(/var\s+statusLabels\s*=/);
    expect(html).not.toMatch(/var\s+groupMeta\s*=/);
    expect(html).not.toMatch(/var\s+filterLabels\s*=/);
    expect(html).toContain('data-i18n="tab.dashboard"');
    expect(html).toContain('data-i18n="tab.actions"');
    expect(html).toContain('data-i18n="tab.sessions"');
    // render still keys display off the stored enum, so filtering/storage is untouched
    expect(html).toContain("statusLabel(status)");
  });

  it("dashboard strings are externalized to the catalog (PLAN-001 STEP-02a)", () => {
    const { html } = renderViewerDocument();
    // dashboard render routes through t(), not inline Chinese
    expect(html).toContain("t('dash.recentSessions')");
    expect(html).toContain("t('dash.firstRun.title')");
    // the catalog carries both locales for a dashboard key
    expect(html).toContain("'dash.recentSessions': 'Recent sessions'");
    expect(html).toContain("'dash.recentSessions': '最近会话'");
  });

  it("actions view is externalized and zh-only rewrites are gated (PLAN-001 STEP-02b)", () => {
    const { html } = renderViewerDocument();
    expect(html).toContain("t('act.refresh')");
    expect(html).toContain("t('act.empty.title')");
    // STEP-16 calm card dropped the attention badge; the card actions still route
    // through the catalog.
    expect(html).toContain("t('act.status.complete')");
    // English locale must not receive the Chinese rewrite tables
    expect(html).toContain("if (I18N_LANG !== 'zh') return s;");
    expect(html).toContain("'act.refresh': 'Refresh'");
    expect(html).toContain("'act.refresh': '刷新'");
  });

  it("expert tabs and the sessions list are externalized (PLAN-001 STEP-02c)", () => {
    const { html } = renderViewerDocument();
    // expert tab labels are catalog keys resolved at render, not inline Chinese
    expect(html).toContain("label: 'tab.crystals'");
    expect(html).toContain("t(tab.label)");
    // sessions list render is keyed
    expect(html).toContain("t('ses.heroTitle')");
    expect(html).toContain("t('ses.byFolder')");
    expect(html).toContain("'ses.heroTitle': 'Sessions'");
    expect(html).toContain("'ses.heroTitle': '会话'");
  });
});
