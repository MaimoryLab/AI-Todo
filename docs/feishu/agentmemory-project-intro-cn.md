# Agent Memory Lab：本地优先的 Agent 记忆工作台

## 0. 一句话定位

Agent Memory Lab 是一个本地优先的 Agent 记忆工作台，用来把聊天记录、网页资料、项目上下文、个人偏好和可复用经验，整理成可审阅、可复用的工作记忆。

它不是普通聊天记录列表，也不是单独的浏览器收藏夹。它更像一个给 Agent 用的本地工作记忆层：浏览器插件负责捕捉网页线索，Viewer 负责回看、整理和审阅，本地 API 负责把数据写进统一记忆库。

## 1. 为什么需要它

| 痛点 | 现在怎么发生 | 产品机会 |
| --- | --- | --- |
| 每次都要重讲背景 | Agent 不知道上次做到哪，也不知道用户偏好 | 自动沉淀项目上下文和稳定偏好 |
| 有用经验散在聊天里 | README、飞书、Skill 反复靠人工同步 | 把经验进入记忆库，再沉淀进 Skill |
| 网页资料无法自然进入工作流 | 看到竞品、文档、GitHub 页面后还要复制粘贴 | 浏览器插件一键保存网页线索 |
| 本地 Skill 越来越多 | 不知道哪些能力可用，也不知道该维护哪个 | Skill 管理台展示来源、路径和详情 |
| 记忆不一定可信 | 自动保存可能误存隐私或临时信息 | 待审阅、可删除、可编辑 |

核心判断：这个项目不是为了“多存一点东西”，而是为了让 Agent 能持续理解用户、项目和工作方式，同时保留人工审阅权。

## 2. 产品结构：主项目 + 浏览器插件 + 本地 API

| 模块 | 角色 | 负责什么 |
| --- | --- | --- |
| Viewer 工作台 | 回看和整理 | 总览、记忆、会话、Skill、待办、活动 |
| 浏览器插件 | 网页捕捉入口 | 保存当前网页、选中文本、网页相关经验 |
| 本地 API | 数据通道 | 接收记忆、经验、会话、行动 |
| 记忆库 | 本地数据层 | 长期记忆、经验、会话记录 |
| Skill 管理 | 能力层 | 把重复经验沉淀为可复用 Skill |

浏览器插件不是另一个产品，它是 Agent Memory Lab 的网页捕捉入口。它参考 Mem0 / OpenMemory 这类跨 AI 产品记忆插件的 supported-sites 思路：按 ChatGPT、Claude、Gemini、Perplexity 等网页维护站点适配，把记忆召回放到用户正在输入的位置。Agent Memory Lab 的差异是本地优先和审阅后写入：插件只生成候选和召回建议，长期记忆必须回到 Viewer 确认。

数据流：

```text
网页 / AI 输入框 → PageCapture / 本地记忆召回 → 本地审阅队列 → Viewer 确认 → 记忆库 / 经验库
```

当前浏览器插件统一使用 `PageCapture` 数据结构，避免 popup、content script、service worker 各自拼不同数据。

## 3. 当前产品截图

只放两张代表图，避免文档变成截图堆叠。

### 3.1 首页 / 总览

总览页把最近会话、记忆、经验、状态放在一个入口里。项目卡片可以点击进入对应会话，适合作为每天打开的工作台。

[图：总览页截图]

### 3.2 Skill 管理台

Skill 页会扫描本机的 Codex、Agents 和插件 Skill 目录，展示每个 Skill 的来源、路径和详情。它解决的是“本地能力越来越多，但不知道从哪里来、做什么用”的问题。

[图：Skill 管理台截图]

## 4. 当前已完成

| 模块 | 当前状态 |
| --- | --- |
| Viewer | 已有总览、记忆、会话、Skill、待办、活动 |
| README | 已改中文图文版，只保留首页和 Skill 页截图 |
| 飞书文档 | 已同步项目介绍，只保留首页和 Skill 页截图 |
| GitHub | 已推到 `sznnnnn/agentmemory-lab` 的 `szn-viewer-ui-iteration` 分支 |
| 浏览器插件 | MVP 已完成，能把网页候选送到待审阅队列，并提供同步侧栏、连接状态和 AI 输入框记忆提示 |
| 数据结构 | 已统一 `PageCapture`，包含页面类型、候选记忆、候选经验、隐私提示和 AI 输入草稿 |
| Skill 管理 | 已支持搜索、来源筛选、详情查看、复制路径 |
| Skill 草稿 | 已支持从可沉淀经验生成 SKILL.md 草稿，先预览和复制，不自动改本地 Skill |
| 记忆库 | 已支持待审阅入口、保存前编辑、浏览器/会话/手动来源筛选 |
| 插件说明 | 已区分浏览器插件和 Agent/MCP 底层集成 |
| 插件发布物料 | 已补中英文隐私说明、英文商店文案草稿、真实站点验收记录、本地免登录插件预览页、PNG 图标资产，并可生成本地预览 zip |

## 5. 浏览器插件 MVP

浏览器插件位于：

```text
/Users/szn/agentmemory/browser-extension
```

现在支持：

| 功能 | 说明 |
| --- | --- |
| 保存当前网页 | 采集标题、URL、摘要、选中文本、页面结构，并送到待审阅队列 |
| 保存经验 | 在浏览网页时补充一条可复用经验候选 |
| 同步侧栏 | 边浏览边查看页面类型、候选记忆、候选经验和隐私提示 |
| 连接状态 | 侧栏顶部显示审阅队列是否可用，未连接时提示先启动本地工作台 |
| 页面类型识别 | 初步识别 AI 对话、GitHub、飞书、Notion、论文 / PDF、插件商店等页面 |
| 输入框记忆提示 | 在 ChatGPT / Claude / Gemini / Perplexity 等页面输入问题时，提示本地相关记忆，并支持插入/复制 |
| AI 页面诊断 | 侧栏显示是否识别 AI 产品、是否找到输入框、输入草稿长度和最近对话数量，并支持复制诊断 JSON |
| 来源细分 | 浏览器写入会保留 AI 产品来源，Viewer 里可筛选 ChatGPT、Claude、Gemini、Perplexity 等来源 |
| 右键菜单保存 | 从页面右键快速保存到 Agent Memory Lab |
| 最近保存记录 | popup 中展示最近保存过的网页线索 |
| 打开工作台 | 一键打开本地 Viewer 首页 |
| 打开 Skill 管理 | 一键进入 Skill 管理台 |
| 本地连接设置 | 配置 API 地址、Viewer 地址和访问密钥 |

预览方式：

```text
Chrome / Edge → chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择 browser-extension/
npm run preview:browser-extension
http://localhost:3113/demo/browser-extension.html
```

完整工作台启动方式：`npm run build && npm run start`。默认 API 是 `http://localhost:3111`，Viewer 是 `http://localhost:3113`；如果默认端口已被占用，先确认是否已有 Agent Memory Lab 在运行。

默认连接：

```text
API: http://localhost:3111
Viewer: http://localhost:3113
```

交付检查：

```bash
npm run check:delivery
```

这个命令会构建项目、检查浏览器插件、校验 README 截图和交付文档，并生成本地插件预览包。插件检查已包含本地 AI fixture 验收，会用最小页面模型检查 ChatGPT、Claude、Gemini、Perplexity、Grok、DeepSeek 的输入框和对话 selector。

权限与隐私说明：`docs/browser-extension-privacy-cn.md`

英文隐私政策草稿：`docs/browser-extension-privacy-en.md`

英文商店发布文案草稿：`docs/browser-extension-store-listing-en.md`

真实站点验收记录：`docs/browser-extension-ai-validation-cn.md`

本地免登录插件预览页：`http://localhost:3113/demo/browser-extension.html`，内置演示记忆，可预览输入框旁记忆提示、插入和复制。

本地预览包输出：`artifacts/agent-memory-lab-extension.zip`

## 6. 还差什么

| 优先级 | 缺口 | 为什么重要 |
| --- | --- | --- |
| P1 | 精准 AI 对话抽取器 | ChatGPT、Claude、Gemini、Perplexity 应继续按站点优化采集方式 |
| P1 | AI 输入框注入精调 | 已补常见输入框选择器、插入事件、复制诊断和 fixture 检查，仍需要真实网页逐站验收 |
| P1 | 经验到 Skill 的安装流程 | 已有草稿预览和复制，后续再做明确确认后的本地写入 |
| P2 | Chrome Web Store 打包 | 已有英文隐私政策和商店文案草稿，仍需要稳定公开隐私政策 URL、发布截图和真实站点验收证据 |

## 7. 设计原则

| 原则 | 体现 |
| --- | --- |
| 少暴露内部概念 | 不直接把 graph、audit、frontier 等内部字段丢给用户 |
| 自动整理，但要能审阅 | 自动提取记忆线索，但用户可以确认、编辑、删除 |
| 截图用真实产品图 | README / 飞书只放首页和 Skill 页 |
| 浏览器插件负责捕捉，不负责长期判断 | 长期记忆进入 Viewer 审阅 |
| 数据统一 | 浏览器插件统一使用 `PageCapture` |
| 失败要能解释 | 会话、活动、插件连接失败时要展示可理解的重试入口 |
| 本地优先 | 默认连接 localhost，不依赖外部数据库 |

## 8. 下一步路线

### 第一阶段：插件可用

- 保存网页
- 保存选中文本
- 隐私预览
- 最近保存记录
- AI 输入框本地记忆提示
- 同步侧栏连接状态

### 第二阶段：和 Viewer 打通

- 待审阅记忆队列
- 浏览器保存后在 Viewer 可见
- 页面来源筛选
- 记忆/经验的编辑和删除闭环
- 保存前编辑候选内容
- 会话页、活动页加载失败兜底

### 第三阶段：沉淀能力

- 经验合并进 Skill
- Skill 草稿确认后写入本地目录
- README / 飞书同步检查
- 项目报告生成
- Chrome Web Store 打包

## 9. 链接与路径

| 类型 | 地址 |
| --- | --- |
| GitHub 分支 | https://github.com/sznnnnn/agentmemory-lab/tree/szn-viewer-ui-iteration |
| 飞书文档 | 当前文档 |
| 浏览器插件 | `/Users/szn/agentmemory/browser-extension` |
| 本地 Viewer | http://localhost:3113/#dashboard |
| 本地 API | http://localhost:3111 |
