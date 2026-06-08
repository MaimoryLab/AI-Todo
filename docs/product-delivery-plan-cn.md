# Agent Memory Lab 交付计划

这份文档用来判断 Agent Memory Lab 什么时候算“能交差”。它不是技术待办，而是产品交付口径：别人打开仓库、看 README、装插件、跑本地 Viewer 时，能不能理解、预览并相信这个产品方向。

## 交付判断

### 今天可展示

目标：可以给熟人、团队成员或评审看一个完整方向。

- GitHub README 能在 3 分钟内讲清产品定位
- README 只放真实产品截图：首页和 Skill 管理台
- 本地 Viewer 能打开首页、会话、记忆、Skill、待办
- 浏览器插件可以加载为开发者扩展
- 插件弹窗可以打开同步侧栏
- 同步侧栏有本地连接状态，能说明审阅队列是否可用
- 同步侧栏能展示当前页面类型、候选记忆、候选经验、隐私提示
- 本地免登录插件预览页可打开：`http://localhost:3113/demo/browser-extension.html`
- 插件保存内容先进入 Viewer 的待审阅队列
- 插件结构按 OpenMemory / Mem0 的 supported-sites 思路拆出 AI 产品站点配置，并把记忆召回锚定在输入框附近
- 站点配置必须包含输入框、锚点和位置策略，避免 AI 页面改版后只能靠猜
- 插件 README 能说明如何预览
- 有插件权限与隐私说明，能解释为什么需要当前权限
- 飞书文档和 GitHub README 的产品叙事一致

### 明天可试用

目标：可以让一两个真实用户照着流程试。

- 保存网页后能在 Viewer 里稳定看到来源
- 保存前可以编辑候选记忆标题和内容
- AI 对话页抽取更精确，减少误抓导航和无关按钮
- 在 ChatGPT / Claude / Gemini / Perplexity 的 AI 输入框附近提示可用记忆，并支持插入/复制
- 同步侧栏能显示 AI 页面诊断，帮助确认输入框和最近对话是否被识别
- AI 页面诊断支持一键复制，方便像 Mem0 / OpenMemory 那样逐站维护 supported-sites 规则
- 选中文本和右键菜单进入同一套待审阅队列，不另开一套数据口径
- 活动页、会话页加载失败时有明确兜底状态：先展示可用数据，再提示失败来源和重试入口
- 插件有独立交付检查，避免 supported-sites 配置和运行脚本分叉
- 记忆库有“待审阅”入口，避免自动内容直接混入长期记忆
- README 有一段非常短的“试用路线”：启动 Viewer、加载插件、使用 AI 页面记忆提示、保存网页、回到工作台查看

### 一周内可交付

目标：可以作为一个小型产品原型对外介绍。

- 插件支持 ChatGPT、Claude、Gemini、Perplexity 的独立抽取规则
- Viewer 支持按来源筛选浏览器保存内容
- 经验可以生成 Skill 草稿，而不是只停留在经验列表；草稿需人工确认后再落到本地 Skill
- 飞书文档包含产品定位、截图、工作流、当前能力、路线图
- GitHub 分支保持最新，重要更新都有 commit 和 push
- 有一个固定 demo checklist，避免现场演示时路径混乱
- 能生成本地预览 zip，方便发给别人开发者模式加载

## 当前优先级

| 优先级 | 任务 | 交付价值 |
| --- | --- | --- |
| P0 | 保证 Viewer 关键页面能打开 | 产品可信度 |
| P0 | 插件侧栏可预览 | 体现浏览器入口是主方向 |
| P0 | README / 插件 README / 飞书同步 | 对外介绍不打架 |
| P0 | 待审阅记忆队列 | 解决自动保存的信任问题 |
| P1 | AI 对话专用抽取器 | 让跨 Agent 记忆方向成立 |
| P1 | 输入框附近的记忆提示 | 已有第一版本地搜索提示和插入能力，下一步要精调不同站点的位置与输入事件 |
| P1 | 保存前编辑候选内容 | 让用户有控制感 |
| P1 | 记忆来源筛选 | 已有浏览器 / 会话 / 手动筛选，并支持 ChatGPT、Claude、Gemini、Perplexity 等 AI 来源细分 |
| P1 | 经验到 Skill 草稿 | 已能从经验分组生成可复制的 SKILL.md 草稿，暂不自动写入本地目录 |
| P2 | Chrome Web Store 打包 | 更正式的分发 |

## 插件发布物料

- 权限与隐私说明：`docs/browser-extension-privacy-cn.md`
- 英文隐私政策草稿：`docs/browser-extension-privacy-en.md`
- 英文商店发布文案草稿：`docs/browser-extension-store-listing-en.md`
- 外部试用指南：`docs/external-tester-guide-cn.md`
- 发布门槛：`docs/release-gates-cn.md`
- 真实站点验收记录：`docs/browser-extension-ai-validation-cn.md`
- 插件 PNG 图标资产：`browser-extension/icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`
- 本地检查：`npm run check:browser-extension`
- 一键交付检查：`npm run check:delivery`
- 免登录插件预览：`npm run preview:browser-extension`
- 本地预览包：`npm run package:browser-extension`，输出 `artifacts/agent-memory-lab-extension.zip`
- 预览包内容检查：`check:browser-extension-package` 会确认 zip 内含 manifest、content script、侧栏、弹窗、设置页、shared 文件和 PNG 图标
- AI fixture 验收：`check:browser-extension` 会用本地最小页面模型检查 ChatGPT、Claude、Gemini、Perplexity、Grok、DeepSeek 的输入框和对话 selector
- 本地免登录预览：`http://localhost:3113/demo/browser-extension.html`，用于快速展示输入框旁“记忆建议”、演示记忆、插入/复制
- 试用者从仓库加载时选择仓库内 `browser-extension/`；从 zip 试用时先解压，再选择解压出来的 `browser-extension/`
- AI 站点适配材料：同步侧栏“复制诊断”输出的 JSON，可用于补 selector 和真实网页验收
- 未来商店发布仍需稳定公开隐私政策 URL、发布截图和逐站真实网页验收

## 默认更新工作流

每次产品更新都走这个闭环：

1. 先判断定位有没有变化。
2. 更新 Viewer、浏览器插件或数据结构。
3. 同步 README、插件 README，必要时同步飞书源文档。
4. 只使用真实产品截图，默认首页和 Skill 管理台。
5. 运行轻量检查和构建。
6. 能打开免登录插件预览页，完整工作台路径另行验证。
7. 提交并推送到 GitHub。

## 插件对标原则

参考 Mem0 / OpenMemory 的不是视觉，而是工作流结构：跨 ChatGPT、Claude、Gemini、Perplexity 等网页维护 supported sites，把记忆能力放在用户正在输入的位置。Agent Memory Lab 保留这个入口位置，但把数据策略改成本地优先：插件只负责识别页面、召回相关记忆、生成候选；长期写入必须回到 Viewer 审阅后确认。

逐站迭代时，以“复制诊断”为最小反馈单元：先确认 provider、输入框、草稿长度、最近对话数量，再决定是补 selector、调整插入逻辑，还是优化本地搜索召回。

## 预计时间

- 今天：能给熟人或内部评审看，说明方向和当前完成度。
- 明天：补保存前编辑和更精确的 AI 对话抽取后，可以让真实用户试一轮。
- 一周内：如果继续稳定推进，可以整理成可对外介绍的小型产品原型。
