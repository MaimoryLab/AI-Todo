# 浏览器插件对标：Mem0 / OpenMemory 实现参考

这份文档记录 Agent Memory Lab 浏览器插件参考 Mem0 Chrome Extension 的方式。它不是视觉参考，而是工作流和工程结构参考。

参考仓库：[`mem0ai/mem0-chrome-extension`](https://github.com/mem0ai/mem0-chrome-extension)。该仓库已经归档，但仍然适合作为“跨 AI 网页记忆插件”的结构样本。

## Mem0 插件做对了什么

Mem0 的核心不是网页剪藏，而是把记忆能力放进用户正在使用的 AI 产品里。

- 支持 ChatGPT、Claude、Perplexity、Grok、Gemini、DeepSeek 等多个 AI 网页。
- 每个 AI 产品有独立的 content 入口，例如 `src/chatgpt/content.ts`、`src/claude/content.ts`、`src/gemini/content.ts`。
- 公共配置集中在 `src/utils/site_config.ts`，用于描述输入框、锚点、按钮位置和浮层摆放策略。
- 公共能力拆在工具层，例如定位工具、搜索、右键菜单、侧栏、弹窗、设置和后台消息。
- 记忆不是藏在插件弹窗里，而是出现在 AI 输入框附近，让用户在提问时顺手调用。
- README 把定位说得很直接：跨 ChatGPT、Claude、Perplexity 等 AI 助手共享上下文。

## 我们应该学的结构

| Mem0 结构 | Agent Memory Lab 对应实现 | 保留原因 |
| --- | --- | --- |
| supported sites | `browser-extension/shared/site-config.js` | 每个 AI 产品的输入框和对话 DOM 都不同，必须显式维护 |
| 输入框附近入口 | `content-script.js` 里的“记忆建议”浮层 | 记忆应该在用户需要提问时出现，而不是只在管理后台出现 |
| 后台消息协调 | `service-worker.js` | 统一保存网页、选中文本、链接和最近记录 |
| 侧栏/弹窗 | `sidepanel.*`、`popup.*` | 弹窗适合快速动作，侧栏适合诊断和审阅上下文 |
| 页面诊断 | `diagnostics` + “复制诊断” | AI 网页 DOM 经常变，逐站适配必须可反馈、可复现 |
| 统一数据类型 | `PageCapture` | 避免 popup、sidepanel、content script 各自拼数据 |

## 我们不能照搬的地方

Agent Memory Lab 的定位和 Mem0 不一样，所以有几件事要反着做。

- Mem0 偏云端 API 和账号体系；我们默认本地优先，API 地址指向本地工作台。
- Mem0 更强调自动写入记忆；我们默认进入待审阅队列，长期记忆必须用户确认。
- Mem0 的内容脚本按产品拆文件；我们当前先采用“单 content script + 站点配置”的轻量结构，等真实站点规则复杂到难维护时再拆分。
- Mem0 README 强调免费和商店安装；我们当前先强调本地试用、隐私边界和真实站点验收。

## 当前实现原则

浏览器插件后续迭代按这四条走：

1. 先让记忆出现在 AI 输入框附近，再补管理入口。
2. 每个 AI 产品都必须有 provider、host、editor、anchor、turn、send 的配置。
3. 所有保存动作先进入 Viewer 待审阅队列，不直接写长期记忆。
4. 每次真实网页失配时，用侧栏“复制诊断”补证据，再更新 selector 和验收记录。

## 下一步插件差距

| 优先级 | 差距 | 目标 |
| --- | --- | --- |
| P0 | 真实 AI 网站还缺验收证据 | ChatGPT、Claude、Gemini、Perplexity 至少各有一次真实页面通过记录 |
| P0 | 保存前编辑候选内容 | 已能在弹窗改标题和记忆正文；下一步补来源、是否进入经验、标签和项目归属 |
| P1 | 记忆建议排序还偏基础 | 根据当前输入、页面类型、项目来源和最近使用记录排序 |
| P1 | 不同站点浮层位置还需要细调 | 避免挡住发送按钮、模型选择、附件按钮和站点原生提示 |
| P1 | 站点配置需要更可维护 | 当 selector 复杂后，把大站点拆成独立 adapter 文件 |
| P2 | 商店发布材料还不完整 | 公开隐私政策 URL、无隐私截图、商店权限说明、演示短视频 |

## 版本判断

当前版本可以作为外部本地试用版继续推进，但不能说成公开发布版。公开发布必须先完成真实 AI 站点验收，并把证据写入 `docs/browser-extension-ai-validation-cn.md`。
