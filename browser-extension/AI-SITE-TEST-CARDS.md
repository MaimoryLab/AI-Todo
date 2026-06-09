# Agent Memory Lab 真实 AI 站点测试卡

这份文件是给外部试用者的快速入口。完整版本在仓库的 `docs/browser-extension-ai-site-test-cards-cn.md`。

公开发布前的必测站点：

- ChatGPT：`chatgpt.com` / `chat.openai.com`
- Claude：`claude.ai`
- Gemini：`gemini.google.com`
- Perplexity：`perplexity.ai` / `www.perplexity.ai`

## 每个站点都要确认

- Provider 识别正确。
- 输入框已找到。
- 输入框附近出现“记忆建议”。
- 点击建议后可以插入或复制记忆。
- 同步侧栏可以复制诊断 JSON。
- 原站输入、发送、滚动、模型选择和附件按钮没有异常。
- 页面里至少有一轮真实对话，诊断 JSON 的 `turnCount > 0`。
- 待审阅候选来自具体对话或用户选中的文字，不是页面标题、链接、导航文案或输入框草稿。

## 保存证据

复制同步侧栏诊断后，在仓库根目录运行：

```bash
npm run wizard:ai-validation-evidence
```

向导会逐项确认“插入/复制本地记忆是否成功、诊断是否复制、原站输入和发送是否仍正常、浏览器版本、无隐私备注”。

已经真实确认三项都通过时，也可以使用无交互模式：

```bash
npm run wizard:ai-validation-evidence -- --yes --browser "Chrome 版本号" --notes "无隐私信息的备注"
```

通过证据里必须能看到 `manualValidation.memoryInsertPassed`、`manualValidation.diagnosticsCopied`、`manualValidation.siteInputStillWorks` 三项都为通过，同时 `matchedSelectors.turn` 和 `turnCount > 0` 能证明插件确实命中了真实会话区域。

## 当前边界

本地 demo 通过不等于公开发布通过。公开发布需要 ChatGPT、Claude、Gemini、Perplexity 都有真实页面通过证据。

反馈模板：`docs/external-feedback-template-cn.md`。

GitHub Issue 模板：`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml`。
