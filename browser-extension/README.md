# Agent Memory Lab 浏览器插件

这是 Agent Memory Lab 的浏览器入口，用来把网页、AI 对话和项目文档同步到本地记忆工作台。

它不是普通 Web Clipper。它更像一个本地优先的“上下文中转站”：先识别你正在看的页面，再生成可审阅的记忆候选，送到 Viewer 的“待审阅”队列，最后由你决定哪些内容值得进入长期记忆。

## 现在支持

- 检查本地 Agent Memory Lab 服务是否在线
- 把当前网页加入待审阅记忆队列
- 把当前网页上的一条观察加入待审阅经验队列
- 侧边栏查看当前页面类型、候选记忆、候选经验和隐私提示
- 侧边栏在 AI 页面显示输入框诊断：识别到的产品、输入框状态、输入草稿长度和最近对话数量
- 侧边栏可一键复制 AI 页面诊断，方便逐站修正输入框和对话抽取规则
- 初步识别 ChatGPT、Claude、Gemini、Perplexity、Grok 等 AI 对话页面
- 参考 OpenMemory / Mem0 的 supported-sites 架构，按 AI 产品维护独立站点配置
- 在 AI 输入框附近召回本地记忆，但长期写入必须先进入本地审阅队列
- 在支持的 AI 页面输入框附近显示“记忆建议”，并从本地搜索相关记忆，支持插入或复制到当前对话
- 初步识别 GitHub、飞书、Notion、论文 / PDF、插件商店等网页类型
- 右键菜单保存当前页面、选中文本或链接，都会进入同一套待审阅队列
- 弹窗里查看最近保存记录
- 一键打开本地工作台首页
- 一键打开 Skill 管理台
- 支持自定义 API 地址、Viewer 地址和访问密钥

## 使用体验

插件目前有两个入口：

| 入口 | 适合做什么 |
| --- | --- |
| 弹窗 | 快速保存当前网页、补充一条经验、打开本地工作台 |
| 同步侧栏 | 边浏览边看页面类型、候选记忆、候选经验和隐私提示 |
| AI 页面状态 | 检查 ChatGPT / Claude 等页面是否找到了输入框和最近对话；如果未命中，可复制诊断用于修正规则 |
| 输入框记忆提示 | 在 ChatGPT / Claude / Gemini / Perplexity 等页面输入问题时，提示本地相关记忆，并可插入当前输入框 |
| 右键保存 | 保存整页、选中文本或链接片段，统一送到 Viewer 待审阅 |

更推荐日常使用“同步侧栏”，因为它更接近未来的跨 AI 产品记忆同步体验。

## 项目结构

```text
manifest.json           Chrome / Edge 扩展入口
service-worker.js       后台协调：API 请求、右键菜单、最近保存记录
content-script.js       只负责采集当前网页上下文
popup.html/js/css       弹窗 UI
sidepanel.html/js/css   浏览器侧边栏同步面板
options.html/js         本地连接设置
shared/schema.js        统一 PageCapture 数据结构
shared/page-types.js    页面类型与 AI 产品识别
shared/site-config.js   ChatGPT / Claude / Gemini / Perplexity 等站点配置；content-script 需保持同一 provider 口径
shared/api.js           统一本地 Agent Memory Lab API 调用
icons/                  插件图标
```

`icons/icon.svg` 是源图，发布和 Manifest 使用 `icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`。

## 数据结构

浏览器插件采集的数据统一成 `PageCapture`：

```js
{
  schemaVersion: 1,
  capturedAt: "2026-06-08T00:00:00.000Z",
  source: "browser-extension",
  page: {
    title: "页面标题",
    url: "https://example.com",
    host: "example.com",
    origin: "https://example.com",
    type: "ai-chat",
    typeLabel: "AI 对话",
    description: "页面摘要",
    selection: "用户选中的文本",
    headings: ["页面标题结构"]
  },
  conversation: {
    provider: "ChatGPT",
    turns: [{ role: "user", text: "最近可见的一轮对话" }]
  },
  diagnostics: {
    supportedAiPage: true,
    provider: "ChatGPT",
    editorFound: true,
    editorSelector: "#prompt-textarea",
    promptLength: 24,
    turnCount: 4
  },
  candidates: {
    memories: ["可保存的记忆候选"],
    lessons: ["可沉淀的经验候选"]
  },
  privacy: {
    risk: "low",
    reasons: []
  }
}
```

所有写入本地记忆、经验和最近保存记录的逻辑都从这个结构转换，避免 popup、content script、service worker 各自拼一套数据。

写入审阅队列时会保留更细的来源信息，例如 `browser-source:chatgpt`、`browser-page:ai-chat`。用户在 Viewer 记忆库里既可以筛选“浏览器”，也可以进一步筛选 ChatGPT、Claude、Gemini、Perplexity 等来源。

## 本地预览

1. 运行 `npm run preview:browser-extension`
2. 打开 Chrome / Edge：`chrome://extensions`
3. 打开“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择本目录：`browser-extension`
6. 打开 `http://localhost:3113/demo/browser-extension.html`
7. 点击浏览器工具栏里的 Agent Memory Lab 图标
8. 点击“打开同步侧栏”预览完整插件工作流

本地免登录预览页：

```text
http://localhost:3113/demo/browser-extension.html
```

这个页面会模拟一个 AI 对话输入框，并内置几条演示记忆。加载插件后，在输入框输入问题，应能看到“记忆建议”、示例记忆、插入/复制按钮，并可在同步侧栏看到 `Agent Memory Demo` 的 AI 页面状态。它用于快速预览插件体验，不能替代真实 ChatGPT / Claude / Gemini / Perplexity 的逐站验收。

如果要跑完整工作台和待审阅队列，再运行 `npm run build && npm run start`，默认 API 是 `http://localhost:3111`，Viewer 是 `http://localhost:3113`。如果默认端口已被占用，先确认是否已有 Agent Memory Lab 在运行；必要时停止旧进程后再启动。

侧栏顶部会显示连接状态：

- “审阅队列可用”：可以把当前页面送去 Viewer 审阅。
- “本地工作台未连接”：先启动本地 Viewer / API，再点“重试”。

建议试用路线：

1. 打开 `http://localhost:3113/demo/browser-extension.html`，确认本地预览页能显示“记忆建议”入口。
2. 打开 ChatGPT / Claude / Gemini / Perplexity 任一页面。
3. 在输入框输入一个和本地项目相关的问题。
4. 查看输入框附近的“记忆建议”提示，尝试插入或复制相关记忆。
5. 打开同步侧栏查看“AI 页面状态”。如果显示“输入框：未找到”，点击“复制诊断”，把诊断交给开发者补站点规则。
6. 用弹窗或同步侧栏把当前网页加入待审阅，再回到 Viewer 记忆库确认保存。

交付检查：

```bash
npm run check:browser-extension
npm run package:browser-extension
npm run preview:browser-extension
```

第一个命令会确认扩展脚本语法、Manifest V3 content script 配置、图标尺寸、`shared/site-config.js` 和运行脚本里的 AI provider 没有分叉，并用本地 fixture 检查 ChatGPT、Claude、Gemini、Perplexity、Grok、DeepSeek 的输入框和对话 selector 至少能命中最小页面模型。第二个命令会生成可分发的本地预览包：`artifacts/agent-memory-lab-extension.zip`，并检查 zip 里包含 manifest、content script、侧栏、弹窗、设置页、shared 数据结构和 PNG 图标。

本地 fixture 不是正式站点验收的替代品，只是防回归网。真正发布前仍需在真实 AI 页面打开插件，确认输入框旁提示、插入、复制和侧栏诊断都可用。

把 zip 发给别人本地试用时，先解压 `artifacts/agent-memory-lab-extension.zip`，再在 Chrome / Edge 的“加载已解压的扩展程序”里选择解压出来的 `browser-extension/` 文件夹。

权限和隐私说明见：[`docs/browser-extension-privacy-cn.md`](../docs/browser-extension-privacy-cn.md)。

英文隐私政策草稿见：[`docs/browser-extension-privacy-en.md`](../docs/browser-extension-privacy-en.md)。

英文商店发布文案草稿见：[`docs/browser-extension-store-listing-en.md`](../docs/browser-extension-store-listing-en.md)。

真实 AI 站点验收记录见：[`docs/browser-extension-ai-validation-cn.md`](../docs/browser-extension-ai-validation-cn.md)。

默认连接：

```text
API: http://localhost:3111
Viewer: http://localhost:3113
```

## 还缺什么

- 真实站点逐页验收：ChatGPT、Claude、Gemini、Perplexity、Grok、DeepSeek 都需要记录截图、浏览器版本和诊断 JSON。
- 更精确的 AI 对话抽取器：每个产品用自己的对话节点规则，减少误抓导航、按钮和系统提示。
- 保存前编辑候选内容：用户可以改标题、标签、项目归属，再送入本地审阅队列。
- 更稳定的输入框注入：按站点维护 `editorSelectors`、`anchorSelectors`、`placement` 和输入事件。
- 选中文本快捷送审：参考 Mem0 的 selection / context menu 流程，让网页片段也能进入同一套审阅队列。

## 参考方向

- Mem0 / OpenMemory：Cross-LLM memory，把记忆带到 ChatGPT、Claude、Perplexity 等产品里。
- Mem0 的实现启发：每个 AI 产品维护站点配置，再共享后台、侧栏和类型定义；记忆召回应贴近输入框，而不是藏在单独页面里。
- Agent Memory Lab 的逐站适配方法：复制侧栏诊断 -> 更新 `shared/site-config.js` 的 selector / placement -> 同步内容脚本站点表 -> 运行 `npm run check:browser-extension` -> 在真实页面确认输入框提示和插入行为。
- Agent Memory Lab 的差异：浏览器里只生成候选和召回建议，长期记忆写入必须经过 Viewer 的审阅、编辑、删除和来源筛选。
- Rethread / Nico / ContextBridge / Personal AI Memory：都在强调跨 AI 产品的上下文延续。
- Agent Memory Lab 的取向：本地优先、保存前可审阅、和主工作台统一数据，而不是把浏览器里看到的内容直接上传到云端。
