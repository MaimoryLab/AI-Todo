# Agent Memory Lab 外部试用指南

这份指南给第一次试用 Agent Memory Lab 的朋友使用。目标不是让对方理解所有技术细节，而是能在 10 分钟内看到产品核心：本地记忆工作台、浏览器插件、AI 输入框旁的记忆建议，以及保存前审阅。

## 试用前需要知道

- 这是本地优先产品，记忆默认留在本机。
- 浏览器插件不会直接写入长期记忆。弹窗和同步侧栏会先给出可编辑草稿，保存后再进入 Viewer 的待审阅队列。
- 免登录插件预览页可以证明基础交互，但真实 ChatGPT / Claude / Gemini / Perplexity 仍需要逐站验收。
- 不要用包含 API Key、密码、身份证、银行卡、私人聊天的页面做截图。

## 试用包包含什么

| 内容 | 位置 | 用途 |
| --- | --- | --- |
| 中文 README | `README.md` | 快速理解产品定位和启动路径 |
| 插件目录 | `browser-extension/` | Chrome / Edge 开发者模式加载 |
| 插件预览页 | `http://localhost:3113/demo/browser-extension.html` | 免登录预览输入框旁记忆建议 |
| 插件压缩包 | `artifacts/agent-memory-lab-extension.zip` | 给别人本地加载或归档 |
| 交付摘要 | `artifacts/delivery-summary.md` | 查看当前版本、产物、发布门槛和检查命令 |
| 交付清单 | `artifacts/delivery-manifest.json` | 机器可读的版本、提交、zip 大小、sha256 和真实 AI 站点验收计数 |
| 演示检查清单 | `docs/demo-checklist-cn.md` | 演示前自查 |
| AI 站点验收记录 | `docs/browser-extension-ai-validation-cn.md` | 记录真实 AI 网页适配结果 |
| 隐私说明 | `docs/browser-extension-privacy-cn.md` | 解释插件权限和数据边界 |

本地交付检查还包含一个免登录交互烟测：它会模拟插件内容脚本在预览页创建“记忆建议”、渲染演示记忆，并确认插入按钮能把记忆写进输入框。这个检查不能替代真实 AI 网页验收，但能证明演示页的核心交互没有退化。

## 最短试用路线

1. 打开项目仓库，或拿到别人发来的 `artifacts/agent-memory-lab-extension.zip`。
2. 运行插件预览：

```bash
npm run preview:browser-extension
```

3. 打开 Chrome / Edge 的扩展管理页。
4. 开启开发者模式。
5. 选择“加载已解压的扩展程序”。
6. 选择插件文件夹：

| 来源 | 应该选择哪个文件夹 |
| --- | --- |
| 从仓库试用 | 选择仓库里的 `browser-extension/` |
| 从 zip 试用 | 先解压 `artifacts/agent-memory-lab-extension.zip`，再选择解压出来的 `browser-extension/` |

7. 打开：

```text
http://localhost:3113/demo/browser-extension.html
```

8. 在页面输入框里输入和记忆相关的问题。
9. 检查输入框附近是否出现“记忆建议”。
10. 点击“插入”或“复制”，确认记忆可以进入当前输入框。
11. 点击浏览器工具栏里的 Agent Memory Lab 图标，打开同步侧栏。
12. 检查侧栏是否识别为 `Agent Memory Demo`，并显示输入框已找到。

## 完整工作台试用路线

如果要试用待审阅队列和记忆库，需要启动完整工作台：

```bash
npm run build && npm run start
```

默认地址：

```text
Viewer: http://localhost:3113/#dashboard
API: http://localhost:3111
```

然后可以试：

- 插件保存当前网页。
- 右键保存选中文本或链接。
- 在弹窗或同步侧栏里先改标题或正文，再加入待审阅。
- 回到 Viewer 的记忆库，查看待审阅队列。
- 编辑标题、内容、标签和项目后再保存。

如果不确定完整工作台是否已经正常运行，可以另开终端检查：

```bash
npm run check:workbench
```

它会检查 API、Viewer 和插件 demo 页，并提示端口可能被占用还是需要重新启动。

也可以检查当前发布门槛：

```bash
npm run check:release-gates
```

如果准备公开发布，再运行：

```bash
npm run check:release-public
```

在真实 AI 站点验收完成前，公开发布检查失败是预期结果。

## 真实 AI 页面验收

对外发布前，需要在真实网页里验收这些产品：

- ChatGPT: `chatgpt.com`
- Claude: `claude.ai`
- Gemini: `gemini.google.com`
- Perplexity: `www.perplexity.ai`
- Grok: `grok.com`
- DeepSeek: `chat.deepseek.com`

每个站点至少确认：

- 页面被识别为对应 AI 产品。
- 输入框状态是“已找到”。
- 输入框附近出现“记忆建议”。
- 记忆可以插入或复制。
- 同步侧栏可以复制诊断 JSON。
- 原站点输入、发送、滚动没有异常。

验收结果写入：

```text
docs/browser-extension-ai-validation-cn.md
```

诊断 JSON 可以保存到：

```text
docs/validation/browser-extension-ai-sites/
```

保存后运行：

```bash
npm run check:ai-validation-evidence
```

它会生成 `artifacts/ai-validation-evidence-summary.json`，用于汇总 ChatGPT、Claude、Gemini、Perplexity 是否已经具备公开发布所需的真实页面证据。

## 反馈时请提供

- 试用日期。
- 浏览器名称和版本。
- 操作系统。
- 目标站点。
- 截图或录屏。
- 同步侧栏复制出来的诊断 JSON。
- 如果可以，直接提供 `docs/validation/browser-extension-ai-sites/` 下的证据 JSON 文件。
- 诊断 JSON 里 `editorFound`、`anchorFound`、`placement`、`memoryWidgetVisible` 的状态。
- 哪一步不符合预期。

## 当前不能承诺

- 还没有 Chrome Web Store 正式发布。
- 还没有完成所有真实 AI 网页的逐站验收。
- 插件不会绕过登录或读取付费产品内部不可见内容。
- 插件不应该保存敏感隐私页面作为演示素材。
