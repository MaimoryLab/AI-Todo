# STEP-03：待办→证据跳转（纯前端逐 session 扫描）

- 线:A（前端三栏）
- 状态:✅ 已合并 PR#9（端到端跳转+高亮待真实非 demo 数据手验）
- 依赖:STEP-02（✅ 上游已把待办栏接通真实数据；证据栏 sessions 也已就绪）
- 对应 PR:`Claude/evidence-jump`

## 目标（一句话）

待办卡片上加「看原文 →」，点击用 `sourceObservationIds` 跳到证据栏对应会话并高亮目标观测。

## 现状核对（2026-06-12 实测）

- **STEP-02 已完成**:`loadActions`(7704) 已接 `review/actions/generate`+`actions`+`frontier`，`renderActions`(7744) 有分组/筛选/候选卡。无需重做。
- **证据栏已就绪**:`loadSessions`(6934)+`renderSessions`(6958)+`renderSessionDetail`(7191) 按 session 组织，`renderSessionDetail` 已调 `observations?sessionId=` 渲染逐条观测。
- **跳转的真正障碍（架构）**:待办卡指向裸 `obs_*` id，但证据栏按 **session** 组织，后端 **无 `obs_id→session` 反查端点**（`/observations` 强制要 `sessionId`）。实测 `obs_mqar8mce_*` 属 `demo_mqar6nmw_*`。
- **数据齐备验证两种分支**:两条 action 一条带 `sourceObservationIds`、一条空。

## 路线（已拍板:纯前端逐 session 扫描，零后端改动）

前端拿到 action 的 `sourceObservationIds[0]`，遍历**已加载的 sessions**，对每个调（或复用缓存）`observations?sessionId=`，命中即得 `sessionId` → 复用 `open-session-group` 同款机制（设 `state.sessions.selectedId` + `switchTab('sessions')`），并设 `pendingHighlightObsId`，`renderSessionDetail` 后滚动+高亮。

## 改动面

- 文件:仅 `src/viewer/index.html`。
  1. `renderActionCard`(7944):`sourceObservationIds.length>0` 时加 `<button data-action="jump-to-evidence" data-obs-id="...">看原文 →</button>`，空则不渲染（降级）。
  2. 点击分发(8699+):新增 `jump-to-evidence` 分支 → 调解析函数。
  3. 新增 `resolveObsSession(obsId)`:遍历 `state.sessions.items`，按 `detailCacheById` 缓存优先、否则 `apiGet('observations?sessionId=')`，返回首个含该 obs 的 sessionId（找不到返回 null）。
  4. `renderSessionDetail`(7191):画逐条观测时给元素加 `id="obs-anchor-<id>"`；渲染末尾若 `state.sessions.pendingHighlightObsId` 命中则 `scrollIntoView`+临时高亮类，然后清空。
- 不动:后端、AGENTS 连带项（无新端点）、Markdown（STEP-04）。

## 结果预测（执行前填）

- 构建:`npm run build` 通过。
- 测试:维持 0 失败；新增 1 个 `resolveObsSession` 解析单测（mock observations 列表 → 命中/未命中）。
- 行为:带来源的待办点「看原文」→ 切到证据栏、定位到来源会话、滚动并高亮该观测；无来源待办不显示按钮。
- 风险:
  - ① **会话未加载/未命中**:目标 obs 所属 session 不在 `state.sessions.items`（被 `isDemoSession` 过滤掉，或分页未取）→ 解析落空。需降级 toast「未找到来源会话」，不可静默失败。
  - ② **扫描成本**:session 多时逐个 `observations?sessionId=` 慢 → 优先用 `detailCacheById` 缓存，未命中才请求，且命中即停。
  - ③ **demo 过滤**:`renderSessions` 用 `isDemoSession` 过滤 demo 会话；若来源是 demo obs，证据栏根本不展示该 session → 解析即便成功也无处可跳。需在真实（非 demo）数据上验证，或临时放开 demo 过滤验证机制。


## 验证命令

```bash
npm run start:local-memory
curl -s "localhost:3111/agentmemory/session/highlights?sessionId=<id>" | head
npm run build
npm test -- --run test/viewer-session-id.test.ts
# 手动:待办点「看原文」验证跳转+高亮
```

## 回滚

revert 单 PR；证据栏与跳转一起回退，待办栏不受影响。

## 实际反馈（执行后由你回填）

- 构建:✅ `npm run build` 通过（~3.1s）。
- 测试:✅ `npm test` **125 文件 / 1338 用例全绿，0 回归**（新增 `test/viewer-evidence-jump.test.ts` 4 用例，锁定 `resolveObsSession` 命中缓存/命中网络/未命中/空 id 四种分支）。
- 实际改动（仅 `src/viewer/index.html`）:
  1. `renderActionCard`:`sourceObservationIds` 取首个非空 → 加「看原文 →」按钮（`data-action="jump-to-evidence"`），空来源不渲染（降级）。
  2. 新增 `resolveObsSession(obsId)`:遍历 `state.sessions.items`，缓存（`detailCacheById`）/内嵌（`embeddedObservations`）优先、未命中才 `apiGet('observations?sessionId=')`，命中即停。
  3. 新增 `jumpToEvidence(obsId)`:必要时先 `loadSessions`，解析失败 → `flashHint` 提示「未找到来源会话」（不静默失败）；成功则设 `selectedId`+`pendingHighlightObsId`，**强制展开目标会话的「完整对话过程」区**（默认折叠，否则锚点不存在），`switchTab('sessions')` + 重渲染。
  4. `renderSessionDetail`:逐条观测加 `id="obs-anchor-<id>"`；渲染末尾 `applyPendingHighlight()` 滚动到锚点 + 2.4s 脉冲高亮。
  5. 新增 `flashHint` 轻量 toast、`.action-evidence-link`/`.obs-jump-highlight` CSS、state 加 `pendingHighlightObsId`。
- 与预测的差异:
  - **新增障碍（已处理）**:观测只在「完整对话过程」区渲染且默认折叠 → `jumpToEvidence` 跳前强制展开该 section，否则高亮锚点不在 DOM。预测没料到。
  - **端到端高亮未手验**:按你的决定，靠单测保证解析正确;跳转+滚动+高亮的端到端验证留到有真实（非 demo）数据时手验——当前 demo 会话被证据栏 `isDemoSession` 过滤掉，无处可跳（风险③已被证实，非 bug）。
- 下一步影响（下游待更新清单）:
  - **STEP-04（Markdown）**:`renderSessionDetail` 的逐条观测正文目前 `esc()` 纯文本;Markdown 接管后需确保 `obs-anchor-<id>` 锚点仍在每条观测的最外层容器上，别被 Markdown 包裹打散。
  - **STEP-05（专家模式）**:若把 sessions 折叠进专家模式，跳转目标可能被隐藏 → 需让 `jumpToEvidence` 在跳转时也确保证据栏可见。
  - 无对 STEP-06 影响。

