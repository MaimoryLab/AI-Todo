# 浏览器插件真实 AI 站点测试卡

这份测试卡给外部试用者使用。它把真实 AI 页面验收拆成四张必测卡，避免只在本地 demo 通过就误判为公开可发布。

当前公开发布门槛：ChatGPT、Claude、Gemini、Perplexity 四个必测站点都要有通过证据。Grok 和 DeepSeek 可以作为扩展验证，但不计入当前公开发布门槛。

## 测试前准备

1. 启动本地 Agent Memory Lab Viewer / API。
2. 在 Chrome 或 Edge 开发者模式加载 `browser-extension/`。
3. 打开目标 AI 产品页面并登录。
4. 打开插件同步侧栏，确认能看到版本、本地连接状态、“复制诊断”和“复制命令”。
5. 如果真实页面没有出现“记忆建议”，再打开 `http://localhost:3113/demo/browser-extension.html` 做自检，用来区分是站点适配问题还是插件注入整体异常。
6. 每测完一个真实 AI 页面，都先复制侧栏诊断，再复制侧栏生成的保存命令，把证据保存到 `docs/validation/browser-extension-ai-sites/`。

保存诊断的推荐命令：

```bash
cd /Users/szn/agentmemory
npm run record:ai-validation-evidence -- --clipboard --browser "Chrome 版本号" --notes "无隐私信息的备注"
```

侧栏里的“复制命令”会按当前 Provider 自动补上 `--provider`，可以直接粘贴到项目终端后再改浏览器版本和备注。

只有真实确认“插入记忆成功、诊断已复制、原站输入仍正常”以后，才可以加 `--pass`。

## 统一通过标准

每张测试卡都按同一组标准判断：

- Provider 识别正确。
- 输入框已找到。
- 输入框附近出现“记忆建议”。
- 点击建议后可以插入或复制记忆。
- 同步侧栏可以复制诊断 JSON。
- 原站输入、发送、滚动、模型选择和附件按钮没有异常。
- 诊断 JSON 的 `manualValidation.memoryInsertPassed`、`manualValidation.diagnosticsCopied`、`manualValidation.siteInputStillWorks` 都为通过。
- 诊断 JSON 里有 `matchedSelectors.editor`、`matchedSelectors.anchor`、`matchedSelectors.send`、`matchedSelectors.turn`，方便复现站点适配问题。

## Mem0 式站点适配检查

Mem0 的插件实现提醒我们：每个 AI 产品都要当成独立站点适配，而不是只看域名匹配。测试时请额外确认这 5 件事：

- `provider` 是否与当前产品一致，而不是命中通用 fallback。
- `editor` 是否指向真正写 prompt 的输入区，而不是历史消息、搜索结果或隐藏 textarea。
- `anchor` 是否靠近输入框工具栏，入口是否避开发送、附件、语音和模型选择按钮。
- 插入记忆后，原站是否触发输入状态，例如发送按钮可用、光标还在输入区。
- `turnSelectors` 是否能读到当前会话区域，方便后续做上下文召回，而不是只保存网页标题。
- 复制诊断后，检查 `matchedSelectors` 是否能说明当前页面命中了哪条输入框、锚点、发送按钮和会话 selector。

如果这 5 项里有任意一项不稳定，就不要把该站点标为通过。把诊断 JSON 和截图交回，优先更新 `browser-extension/shared/site-config.js`；当某个站点规则开始变复杂，再拆成独立 adapter。

## 测试卡 1：ChatGPT

- 目标域名：`chatgpt.com` 或 `chat.openai.com`
- 重点观察：输入框底部工具栏、发送按钮、语音按钮、模型选择入口。
- 建议测试 prompt：`帮我找一下我们之前关于浏览器插件和本地记忆的产品决策。`
- 通过时应该看到：插件识别 Provider 为 ChatGPT，入口贴近 prompt 区域，不遮挡发送或语音按钮。
- 常见失败记录：入口没有出现、入口遮挡发送按钮、插入后输入框没有触发原站输入状态。

## 测试卡 2：Claude

- 目标域名：`claude.ai`
- 重点观察：富文本输入框、附件按钮、发送按钮、项目/聊天页面差异。
- 建议测试 prompt：`总结一下 Agent Memory Lab 的插件交付还差哪些真实站点证据。`
- 通过时应该看到：插件识别 Provider 为 Claude，入口在输入区附近，插入内容后富文本输入仍可继续编辑。
- 常见失败记录：contenteditable 插入失败、入口被输入区裁切、项目页和普通聊天页表现不一致。

## 测试卡 3：Gemini

- 目标域名：`gemini.google.com`
- 重点观察：`rich-textarea` 输入区、发送按钮、语音/图片入口、多语言按钮文本。
- 建议测试 prompt：`基于我的本地记忆，帮我整理浏览器插件的下一步验收计划。`
- 通过时应该看到：插件识别 Provider 为 Gemini，输入框状态为已找到，入口不影响原站发送。
- 常见失败记录：输入框 selector 变化、入口挂到错误容器、插入后发送按钮不激活。

## 测试卡 4：Perplexity

- 目标域名：`perplexity.ai` 或 `www.perplexity.ai`
- 重点观察：搜索输入框、模型选择按钮、Submit/Send 按钮、线程页面和首页差异。
- 建议测试 prompt：`检索并结合我的本地记忆，说明多 AI 网页记忆插件应该怎么验收。`
- 通过时应该看到：插件识别 Provider 为 Perplexity，入口靠近输入区但不挡住模型选择和提交。
- 常见失败记录：入口跑到页面主体、输入框识别成搜索结果区域、复制诊断缺少 placement 或 anchor 信息。

## 可选测试卡：Grok / DeepSeek

- Grok 目标域名：`grok.com` 或 `x.ai`
- DeepSeek 目标域名：`chat.deepseek.com` 或 `deepseek.com`
- 目的：验证更多 AI 网页的适配潜力。
- 注意：这两个站点当前不计入公开发布门槛，但失败也要记录，方便后续扩展 supported sites。

## 失败时怎么反馈

失败不是坏事，真实失败比“看起来能用”更有价值。反馈时请包含：

- 产品名和 URL。
- 浏览器名称和版本。
- 失败发生在哪一步。
- 同步侧栏“复制诊断”的 JSON。
- 截图或录屏，但不要包含私人聊天全文、Cookie、Token、学校申请材料或账号信息。

反馈模板：`docs/external-feedback-template-cn.md`。

GitHub Issue 模板：`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml`。

## 验收后同步

录入证据后运行：

```bash
cd /Users/szn/agentmemory
npm run check:ai-validation-evidence
npm run sync:ai-validation-table
npm run status:delivery
```

`status:delivery` 只有在四个必测站点都通过后，才会让真实站点证据从 `0/4` 推到 `4/4`。在此之前，公开发布仍然是 `not-ready`。
