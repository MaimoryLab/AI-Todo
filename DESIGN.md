# AI Todo — Design System

> **Scope.** This document describes the **product UI** of AI Todo: the local web **viewer** (`src/viewer/index.html`) and the **browser extension** (`browser-extension/`). Both share one visual language — a light, warm-stone, editorial system. The marketing **website** (`website/`) is a *separate* surface on a different brand (black + gold); it is documented at the end as a divergent surface, not as the product system.
>
> **Source of truth.** The values below are read from the live code, not aspiration. The viewer carries **two** `:root` blocks; the **second** ("editorial visual pass", ~line 2250 of `index.html`) overrides the first and is what ships — quote that one. When code and this doc disagree, the code wins and this doc should be corrected.
>
> **History.** This replaces an earlier `DESIGN.md` that described a Lamborghini-brand black/gold/zero-radius/hexagonal system. That system does **not** match the product app (it loosely matches the marketing website). It was removed as inaccurate; the genuinely transferable parts (doc structure, token discipline, do/don'ts, accessibility, the agent-prompt guide) are kept here.

---

## 1. Identity

AI Todo's product UI is a **calm, light, editorial dashboard**. The canvas is a warm stone-gray paper (`#f5f5f5`) washed with soft pastel "aurora" radial gradients (mint / peach / lavender). Content sits on white cards with hairline borders, generously rounded corners, and near-flat elevation. Type pairs a **thin serif display** (weight 300) with **Inter** for everything functional. The only saturated colors are semantic (green = success, red = danger) and soft pastel status tints; there is no brand accent color — emphasis is carried by **near-black ink on light paper**.

**Key characteristics**
- Light, warm-neutral ("stone") palette; **no pure black, no gold**. Darkest value is warm near-black ink `#0c0a09`.
- Rounded everywhere: cards 16–24px, buttons/badges/tabs/chips are full pills (9999px), inputs 8px.
- Two-typeface discipline: a light (300) **serif** display + **Inter** UI/body. Sentence case, not all-caps.
- Near-flat depth: hairline `#e7e5e4` borders + a fixed pastel gradient wash do most of the work; shadows are rare and very soft.
- Status is communicated with **soft pastel tints** (mint/blue/peach/pink), not loud chips.
- Opt-in **dark mode** (`html[data-theme="dark"]`), warm near-black — not the default.
- Decorative motifs are **soft circles and organic gradient blobs**, never hexagons or sharp geometry.

---

## 2. Design Tokens

The viewer defines tokens as CSS custom properties; the extension mirrors the same palette with literal values. **Always reference tokens, never raw hex, in new code.**

### 2.1 Color — light (default)

| Token | Value | Role |
|---|---|---|
| `--bg` | `#f5f5f5` | Page/canvas (over a fixed pastel gradient wash) |
| `--bg-alt` | `#fafafa` | Hover rows, code blocks, subtle alt surfaces |
| `--bg-subtle` / `--bg-inset` | `#f0efed` | Badge fills, button hover, inset chips |
| `--surface-card` | `#ffffff` | All cards, panels, inputs |
| `--border` | `#e7e5e4` | Default hairline border |
| `--border-light` | `#f0efed` | Lighter dividers, scrollbar thumb |
| `--border-heavy` | `#d6d3d1` | Button outline, emphasized border |
| `--ink` | `#0c0a09` | Primary text/headings; active-tab & primary-button fill |
| `--ink-secondary` | `#4e4e4e` | Body text (set on `body`) |
| `--ink-muted` | `#777169` | Labels, secondary/muted text, placeholders |
| `--ink-faint` | `#a8a29e` | Faintest text, disabled, low-priority |
| `--accent` | `#292524` | Warm near-black; primary-button hover fill (NOT a chromatic accent) |
| `--accent-light` | `#d6d3d1` | Light accent variant |
| `--green` | `#16a34a` | Success / connected |
| `--red` | `#dc2626` | Danger / error / high priority |

> Note: `--blue`, `--yellow`, `--purple`, `--orange`, `--cyan` exist but are **redefined to neutral grays** (`#777169` / `#4e4e4e`) in the editorial pass — i.e. the old colored badge variants are intentionally flattened to neutral. Don't reintroduce them as chromatic without a deliberate decision.

### 2.2 Color — dark (opt-in, `html[data-theme="dark"]`)

| Token | Value |
|---|---|
| `--bg` | `#0c0a09` (warm near-black, not `#000`) |
| `--surface-card` | `#1c1917` |
| `--ink` | `#ffffff` |
| `--accent` | `#ffffff` |

Theme is chosen by the user toggle (persisted in `localStorage`) or `prefers-color-scheme: dark`; light is the shipped default.

### 2.3 Pastel "aurora" palette (decorative + status tints)

Used both for the body's fixed background gradient and for status indicators. Always low-opacity tints, never solid fills.

| Hue | Value | Used for |
|---|---|---|
| Mint | `rgba(167,229,211,·)` | Body wash; **done** status tint (`0.36`) |
| Blue | `rgba(168,200,232,·)` | Body wash; **active** status tint (`0.34`) |
| Peach | `rgba(244,197,168,·)` | Body wash; **pending** status tint (`0.32`) |
| Lavender | `rgba(200,184,224,·)` | Body wash; decorative blobs |
| Pink | `rgba(232,184,196,·)` | **blocked / failed / cancelled** status tint (`0.34`) |

### 2.4 Typography tokens

| Token | Stack | Use |
|---|---|---|
| `--font-display` | `"Waldenburg", "Times New Roman", Georgia, serif` | Headings, stat numerals, hero & empty-state titles — **weight 300** |
| `--font-body` | `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif` | Body text |
| `--font-ui` | same as body | Buttons, labels, badges, tabs |
| `--font-mono` | `"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace` | Code, commands, technical meta |

### 2.5 Radius scale

| Token | Value | Use |
|---|---|---|
| `--radius-sm` | `6px` | small controls |
| `--radius-md` | `8px` | inputs, selects, textareas |
| `--radius-lg` | `12px` | action cards, groups |
| `--radius-xl` | `16px` | **default card radius** |
| `--radius-xxl` | `24px` | stat-grid container, empty-state, hero panels |
| `--radius-pill` | `9999px` | **buttons, badges, tabs, chips, status pills** |
| — | `50%` | dots, avatars, status circles |
| — | `0` | **only** deliberate exceptions: inner stat-grid cells, scrollbar thumb |

### 2.6 Spacing

Roughly an 8px-based scale with 6 and 12 as common in-betweens:
`4 · 6 · 8 · 10 · 12 · 16 · 20 · 24 · 32 · 48`px.
Anchors: view padding **32px**, card padding **24px**, modal **28px**, empty-state **48px**, sidebar rail **148px** wide.

### 2.7 Elevation / shadow

Near-flat by design — depth comes from hairline borders + the pastel wash.
- **Default:** `none` (cards, buttons, inputs).
- **Soft card elevation:** `0 16px 40px rgba(41,37,36,0.04)`; hover deepens to `0 18px 44px` / `0 22px 54px rgba(41,37,36,0.04–0.08)`.
- **Modal:** a deliberate hard "sticker" offset — `6px 6px 0 0 var(--border)` — the one intentionally un-soft shadow.
- **Focus ring:** `0 0 0 4px rgba(12,10,9,0.05)`.

---

## 3. Color Roles

- **Ink on paper is the system.** Primary emphasis = `--ink` fills (active tab, primary button) with white text. There is no accent hue to "pop"; restraint is the brand.
- **Semantic colors are sparing:** `--green #16a34a` (success/connected), `--red #dc2626` (danger/high-priority). Extension adds sage-green (`#51735b` on `#edf4ee`) and amber (`#9a5c22` on `#fff4e8`) for ready/waiting states.
- **Status uses pastel tints, not saturated chips** (see 2.3). Keep them translucent and let the icon + label carry meaning.
- **Priority rail:** high = `--red`, normal = `--accent`, low = `--ink-faint`.

---

## 4. Typography Rules

- **Display = thin serif.** Headings, big stat numerals (44px), hero and empty titles use `--font-display` at **weight 300**. Big, light, editorial — the opposite of a heavy condensed display face.
- **Everything functional = Inter.** Body, buttons, labels, tabs, badges.
- **Sentence case is the default voice.** `text-transform: none` almost everywhere. The only uppercase is small **labels / table headers**, with `letter-spacing: 0.08em`.
- **Weights:** 300 (display), 500 (buttons/tabs), 600–650 (labels, section heads, action titles), 700–800 (modal titles, strong emphasis).
- **Type scale** (px): `9 · 10 · 11 · 12 · 13 · 14 · 15 · 16 · 17 · 18 · 22 · 24 · 26 · 28 · 32 · 36 · 42 · 44`. Body/UI base is **15px**.
- **No embedded fonts.** Waldenburg + Inter are expected from the system; serif/sans fallbacks must remain in the stack.

---

## 5. Components

The viewer is a single-page app; these are its real building blocks (class names are the actual ones in `index.html`).

- **App shell / tab rail** — fixed left vertical rail (~148px), translucent `rgba(245,245,245,0.88)` with `backdrop-filter: blur(18px)`. Three primary pill tabs: **总览/dashboard · 待办/actions · 证据/sessions**; active tab fills `--ink` and inverts its icon. An expert toggle + repo/docs/feedback icon links pin below. There is **no top header** (the legacy `.app-header` is `display:none !important`). `.tab-bar`, `.view(.active)`
- **Card** — white surface, 1px hairline border, **16px** radius, 24px padding, flat. Optional `.card-title` with a bottom hairline. `.card`
- **Stats grid** — bordered container at **24px** radius with `overflow:hidden`; inner `.stat-card` cells have radius `0` and share borders to tile seamlessly. Value is 44px thin serif. `.stats-grid` / `.stat-card`
- **Button** — full pill, 40px tall, 1px `--border-heavy` outline, transparent; `.btn-primary` fills `--ink` with white text; `.btn-danger` is red outline filling red on hover. Calm: background/opacity hover only, **no transform**. `.btn`
- **Input / select / textarea** — 44px min-height, **8px** radius, white surface, focus = ink border (no shadow). `.search-input`, `input/select/textarea`
- **Badge / label chip** — small pill, `--bg-subtle` fill, 12px 600-weight, `0.08em` uppercase tracking. Color variants are flattened to neutral. `.badge`
- **Status icon-badge** — 30px circle carrying an SVG glyph, tinted by status: done = mint, active = blue, pending = peach, blocked/failed/cancelled = pink. This is the real status indicator. `.icon-badge.done/.active/.pending/.blocked/.failed/.cancelled`
- **Action item card** (待办) — white card, 12px radius, 3-col grid: thin rounded **priority rail** (6px; high/normal/low) | title + desc + meta | status icon-badge. Candidate cards add 待确认/忽略 buttons. `.action-item-card`, `.action-priority-rail`
- **Action overview strip** — 5-column grid of small bordered metric cards (待回应/待确认/待跟进/进行中/已完成), each a label + large thin-serif count; salient one gets `.primary`. `.action-overview`
- **Filter chips + search** — search input + a row of pill filter chips; active chip gets accent border + warm bg + bold. `.actions-filter-chip(.active)`
- **Done-today collapsible** — borderless full-width header (count + ▸/▾ caret) toggling a card list; default collapsed, slightly dimmed. Reuse this pattern for any "history default-hidden" bucket. `.done-today-section`
- **Modal** — centered dialog over `rgba(0,0,0,0.3)` scrim; light panel, 2px border, 28px padding, the hard `6px 6px` offset shadow, serif title, right-aligned actions. `.modal-overlay(.open)`, `.modal`
- **Stale / notice card** — inline warning card (muted dot + message + a primary action), **not** a floating toast. `sessionStaleNoticeMarkup`
- **Toast** — the one true toast: a fixed bottom-center 8px-radius chip, `--ink` bg, white text, `0 4px 16px` shadow (built in JS).
- **Empty state** — bordered 24px panel, thin-stroke icon, 28px thin-serif title, lead paragraph, optional mono command pill, link. `.empty-state`
- **Session inbox** (证据) — hero (serif title + mono meta) + a segmented `.mode-switch` (按文件夹/按来源) + a 2-col inbox: sticky source-chip rail | session list; selected item gets an accent left border. `.session-inbox`
- **Table** — full-width, separated borders, 15px; uppercase tracked `th` with bottom hairline; rows hover-highlight.

**Browser extension** reuses this language at smaller scale: 340px popup / side panel, single-column card stack (8px-radius cards, pill buttons, system font), sage-green/amber status tints, a near-black `.brand-mark`. No 3-tab shell; collapsible `<details>` sections instead.

---

## 6. Layout

- **Side-rail shell, no top chrome.** Fixed 148px left rail is the only navigation; main content is `margin-left: 148px` with 32px padding and scrolls independently. Body is a full-viewport flex column (`100vh`, `overflow:hidden`) over a fixed pastel aurora gradient.
- **Content = vertical card stacks.** Dashboard: stats grid + folder grid. Actions: overview strip + filter row + grouped card lists + done-today collapse. Sessions: hero + segmented switch + sticky-rail 2-col inbox.
- **Whitespace + hairlines over boxes.** Prefer a 1px `--border` divider and spacing to a heavy container or shadow.

---

## 7. Dark Mode

Opt-in, warm. Setting `data-theme="dark"` on `<html>` swaps to canvas `#0c0a09`, card `#1c1917`, ink `#ffffff`, accent `#ffffff`. Keep status pastels and semantic green/red legible against the dark surface; don't introduce pure `#000`.

---

## 8. Accessibility

- **Touch targets:** inputs are 44px min-height (meets WCAG 2.5.5). **Buttons are 40px** — slightly under the 44px target; bump to 44px for any new primary/touch-first control. *(Known gap, worth a pass.)*
- **Contrast:** `--ink #0c0a09` / `--ink-secondary #4e4e4e` on white are strong; `--ink-faint #a8a29e` on white is borderline — reserve it for non-essential meta, never body copy.
- **Don't encode meaning in tint alone:** status pastels (mint/blue/peach/pink) are close in value — always pair with the icon + text label, never color-only.
- **Motion:** hovers are color/opacity only (no transform); honor `prefers-reduced-motion` for any added animation.

---

## 9. Do's & Don'ts

**Do**
- Reference tokens (`--ink`, `--surface-card`, `--radius-xl`, `--green`) — never raw hex — in new styles.
- Keep the warm-stone neutral base; let ink-on-paper carry emphasis.
- Use pills for buttons/badges/tabs, 16px for cards, 24px for grouped containers.
- Communicate status with the pastel icon-badges + a text label.
- Keep elevation near-flat: hairline borders first, soft long shadows only for true cards.
- Use the thin serif display for headings/numerals and Inter for everything else; sentence case.
- Reuse the done-today collapse pattern for any history/default-hidden bucket.

**Don't**
- Reintroduce `#000000` surfaces or a gold accent in the product app (that's the website brand, see §11).
- Add chromatic badge variants — the colored classes are intentionally flattened to neutral.
- Add hover transforms/scale, glows, or heavy drop shadows.
- Use all-caps for body/headings (only small labels are uppercase).
- Add hexagonal or hard-angular motifs — the decorative language is soft circles/blobs.
- Hard-code colors or invent a parallel palette in a component.

---

## 10. Agent Prompt Guide

When asking an AI to build or refine a screen in this system, anchor it with real tokens.

**Quick reference**
- Canvas: warm stone `#f5f5f5` under a soft mint/peach/lavender pastel wash
- Card: white `#ffffff`, 1px `#e7e5e4` border, 16px radius, flat
- Primary action: pill button filled near-black `#0c0a09`, white text
- Text: heading near-black `#0c0a09`; body `#4e4e4e`; muted `#777169`
- Display font: thin (300) serif (Waldenburg/Georgia); UI/body: Inter
- Status: done=mint, active=blue, pending=peach, blocked=pink (translucent tints + icon)

**Example prompts**
- "A dashboard stat card: white surface, 16px radius, 1px `#e7e5e4` border, no shadow; small uppercase muted label (`#777169`, 0.08em tracking) above a 44px thin-serif near-black numeral."
- "A todo card: 12px-radius white card, a 6px rounded priority rail on the left (red for high), title in Inter 600, muted meta line, and a 30px circular pastel status icon-badge (mint = done) on the right."
- "An empty state: 24px-radius bordered white panel, 48px padding, a thin-stroke icon, a 28px thin-serif title, a muted lead line, and a monospace command pill."
- "A primary button: full pill, 40px tall, filled `#0c0a09` with white text; hover darkens slightly; no transform."

**Iteration**
1. Refine one component at a time against the token tables above.
2. Name tokens, not hex, in feedback.
3. Keep it calm — if something feels loud, it's probably off-system.

---

## 11. Marketing Website — Separate Surface (divergent)

`website/` (Next.js) is **not** built on the system above. It is the **agentmemory** marketing brand: true-black `#000000` canvas, a single gold accent `#FFC000` (`--gold`), heavy **Archivo** (weight 900) near-universal uppercase display, **JetBrains Mono** for technical text, `#202020` hairlines, predominantly **zero border-radius**, flat (no shadows; depth via radial vignettes + blur), and a single SVG **hexagon** play/pause control in `MemoryGraph`. (Minor inconsistencies even within it: the OG image uses `#f3b840`, the favicon uses orange `#FF6B35`.)

This is the surface the old Lamborghini doc actually resembled. It currently **diverges from the product app on every axis** (dark vs light, gold vs none, sharp vs rounded, Archivo vs serif+Inter) and still carries the old `agentmemory` brand.

**Open decision — not resolved here:** the product app and the marketing site are two different visual brands. They should be reconciled into one direction (most likely: align the website to the product's light editorial system as part of the `agentmemory → AI Todo` rename), or the split should be made deliberate and documented. Track this with the rename plan (PLAN-004) and the i18n/rebrand plan (PLAN-001 STEP-04).

---

## 12. Known Inconsistencies (cleanup backlog)

Real issues found while auditing the live code — worth a tidy-up pass, none blocking:
- **Two `:root` blocks** in `index.html`: an older cool-palette/Georgia block (~line 17) fully superseded by the editorial block (~line 2250). The dead first block should be removed to avoid confusion.
- **Dangling tokens:** `--radius-xs` (referenced ~line 2779) and `--shadow-2` (~line 3189) are used but **undefined** in the active `:root` — they silently resolve to initial. Define or remove.
- **Flattened badge colors:** `--blue/--yellow/--purple/--orange/--cyan` are redefined to neutral grays; the `.badge-*` color classes therefore render identically. Either restore intent or delete the unused classes.
- **Brand string in state key:** the theme is persisted under `localStorage["agentmemory-theme"]` — a rename touchpoint (see PLAN-004); changing it needs a migration or it silently resets users' theme.
- **Knowledge-graph data-viz palette** (`NODE_COLORS`, the old `--node-*` vars) is vivid and chromatic by necessity; it's intentionally exempt from the neutral product palette — keep, but treat as data-viz, not chrome.
