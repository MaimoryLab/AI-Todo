# Agent Memory Lab 外部试用反馈模板

请尽量不要粘贴私人聊天全文、账号信息、Cookie、访问令牌、学校申请材料或任何敏感页面内容。诊断 JSON 可以保留页面标题、URL、AI 页面状态和 `manualValidation` 字段；如有隐私信息，请先删改。

维护者收到这份反馈后，会按 [外部反馈分诊指南](external-feedback-triage-cn.md) 归类处理：先判断是不是本地连接、站点适配、输入事件、审阅队列、隐私信任或交付文档问题，再决定修插件、补 selector、更新证据还是改说明。

## 基本信息

- 试用日期：
- 操作系统：
- 浏览器和版本：
- 插件版本：
- 加载方式：仓库 `browser-extension/` / zip 解压后加载
- 本地工作台状态：`npm run check:workbench` 结果
- 交付状态：`npm run status:delivery` 结果

## 试用路径

- 试用页面：本地 demo / ChatGPT / Claude / Gemini / Perplexity / Grok / DeepSeek / 其他
- 页面 URL：
- 你输入的问题或任务类型：
- 页面里是否已有至少一轮真实对话：是 / 否
- 诊断 JSON 里的 `turnCount`：
- 待审阅候选是否来自具体对话或用户选中文本：是 / 否 / 不确定
- 是否看到“记忆建议”：是 / 否
- 是否成功插入或复制记忆：是 / 否
- 是否成功把网页加入待审阅：是 / 否
- 是否在 Viewer 待审阅队列看到内容：是 / 否

## 问题描述

- 发生了什么：
- 期望应该是什么：
- 实际结果是什么：
- 是否能稳定复现：每次 / 偶尔 / 只出现一次
- 影响程度：阻断试用 / 影响核心体验 / 小问题 / 建议优化

## 诊断信息

请粘贴同步侧栏“复制问题信息”的 JSON，或提供 `docs/validation/browser-extension-ai-sites/` 里的证据文件名。

```json
{
  "product": "Agent Memory Lab Browser Extension",
  "extension": {},
  "page": {},
  "ai": {
    "turnCount": 0,
    "matchedSelectors": {
      "turn": ""
    }
  },
  "manualValidation": {
    "memoryInsertPassed": false,
    "diagnosticsCopied": true,
    "siteInputStillWorks": false,
    "browser": "",
    "notes": ""
  }
}
```

如果反馈来自真实 AI 页面，请保留 `turnCount` 和 `matchedSelectors.turn`，用来判断插件是否真的命中了会话区域。不要粘贴完整聊天正文；也不要把页面标题、链接、导航文案或输入框草稿当作记忆来源。

## 截图或录屏

- 附件路径或链接：
- 是否已确认不含敏感信息：是 / 否

## 你的建议

- 哪个地方最困惑：
- 哪个地方最有用：
- 你希望下一版优先改什么：
