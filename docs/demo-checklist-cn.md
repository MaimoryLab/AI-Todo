# Agent Memory Lab 演示检查清单

这份清单用于演示前自查，目标是 5 分钟内把产品讲清楚、跑通核心路径，并避免现场翻车。

## 演示前准备

- GitHub 分支打开：`szn-viewer-ui-iteration`
- 插件免登录预览可启动：`npm run preview:browser-extension`
- 本地插件预览页可访问：`http://localhost:3113/demo/browser-extension.html`
- 完整工作台可启动：`npm run build && npm run start`，Viewer 默认 `http://localhost:3113/#dashboard`
- 浏览器插件已加载：Chrome / Edge → `chrome://extensions` → 加载 `browser-extension/`
- 插件检查已通过：`npm run check:browser-extension`，包括 AI 页面 fixture 的输入框和对话 selector 检查
- 若要对外展示插件稳定性，更新 `docs/browser-extension-ai-validation-cn.md` 的真实站点验收记录
- 若要对外分发插件，确认 `docs/browser-extension-privacy-en.md` 和 `docs/browser-extension-store-listing-en.md` 已同步最新权限与截图要求
- README 截图只展示首页和 Skill 管理台
- 不展示包含个人敏感资料的记忆卡片截图

## 核心演示路线

### 1. 打开首页

讲清一句话：Agent Memory Lab 是本地优先的 Agent 记忆工作台，不是普通聊天记录列表。

检查点：

- 首页能打开
- 最近会话卡片能看到
- 导航里有总览、记忆、会话、Skill、待办、活动

### 2. 打开 Skill 管理台

讲清：本地 Skill 越来越多，需要能看来源、用途和路径。

检查点：

- Skill 列表能加载
- 搜索和来源筛选可见
- 能打开详情或复制路径

### 3. 演示浏览器插件弹窗和侧栏

讲清：插件是网页和 AI 对话进入本地记忆库的入口。

检查点：

- 插件弹窗能打开
- 能看到当前网页标题
- 能打开同步侧栏
- 侧栏顶部显示“审阅队列可用”；如果显示未连接，先启动本地 Viewer / API 后重试
- 侧栏能看到页面类型、候选记忆、候选经验、隐私提示

### 4. 演示待审阅队列

讲清：插件不会直接写入长期记忆，先进入待审阅，用户确认后才保存。

检查点：

- 从插件加入待审阅
- 回到记忆库顶部看到“待审阅”
- 点“审阅保存”可以编辑标题、内容、类型、项目、标签
- 确认后进入长期记忆或经验
- 在记忆库用“浏览器”来源筛选找到刚保存的内容

### 5. 演示 AI 页面记忆提示

讲清：参考 OpenMemory / Mem0 的思路，在 ChatGPT / Claude 等页面输入问题时，本地记忆会主动出现在输入框附近；不同的是，我们不会直接把网页内容写进长期记忆，而是先进入本地审阅队列。

检查点：

- 先打开 `http://localhost:3113/demo/browser-extension.html` 做免登录预览
- 同步侧栏识别为 `Agent Memory Demo`，并且输入框为“已找到”
- 输入框附近出现“本地记忆”入口，面板里能看到演示记忆，并可插入 / 复制
- 打开 ChatGPT 或 Claude 页面
- 在输入框输入一个和本地记忆相关的问题
- 同步侧栏的“AI 页面状态”显示已识别产品，并且输入框为“已找到”
- 如果输入框为“未找到”，点击“复制诊断”，把 JSON 留作下一轮站点适配材料
- 输入框附近出现“本地记忆”按钮
- 面板里能看到相关记忆
- 能插入或复制到当前输入框

## 当前不要演示

- 不演示私密画像页
- 不把活动页作为主卖点
- 不承诺 Chrome Web Store 已发布
- 不承诺所有 AI 产品的 DOM 抽取都已完美适配

## 讲法重点

- 本地优先：私人记忆先留在本机
- 可审阅：自动整理不是自动乱存
- 跨产品：浏览器插件覆盖 ChatGPT、Claude、Gemini、Perplexity 等 AI 页面
- 可沉淀：高频经验未来可以进入 Skill

## 演示后下一步

- 精调 ChatGPT / Claude / Perplexity 的输入框定位和插入事件
- 继续逐站验收 ChatGPT / Claude / Gemini / Perplexity 的输入框定位和插入事件
- Skill 草稿确认后写入本地目录
- 准备 Chrome Web Store 英文隐私政策和发布截图
