# 浏览器插件 AI 站点验收记录

这份表用于记录浏览器插件的 AI 页面验收结果。`npm run check:browser-extension` 里的 fixture 只能证明 selector 规则没有结构性退化；本地预览页能证明基础交互可跑通；真正对外发布前，还需要在真实网页里确认输入框旁“记忆建议”、插入、复制和侧栏诊断都可用。

## 验收方法

1. 启动本地 Viewer / API。
2. 在 Chrome / Edge 开发者模式加载 `browser-extension/`。
3. 先打开本地免登录预览页 `http://localhost:3113/demo/browser-extension.html`，确认基础插件体验可用。
4. 打开目标 AI 产品页面并登录。
5. 在输入框输入一个和本地记忆相关的问题，至少 8 个字。
6. 打开插件同步侧栏，检查“AI 页面状态”。
7. 检查输入框附近是否出现“记忆建议”提示。
8. 尝试插入一条记忆到输入框。
9. 点击“复制诊断”，把 JSON 保存到 `docs/validation/browser-extension-ai-sites/`。可以手动保存为 `YYYY-MM-DD-provider.json`，也可以使用 `npm run record:ai-validation-evidence` 自动命名和补齐模板。
10. 记录截图、日期、浏览器版本和结果。
11. 运行 `npm run check:ai-validation-evidence` 生成证据汇总。
12. 运行 `npm run sync:ai-validation-table`，把证据同步回本页验收表。

复制侧栏诊断后，可以直接从剪贴板保存证据：

```bash
npm run record:ai-validation-evidence -- --clipboard --browser "Chrome 版本号" --notes "无隐私信息的备注"
```

如果已经人工确认插入记忆成功、诊断复制成功、原站输入仍正常，再加 `--pass`。不要在没有真实操作的情况下使用 `--pass`。

## 通过标准

- Provider 被正确识别。
- 输入框状态为“已找到”。
- 输入框附近出现“记忆建议”入口。
- 侧栏显示入口锚点已找到，并记录入口位置策略。
- 本地搜索有结果时，可以插入或复制记忆。
- 同步侧栏可复制诊断 JSON。
- 插件没有导致原站点输入框、发送按钮、页面滚动异常。

## 证据目录和汇总命令

真实站点证据目录：`docs/validation/browser-extension-ai-sites/`。

每份诊断 JSON 会自带 `manualValidation` 模板。保存证据前，请把下面这些字段按真实验收结果改好：

```json
{
  "manualValidation": {
    "memoryInsertPassed": true,
    "diagnosticsCopied": true,
    "siteInputStillWorks": true,
    "browser": "Chrome 版本号",
    "notes": "无隐私信息的备注"
  }
}
```

汇总命令：

```bash
npm run record:ai-validation-evidence -- --file diagnostics.json
npm run check:ai-validation-evidence
npm run sync:ai-validation-table
```

第一条命令会把诊断 JSON 保存成标准证据文件。第二条命令会生成 `artifacts/ai-validation-evidence-summary.json`。第三条命令会用证据目录更新本页真实站点验收表。它们不会把待验收状态误判为通过；`memoryInsertPassed`、`diagnosticsCopied`、`siteInputStillWorks` 都为通过时，才会计入真实证据通过数。公开发布仍需 ChatGPT、Claude、Gemini、Perplexity 都有通过证据。

## 本地可验证项

| 项目 | 命令 / 页面 | 通过标准 | 当前状态 | 证据 |
| --- | --- | --- | --- | --- |
| 插件结构检查 | `npm run check:browser-extension` | 内容脚本语法、站点配置、图标、右键 selection/link 保存检查通过 | 已通过 | 最近一次 `npm run package:browser-extension && npm run check:delivery` |
| 免登录交互烟测 | `scripts/check-browser-extension-demo-interaction.mjs` | 模拟内容脚本在预览页创建“记忆建议”、渲染演示记忆，并把记忆插入输入框 | 已通过 | `check:browser-extension` 已包含 |
| 插件包检查 | `npm run package:browser-extension` | 生成 `artifacts/agent-memory-lab-extension.zip`，且包含 manifest、content script、service worker、side panel、popup/options、shared files、PNG 图标 | 已通过 | package check: 25 entries |
| 交付检查 | `npm run check:delivery` | 构建、README 图片引用、插件预览页、插件包检查均通过 | 已通过 | delivery checks ok |
| 免登录预览页 | `http://localhost:3113/demo/browser-extension.html` | 页面可访问，并含 `Agent Memory Demo`、演示输入框和演示记忆 | 已通过 | `check:delivery` 会启动预览服务并抓取页面 |
| 真实证据记录 | `npm run record:ai-validation-evidence` | 从剪贴板或文件保存标准诊断 JSON，不手工猜文件名 | 已接入 | `docs/validation/browser-extension-ai-sites/` |
| 真实证据汇总 | `npm run check:ai-validation-evidence` | 读取真实 AI 页面诊断 JSON，输出必需产品通过计数 | 已接入 | `artifacts/ai-validation-evidence-summary.json` |

## 真实站点验收表

| 产品 | 目标域名 | Provider | 输入框 | 记忆提示 | 插入 | 复制诊断 | 结果 | 日期 | 证据/备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ChatGPT | `chatgpt.com` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |
| Claude | `claude.ai` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |
| Gemini | `gemini.google.com` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |
| Perplexity | `www.perplexity.ai` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |
| Grok | `grok.com` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |
| DeepSeek | `chat.deepseek.com` | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | - | - |
## 诊断 JSON 示例

```json
{
  "product": "Agent Memory Lab Browser Extension",
  "extension": {
    "name": "Agent Memory Lab",
    "version": "0.1.0",
    "manifestVersion": 3
  },
  "generatedAt": "2026-06-08T00:00:00.000Z",
  "page": {
    "title": "ChatGPT",
    "url": "https://chatgpt.com/",
    "host": "chatgpt.com",
    "origin": "https://chatgpt.com",
    "type": "ai-chat",
    "typeLabel": "AI 对话"
  },
  "ai": {
    "supportedAiPage": true,
    "provider": "ChatGPT",
    "editorFound": true,
    "editorSelector": "#prompt-textarea",
    "anchorFound": true,
    "placement": "toolbar-end",
    "memoryWidgetVisible": true,
    "promptLength": 18,
    "turnCount": 4,
    "checkedAt": "2026-06-08T00:00:00.000Z"
  },
  "manualValidation": {
    "memoryInsertPassed": false,
    "diagnosticsCopied": true,
    "siteInputStillWorks": false,
    "browser": "填写浏览器名称和版本",
    "notes": "填写无隐私信息的验收备注"
  }
}
```

## 修复记录

| 日期 | 产品 | 问题 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| - | - | - | - | - |
