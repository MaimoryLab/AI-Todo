# Agent Memory Lab 外部反馈分诊指南

这份指南用于把外部试用反馈快速分成可执行任务。目标不是讨论“感觉不好”，而是判断问题属于连接、站点适配、记忆召回、审阅队列、打包交付还是文档说明。

## 先看三份材料

1. 反馈模板：`docs/external-feedback-template-cn.md`
2. 侧栏诊断 JSON：尤其是 `ai` 和 `manualValidation`
3. 当前状态：`npm run status:delivery`

如果反馈没有诊断 JSON，先请试用者补“同步侧栏 -> 复制问题信息”。如果涉及真实 AI 页面公开发布验收，还需要把 JSON 放到 `docs/validation/browser-extension-ai-sites/`。

## 分诊表

| 现象 | 优先看 | 归类 | 下一步 |
| --- | --- | --- | --- |
| 插件弹窗显示未连接 | `npm run check:workbench`、API/Viewer 地址 | 本地连接 | 启动工作台或修配置页默认地址 |
| demo 页没有“记忆建议” | `npm run preview:browser-extension`、demo interaction check | 插件预览 | 修 demo 页或 content script 注入逻辑 |
| AI 页面 provider 识别错 | `ai.provider`、`page.host` | 站点适配 | 更新 `shared/site-config.js` 和内容脚本站点表 |
| 输入框未找到 | `ai.editorFound`、`ai.editorSelector` | 站点 selector | 补 `editorSelectors`，增加 fixture |
| 入口锚点未找到 | `ai.anchorFound`、`ai.placement` | 入口位置 | 补 `anchorSelectors` 或调整 placement |
| 只有页面标题/链接，没有具体对话记忆 | `ai.turnCount`、`matchedSelectors.turn`、候选草稿来源 | 会话抽取 | 补 `turnSelectors`，确认 `turnCount > 0` 后再算真实站点通过 |
| 有入口但挡住原站按钮 | 截图/录屏、`ai.placement` | 交互位置 | 调整 placement 或样式 |
| 插入记忆失败 | `manualValidation.memoryInsertPassed`、目标站点 | 输入事件 | 修插入逻辑和 input/change 事件触发 |
| 原站输入/发送异常 | `manualValidation.siteInputStillWorks` | 站点兼容 | 优先回滚相关站点注入策略 |
| 加入待审阅后 Viewer 看不到 | API 响应、最近同步、Viewer 待审阅 | 审阅队列 | 检查 `/agentmemory/review` 和来源筛选 |
| 保存内容不可信/太黑盒 | 草稿截图、标题正文、项目、标签、经验候选状态 | 审阅草稿 | 优化弹窗/侧栏草稿生成与说明 |
| zip 加载不清楚 | `LOAD-THIS-FIRST.md` 是否被看到 | 交付文档 | 更新 zip 内说明和外部试用指南 |
| 用户担心隐私 | 复制问题信息内容、隐私说明 | 隐私/信任 | 更新隐私说明，删去不必要字段 |

## 优先级规则

| 优先级 | 条件 | 处理方式 |
| --- | --- | --- |
| P0 | 插件无法加载、demo 无法预览、审阅队列无法保存 | 立即修，修完跑 `npm run check:delivery` |
| P0 | 公开发布必需站点出现原站输入/发送异常 | 立即修，未修前不得标记站点通过 |
| P1 | 必需站点 provider/input/anchor/turn 任何一项失败，或 `turnCount` 为 0 | 更新 selector，补真实证据 |
| P1 | 保存前草稿不清楚、用户不知道保存到哪个项目或带了什么标签 | 优化弹窗/侧栏草稿元信息 |
| P2 | 文档措辞、截图、非必需站点适配 | 排入下一版 |

## 修复后的最小验证

每次修复后至少运行：

```bash
npm run check:browser-extension
npm run check:delivery
npm run status:delivery
```

如果修的是真实 AI 页面适配，还要运行：

```bash
npm run check:ai-validation-evidence
npm run sync:ai-validation-table
npm run check:release-gates
```

如果准备公开发布，最后运行：

```bash
npm run check:release-public
```

在 ChatGPT、Claude、Gemini、Perplexity 的表格和证据 JSON 都没有 4/4 通过前，公开发布检查失败是正确结果。
