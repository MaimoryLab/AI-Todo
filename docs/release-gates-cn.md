# Agent Memory Lab 发布门槛

这份文档用来区分三个状态：本地可演示、外部可试用、公开可发布。它避免把“能跑 demo”误说成“已经可以公开发布”。

## 当前结论

| 状态 | 结论 | 证据 |
| --- | --- | --- |
| 本地可演示 | 已达到 | `npm run check:delivery` 通过；README 和飞书文档已同步；首页和 Skill 页截图齐全 |
| 外部可试用 | 基本达到 | 有外部试用指南、插件 zip、免登录预览页、交互烟测、隐私说明和验收表 |
| 公开可发布 | 未达到 | 仍缺真实 AI 站点逐站验收、公开隐私政策 URL、发布截图和商店审核材料 |

## 本地可演示门槛

- README 是中文图文版。
- README 只放首页和 Skill 管理台两张真实产品截图。
- 飞书项目介绍和 README 叙事一致。
- `npm run check:delivery` 通过。
- `npm run check:workbench` 能给出 API、Viewer 和插件 demo 页的当前状态。
- 本地免登录插件预览页可打开。
- 插件交互烟测通过：输入问题后出现“记忆建议”，演示记忆可插入输入框。

## 外部可试用门槛

- 可以生成 `artifacts/agent-memory-lab-extension.zip`。
- 可以生成 `artifacts/delivery-summary.md` 和 `artifacts/delivery-manifest.json`，用于快速查看当前版本、提交、产物、sha256 和发布状态。
- zip 内容检查通过，不包含 macOS 元数据。
- zip 内包含 `browser-extension/LOAD-THIS-FIRST.md`，解压后有独立加载说明。
- 试用者知道两种加载方式：从仓库加载 `browser-extension/`，或从 zip 解压后加载 `browser-extension/`。
- 插件弹窗能显示扩展版本、本地连接状态和外部试用指南入口，便于试用者自查是否加载正确。
- 插件权限与隐私说明齐全。
- 弹窗和同步侧栏都有保存前审阅草稿，可改标题、正文、保存范围、分类备注和经验候选状态，再送入 Viewer 待审阅队列。
- 外部试用指南说明了启动、加载、预览、反馈诊断 JSON 的流程。
- 外部试用反馈模板存在，并能收集环境、路径、问题、诊断 JSON、截图和影响程度。
- GitHub 外部试用 Issue 模板存在，并能收集试用路径、环境、诊断 JSON、manualValidation 和隐私确认。
- 外部反馈分诊指南存在，并能把反馈归类到本地连接、站点适配、输入事件、审阅队列、隐私信任或交付文档。
- 诊断 JSON 包含扩展版本、输入框命中规则、入口锚点、入口位置策略和记忆建议可见状态。
- AI 站点验收记录区分“本地可验证”和“真实站点待验收”。
- 真实 AI 站点诊断 JSON 有固定证据目录，并可用 `npm run check:ai-validation-evidence` 汇总。
- 可以生成 `artifacts/ai-validation-run/tester-pack-cn.md`，让外测者按同一套站点、prompt、隐私边界和证据命令执行。

## 公开可发布门槛

公开发布前必须补齐：

- ChatGPT 真实页面验收。
- Claude 真实页面验收。
- Gemini 真实页面验收。
- Perplexity 真实页面验收。
- 真实站点验收记录中要保留诊断 JSON 或截图证据；诊断 JSON 必须包含 `turnCount > 0` 和会话区域 selector。
- 记忆候选必须来自具体对话或用户选中的文字，页面标题、链接、导航文案或输入框草稿不能计入公开发布通过证据。
- `artifacts/ai-validation-evidence-summary.json` 中必需产品通过数为 4/4。
- 至少一组不含私人信息的插件截图或短录屏。
- 稳定公开隐私政策 URL。
- Chrome Web Store 权限说明与 `browser-extension/manifest.json` 一致。
- Store listing 文案和当前产品能力一致，不承诺未完成能力。

## 每次更新后的默认检查

```bash
npm run package:browser-extension && npm run check:delivery
```

查看当前发布门槛：

```bash
npm run status:delivery
```

`status:delivery` 会同时显示 current commit 和 artifact commit。两者不一致时，说明交付物是旧提交生成的，需要先重新运行 `npm run package:browser-extension`。

再看详细发布门槛：

```bash
npm run check:release-gates
```

准备真实 AI 站点外测包：

```bash
npm run prepare:ai-validation
npm run make:ai-validation-tester-pack
```

公开发布前必须额外通过：

```bash
npm run check:release-public
```

在真实 AI 站点验收完成前，`check:release-public` 应该失败，避免误把外部试用版说成公开发布版。

如果飞书源文档有变化，同步到线上飞书文档。
