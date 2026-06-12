# STEP-01：三栏导航骨架 + 砍主导航

- 线:A（前端三栏）
- 状态:✅ 已合并 PR#7
- 依赖:STEP-00（已跳过，基线已绿）
- 对应 PR:`Claude/three-tab-restructure`

## 目标（一句话）

把主导航从 6 栏改为三栏（总览 / 待办 / 证据），把 memories、lessons(Skill) 移出主导航，sessions/timeline/activity 归入「证据」——纯 IA 与路由，不接新数据。

## 复核结论（2026-06-12，对 origin/main c5b4e4c 的 9217 行 viewer）

导航结构与规划时一致，预测成立，无需返工。关键定位:
- `TAB_IDS` 在 **3708 行**，`TAB_REDIRECTS` 在 **3709 行**（6 栏 + 6 隐藏视图，完全一致）。
- 真实导航按钮在 **3567–3582 行**（`tab-main` 含 dashboard/memories/sessions/activity；`tab-extra` 含 lessons/actions，已有「核心/进阶」分组）。
- 12 个 `view-*` 容器在 **3589–3600 行**。
- **陷阱 1**:200–215 行有一批 `.tab-bar button[data-tab="X"] .tab-icon` 的 **CSS 图标定义**（含 graph/timeline/profile/audit/replay 等隐藏 tab）。这些**不是按钮**，STEP-01 不要删——STEP-05 专家模式放回这些 tab 时正好复用。
- **陷阱 2**:现有「进阶」分组里放着 `actions`，而三栏目标要把**待办提到首位**。STEP-01 是**重排分组**，不是单纯删按钮。

## 改动面

- 文件:`src/viewer/index.html`
  - `TAB_IDS`（3708）：改为三栏对应的 id 集合。
  - `TAB_REDIRECTS`（3709）：把 memories/lessons 也加入重定向（指向证据或总览）。
  - tab-bar 按钮（3567–3582）：重排为 总览 / 待办 / 证据 三个主按钮，待办置首。
  - `view-*` 容器（3589–3600）：保留全部，仅控制显隐与归属。
- 不动:各 `view-*` 渲染函数实现、200–215 的 CSS 图标定义、所有后端/REST。被移出视图的渲染代码**保留**（STEP-05 收纳）。
- AGENTS 连带项:无（不碰 MCP/REST/版本）。

## 结果预测（已复核）

- 构建:`npm run build` 通过。
- 测试:`npm test` 维持 0 失败。**已确认** `viewer-session-id.test.ts` 用的是自带 mock 的 tabs 数组（非读真实 DOM），改导航按钮不直接撞它；除非改动 `switchTab`/`normalizeTab` 的契约。预期 0 处测试需改。
- 行为:导航只剩三栏；`#memories`/`#lessons` 直接访问被重定向；证据栏聚合原会话/时间线/活动入口。
- 风险:`normalizeTab`/`TAB_REDIRECTS` 改动影响旧书签与 hash 回退；需确认 `tabFromRoute` 回退到三栏内的合法值。**风险较原预测更低**（测试不依赖真实导航 DOM）。

## 待定（执行前需确认）

- 「证据」用**新 tab id**（如 `evidence`）还是**复用 `sessions`** 容器改名？建议复用 `sessions`（会话原文即证据来源），减少新容器。
- 三栏的 `TAB_IDS` 具体取值:建议 `['dashboard', 'actions', 'sessions']`（总览/待办/证据），待办置首由按钮顺序体现。

## 验证命令

```bash
npm run build
npm test -- --run test/viewer-session-id.test.ts test/viewer-security.test.ts
# 手动:点三栏、直敲 #memories 看重定向
```

## 回滚

revert 单 PR，恢复两个数组与按钮即还原 6 栏。

## 实际反馈（执行后由你回填）

- 构建:✅ `npm run build` 通过（~3s）。
- 测试:✅ `npm test` **124 文件 / 1334 用例全绿，0 失败**（与基线一致，零回归）。`viewer-session-id` / `viewer-security` 专项绿。**预测命中**:0 处测试需改。
- 行为（预览面板实测）:
  - 导航渲染为三栏 **总览 / 待办 / 证据**，顺序正确、待办置第二（总览之后）。
  - 点「待办」→ `activeTab=actions`、显示 `view-actions` ✓
  - 直敲旧 hash `#memories` → 自动重定向到 `#dashboard`、显示 `view-dashboard` ✓（被砍导航不白屏）
  - 总览空数据态正常，无 JS 报错。
- 实际改动（采纳建议:证据复用 `sessions`，`TAB_IDS=['dashboard','actions','sessions']`）:
  1. `TAB_IDS` → `['dashboard', 'actions', 'sessions']`
  2. `TAB_REDIRECTS` → 新增 `memories→dashboard, lessons→dashboard, activity→sessions`（保留原有 graph/profile/audit/replay/timeline/crystals）
  3. tab-bar 按钮重排为 总览/待办/证据 三个，移除 memories/活动/Skill 按钮与 `tab-extra` 进阶分组、`tab-group-label`
- 与预测的差异:基本无。新增确认了「证据」复用 sessions 容器后 `view-sessions` 仍正常激活。
- 下一步影响（下游待更新清单）:
  - **遗留无害死代码**:`switchTab`(~4883) 与事件委托(~8507) 仍引用已删除的 `#tab-extra`/`#tab-extra-toggle`，均有 `if(!el)return` 守卫，不崩溃。**STEP-05 专家模式**实现时应一并清理或复用这套折叠逻辑——已记为 STEP-05 的输入。
  - `switchTab` 内 `advancedTabs` 局部变量现已无实际作用，同上留待 STEP-05。
  - **STEP-02（待办接数据）前提不变**:`view-actions` 容器与 `loadActions()` 仍在，待办栏现为空骨架，可直接接数据。
  - **STEP-03（证据栏）**:确认「证据」= `sessions` tab，`view-sessions`/`loadSessions()` 正常，跳转目标容器为 `view-sessions`。
