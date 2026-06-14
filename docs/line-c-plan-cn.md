# 线 C 方案:Agent→用户异步收件箱(待回应 / 已完成)

> 状态:**v2,已审阅通过、开工中**。第一轮审阅 5 点已落实(§0.5),边界已锁定(Agent 主动写→工作台收,本轮不接飞书)。
> 日期:2026-06-13 · 基线:`@agentmemory/agentmemory` v0.9.24 · 前置:线 A(三栏)已交付。
> 方法论沿用线 A 验证有效的工作流(见 `dev/workflow-review-cn.md`):一步一 PR、预测后回填、preview 实证、文档零 CI。

## 进度看板(2026-06-13)

| STEP | 内容 | 状态 |
|---|---|---|
| **C1** | inbox 后端原语(5 函数 + 5 REST + 2 MCP 工具 + KV + audit) | ✅ **已合并** [PR#19](https://github.com/MaimoryLab/agentmemory-lab/pull/19)(main baa5771) |
| **C1.5** | Agent 主动发送+整理接入点(`ask-user`/`organize-todos` skill,⭐核心) | ✅ **已合并** [PR#21](https://github.com/MaimoryLab/agentmemory-lab/pull/21)(main a22e411)+ 真实触发场景端到端测试 |
| **C2** | viewer「待回应/通知」区接真数据 | ✅ **已合并** [PR#22](https://github.com/MaimoryLab/agentmemory-lab/pull/22)(main fd6be27,question/briefing 双卡,preview 实证)|
| **C3** | 动作:回应 / 知道了 / 转待处理 / 看原文 | ✅ **已合并** [PR#24](https://github.com/MaimoryLab/agentmemory-lab/pull/24)(main c8887a6)+ 防重入收口 [PR#25](https://github.com/MaimoryLab/agentmemory-lab/pull/25)(main c679732)|
| **C4** | 「已完成」区(只读 done,可与 C3 并行) | ✅ **已实现**(底部折叠区,只读 `status:done` 当天项,默认折叠,preview 实证)|

> **里程碑**:🎉 **线 C 全栈贯通(C1→C4)**——「Agent 写→落库→用户看到→回应/消解→已完成归档」整条闭环可用。C4 给待办栏底部加只读「已完成」折叠区(§3.2/§3.3),筛 `action.status==='done'` 且当天 `updatedAt`,默认折叠、点击展开,纯前端零后端。
> 另:[PR#23](https://github.com/MaimoryLab/agentmemory-lab/pull/23)(main 0f2d7f9)收口 inbox REST 字段白名单 + 空白正文 400;[PR#26](https://github.com/MaimoryLab/agentmemory-lab/pull/26)(main 54493f8)修 viewer 预览代理端口自动发现(实证环境可信度)。

---

## 0. 一句话

线 A 把工作台内的形态立好了(待办栏含「待回应」空壳 STEP-06)。线 C 补上它背后**真正缺的后端语义**——让 Agent 能把「我问了你、在等你回」这件事真实地推进收件箱,用户能在工作台看到、回应、消解。**本轮拍板:只做后端语义 + viewer 接真数据,飞书投递出口排后;已完成简报只展示已有 done,不做自动识别。**

## 0.5 审阅决议(2026-06-13 第一轮审阅落实)

| # | 议题 | 决议 |
|---|---|---|
| 1 | 新建 inbox vs 扩展 signals | ✅ **认可新建**独立 inbox 原语 |
| 2 | 三动作流转(回应/转待处理/看原文) | ✅ **流转正确**,按 §3.1 实现 |
| 3 | Agent 接入点(原 C5,旁路) | ⭐ **升级为核心**:让 **Agent 主动发送+整理待办**,整理后的结果**直接通知用户**(本轮「通知」= 写入工作台收件箱作为送达面,用户打开即见;主动推送见下条)。原 C5「可选旁路」改为 **C1.5 必做**,见 §4。 |
| 4 | 优先级判定 | ⏸️ **本轮不处理**:`priority` 字段保留为可选,Agent 可填可不填;前端不做启发式排序,按 `createdAt` 倒序即可。优先级算法单列后续。 |
| 5 | 飞书投递 | ⛔ **本轮不做**:Agent→用户的「通知」本轮止于工作台收件箱(本地、打开即见)。跨设备主动推送(飞书/lark/openclaw、桌面 Notification)单列后续线 D。 |

> **第 3 与第 5 的边界澄清**(避免误解):第 3 点「直接通知用户」在本轮**指 Agent 把整理好的待办/问题写进工作台收件箱,用户在工作台看到**——这是「送达到一个用户必看的统一入口」,不是手机推送。真正的跨设备主动推送依赖通道(飞书),按第 5 点排后。本轮先把「Agent 主动写、用户工作台收」这条**本地闭环**打通。

## 1. 需求明确(先对齐再开工)

### 1.1 真实痛点(用户视角,个人重度 Agent 用户)
线 A 所有能力都在「工作台内被动查看」。但用户最在意的一类——**Agent 运行中抛出、时间敏感、Agent 在那头等着的问题**——目前**完全没有后端语义**。STEP-06 已诚实地把 viewer 分区做成空壳,等的就是本线。

### 1.2 三类收件箱条目(来自会议,线 A 已确认)
| 类型 | 性质 | 用户动作 | 本轮 |
|---|---|---|---|
| 🔴 待回应 | Agent 抛问题、在等你、时间敏感 | 回一句 / 转待处理 / 看原文 | ✅ **本轮做后端语义 + 接线** |
| 🟡 待处理 | 欠着的事(= 现有 action) | 已在线 A 跑通 | 不动 |
| 🟢 已完成 | 汇报性质、知悉即可 | 自动归档 | ⚠️ **仅展示已有 `action.status:done`,不自动识别** |

### 1.3 本轮边界(拍板结论)
- ✅ 新建 **inbox 原语**(独立 KV scope,非改 signals)承载「待回应」。
- ✅ **Agent 主动发送+整理待办**(核心):Agent 在会话中把问题/整理后的待办写进收件箱;整理结果直接送达工作台收件箱(用户必看入口)。配套 `ask-user`/整理引导 skill + AGENTS.md 引导。
- ✅ viewer 把 STEP-06 空壳接上真实 inbox 数据。
- ✅ 「已完成」区只读现有 `action.status:done`,**不**加自动识别抽取器。
- ⏸️ **优先级判定**:本轮不处理;`priority` 保留可选字段,前端按 `createdAt` 倒序,不做启发式。算法单列后续。
- ⛔ **飞书/lark/openclaw 投递出口 + 桌面通知**:本轮**不做**,单列后续线 D(跨设备主动推送)。本轮「通知」止于工作台收件箱本地闭环。

### 1.4 为什么新建 inbox 而非扩展 signals(关键决策)
`signals`(`src/functions/signals.ts`)是 **agent↔agent** 消息原语:读取强制要 `agentId`、无「未答/已答」状态、type 里没有「问题」语义。STEP-06 已论证「接 signals 语义不对、会误导」。扩展它要塞 question 类型 + answered 状态 + 去 agentId 的用户读路径,反而污染原有 agent 间语义、动 `test/signals.test.ts` 一堆守卫。**新建独立 `inbox` 原语更干净**:语义专一(Agent→用户问答)、不碰 signals、守卫独立。

<!-- PLACEHOLDER_REST -->

## 2. 数据模型(新 inbox 原语)

```ts
// src/types.ts 新增
interface InboxItem {
  id: string;                 // inbox_<ts>_<rand>
  kind: "question" | "briefing";  // 问题(需回应) / 整理通知(知悉即可)
  body: string;               // 正文(Markdown,复用 renderMarkdownSafe)。question=问题,briefing=整理后的待办通知
  status: "awaiting" | "answered" | "dismissed";  // 核心:未答/已答(或已读)/已消解
  priority?: "high" | "normal" | "low";  // 本轮不处理算法,字段保留;Agent 可填可不填
  fromAgent?: string;         // 哪个 Agent/会话抛的(展示「来自」用)
  project?: string;           // 关联项目
  sourceObservationIds?: string[];  // 复用线 A 跳证据机制(STEP-03 的 resolveObsSession)
  sourceSessionId?: string;
  answer?: string;            // 用户回应正文(question 被 answered 时)
  createdAt: string;
  answeredAt?: string;
  expiresAt?: string;         // 可选 TTL
}
```

设计要点:
- `kind` 区分两用途:`question`(Agent 抛问题、需用户回应)与 `briefing`(Agent **主动整理**后的待办通知,知悉即可、可一键已读)。两者都进同一收件箱,前端分区呈现。
- `status` 三态是核心——「待回应」区只显示 `awaiting`;question 回应后转 `answered`、briefing 点「知道了」转 `answered`(已读)归档;「转待处理」= `dismissed` 并新建一条 action(转给现有线 A 待处理流)。
- `priority` 本轮**不参与排序**(算法排后),前端按 `createdAt` 倒序;字段保留供 Agent 选填、后续线接算法。
- `sourceObservationIds` 刻意与 Action 同名,**直接复用 STEP-03 的 `resolveObsSession` + 「看原文 →」**,零新增跳转逻辑。
- 不含 `to` 字段:inbox 天然是「Agent→当前用户」,无需 agentId(这正是与 signals 的本质区别)。

## 3. 用户体验(线框,与线 A 视觉一致)

### 3.1 待办栏顶部「待回应」区(把 STEP-06 空壳接真)
```text
┌─────────────────────────────────────────────────────────┐
│ ● 待回应 (2)                          Agent 在等你回复     │
│ ┌───────────────────────────────────────────────────┐   │
│ │ 🔴 /admin/* 路由要不要也加鉴权?         来自 auth 重构 │   │  ← kind=question
│ │    "我改完了 /api/*,但 /admin/* 你之前没说…"  看原文→ │   │
│ │    [ 回应… ]  [ 转待处理 ]  [ 知道了/消解 ]            │   │
│ ├───────────────────────────────────────────────────┤   │
│ │ 🔴 这两个测试是删还是修?              来自 测试清理     │   │  ← kind=question
│ │    [ 回应… ]  [ 转待处理 ]  [ 知道了/消解 ]            │   │
│ └───────────────────────────────────────────────────┘   │
│ ● Agent 整理 (1)                      知悉即可,可一键已读  │
│ ┌───────────────────────────────────────────────────┐   │
│ │ 📋 今天我跟进了 3 件:补了分页/修了登录测试/…   看原文→ │   │  ← kind=briefing
│ │    [ 知道了 ]  [ 转待处理 ]                            │   │  (Agent 主动整理后推送)
│ └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```
- 两类卡:`question`(🔴 Agent 在等你回)与 `briefing`(📋 Agent 主动整理后推的通知,知悉即可)。前端按 kind 分子区呈现,均按 `createdAt` 倒序(本轮不按 priority)。
- 空态(无 awaiting):保留 STEP-06 的诚实空态文案,但去掉「尚未接通后端」那句(已接通)。
- 「回应…」(question)展开行内输入框,提交 → `answer` 入库、状态转 `answered`、卡片淡出归档。
- 「知道了」(briefing,或 question 无需回时)→ `inbox-answer` 空 answer,标已读归档。
- 「转待处理」→ inbox 项 `dismissed` + 新建一条 action(标题取 `body`),落入线 A 待处理区。
- 「看原文 →」复用 STEP-03 跳证据。

### 3.2 「已完成」区(只读 done,折叠)
```text
🟢 已完成  今天完成了 N 件 ▾        (默认折叠,点开列 status:done 的 action)
```
- 数据源:现有 `GET /agentmemory/actions` 里 `status==="done"` 的项,按 `updatedAt` 当天过滤。
- **不**自动识别,**不**新增抽取器——纯前端筛现有数据。

### 3.3 分区顺序(顶→底)
待回应(awaiting,Agent 在等)→ 待确认(候选)→ 待处理(active/pending)→ 已完成(done,折叠)。

## 4. STEP 拆解(每步 = 一个 PR,薄切、可验证、可回滚)

> 合并顺序 C1 → C1.5 → C2 → C3 → C4;C4 可与 C3 并行。建议顺序:先后端语义(C1)绿、接入点(C1.5)到位,再逐步接前端。

### STEP-C1 — inbox 后端原语(MCP 工具 + REST + KV)
- **改动面**:
  - `src/types.ts`:加 `InboxItem` 接口(含 `kind: question|briefing`)。
  - `src/state/schema.ts`:加 KV scope `inbox = "mem:inbox"`(AGENTS.md KV 连带:schema + types,2 处)。
  - `src/functions/inbox.ts`(新):`mem::inbox-ask`(Agent 抛问题,kind=question)/`mem::inbox-notify`(Agent 推整理后的待办通知,kind=briefing)/`mem::inbox-list`(列 awaiting,**无需 agentId**,可按 kind 过滤)/`mem::inbox-answer`(回应/已读,转 answered)/`mem::inbox-dismiss`。
  - `src/triggers/api.ts`:对应 REST 端点 `/agentmemory/inbox*`(REST 连带:api + index 计数 + README,3 处;端点数 131→+N)。
  - `src/mcp/tools-registry.ts` + `src/mcp/server.ts`:`memory_inbox_ask`/`memory_inbox_notify` 等 MCP 工具(MCP 连带:8 处全套/每工具,见 §5)。
  - `src/index.ts`:function 注册 + 端点计数日志。
  - 审计:`src/types.ts` `AuditEntry.operation` 加 `inbox_ask`/`inbox_notify`/`inbox_answer`(audit 连带,1 处)。
  - `test/inbox.test.ts`(新):ask/notify/list/answer/dismiss + 状态机 + 「list 不要 agentId」守卫 + kind 过滤。
- **结果预测**:build 通过;`npm test` 维持绿 + 新增 inbox 用例;`consistency.test` 因新增 MCP 工具/REST 端点会要求同步计数——**必须按 §5 清单全改,否则计数断言红**。
- **风险**:一致性铁律是本步最大风险(改 8+3 处 + KV2 + audit1)。先跑 `npm run check:consistency-local` 秒级自检,再 build/test。
- ✅ **实际反馈([PR#19](https://github.com/MaimoryLab/agentmemory-lab/pull/19) 已合并,main baa5771)**:
  - 落地 `src/functions/inbox.ts`(142 行):`mem::inbox-ask`/`-notify`/`-list`/`-answer`/`-dismiss` 共 5 函数。`list` 确认**无需 agentId**、可按 `status`/`kind` 过滤、按 `createdAt` 倒序、默认 limit 50、过期项过滤。`answer` 空 answer = briefing 已读(`answer` 留 undefined)。
  - KV scope `mem:inbox`(schema + types,2 处);5 REST 端点 `/agentmemory/inbox/{ask,notify,answer,dismiss}` + `GET /agentmemory/inbox`(端点数 **131→136**);2 写侧 MCP 工具 `memory_inbox_ask`/`memory_inbox_notify`(工具数 **53→55**,读/答消解走 REST+viewer);audit op 加 `inbox_ask`/`inbox_notify`/`inbox_answer`/`inbox_dismiss`(实际 4 个,比预测多 dismiss)。
  - `test/inbox.test.ts` 9 例全绿;一致性铁律全套连带已改。
  - **踩坑**:`test/session-highlights-api.test.ts` **硬编码** `endpointCount===131`(独立于 `consistency.test`),`check-consistency-local.mjs` 只比跨文档一致、不扫测试硬编码字面量,**漏报**——已手动改 136。教训:本地 check 脚本对「测试内硬编码计数」是盲区,后续可增强扫描。
  - 最终基线:**128 文件 / 1362 用例 0 失败**;CI 4 格(ubuntu/macos × node 20/22)全绿;PR CLEAN/MERGEABLE,已 `--merge --delete-branch`。

### STEP-C1.5 — Agent 主动发送+整理的接入点(⭐ 核心,原 C5 升级)
- **为什么必做**:这是「收件箱有没有数据」的产品闭环命门。没有 Agent 主动往里写,inbox 永远空、线 C 价值无从兑现。审阅已拍板把它从旁路提为核心。
- **改动面**:
  - `plugin/skills/ask-user/SKILL.md`(新):引导 Agent「需要用户拍板/回应时,调 `memory_inbox_ask`」。
  - `plugin/skills/organize-todos/SKILL.md`(新):引导 Agent「会话告一段落时,**主动整理**本次产生的待办/进展,调 `memory_inbox_notify` 推一条整理通知给用户」。
  - `AGENTS.md` / `plugin/plugin.json`:把这两个 skill 纳入 skill 计数与说明(注意 skill 数 12→14,但 skill 计数不被 consistency.test 锁,仍建议同步 AGENTS.md Current Stats)。
  - (可选)hook 探索:会话结束 hook 自动触发整理通知——本步先不做自动,先靠 skill 引导 Agent 主动调,避免误触发。
- **结果预测**:纯文档/skill,零 CI 成本(`plugin/**` 非 paths-ignore 的需确认;若触发 CI 则 build+test 应不受影响)。
- **风险**:产品风险而非技术风险——skill 措辞要让 Agent 在「真该问/真该汇报」时才写,避免 inbox 被噪音淹没。审阅时重点看 skill 的触发判据措辞。
- ✅ **实际反馈([PR#21](https://github.com/MaimoryLab/agentmemory-lab/pull/21) 已合并,main a22e411)**:
  - 两个 skill 均 `user-invocable: false`(Agent 自主触发,非用户 `/` 调):`ask-user`(kind=question,三条高门槛全满足才发:①确实受阻 ②确属用户决策 ③inline 已失败)、`organize-todos`(kind=briefing,非trivial+自然停顿点+有料可报,每停顿点至多一条)。均带 MCP→REST fallback。
  - 连带:`AGENTS.md` 加 skill 连带规则(skill→3 处)+ Current Stats 12→14;`plugin/.claude-plugin/plugin.json` description 8→14(校正旧漂移);`test/copilot-plugin.test.ts` `KNOWN_SKILL_DIRS` 加两目录。
  - **补**:加 `test/inbox-skill-trigger.test.ts`(7 例端到端)——补 skill 真正写入链路的覆盖:主路径 `memory_inbox_ask`/`notify` MCP 工具经 `mcp::tools::call` dispatch、fallback `POST /agentmemory/inbox/{ask,notify}` REST,断言条目真落进 `mem:inbox` 且 `inbox-list` 能查到(模拟用户打开工作台),含空 body 拒绝、MCP+REST 汇入同一收件箱、createdAt desc 排序。此前 `inbox.test.ts` 只测最底层 function,这两层零覆盖。
  - 基线:CI 4 格全绿。

### STEP-C2 — viewer「待回应/通知」区接真数据
- **改动面**:仅 `src/viewer/index.html`。`renderAwaitingReplySection()`(STEP-06 占位)改为 `loadInbox()` 拉 `/agentmemory/inbox?status=awaiting` → 按 `kind` 分呈现(question 卡 + briefing 卡);空态去掉「尚未接通」。复用 `renderMarkdownSafe` 渲染 `body`;按 `createdAt` 倒序(不按 priority)。
- **结果预测**:build 通过;新增 viewer 渲染单测(参考 STEP-06 的 viewer-session-id 用例);preview 实证两种卡片渲染。
- **风险**:demo 数据需造 inbox 项(本地 API 直接 ask/notify 几条)。
- ✅ **实际反馈(已实现,待开 PR)**:
  - 仅改 `src/viewer/index.html`:`state` 加 `inbox: { loaded, items }`;`loadActions()` 并行批加一条 `apiGet('inbox?status=awaiting&limit=50')`,结果存 `state.inbox.items`。
  - `renderAwaitingReplySection()` 由空壳改为读 `state.inbox`:按 `kind` 分两子区——`question`(🔴 卡 + 「Agent 在等你回」徽标 + 标题计数)与 `briefing`(📋「Agent 整理」子区,知悉即可),均 `createdAt` 倒序。`body` 走 `renderMarkdownSafe`(XSS 安全);有 `sourceObservationIds` 才渲「看原文 →」,复用 STEP-03 `data-action="jump-to-evidence"`,零新增跳转逻辑。空态去掉「尚未接通」「即将上线」,改诚实「目前没有待回应的条目」。
  - 动作(回应/知道了/转待处理)**本步不做**,留待 C3——C2 只把卡片形态接真 + 看原文。
  - 新增 `test/viewer-inbox-section.test.ts`(7 例,VM sandbox 直调 `renderAwaitingReplySection()`):空态、question 卡、briefing 子区、看原文按钮有/无、混合分区顺序、XSS 转义;改 `test/viewer-session-id.test.ts` 原 STEP-06 占位守卫为 C2 接真后行为(去「尚未接通」、seed `state.inbox`)。
  - **preview 实证**:本地 daemon 经 `POST /inbox/ask`+`/notify` 造 1 question+1 briefing → viewer actions 页 DOM 实测 `questionCards:1, briefingCards:1, evidenceBtns:1, hasOldText:false, rendersCode:true`,实证后已 dismiss 清理 demo 数据。
  - 基线:`npm run pre-pr` 130 文件 / 1376 用例全绿。

### STEP-C3 — 动作:回应 / 知道了 / 转待处理 / 看原文
- **改动面**:`src/viewer/index.html`。question 卡:「回应」行内输入 → `inbox-answer`;briefing 卡:「知道了」→ `inbox-answer`(空 answer,标已读)。两者通用:「转待处理」→ `inbox-dismiss` + `action-create`;「看原文」复用 STEP-03 `jumpToEvidence`。
- **结果预测**:build + 单测(动作分发);preview 实证回应/已读后卡片归档、转待处理后落入待处理区。
- **风险**:`inbox-dismiss` + `action-create` 两步要原子感(失败回滚提示),前端串行调用。
- ✅ **实际反馈(已实现,待开 PR)**:
  - 仅改 `src/viewer/index.html`。`renderInboxCard` 加动作按钮(question:回应…/转待处理/知道了;briefing:知道了/转待处理),`state.inbox` 加 `replyingId` 驱动行内输入框的展开。
  - 四个 async handler:`submitInboxReply`(`POST inbox/answer {id,answer}`,空回应前端拦 flashHint)、`ackInboxItem`(空 answer = 已读)、`convertInboxToTodo`、`openInboxReply`/`cancelInboxReply`(切换 replyingId)。
  - **转待处理的两步原子感**:**先** `POST actions {title: body.slice(0,120)}` 成功**再** `POST inbox/dismiss`;若 dismiss 失败 → 不剔除本地项 + flashHint「已建待办,但收件箱项未消解,请手动知道了」,避免「dismiss 了却没建 action」的丢条目。顺序刻意是 create-then-dismiss(宁可多一条待办,不可丢)。
  - **乐观更新**:动作成功后 `removeInboxItemLocal` 本地剔除该项 + `renderActions()` 重渲,不全量 loadActions 抖动;转待处理额外触发 `loadActions({generate:false})` 让新待办进待处理区。
  - 「看原文」复用 STEP-03 `data-action="jump-to-evidence"`,零新增。
  - 测试:`test/viewer-inbox-section.test.ts` 加 5 例(动作按钮存在性、briefing 无回应、replyingId 驱动输入框、removeInboxItemLocal 剔除+清回应态)。**preview 三流实证**:回应→后端 `answered` + 回应文本入库 + 卡片移除;转待处理→后端 inbox `dismissed` + 新 action 标题取 body + 卡片移除;空态正确。实证后已清理 demo(action 置 cancelled)。
  - **踩坑**:Edit 替换 `renderActions(){` 时把函数声明行一并吞掉,导致 viewer JS 语法断裂——但 tsdown 把 HTML 当字符串资产打包、**不做 JS 解析,build 仍绿**,是 viewer 测试的 VM sandbox 才暴露(`Unexpected token`)。教训:viewer 改动光看 build 过不够,必须跑 viewer 测试或 preview。
  - 基线:`npm run pre-pr` 130 文件 / 1382 用例全绿。
  - ✅ **review 收口(PR 待开)**:[P2] 转待处理缺防重入,慢网双击会重复建待办——加 `state.inbox.pendingById[id]`,三个 async 动作进入即标记 + 按钮渲染 `disabled`/「处理中…」,`finally` 清标记;`isInboxPending` 早返回挡住重复提交。[P3] 补 7 例 VM mock `apiPost` 异步测试:回应带 answer / 空回应不发请求 / 知道了空 answer / 转待处理 create→dismiss 两步 / create 失败不 dismiss 不剔除 / dismiss 失败保留条目 / 防重入 race(in-flight 时第二次调用零请求)。preview 实证:双击 `convertInboxToTodo` 仅 1 次 create(后端确认仅建 1 条待办)。1389 用例全绿。

### STEP-C4 — 「已完成」区(只读 done,可与 C3 并行)
- **改动面**:`src/viewer/index.html`。新增折叠区,筛 `state.actions.items` 里 `status==="done"` 且当天 `updatedAt`。
- **结果预测**:build + 单测;零后端改动;preview 实证折叠/展开。
- **风险**:极低。纯前端筛现有数据。
- ✅ **实际反馈(已实现,待开 PR)**:
  - 仅改 `src/viewer/index.html`。`state.actions` 加 `doneExpanded`(默认 false);新增 `isUpdatedToday`(本地日期判定)+ `renderDoneTodaySection(doneItems, frontierIds, cardRenderer)`。
  - **默认视图改造**:无筛选时 `done` 不再混进常规分组流(`['active','blocked','pending','cancelled']`),改由底部「🟢 已完成」折叠区单独承载、且**只显当天** `updatedAt` 的;点「已完成」筛选 chip(`statusFilter==='done'`)时仍照常全列、不走折叠区。
  - 折叠区是 `<button data-action="toggle-done-today">`,`aria-expanded` + ▸/▾ 反映 `doneExpanded`;展开才渲染卡片。
  - **踩坑**:`renderActionCard` 是 `renderActions` 的**内嵌函数**,顶层的 `renderDoneTodaySection` 闭包看不到它——直接引用会 `ReferenceError`(build 仍绿,VM sandbox 暴露)。改为把 `renderActionCard` 作为 `cardRenderer` 参数传入。教训同 C3:viewer 改动必跑测试/preview,build 过 ≠ JS 正确。
  - 测试:新增 `test/viewer-done-section.test.ts`(5 例:isUpdatedToday 当天判定、折叠区只收当天 done、展开渲染卡片、无当天 done 不渲染、默认视图 done 进折叠区而 done 筛选照常全列)。**preview 实证**:造 1 条当天 done → 折叠区显示「今天完成了 1 件」、aria-expanded=false/0 卡;点击展开→true/1 卡;再点→收起。实证后 demo action 置 cancelled。
  - 基线:`npm run pre-pr` 131 文件 / 1394 用例全绿。

## 5. 一致性铁律连带清单(C1 已守完,留作 C1.5+ 参照)

> C1 新增 MCP 工具/REST/KV/audit 时已按下表全改,`consistency.test` 绿 = 已对齐。**C1.5 起若再动工具/端点计数,仍按此表逐项过。**

C1 落实情况(✅ 已改):
- [x] `src/mcp/tools-registry.ts`(`INBOX_TOOLS` 定义 + getAllTools)
- [x] `src/mcp/server.ts`(`memory_inbox_ask`/`memory_inbox_notify` 合并 case)
- [x] `src/triggers/api.ts`(5 REST 孪生 `/agentmemory/inbox*`)
- [x] `src/index.ts`(`registerInboxFunction` 注册 + 端点计数 131→**136**)
- [x] `test/mcp-standalone.test.ts`(工具计数 → **55**)
- [x] `README.md`(MCP 工具 53→55 + REST 端点 131→136,consistency.test 锁定)
- [x] `AGENTS.md`(REST "136 REST endpoints" + Current Stats)
- [x] `plugin/.claude-plugin/plugin.json`(工具数 55,description)
- [x] `src/state/schema.ts` + `src/types.ts`(KV scope `mem:inbox` + `InboxItem`)
- [x] `src/types.ts` `AuditEntry.operation`(`inbox_ask`/`inbox_notify`/`inbox_answer`/`inbox_dismiss`)
- [x] ⚠️ **额外踩坑**:`test/session-highlights-api.test.ts` 硬编码端点数 131,本地 check 脚本扫不到,手动改 136
- [x] 推前 `npm run check:consistency-local` → `npm run pre-pr`(均绿)

> **C1.5 提示**:新增 skill **不**触发 MCP/REST/KV 连带,但 skill 计数 12→14 建议同步 `AGENTS.md` Current Stats + `plugin/.claude-plugin/plugin.json` description(skill 计数不被 consistency.test 锁,纯文档)。

## 5.5 C1 落地的 wire 契约(C2/C3 直接消费,免回查源码)

C2/C3 前端按此对接,无需再读 `inbox.ts`:

```text
POST /agentmemory/inbox/ask      body: {body, fromAgent?, project?, sourceObservationIds?, sourceSessionId?, priority?, expiresInMs?}  → 201 {success, item}
POST /agentmemory/inbox/notify   body: 同上                                                                                          → 201 {success, item}
GET  /agentmemory/inbox          query: ?status=awaiting&kind=question&limit=50  (全可选,无需 agentId)                              → 200 {success, items[]}
POST /agentmemory/inbox/answer   body: {id, answer?}   (空 answer = briefing 已读/ack)                                              → 200 {success, item}
POST /agentmemory/inbox/dismiss  body: {id}                                                                                         → 200 {success, item}
```
- `item` = `InboxItem`(见 §2):`{id, kind, body, status, priority?, fromAgent?, project?, sourceObservationIds?, sourceSessionId?, answer?, createdAt, answeredAt?, expiresAt?}`。
- `list` 默认按 `createdAt` 倒序、滤掉过期项;**C2 拉 `?status=awaiting` 即得待回应+待读通知两类**,前端按 `kind` 分区。
- 写侧 MCP 工具仅 `memory_inbox_ask` / `memory_inbox_notify`(给 Agent);**读/答/消解走 REST**(viewer 用)。

## 6. 验证(沿用线 A 配方)
- 每步 `npm run pre-pr`(自检 + build + test)。
- viewer 改动用 preview 实证(`scripts/viewer-preview-proxy.cjs` + launch.json viewer-proxy):造几条 inbox → 截图/inspect/console-error。
- C1 后端用 `curl localhost:3111/agentmemory/inbox*` 验 wire shape。

## 7. 依赖图
```text
C1(后端 inbox 原语) → C1.5(Agent 接入点 skill,⭐核心) → C2(viewer 接真) → C3(动作)
                                                       → C4(已完成只读 done,可与 C3 并行)
```
C1.5 紧跟 C1:原语一就绪就让 Agent 能往里写,避免「前端接好了却没数据」。

## 8. 待人工审阅 / 拍板的点

### 已在第一轮审阅落实(见 §0.5)
- ✅ 1 认可新建 inbox · ✅ 2 三动作流转正确 · ⭐ 3 Agent 主动发送+整理升级为核心(C1.5)· ⏸️ 4 优先级本轮不处理 · ⛔ 5 飞书本轮不做。

### 仍需你确认
1. **§0.5 第 3/5 边界澄清**:本轮「Agent 直接通知用户」= 写入**工作台收件箱**(本地、打开即见),**不含**手机/桌面主动推送(那依赖飞书,排后线 D)。这个理解对吗?——若你期望本轮就有「真·推送到手机」,那第 5 点要重新讨论(会显著扩大范围)。**(已按此边界开工 C1)**
2. **§4 C1.5 skill 触发判据**:`ask-user`(何时该问)与 `organize-todos`(何时该主动整理汇报)的措辞,要让 Agent 在「真该问/真该报」时才写,避免收件箱被噪音淹没。这是产品体验成败关键——**C1.5 开工时出 skill 文案,请重点过这一眼**。
3. **briefing 自动触发**:`organize-todos` 本轮靠 skill 引导 Agent **主动**调,不做会话结束 hook 自动触发(避免误触)。认可先手动引导、自动化排后?

### 进展(2026-06-13)
- ✅ 规划文档审阅通过、边界锁定(Agent 主动写→工作台收,不接飞书)。
- ✅ **C1 已交付合并**([PR#19](https://github.com/MaimoryLab/agentmemory-lab/pull/19),main baa5771)——后端 inbox 原语全套就绪、CI 全绿。
- ✅ **C1.5 已交付合并**([PR#21](https://github.com/MaimoryLab/agentmemory-lab/pull/21),main a22e411)——`ask-user`/`organize-todos` 两个 Agent 自主 skill + 真实触发场景端到端测试。
- ✅ **C2 已交付合并**([PR#22](https://github.com/MaimoryLab/agentmemory-lab/pull/22),main fd6be27)——viewer 待回应区接真 inbox 数据(question/briefing 双卡、看原文、preview 实证)。
- ✅ **inbox REST 收口合并**([PR#23](https://github.com/MaimoryLab/agentmemory-lab/pull/23),main 0f2d7f9)——review [P2/P3]:写端点字段白名单 + 空白正文 400。
- ✅ **C3 已合并**([PR#24](https://github.com/MaimoryLab/agentmemory-lab/pull/24),main c8887a6)+ 防重入收口([PR#25](https://github.com/MaimoryLab/agentmemory-lab/pull/25),main c679732)——四动作接 inbox-answer/dismiss + action-create,乐观更新+防重入,preview 实证。
- ✅ **预览代理修复**([PR#26](https://github.com/MaimoryLab/agentmemory-lab/pull/26),main 54493f8)——viewer 预览代理端口自动发现,消除多 worker 端口漂移误判。
- ✅ **C4 已实现**——待办栏底部「已完成」只读折叠区,筛 done 当天项,默认折叠,preview 实证,待开 PR。
- 🎉 **线 C 全栈贯通(C1→C4)。** 后续可选:优先级算法、飞书投递出口(线 D)、briefing 自动触发 hook。


