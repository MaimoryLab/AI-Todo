# 线 D 方案:收件箱跨设备投递(飞书推送)

> 状态:**草案 v2,待人工审阅**。前置:线 C(收件箱全栈 C1→C4)已交付合并(main `a308c8d`+)。lark-cli 与 27 个 lark-* skill 已装,**bot 身份已就绪**(appId `cli_aa9eb0457cfadbc3`,`lark-cli auth status` = bot ready)。
> 日期:2026-06-15 · 基线:`@agentmemory/agentmemory` v0.9.24 · 沟通信道:`lark-cli`(`/opt/homebrew/bin/lark-cli` v1.0.50)。
> 方法论沿用线 A/C 验证有效的工作流:一步一 PR、预测后回填、preview/实跑实证、文档零 CI。
>
> **v3 拍板更新(2026-06-15)**:在 v2(都推 + 回复闭环必做)基础上 ——④ 回复映射**选方案 A(单未决假设)**(§9.2)⑤ 目标 **open_id 已给:`ou_e569d0bfc85638755d4d805100832fb1`**,并已**实发一条 bot 私聊验证通过**(`message_id om_x100b...`,P2P `chat_id oc_15d763954d0416d4759afe452bef0d39`)——bot→你的推送链路已确证可用。剩余仅 §8 三个轻量确认(沟通方式 A / 加急策略 / p2p scope),均有默认、无异议即采纳。

## 进度看板(2026-06-15)

| STEP | 内容 | 状态 |
|---|---|---|
| **D1** | 投递原语后端:`mem::inbox-deliver` 函数 + 投递配置 + audit + 去重 | ✅ **已合并** [PR#34](https://github.com/MaimoryLab/agentmemory-lab/pull/34)(main 658e7b4,纯后端默认关,7 例测试 + CI 4 格绿;适配器 D1 桩、D2 实接) |
| **D2** | lark-cli 适配器:把 InboxItem 渲染成飞书消息(卡片/markdown)并发出 | ✅ **已合并** [PR#35](https://github.com/MaimoryLab/agentmemory-lab/pull/35)(main 6a837f4,真 execFile 实接、9 例测试 + CI 4 格绿;**真发验证**:question 卡片 + briefing 各一条 `ok:true`,urgent 缺 scope 正确降级) |
| **D3** | 挂接 inbox 写路径:ask/notify 后 fire-and-forget 触发投递 | ✅ **已合并** [PR#36](https://github.com/MaimoryLab/agentmemory-lab/pull/36)(main 9cecd5c,只改 inbox.ts、4 新测试)+ **关键修复** [PR#40](https://github.com/MaimoryLab/agentmemory-lab/pull/40)(main fca8a41):原 dispatch 用了 iii-sdk 0.11.2 不存在的 `sdk.triggerVoid`,投递从未真正发生,改用 `sdk.trigger({action:TriggerAction.Void()})`,真发复验通过 |
| **D4** | 投递状态回写 + viewer 呈现(已推送/推送失败标记) | ✅ **已合并** [PR#41](https://github.com/MaimoryLab/agentmemory-lab/pull/41)(main 612bd28,**不新增端点**、inbox-list join `mem:delivery`、9 新测试 + CI 4 格绿;真发实证工作台显示「已推送 ✓」) |
| **D5** | **飞书内回复闭环**:bot 订阅收信 → 回复映射回 inbox-answer(**本轮必做**) | ⬜ 待开工(依赖 D3,见 §9) |

> **里程碑**:线 C 已让「Agent 写 → 落库 → 用户**打开工作台**才看到」。线 D 补上**跨设备主动触达 + 飞书内回复闭环**——Agent 抛出 question/briefing 后,飞书 bot 主动私聊推给用户(D1-D4);用户**直接在飞书回一句**就把对应 question 在工作台标记 answered(D5)。推送 + 回复双向都在飞书完成,工作台与飞书互为镜像。

---

## 0. 一句话

线 C 的收件箱是"拉"模型(用户主动开工作台看);线 D 加"推"模型(条目产生即推飞书)。**只做出口投递,不改收件箱语义本身**——inbox 仍是真相源,飞书是它的一个投递通道(送达面之一,与工作台并列)。

## 0.5 边界(开工前先锁,避免重蹈线 C 范围蔓延)

| # | 议题 | 草案立场(待你拍板) |
|---|---|---|
| 1 | 推什么 | ✅ **已定:question + briefing 都推**,但分级:question(Agent 在等你回)走**加急/卡片**;briefing(知悉即可)走**普通 DM**,不加急。 |
| 2 | 推给谁 | 本轮**只推给单个用户**(收件箱本就是单用户语义)。目标 user 由配置 `AGENTMEMORY_LARK_USER_ID` 指定。不做群推、不做多人分发。 |
| 3 | 用什么身份 | **bot 身份(`--as bot`)**:只需 appId+appSecret、免 `auth login`、适合后台 daemon 无人值守。bot 私聊推给用户。**已核:`lark-cli auth status` → bot ready**。 |
| 4 | 触发时机 | 条目**落库后** fire-and-forget 触发(不阻塞 inbox 写)。投递失败**不影响** inbox 落库——飞书只是额外通道,工作台始终能看到。 |
| 5 | 回执闭环 | ✅ **已定:本轮做**(D5,见 §9)。bot 订阅 `im.message.receive_v1` 收用户私聊回复 → 映射回对应 question → 写 `mem::inbox-answer`。**映射是难点**(飞书收信事件不带"回复哪条"的 parent 字段,见 §9 三个方案)。 |
| 6 | 去重/幂等 | 每个 InboxItem **至多推一次**。用 `lark-cli` 的 idempotency key + 本地投递台账(KV `mem:delivery`)双保险,避免重启/重试重复打扰。回执侧用事件 `event_id`(schema 标注 dedup-safe)去重。 |
| 7 | 失败处理 | best-effort + 有限重试。投递失败记 audit + 在 viewer 标「推送失败」,但**绝不**因投递失败阻塞或回滚 inbox。 |
| 8 | 默认开关 | **默认关闭**(`AGENTMEMORY_LARK_DELIVERY=false`)。未配置 user-id/未开关时,inbox 行为与线 C 完全一致,零副作用。显式开启才推。回执订阅另有开关 `AGENTMEMORY_LARK_REPLY_LOOP`。 |

## 1. 项目 ↔ lark-cli 的沟通方式(核心)

调研结论:仓库现无任何投递层(grep `delivery/notify/webhook/lark/feishu/slack` 仅命中注释与 inbox 自身命名),线 D 是绿地新建。沟通有两条候选路径,**本方案选 A(lark-cli 子进程)为主**:

### 路径 A — `lark-cli` 子进程(选用)

项目后端通过 `child_process.execFile` 调 `lark-cli`,把 InboxItem 发成飞书消息。

- **先例**:`src/functions/branch-aware.ts:8-14` 已有 promisified `execFile` 封装(`{ cwd, timeout: 5000 }`)。线 D 复用同款模式。
- **为什么选它**:你已装好 lark-cli + 27 skill + 完成 `config init`,bot 身份免授权即用;lark-cli 封装了 token 刷新、加急、卡片、幂等键、风险门禁,项目侧不必自己管飞书 OpenAPI 与鉴权。
- **调用形态**(参数数组,绝不 `sh -c` 拼接,遵循 lark-shared 安全规则):
  ```
  execFile("lark-cli", [
    "im", "+messages-send",
    "--as", "bot",
    "--user-id", "<AGENTMEMORY_LARK_USER_ID>",
    "--msg-type", "interactive",      // question 用卡片;briefing 用 "text"/markdown
    "--idempotency-key", "<item.id>", // 幂等:同一 InboxItem 重发不重复
    "--json"
  ], { input: <message-json via stdin>, timeout: 8000 })
  ```
  > 数据(消息体 JSON)走 **stdin**,不走命令行参数——避免长 JSON 转义与 `unsafe file path`(lark-shared §安全规则)。
- **输出解析**:lark-cli `--json` 返回 `{ message_id, ... }`;失败时 exit≠0 + stderr JSON。需识别 **exit 10 = `confirmation_required`**(高风险写门禁),但 `im +messages-send` 非高风险,正常不触发——若触发则记失败、不静默加 `--yes`(lark-shared §exit 10 铁律)。

### 路径 B — Webhook `fetch`(备选,不在本轮)

直接 `fetch` 飞书自定义机器人 webhook。先例 `src/functions/mesh.ts:262` 的外呼 + SSRF 守卫(`mesh.ts:35`)。
- 优点:无 lark-cli 依赖、纯 HTTP。缺点:能力受限(无加急、卡片交互弱、需自管 webhook 签名)、且 webhook 机器人通常绑群而非私聊单用户。
- **结论**:本轮不用。若将来要去 lark-cli 依赖(类似线 B 的去 Docker 取向),B 作为退路保留。

### 身份与认证(bot 身份)

- `--as bot` → `tenant_access_token`,只需后台配好 appId+appSecret,**无需 `auth login`**(lark-shared §身份选择原则)。适合 daemon 无人值守。
- 前置:用户需在飞书开发者后台给 bot 开通 `im:message`(发消息)、`im:message.urgent`(应用内加急)等 scope,并把 bot 加入可见范围 / 与目标用户建立可私聊关系。**这一步是人工配置,计划文档需把 scope 清单和配置链接列清**(见 §6 前置清单)。
- 权限不足时 lark-cli 返回 `permission_violations` + `console_url`——项目侧投递失败时把这些透传进 audit/viewer,引导用户去后台补 scope。

## 2. 输出方式(InboxItem → 飞书消息)

按 kind 分级渲染,对齐线 C 的 question/briefing 二分:

### question(🔴 Agent 在等你回)→ 交互卡片 + 加急

- **消息类型**:`interactive`(飞书卡片),含标题「🔴 Agent 在等你回」、正文(item.body 的 Markdown)、来源(fromAgent)、以及一个**「去工作台回应 →」按钮**(链接到 viewer `#actions`,作为飞书内回复=D5 之外的备选路径)。卡片底部注明「直接回复将回答这条」(配合 §9.2 方案 A)。
- **加急**:发送后对该 message 调 `lark-cli im messages urgent_app`(应用内加急,需 `im:message.urgent` scope),确保时间敏感问题不被淹没。是否加急可由 `item.priority` 或配置 `AGENTMEMORY_LARK_URGENT_QUESTION` 控制。
- **降级**:若卡片能力不可用(scope 缺失),降级为 markdown 文本 DM,正文末尾附工作台链接。

### briefing(📋 知悉即可)→ 普通 markdown DM

- **消息类型**:`text`(markdown),不加急。标题「📋 Agent 整理」+ item.body + 「看详情 →」工作台链接。
- 与线 C 工作台里 briefing 默认折叠的低优先级定位一致——飞书侧也安静推送,不打扰。

### 消息体构造原则

- **正文 = item.body 原样**(已是 Markdown,Agent 写时遵循 ask-user/organize-todos skill 的格式)。飞书 markdown 子集与 viewer 的 renderMarkdownSafe 略有差异,但 body 本身是 Agent 产出的规范 Markdown,直接透传即可;路径类用反引号包裹(skill 已约定)。
- **附工作台深链**:每条消息都带回 viewer 的链接(`#actions`),让"飞书看到 → 一键回工作台操作"路径顺滑,弥补本轮不做飞书内回执。
- **不在消息里塞敏感数据**:body 由 Agent 控制;sourceObservationIds 等内部 id 不进飞书消息(隐私 + 无意义)。


## 3. 数据模型(投递台账,新增)

投递状态**不污染** InboxItem 主体——单独建投递台账,inbox 仍是真相源。

```ts
// src/state/schema.ts 新增 KV scope:delivery: "mem:delivery"(与 inbox 同级)
// src/types.ts 新增接口
interface DeliveryRecord {
  id: string;              // = InboxItem.id(一对一,天然去重键)
  channel: "lark";         // 本轮只有 lark;预留多通道
  status: "sent" | "failed" | "skipped";
  messageId?: string;      // lark message_id(om_xxx),回执/撤回用
  urgent?: boolean;        // question 是否加急成功
  error?: string;          // 失败原因(透传 lark-cli stderr 摘要 / permission_violations)
  attempts: number;        // 重试计数
  createdAt: string;
  deliveredAt?: string;
}
```

- 去重:投递前查 `kv.get(KV.delivery, item.id)`,已 `sent` 则跳过(`status:skipped` 不重记)。配合 lark-cli `--idempotency-key=item.id` 双保险。
- viewer 读这张表给卡片标「已推送 ✓ / 推送失败 ⚠」(D4)。

## 4. STEP 拆解(每步 = 一个 PR,薄切、可验证、可回滚)

> 合并顺序 D1 → D2 → D3 → D4 →(可选 D5)。D1/D2 可并行起草,但 D3 挂接前两者都要在。

### STEP-D1 — 投递原语后端(函数 + 配置 + 台账 + audit)
- **改动面**:
  - `src/config.ts`:`getLarkConfig()`(读 `AGENTMEMORY_LARK_USER_ID` / `AGENTMEMORY_LARK_URGENT_QUESTION`)+ `isLarkDeliveryEnabled()`(读 `AGENTMEMORY_LARK_DELIVERY === "true"`,默认 false)。仿 `config.ts:187` 的 `is*Enabled()` 范式。
  - `src/state/schema.ts` + `src/types.ts`:KV scope `mem:delivery` + `DeliveryRecord` 接口(KV 连带 2 处)。
  - `src/types.ts` `AuditEntry.operation`:加 `inbox_delivered` / `delivery_failed`(audit 连带 1 处)。
  - `src/functions/inbox-deliver.ts`(新):`mem::inbox-deliver`(入参 `{item}`)——查去重 → 调适配器(D2)→ 写 `DeliveryRecord` → `safeAudit`。注册于 `src/index.ts`(仿 `registerInboxFunction`,index.ts:314)。
  - `test/inbox-deliver.test.ts`(新):去重(已 sent 跳过)、配置门(未开/缺 user-id 直接 skipped)、台账写入、失败记录。**适配器(lark-cli 调用)在测试里 mock 掉**,不真发飞书。
- **结果预测**:build + test 绿;**不新增 MCP 工具/REST 端点**(投递是内部 fire-and-forget,无对外接口),故**不触发**一致性铁律的 8 处/3 处连带,只动 KV(2)+audit(1)。
- **风险**:低。纯后端、有开关、默认关。
- ✅ **实际反馈([PR#34](https://github.com/MaimoryLab/agentmemory-lab/pull/34) 已合并,main 658e7b4,CI 4 格绿)**:
  - `config.ts`:`isLarkDeliveryEnabled()`(`DELIVERY==="true"` **且** user-id 有值)、`isLarkReplyLoopEnabled()`(D5)、`getLarkConfig()`→`{userId,urgentQuestion}`(缺 user-id 返 null)。
  - `schema.ts` KV `delivery:"mem:delivery"`;`types.ts` `DeliveryRecord` + audit ops `inbox_delivered`/`delivery_failed`(KV 2 + audit 1)。
  - `inbox-deliver.ts`:配置门(关/无配置→写 `skipped`、不调适配器)+ 去重(`sent` 跳、`failed` 重试 attempts++)+ 成功 `sent`+audit / 失败 `failed`+audit。台账独立 KV,inbox 不改。
  - `lark-adapter.ts`:**D1 桩**(冻结契约、默认返 `pending STEP-D2`),注入式 → 测试传桩;真 lark-cli execFile 在 D2。
  - `test/inbox-deliver.test.ts` 7 例(配置门/去重/失败重试/audit/briefing),`vi.mock` config + `vi.fn` 注入 adapter,零飞书依赖。
  - **不新增 MCP工具/REST端点 → 不触发一致性 8/3 连带**(符合预测),只动 KV+audit。pre-pr 132 文件/1409 用例 + CI 4 格全绿。
### STEP-D2 — lark-cli 适配器(InboxItem → 飞书消息)
- **改动面**:
  - `src/functions/lark-adapter.ts`(新):`deliverViaLark(item, config)`——按 kind 构造消息 JSON、`execFile("lark-cli", [...], {input, timeout})`(仿 `branch-aware.ts:8`)、解析 `--json` 输出、question 成功后调加急、返回 `{messageId, urgent, error}`。
  - 渲染:question→`interactive` 卡片(标题+body+来源+「去工作台」按钮);briefing→`text` markdown。
  - 安全:参数数组形式、数据走 stdin、识别 exit 10 不静默 `--yes`、不打印密钥(lark-shared 全套铁律)。
- **结果预测**:单测覆盖消息体构造(给定 item → 期望 argv + stdin JSON 形状),**execFile 用 mock/注入**;真发飞书走手动实跑验证(见 §5)。
- **风险**:中。飞书消息体格式、卡片 schema、加急 scope 需实跑校准。这步最可能反复。
- ✅ **实际反馈([PR#35](https://github.com/MaimoryLab/agentmemory-lab/pull/35) 已合并,main 6a837f4,CI 4 格绿)**:
  - 真接 `execFile` lark-cli,注入式 `CliRunner`(测试 mock,默认 `realRunner` 真发)。**永不抛错** → `{ ok:false, error }`。
  - **3 处实跑校正(开工前用户真测推翻原计划假设)**:① `--content` **不接受 stdin `-`**(报 `--content is not valid JSON: -`),正文必须作为 argv 参数 `--content JSON.stringify(card)`;② `--markdown` 被 CLI 包装成 `msg_type=post`(非 text);③ lark-cli 遇本地代理会告警 → `realRunner` 设 `LARK_CLI_NO_PROXY=1` 并清理 proxy env,直连飞书。
  - question→`--msg-type interactive --content <card-json>`;briefing→`--markdown`;均带 `--idempotency-key item.id --json`。urgent_app **接受** `--data -`(stdin body `{user_id_list:[userId]}`)。
  - **urgent 失败降级**:`urgent_app` 失败(如缺 `im:message.urgent` scope)→ 记 warn、返 `urgent:false`,**投递仍成功**,不是投递失败。
  - **真发验证(本地手动,非 CI)**:向真实用户各发一条——question 卡片 `om_x100b6dcd1bfdcca8b2fd1303b959040`、briefing `om_x100b6dcd1b800ca4b2571c568b75ae6`,均 `ok:true`;`urgent_app` 返 access-denied(bot 未授予 `im:message.urgent`),**正确降级 `urgent:false`**——印证降级路径符合设计。
  - `test/lark-adapter.test.ts` 9 例 mock CliRunner 零飞书依赖;不新增 MCP/REST → 不触发一致性 8/3 连带。

> **D2 渲染最终形态修正**:原计划 §D2 写「briefing→text markdown」,实跑证明 `--markdown` 出 `msg_type=post`;urgent scope(`im:message.urgent`)bot 当前未授予,降级路径已覆盖,后续如需真加急需在飞书开放平台补该 scope。

### STEP-D3 — 挂接 inbox 写路径(fire-and-forget)
- **改动面**:`src/functions/inbox.ts`。`mem::inbox-ask`(`:27` kv.set 后)与 `mem::inbox-notify`(`:50` 后)各加:
  ```ts
  if (isLarkDeliveryEnabled()) {
    try { sdk.triggerVoid("mem::inbox-deliver", { item }); }
    catch (e) { logger.warn("lark delivery dispatch failed", e); }
  }
  ```
  仿 `events.ts:51/66` 的 `triggerVoid` + try/catch-only-log 范式。**投递失败绝不冒泡到 inbox 写**。
- **结果预测**:`test/inbox.test.ts` 现有 9 例不受影响(默认关);加 1-2 例验「开启时触发 deliver、关闭时不触发」(mock triggerVoid)。
- **风险**:低。一处薄挂接,有开关保护。
- ✅ **实际反馈([PR#36](https://github.com/MaimoryLab/agentmemory-lab/pull/36) 已合并,main 9cecd5c,CI 4 格绿)**:
  - **只改 `src/functions/inbox.ts`**(+ test):新增 `dispatchDelivery(sdk, item)` helper——`isLarkDeliveryEnabled()` 开关保护、`triggerVoid("mem::inbox-deliver",{item})` 包 try/catch、失败只 `logger.warn` 吞掉。在 ask/notify 各自 `kv.set`+`recordAudit` **之后**调用。
  - **`mem::inbox-deliver` 是注册的 function**(非 trigger),`triggerVoid` 按 id 直接 fire-and-forget,无需额外 trigger 包装——核实 events.ts:51 `triggerVoid("mem::slot-reflect")` 同样是触发 function。
  - 测试:原 9 例行为不变(默认关 → guard 在 triggerVoid 前短路,mock sdk 加 `triggerVoid` spy 不被调用)。新增 4 例:关闭不触发 / 开启 ask 用持久化 item 触发 / 开启 notify 触发 / triggerVoid 抛错仍 success 且 item 落库。
  - **不新增 MCP/REST/KV scope/audit op → 不触发一致性连带。**
  - **🎉 第一条完整链路贯通**:Agent 写 inbox(ask-user/organize-todos skill)→ inbox-deliver 自动触发 → lark-adapter 真发 → 飞书 bot 私聊收到。剩 D4(viewer 状态回写)+ D5(飞书回复闭环)。
  - **真加急 scope 仍未挡**:缺 `im:message.urgent` 只是 `urgent:false` 降级,推送链路已可用;若要 question 带飞书加急横幅,去开放平台补 scope 即可(非阻塞)。

### STEP-D4 — 投递状态回写 viewer
- **改动面**:`src/triggers/api.ts`(inbox-list 响应里 join DeliveryRecord,或新增 `GET /agentmemory/delivery`)+ `src/viewer/index.html`(卡片角标「已推送 ✓ / 推送失败 ⚠ + 原因」)。
- **结果预测**:REST 若新增端点则触发端点计数连带(3 处);viewer 加单测 + preview 实证。
- **风险**:低-中。看是否新增端点(影响一致性铁律)。
- ✅ **实际反馈([PR#41](https://github.com/MaimoryLab/agentmemory-lab/pull/41) 已合并,main 612bd28,CI 4 格绿)**:
  - **选了 join、不加端点**:`api::inbox-list` 对每条 item 读 `kv.get(KV.delivery, item.id)`,附加只读 `delivery` 字段 `{channel,status,messageId,urgent,error,attempts,deliveredAt}`。**InboxItem 落库结构不动**,字段只在 API 响应里。**端点计数不变 → 不触发一致性 3 处连带。**
  - viewer `inboxDeliveryBadge`:sent→「已推送 ✓」(urgent 加「· 加急」)/ failed→「推送失败 ⚠」+ ≤60 字短错误(完整在 title)/ skipped→不显示(投递未开启不污染 UI)。错误走 `esc()` 防 XSS。渲在卡片头部时间戳后。
  - 测试:`inbox-skill-trigger.test.ts` +2(join 正确、落库不含 delivery 键)、`viewer-inbox-section.test.ts` +7(sent/urgent/failed/截断/skipped 静默/无 delivery 向后兼容/错误 XSS)。
  - **真发实证**:开投递→inbox-ask 真推飞书→台账记 sent→GET /inbox 带出→preview DOM 实测卡片 badge = 「已推送 ✓」。
  - **⚠ 本轮捎带发现并修了 D3 的硬 bug**:真发实证时发现 D3 的 `sdk.triggerVoid` 在 iii-sdk 0.11.2 根本不存在(`grep -rln triggerVoid node_modules/iii-sdk/dist/` 零命中),投递一直静默失败(被 try/catch 当 warn 吞掉)。**单测过是因为 mock sdk 自带了真实 SDK 没有的 triggerVoid——只 mock 的盲区,务必真发复验**。已在 [PR#40](https://github.com/MaimoryLab/agentmemory-lab/pull/40) 单独修复(改 `sdk.trigger({action:TriggerAction.Void()})`+不 await 加 `.catch`)。**src/ 其它 8+ 处 `triggerVoid` 同源 bug(observe/image/disk/events/api),都藏在很少走的 gated 分支里,已另行登记单独 PR 处理,不在 D3/D4 范围。**
  - **协作踩坑**:并行的「修全仓 triggerVoid」后台任务在同一 worktree 改了 api.ts/events.ts/observe.ts 等,与 D4 工作树串味,差点把它的改动混进 D4 commit(CI `session-end-triggers-graph.test.ts` 断言旧 triggerVoid 字符串才暴露)。**教训:多任务共用 worktree 时,commit 前必 `git show HEAD:<file>` 核对、跑全套(非仅 targeted)**。

### STEP-D5(本轮必做)— 飞书内回复闭环
- **改动面**:新增长驻订阅消费者(`lark-cli event consume im.message.receive_v1 --as bot`)+ 把回复映射回 `mem::inbox-answer`。详见 **§9 专章**(映射方案是核心难点)。
- **结果预测**:订阅进程管理(随 worker 起停、ready marker、优雅退出)+ 映射逻辑单测 + 实跑(飞书私聊回一句 → 工作台对应 question 转 answered)。
- **风险**:**高**(本轮最难一步)。长驻进程生命周期、回复→question 映射(事件无 parent 字段)、鉴权 scope、防重复消费。见 §9。

## 5. 验证(沿用线 A/C 配方)

- 每步 `npm run pre-pr`(自检 + build + test)。
- D1/D2 单测把 `execFile` mock 掉,**不在 CI 里真发飞书**(CI 无 lark 凭证、会泄密/不稳定)。
- **真发飞书走手动实跑**(本地、一次性):
  ```bash
  # 开关 + 配置就绪后,本地造一条 question 触发投递,人工确认手机收到推送
  AGENTMEMORY_LARK_DELIVERY=true AGENTMEMORY_LARK_USER_ID=<ou_xxx> \
    curl -X POST localhost:3111/agentmemory/inbox/ask -d '{"body":"线D投递实测","fromAgent":"line-d-test"}'
  # 预期:手机飞书收到 bot 私聊卡片 + 加急;viewer 卡片标「已推送 ✓」
  ```
- 投递台账可直接查:`curl localhost:3111/agentmemory/delivery`(若 D4 加了端点)或 viewer 角标。

## 6. 前置清单(人工配置,开工 D2 前必须就绪)

这些是**用户侧一次性配置**,计划落地前需你确认/操作:

1. ✅ **lark-cli config init 已完成**(已核:bot 身份 ready,appId `cli_aa9eb0457cfadbc3`,配置在 `~/.lark-cli/config.json`)。
2. **bot scope**(飞书开发者后台开通,见 lark-im / lark-event §权限表):
   - `im:message`(发消息,必需)
   - `im:message.urgent`(应用内加急,question 加急用;不开则降级为不加急)
   - **`im:message.p2p_msg:readonly`(收私聊,D5 回复闭环必需)** + 后台勾选 `im.message.receive_v1` 事件
   - 失败时 lark-cli 回 `console_url`,照它去后台补。
3. **bot 可私聊目标用户**:bot 加入可见范围,且与目标用户能建立 P2P 会话。
4. ~~目标用户 open_id~~ → ✅ **已给并实发验证**:`ou_e569d0bfc85638755d4d805100832fb1`(P2P chat `oc_15d763954d0416d4759afe452bef0d39`)。填进 `AGENTMEMORY_LARK_USER_ID`。
5. **配置写入** `~/.agentmemory/.env`(config.ts 的 file-env 层自动加载;**已核该文件当前不存在,D1 落地时新建**):
   ```
   AGENTMEMORY_LARK_DELIVERY=true
   AGENTMEMORY_LARK_USER_ID=ou_e569d0bfc85638755d4d805100832fb1
   AGENTMEMORY_LARK_URGENT_QUESTION=true
   AGENTMEMORY_LARK_REPLY_LOOP=true
   ```

> 在这些就绪前,D1(纯后端 + 默认关)可以先做、先合,不依赖飞书配置。

## 7. 一致性铁律连带(参照 AGENTS.md)

- **D1**:不新增 MCP 工具/REST 端点 → **不触发** 8 处/3 处连带。只动 KV scope(schema+types,2 处)+ AuditEntry.operation(types,1 处)。
- **D4**:若新增 `GET /agentmemory/delivery` 端点 → 触发 REST 连带 3 处(api.ts + index.ts 计数 + README)。若只在 inbox-list 里 join 则不新增端点、零连带。**倾向后者**(不新增端点)。
- 版本号:线 D 合并时若 bump version,按 7 处连带走(package.json / version.ts / types.ts / export-import.ts / 对应 test / plugin.json ×2)。
- 每步推前 `npm run check:consistency-local`。

## 8. 待人工审阅 / 拍板的点

> v3 已锁:① 都推 ② 飞书内回复闭环本轮做 ③ bot 配置就绪 ④ 映射方案 A ⑤ open_id 已给并实发验证通过。剩余仅 §8.3/8.4/8.7 三个轻量确认:

1. ~~question + briefing 都推 还是只推 question~~ → ✅ **已定:都推**。
2. ~~回执闭环本轮做不做~~ → ✅ **已定:做**(§9)。
3. **沟通方式选 A(lark-cli 子进程)**:认可用 lark-cli 而非自建 webhook?(回复闭环强依赖 lark-cli 的 event consume,A 几乎是唯一合理选择)。**默认按 A,无异议即采纳**。
4. **加急策略**:question 默认 `urgent_app`(应用内加急)。要不要更激进(`urgent_phone`)或更克制(不加急)?**默认 urgent_app,无异议即采纳**。
5. ~~目标 open_id~~ → ✅ **已给:`ou_e569d0bfc85638755d4d805100832fb1`**,且已**实发一条 bot 私聊验证通过**(`message_id om_x100b...`,P2P `chat_id oc_15d763954d0416d4759afe452bef0d39`)。
6. ~~回复→question 映射方案~~ → ✅ **已定:方案 A(单未决假设)**,见 §9.2。
7. **bot scope 确认**:发消息已验证可用(`im:message` 在)。回复闭环还需 **`im:message.p2p_msg:readonly`**(收私聊)+ 后台勾选 `im.message.receive_v1` 事件——**D5 实跑时若遇 `missing_scope` 我会透传 console_url 给你补**;若你已开通则直接通。加急需 `im:message.urgent`(同理,缺则降级不加急)。

---

## 9. 飞书内回复闭环(D5,本轮必做)— 设计专章

目标:用户在飞书私聊里**直接回一句**,就把对应 question 在工作台标记 `answered` 并写入回复正文,不必再开工作台。

### 9.1 收信机制(已核实)

- bot 订阅 `lark-cli event consume im.message.receive_v1 --as bot` → 用户私聊消息以 **NDJSON** 流到 stdout。
- **scope**:`im:message.p2p_msg:readonly`(后台需开通 + console 勾选 `im.message.receive_v1` 事件)。
- 事件字段(已查 schema):`chat_id` / `chat_type`(p2p/group)/ `content`(已渲染成纯文本)/ `sender_id`(ou_)/ `message_id`(om_)/ `event_id`(**dedup-safe**,用它防重复消费)/ `create_time`。
- 订阅是**长驻进程**,lark-event skill 定义了 subprocess 契约:stderr `[event] ready` 就绪标记、stdin EOF 优雅退出、**禁止 `kill -9`**(会泄漏服务端订阅)。

### 9.2 核心难点:回复 → 哪条 question 的映射

**飞书收信事件不带"回复的是哪条消息"的 parent/root/thread 字段**(已查 schema 确认:只有 chat_id/sender_id/content,无 parent_id)。所以一条裸回复无法直接知道它答的是哪个 question。三个候选方案:

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A. 单未决假设**(✅ **已选,本轮做**) | 维护"最近一条未答 question"的指针;用户回复即视为答它 | 实现最简、零额外交互 | 多条 question 同时未决时会答错;需在卡片里提示"回复将答最新一条" |
| B. 引用回复 + 文本锚 | 推送时在 question 正文带短 token(如 `#q3a2`),要求用户引用/带 token 回复;消费侧正则提取 token 反查 inbox 项 | 能精确对应任意一条 | 要求用户带 token,体验差;飞书引用回复在事件里仍不一定回传 parent |
| C. 一问一会话(每条 question 单开 thread/话题) | 用 `+messages-reply --reply-in-thread` 或为每条 question 建独立话题群,回复落在该 thread | 天然隔离、对应精确 | 重(每问一会话)、bot 建话题/群成本高 |

> ✅ **已拍板:本轮做方案 A(单未决假设)**。question 卡片底部明确写「直接回复将回答这条;多条待答请去工作台」。精确映射(B/C)留作 D5.1 增强。
>
> **方案 A 的指针语义(实现要点)**:
> - 投递 question 成功后,把 `item.id` 记为"当前未决指针"(存 KV,如 `mem:delivery` 里的 `pendingReplyTarget`)。
> - 多条 question 接连推送时,指针指向**最新推出**的一条(后推覆盖前指针)。
> - 收到用户回复 → 答指针指向的 question → 答完**清空指针**(下条回复无指针则忽略/提示去工作台)。
> - briefing 不参与指针(briefing 不需要回复,飞书侧用 reaction ack 或直接已读,见 §9.3)。
> - 边界提示:若用户在"无未决指针"时回复,bot 回一句「当前没有在等你回的问题,去工作台看看?」+ 工作台链接。

### 9.3 写回路径

消费者拿到回复后:
1. `event_id` 去重(查 KV,已处理则跳过)。
2. 校验 `sender_id === AGENTMEMORY_LARK_USER_ID`(只认目标用户的回复,别人发的忽略)。
3. 按 §9.2 选定方案定位 question 的 `item.id`。
4. 调 `POST /agentmemory/inbox/answer { id, answer: content }`(复用线 C 现成端点,零新增后端语义)→ 工作台该卡转 `answered`、落 answer 正文。
5. (可选)bot 回一条「✓ 已记录」确认。

### 9.4 进程生命周期(订阅消费者)

- **谁拉起**:agentmemory worker 启动时,若 `AGENTMEMORY_LARK_REPLY_LOOP=true`,spawn 一个长驻 `lark-cli event consume` 子进程(参考 `src/index.ts:542` 的后台 worker 注册 + `.unref()` 范式,但这是子进程非 setInterval)。
- **就绪/退出**:阻塞读 stderr 等 `[event] ready` 再认为订阅生效;worker 关闭时给子进程 **SIGTERM 或关 stdin**(绝不 `kill -9`)。
- **读取循环**:逐行读 stdout NDJSON → 解析 → §9.3 写回。失败隔离(单条解析失败不停整个循环)。
- **风险**:这是线 D 最复杂的部分。子进程崩溃重启、订阅泄漏、worker 与子进程的生命周期耦合都要处理。**建议 D5 单独一个 PR、充分实跑**。

### 9.5 STEP-D5 拆解

- `src/config.ts`:`isLarkReplyLoopEnabled()`(读 `AGENTMEMORY_LARK_REPLY_LOOP`)。
- `src/functions/lark-reply-consumer.ts`(新):spawn + 管理 `event consume` 子进程,读 NDJSON,映射,调 inbox-answer。
- KV scope `mem:delivery` 里复用或加字段存"最近未决 question 指针"(方案 A)+ `event_id` 去重集。
- `src/index.ts`:worker 启动时按开关 spawn 消费者;关闭时优雅停。
- 测试:NDJSON 解析 + 映射 + 去重单测(mock 子进程 stdout);实跑飞书私聊回一句验证闭环。

---

- `README.md`(本文件)— 线 D 总方案。
- 后续可加:`lark-cli-contract.md`(lark-cli 调用参数/输出契约冻结)、`delivery-wire.md`(DeliveryRecord + REST 形状),按需在开工对应 STEP 时补,避免一次写太多空中楼阁。
