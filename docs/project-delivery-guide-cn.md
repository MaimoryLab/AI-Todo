# Agent Memory Lab 项目交付说明

这份说明给维护者和试用协作者使用。它不替代 README，而是把“当前能交付什么、怎么验证、还有什么不能承诺”放在一个入口里。

## 当前分支

```text
repo: https://github.com/novitalabs/agentmemory-lab
branch: szn-viewer-ui-iteration
current PR: https://github.com/novitalabs/agentmemory-lab/pull/3
```

这个分支是当前工作入口。目标分支受保护，不能直接推送；交付改动先推到 PR 分支，再通过 PR 合并。浏览器插件、Viewer、中文 README、外部试用文档和交付检查都以这个分支为准。

## 当前可交付范围

- 本地 Viewer 可以作为记忆工作台预览：总览、记忆、会话、活动、Skill、待办等核心入口已经串起来。
- 浏览器插件可以用开发者模式加载，作为网页和 AI 对话进入本地审阅队列的入口。
- 插件支持保存前编辑标题、正文、保存范围、分类备注，并可标记为可沉淀经验。
- 插件会先把内容送入 Viewer 待审阅队列，不直接写入长期记忆。
- AI 对话页的候选记忆必须来自具体对话事实；如果只读到页面标题或链接，会被阻断，不再生成空泛记忆。
- README、插件 README、试用指南、隐私说明、真实 AI 站点测试卡和飞书文档源文件已经放在仓库里。
- 插件 zip 可以用 `npm run package:browser-extension` 生成，适合给内部或熟人外部测试者用开发者模式加载。

## 当前不能承诺

- 这还不是 Chrome Web Store 公开发布版。
- ChatGPT、Claude、Gemini、Perplexity 四个真实 AI 站点还没有全部通过证据，目前公开发布会被检查脚本拦住。
- 插件不会绕过登录，也不会读取页面不可见内容。
- 真实站点 DOM 经常变化，输入框附近的“记忆建议”需要逐站验收和维护。

## 本地启动

```bash
cd agentmemory-lab
npm install
npm run build
npm run start
```

启动后看终端输出里的 Viewer 地址，例如：

```text
http://localhost:3114/#dashboard
```

如果需要接入某台机器已有的本地记忆数据，可以参考 `iii-config.local-memory.yaml`，但不要把个人本机路径当作默认配置。

## 加载浏览器插件

1. 打开 Chrome 或 Edge。
2. 进入 `chrome://extensions`。
3. 打开开发者模式。
4. 选择“加载已解压的扩展程序”。
5. 选择仓库里的 `browser-extension/` 目录。

如果要发给测试者，用下面命令生成 zip：

```bash
npm run package:browser-extension
```

生成物在：

```text
artifacts/agent-memory-lab-extension.zip
```

## 必跑检查

每次准备交付或合并前，建议按这个顺序跑：

```bash
npm run check:browser-extension
npm run check:delivery
npm run package:browser-extension
npm run status:delivery
npm run prepare:ai-validation
npm run make:ai-validation-tester-pack
npm run check:remote-delivery
```

这些检查分别覆盖：

- 插件语法、站点配置、审阅草稿、具体对话记忆草稿、本地 demo 交互。
- README、截图、文档、插件包、交付状态、发布门槛。
- 当前提交对应的真实 AI 站点验收清单。
- 给外测者的一页式真实 AI 站点验收包。
- 远端仓库是否包含当前提交：已合并时看目标分支，未合并时看交付 PR 分支；同时检查插件包是否对齐当前提交。

## 真实 AI 站点验收

公开发布前必须补齐这四个站点：

- ChatGPT
- Claude
- Gemini
- Perplexity

测试入口：

```text
docs/browser-extension-ai-site-test-cards-cn.md
docs/browser-extension-ai-validation-cn.md
docs/validation/browser-extension-ai-sites/
```

测试时打开插件同步侧栏，点击“复制问题信息”和“复制检查步骤”。推荐用：

```bash
npm run prepare:ai-validation
npm run wizard:ai-validation-evidence -- --clipboard
npm run check:ai-validation-evidence
npm run sync:ai-validation-table
```

只有确认“记忆建议可见、可插入或复制、诊断已复制、原站输入和发送不受影响”以后，才能把该站点标为通过。

## 文档入口

- README：`README.md`
- 插件说明：`browser-extension/README.md`
- 插件加载说明：`browser-extension/LOAD-THIS-FIRST.md`
- 外部试用指南：`docs/external-tester-guide-cn.md`
- 产品交付计划：`docs/product-delivery-plan-cn.md`
- 发布门槛：`docs/release-gates-cn.md`
- Mem0 / OpenMemory 参考：`docs/browser-extension-mem0-reference-cn.md`
- 飞书文档：<https://my.feishu.cn/docx/Ys7qdCP3mo1KOtxpVZuc8nPCnZI>
- 飞书文档源稿：`docs/feishu/agentmemory-project-intro-cn.md`
- 飞书白板源稿：`docs/feishu/whiteboards/workflow.mmd`、`docs/feishu/whiteboards/structure.mmd`

## 维护建议

下一步优先做真实站点验收，而不是继续加新页面。现在最重要的是拿到 ChatGPT、Claude、Gemini、Perplexity 的可复现诊断和无隐私截图，确认插件在真实 AI 输入框附近稳定可用。
