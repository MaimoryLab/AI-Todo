# Agent Memory Lab 外部测试闭环

这份文档用于把一次试用收成可复现、可分诊、可继续迭代的反馈。目标不是让测试者理解全部工程结构，而是让他先在真实网页里用起来，再把真实页面问题反馈回来。

## 四步闭环

| 步骤 | 测试者要做什么 | 我们需要得到什么 |
| --- | --- | --- |
| 1. 加载插件 | 在 Chrome / Edge 开发者模式加载 `browser-extension/` 或解压后的插件包 | 插件是否能连接本地工作台，弹窗和同步侧栏是否可用 |
| 2. 真实页面使用 | 在普通网页、ChatGPT、Claude、Gemini 或 Perplexity 里保存候选内容 | 是否能保存到 Viewer 待审阅队列，是否能看到“记忆建议” |
| 3. 逐站验收 | 在 ChatGPT、Claude、Gemini、Perplexity 检查输入框、记忆建议、插入、复制诊断 | 一份脱敏诊断 JSON，或 `docs/validation/browser-extension-ai-sites/` 里的证据文件 |
| 4. 提交反馈 | 使用 `docs/external-feedback-template-cn.md` 或 GitHub Issue 模板 | 问题路径、影响程度、实际现象、诊断 JSON、截图或录屏路径 |

## 最少要回收的信息

- 试用路径：本地 demo / ChatGPT / Claude / Gemini / Perplexity / Viewer / 插件加载。
- 是否看到记忆建议。
- 是否能插入或复制记忆。
- 是否能把网页加入待审阅。
- Viewer 记忆库里是否出现待审阅卡片。
- 如果是真实 AI 页面问题，必须附同步侧栏“复制诊断”的 JSON。
- 如果有截图或录屏，先确认不含私人聊天、Cookie、访问令牌、API Key 或申请材料。

## 反馈后怎么处理

| 反馈类型 | 看哪里 | 下一步 |
| --- | --- | --- |
| 插件未连接本地工作台 | `npm run check:workbench` | 修启动说明、默认地址或连接状态提示 |
| 真实页面没有记忆建议 | 先看同步侧栏诊断，再用 demo 自检 | 判断是站点适配问题还是插件注入整体异常 |
| AI 页面识别错 | `ai.provider`、`page.host` | 更新站点配置和 fixture |
| 输入框或入口位置没找到 | `matchedSelectors.editor`、`matchedSelectors.anchor` | 补 selector 或调整入口位置 |
| 插入后原站输入异常 | `manualValidation.siteInputStillWorks` | 优先修输入事件，必要时回滚该站点注入策略 |
| Viewer 待审阅没有内容 | `/agentmemory/review`、来源筛选 | 修审阅队列或保存草稿结构 |
| 测试者看不懂下一步 | `README.md`、`docs/external-tester-guide-cn.md`、`browser-extension/LOAD-THIS-FIRST.md` | 改外部说明，而不是只改内部脚本 |

## 交付判断

- 本地可演示：demo 页、插件预览、待审阅队列、Skill 管理台可跑通。
- 外部可试用：zip 包、加载说明、反馈模板、分诊指南和交付摘要齐全。
- 公开可发布：ChatGPT、Claude、Gemini、Perplexity 都有真实页面通过证据，并且隐私政策、商店截图和发布文案准备好。

当前公开发布不能只靠本地 fixture 通过。真实 AI 页面证据必须来自测试者实际页面，并能通过 `npm run check:ai-validation-evidence` 汇总。
