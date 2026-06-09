# 浏览器插件真实 AI 站点证据

这个目录用于临时收集真实 AI 页面验收证据。公开发布前，ChatGPT、Claude、Gemini、Perplexity 至少各需要一份通过证据。

## 怎么保存证据

1. 在目标 AI 页面打开 Agent Memory Lab 同步侧栏。
2. 输入一个真实问题并等待 AI 回复，确保页面里已经出现至少一轮真实对话。
3. 确认输入框旁出现“记忆建议”，并且待审阅候选来自具体对话或用户选中的文字，不是页面标题、链接或输入框草稿。
4. 尝试插入或复制一条本地记忆。
5. 点击侧栏里的“复制问题信息”。
6. 用命令把诊断 JSON 保存成标准证据文件。

从剪贴板保存：

```bash
npm run wizard:ai-validation-evidence
```

向导会读取剪贴板里的诊断 JSON，并逐项询问人工验收结果：插入/复制本地记忆是否成功、诊断是否复制成功、原站输入和发送是否仍正常、浏览器版本和无隐私备注。

如果已经把诊断保存成文件：

```bash
npm run wizard:ai-validation-evidence -- --file diagnostics.json
```

如果你已经确认三项人工验收都通过，也可以用无交互模式：

```bash
npm run wizard:ai-validation-evidence -- --file diagnostics.json --yes --browser "Chrome 版本号" --notes "无隐私信息的备注"
```

旧的记录命令仍可用于排查兼容性，但默认优先使用上面的向导。也可以直接用命令行参数保存：

```bash
npm run wizard:ai-validation-evidence -- --clipboard
```

从文件保存：

```bash
npm run wizard:ai-validation-evidence -- --file diagnostics.json
```

如果已经人工确认插入记忆成功、诊断复制成功、原站输入仍正常，可以加 `--pass`：

```bash
npm run wizard:ai-validation-evidence -- --clipboard --pass --browser "Chrome 版本号" --notes "无隐私信息的备注"
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
- `ai.turnCount`
- `ai.checkedAt`

复制问题信息会自带 `manualValidation` 模板。请按真实验收结果把它改好：

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
- `turnCount > 0`，证明插件确实命中了真实会话区域，而不是只识别到输入框或页面壳。
- 待审阅候选来自具体对话或用户选中的文字；页面介绍、URL、导航文案或输入框草稿不能计入通过。
- `manualValidation.memoryInsertPassed`、`manualValidation.diagnosticsCopied`、`manualValidation.siteInputStillWorks` 都为通过。
- `browser` 和 `notes` 写清楚无隐私的浏览器版本与测试备注。

复制出来的诊断默认不包含 prompt 草稿、完整会话正文或候选记忆正文；它只保留页面标题、URL、selector、计数和人工验收字段。如果页面标题或 URL 暴露敏感项目名、账号路径或内部链接，可以先删改，但不要删掉 `ai` 里的 selector 和布尔状态。selector 证据不会包含 Cookie、Token 或账号密码，却能帮助我们复现和修复站点适配问题。

## 隐私提醒

不要提交包含私人聊天正文、账号、Cookie、访问令牌、邮箱、手机号、学校申请材料或任何敏感页面截图的证据。真实证据可以只保留在本地，用 `npm run check:ai-validation-evidence` 汇总状态。
