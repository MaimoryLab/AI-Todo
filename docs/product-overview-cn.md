# AI-Todo 产品概览

AI-Todo 是一个本地优先的 AI 待办收件箱。它把分散在 Codex、Claude Code 和浏览器会话里的未完成工作整理成 todo，并保留原始 evidence，帮助用户判断每个事项是否可信、是否要继续推进。

## 用户旅程

1. 捕获会话：从本地 agent 会话或浏览器入口导入记录。
2. 组织待办：通过 LLM-only 提取近期未完成事项，每次优先处理最近的会话窗口，不使用 rules fallback 生成默认卡片。
3. 审查证据：每张 todo 都能回到相关 observation 和 session。
4. 处理事项：用户确认、完成、忽略、归档或回到来源继续工作。
5. 日常复盘：围绕 pending、blocked、needs review 和 done today 管理 open loops。

## 核心功能

- 本地 SQLite 存储 session、observation、todo、evidence 和 organize run。
- CLI、HTTP UI 和 MCP 三个入口共享同一套数据。
- `ai-todo open` 默认使用 `127.0.0.1:3111`，可通过 `--port <n>` 覆盖。
- Organize 默认处理最近 16 个 session，点击后会显示预计等待时间。
- Codex 和 Claude Code 支持默认路径，也支持显式路径扫描。
- 浏览器会话通过本地 HTTP API 进入同一 evidence 链路。

## Evidence 链路

Todo 卡片不是孤立结论。它需要展示：

- 来源类型：Codex、Claude Code 或 browser。
- 来源 session 和 observation。
- 触发 todo 的原始内容片段。
- 最近一次 organize run 的结果和 warning。

原始 evidence 内容保持原语言；产品界面和控件保持英文。

## Todo 状态

- `todo`：仍需处理。
- `done`：用户已完成。
- `ignored`：用户决定不再跟进。

近期 UI 优先展示待处理、阻塞、进行中和需要确认的事项，减少调试信息对决策流的干扰。

## LLM-only 卡片生成

当前产品方向要求 todo 卡片由 LLM 提取。缺少 API key、provider 失败、模型输出无效或本地服务不可用时，应展示清晰诊断和下一步，而不是恢复 rules fallback。这样可以避免把低置信度规则结果伪装成已组织的 AI todo。

## 当前限制

- 需要 OpenAI-compatible LLM endpoint。
- 浏览器捕获仍依赖本地 UI/API 可用。
- 当前没有自动杀占用 `3111` 的非 AI-Todo 进程。

## 近期路线图

- 产品化固定端口和启动错误提示。
- 强化 OpenAI-compatible provider 错误诊断。
- 统一 To-Do、Evidence、Settings 的图标和状态表达。
- 强化 source/avatar 资产，减少 confusing initials fallback。
- 保持 390px mobile 和 desktop 布局无横向溢出。
