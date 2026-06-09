# Agent Memory Lab 外部试用指南

这份指南给第一次试用 Agent Memory Lab 的朋友使用。目标不是让对方理解所有技术细节，而是能在 10 分钟内看到产品核心：本地记忆工作台、浏览器插件、AI 输入框旁的记忆建议，以及保存前审阅。

如果这次试用需要沉淀为可复现反馈，请同时按 [外部测试闭环](external-test-loop-cn.md) 收集结果：先加载插件，在真实网页里使用，再提交诊断和问题描述。demo 只作为排错自检。

## 试用前需要知道

- 这是本地优先产品，记忆默认留在本机。
- 浏览器插件不会直接写入长期记忆。弹窗和同步侧栏会先给出可编辑草稿，保存后再进入 Viewer 的待审阅队列。
- 本地 demo 可以帮助排查插件注入是否正常，但不能替代真实 ChatGPT / Claude / Gemini / Perplexity 的逐站验收。
- 不要用包含 API Key、密码、身份证、银行卡、私人聊天的页面做截图。

## 试用包包含什么

| 内容 | 位置 | 用途 |
| --- | --- | --- |
| 中文 README | `README.md` | 快速理解产品定位和启动路径 |
| 插件目录 | `browser-extension/` | Chrome / Edge 开发者模式加载 |
| 插件自检页 | `启动输出里的 Viewer 地址 + /demo/browser-extension.html` | 排查输入框旁记忆建议是否能注入 |
| 插件压缩包 | `artifacts/agent-memory-lab-extension.zip` | 给别人本地加载或归档 |
| 交付摘要 | `artifacts/delivery-summary.md` | 查看当前版本、产物、发布门槛和检查命令 |
| 交付清单 | `artifacts/delivery-manifest.json` | 机器可读的版本、提交、zip 大小、sha256 和真实 AI 站点验收计数 |
| 演示检查清单 | `docs/demo-checklist-cn.md` | 演示前自查 |
| AI 站点验收记录 | `docs/browser-extension-ai-validation-cn.md` | 记录真实 AI 网页适配结果 |
| AI 站点测试卡 | `docs/browser-extension-ai-site-test-cards-cn.md` | 按 ChatGPT、Claude、Gemini、Perplexity 拆分真实页面验收任务 |
| AI 验收一页纸 | `artifacts/ai-validation-run/quickstart-cn.md` | 给测试者先看的短清单，说明 4 个必测站点、6 步操作、通过标准和隐私边界 |
| AI 站点外测包 | `artifacts/ai-validation-run/tester-pack-cn.md` | 完整真实站点验收包，包含每个站点的 prompt、重点观察和证据命令 |
| 隐私说明 | `docs/browser-extension-privacy-cn.md` | 解释插件权限和数据边界 |

启动 Viewer 后，首页的“浏览器记忆入口”也会直接提供这些常用入口：下载插件包、外测手册、验收一页纸、AI 验收包、反馈模板和分诊指南。外部试用者优先从首页拿材料；`artifacts/` 路径主要用于维护者归档和校验。

本地交付检查还包含一个免登录交互烟测：它会模拟插件内容脚本在预览页创建“记忆建议”、渲染演示记忆，并确认插入按钮能把记忆写进输入框。这个检查不能替代真实 AI 网页验收，但能证明演示页的核心交互没有退化。

## 最短试用路线

1. 打开项目仓库，或打开 Viewer 首页，在“浏览器记忆入口”点击“下载插件包”。
2. 进入项目目录并启动完整工作台：

```bash
cd agentmemory-lab
npm run build && npm run start:local-memory
```

3. 打开 Chrome / Edge 的扩展管理页。
4. 开启开发者模式。
5. 选择“加载已解压的扩展程序”。
6. 选择插件文件夹：

| 来源 | 应该选择哪个文件夹 |
| --- | --- |
| 从仓库试用 | 选择仓库里的 `browser-extension/` |
| 从 zip 试用 | 先解压 `artifacts/agent-memory-lab-extension.zip`，阅读 `browser-extension/LOAD-THIS-FIRST.md`，再选择解压出来的 `browser-extension/` |

7. 打开 ChatGPT、Claude、Gemini、Perplexity 或普通网页。
8. 点击浏览器工具栏里的 Agent Memory Lab 图标，打开同步侧栏。
9. 保存当前网页或选中文本，回到 Viewer 记忆库确认待审阅内容出现。
10. 如果输入框旁没有“记忆建议”或侧栏识别异常，再打开自检页：

```text
启动输出里的 Viewer 地址 + /demo/browser-extension.html
```

## 完整工作台试用路线

如果还没有启动待审阅队列和记忆库，需要启动完整工作台：

```bash
cd agentmemory-lab
npm run build && npm run start:local-memory
```

默认地址：

```text
Viewer: 启动输出里的 Viewer 地址，例如 http://localhost:3114/#dashboard
API: http://localhost:3111
```

然后可以试：

- 插件保存当前网页。
- 右键保存选中文本或链接。
- 在弹窗或同步侧栏里先改标题或正文，再加入待审阅。
- 回到 Viewer 的记忆库，查看待审阅队列，并确认保存范围、分类备注、来源和经验候选状态没有丢失。
- 编辑标题、内容、标签和项目后再保存。

如果不确定完整工作台是否已经正常运行，可以另开终端检查：

```bash
cd agentmemory-lab
npm run check:workbench
```

它会检查 API、Viewer 和插件 demo 页，并提示端口可能被占用还是需要重新启动。

也可以检查当前发布门槛：

```bash
cd agentmemory-lab
npm run status:delivery
```

这个命令会先告诉你当前插件包、核心体验、真实 AI 站点证据和下一步目标是什么。

也可以继续看发布门槛：

```bash
cd agentmemory-lab
npm run check:release-gates
```

如果准备公开发布，再运行：

```bash
cd agentmemory-lab
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

逐站操作请按 `docs/browser-extension-ai-site-test-cards-cn.md` 执行。它把 ChatGPT、Claude、Gemini、Perplexity 四个公开发布必测站点拆成测试卡，并说明每个站点要观察输入框、发送按钮、模型选择和附件入口是否被插件影响。

给测试者发包前，可以先生成一页式外测包：

```bash
cd agentmemory-lab
npm run prepare:ai-validation
npm run make:ai-validation-tester-pack
```

优先把 `artifacts/ai-validation-run/quickstart-cn.md` 发给测试者，它是一页短清单。需要更完整的站点细节时，再看 `artifacts/ai-validation-run/tester-pack-cn.md`；它会按当前提交列出 ChatGPT、Claude、Gemini、Perplexity 的建议 prompt、证据文件名、保存命令和隐私边界，适合贴到飞书或发给测试者。

每个站点至少确认：

- 页面被识别为对应 AI 产品。
- 输入框状态是“已找到”。
- 输入框附近出现“记忆建议”。
- 记忆可以插入或复制。
- 同步侧栏可以复制问题信息 JSON，也可以复制保存证据的终端命令。
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
cd agentmemory-lab
npm run wizard:ai-validation-evidence -- --file diagnostics.json
npm run check:ai-validation-evidence
npm run sync:ai-validation-table
```

优先使用 `npm run wizard:ai-validation-evidence`。它会读取剪贴板里的诊断 JSON，并询问插入/复制本地记忆、诊断复制、原站输入发送、浏览器版本和无隐私备注。后续命令会生成 `artifacts/ai-validation-evidence-summary.json` 并同步 `docs/browser-extension-ai-validation-cn.md` 的真实站点验收表，用于汇总 ChatGPT、Claude、Gemini、Perplexity 是否已经具备公开发布所需的真实页面证据。

## 反馈时请提供

可以直接复制 [外部试用反馈模板](external-feedback-template-cn.md) 填写。
如果要在 GitHub 上提交，使用仓库里的结构化 Issue 模板：`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml`。
维护者收到反馈后，按 [外部反馈分诊指南](external-feedback-triage-cn.md) 判断问题属于本地连接、站点适配、输入框插入、审阅队列、隐私信任还是交付文档。

- 试用日期。
- 浏览器名称和版本。
- 操作系统。
- 目标站点。
- 截图或录屏。
- 同步侧栏复制出来的诊断 JSON，以及侧栏“复制检查步骤”生成的保存命令执行结果。
- 如果可以，直接提供 `docs/validation/browser-extension-ai-sites/` 下的证据 JSON 文件。
- 复制问题信息里的 `manualValidation` 字段需要按真实结果改成 `true` / `false`，不要默认当作通过。
- 诊断 JSON 里 `editorFound`、`anchorFound`、`placement`、`memoryWidgetVisible` 的状态。
- 哪一步不符合预期。

## 当前不能承诺

- 还没有 Chrome Web Store 正式发布。
- 还没有完成所有真实 AI 网页的逐站验收。
- 插件不会绕过登录或读取付费产品内部不可见内容。
- 插件不应该保存敏感隐私页面作为演示素材。
