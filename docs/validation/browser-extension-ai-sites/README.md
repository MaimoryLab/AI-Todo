# 浏览器插件真实 AI 站点证据

这个目录用于临时收集真实 AI 页面验收证据。公开发布前，ChatGPT、Claude、Gemini、Perplexity 至少各需要一份通过证据。

## 怎么保存证据

1. 在目标 AI 页面打开 Agent Memory Lab 同步侧栏。
2. 输入一个真实问题，确认输入框旁出现“记忆建议”。
3. 尝试插入或复制一条本地记忆。
4. 点击侧栏里的“复制诊断”。
5. 把 JSON 保存成下面这种文件名：

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
- `ai.checkedAt`

如果插入/复制也验证通过，可以手动补充：

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

## 隐私提醒

不要提交包含私人聊天正文、账号、Cookie、访问令牌、邮箱、手机号、学校申请材料或任何敏感页面截图的证据。真实证据可以只保留在本地，用 `npm run check:ai-validation-evidence` 汇总状态。
