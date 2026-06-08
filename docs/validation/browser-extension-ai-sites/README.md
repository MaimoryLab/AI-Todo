# 浏览器插件真实 AI 站点证据

这个目录用于临时收集真实 AI 页面验收证据。公开发布前，ChatGPT、Claude、Gemini、Perplexity 至少各需要一份通过证据。

## 怎么保存证据

1. 在目标 AI 页面打开 Agent Memory Lab 同步侧栏。
2. 输入一个真实问题，确认输入框旁出现“记忆建议”。
3. 尝试插入或复制一条本地记忆。
4. 点击侧栏里的“复制诊断”。
5. 用命令把诊断 JSON 保存成标准证据文件。

从剪贴板保存：

```bash
npm run record:ai-validation-evidence -- --clipboard
```

从文件保存：

```bash
npm run record:ai-validation-evidence -- --file diagnostics.json
```

如果已经人工确认插入记忆成功、诊断复制成功、原站输入仍正常，可以加 `--pass`：

```bash
npm run record:ai-validation-evidence -- --clipboard --pass --browser "Chrome 版本号" --notes "无隐私信息的备注"
```

也可以手动把 JSON 保存成下面这种文件名：

```text
YYYY-MM-DD-provider.json
```

例子：

```text
2026-06-08-chatgpt.json
2026-06-08-claude.json
```

## 证据字段

诊断 JSON 至少需要包含：

- `extension.version`
- `page.url`
- `ai.provider`
- `ai.editorFound`
- `ai.anchorFound`
- `ai.placement`
- `ai.memoryWidgetVisible`
- `ai.matchedSelectors.editor`
- `ai.matchedSelectors.anchor`
- `ai.matchedSelectors.send`
- `ai.matchedSelectors.turn`
- `ai.checkedAt`

复制诊断会自带 `manualValidation` 模板。请按真实验收结果把它改好：

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

不要把模板里的 `false` 留着就当通过。`npm run check:ai-validation-evidence` 只有在这三项都为通过时，才会把对应产品计入通过数。

## 证据质量门槛

公开发布需要的是“可复现证据”，不是一句“我这边能用”。因此 ChatGPT、Claude、Gemini、Perplexity 的通过证据必须同时满足：

- `provider`、`editorFound`、`anchorFound`、`memoryWidgetVisible` 都是真实页面结果。
- `matchedSelectors` 里保留输入框、锚点、发送按钮、会话区域四类命中规则。
- `manualValidation.memoryInsertPassed`、`manualValidation.diagnosticsCopied`、`manualValidation.siteInputStillWorks` 都为通过。
- `browser` 和 `notes` 写清楚无隐私的浏览器版本与测试备注。

如果担心隐私，可以删掉 prompt 草稿、会话片段和页面标题中的敏感内容，但不要删掉 `ai` 里的 selector 和布尔状态。selector 证据不会包含 Cookie、Token 或账号密码，却能帮助我们复现和修复站点适配问题。

## 隐私提醒

不要提交包含私人聊天正文、账号、Cookie、访问令牌、邮箱、手机号、学校申请材料或任何敏感页面截图的证据。真实证据可以只保留在本地，用 `npm run check:ai-validation-evidence` 汇总状态。
