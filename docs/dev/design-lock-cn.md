# 🔒 产品设计锁定文档（冻结基线）

状态:v1，**待你审查并锁定**。
作用:把「重构开始前，产品确切是什么样」冻结成一份权威事实。重构每一步都以此为对照；任何「原来不是这样」的发现记入对应 STEP 的「实际反馈」，不直接改本文件。锁定后若需变更，须在 PR 中显式标注 `[design-lock change]`。

本文件只描述 **现状（as-is）**，不描述目标形态（目标见 `../product-restructure-plan-cn.md`）。

---

## A. 产品身份（冻结）

- 包名 `@agentmemory/agentmemory`，版本 **v0.9.24**。
- 定位:本地优先的 Agent 记忆系统，基于 iii-engine 三原语（Worker/Function/Trigger）。
- 受众（重构后锁定）:个人重度 Agent 用户。
- 基于 `rohitg00/agentmemory` 二次开发；当前分支聚焦中文本地工作台 + 浏览器记忆同步。

## B. 当前导航与视图（冻结，重构主战场）

Viewer = 单文件 `src/viewer/index.html`（**8884 行**，HTML/CSS/JS 全内联，无构建）。

**主导航实际 6 栏**（`TAB_IDS`）:
```
dashboard(总览) · memories(记忆) · sessions(会话) · lessons(Skill) · actions(待办) · activity(活动)
```

**被路由重定向、用户进不去的视图**（`TAB_REDIRECTS`，代码仍在）:
```
graph→dashboard · profile→dashboard · audit→dashboard · replay→dashboard · crystals→dashboard · timeline→sessions
```

> 冻结含义:重构「砍导航」动的是 `TAB_IDS`/`TAB_REDIRECTS` 这两个数组 + 对应 `view-*` 容器与渲染函数。这些视图的渲染代码是资产，默认不删，收进专家模式。

## C. 后端能力规模（冻结，实测）

| 层 | 规模 | 位置 |
|---|---|---|
| 记忆函数 | 66 个 function 文件 | `src/functions/` |
| REST 端点 | 131 个 | `src/triggers/api.ts` |
| MCP 工具 | 53 个（默认 8 可见） | `src/mcp/` |
| MCP 资源/提示 | 6 / 3 | `src/mcp/` |
| Hook 脚本 | 15 个 | `src/hooks/` |
| Plugin Skill | 12 个 | `plugin/skills/` |
| LLM Provider | 6 家 + 熔断/降级/回退 | `src/providers/` |
| 测试文件 | 131 个（1384 用例） | `test/` |

> 注:README/AGENTS.md 标注的 v0.9.16 / 131 endpoints 是旧值；package 已 v0.9.24。计数以实测为准。

## D. 待办 / 证据链路（冻结，重构核心依赖）

- 待办数据模型 `Action`（`src/types.ts:687`）:`status: pending|active|done|blocked|cancelled`，带 `priority`、`sourceObservationIds`、`sourceMemoryIds`、`result`、`parentId`。
- 抽取器 `action-candidates.ts`:**纯关键词正则**（动词 `修复|补充|实现|调整|验证…` + 英文 follow-up），无大模型。产出 `reason: todo|follow_up|command_failed|blocked|validation_failed`。
- 候选生成:`POST /agentmemory/review/actions/generate`。
- CRUD/边:`mem::action-create/update/get/list/edge-create` → `/agentmemory/actions*`。
- 下一步推荐:`mem::frontier` / `mem::next` → `/agentmemory/frontier`。
- 证据来源:`GET /agentmemory/session/highlights` + `mem::timeline` + `mem::observe`。

**已知缺口（冻结为「待补」）:**
1. **「待回应」语义不存在**:后端无「Agent 提问、等用户回应」概念；最接近的是 `signals`（`replyTo`/`type`）。
2. **「已完成」不主动识别**:`action.status:done` 字段在，但抽取器不从会话识别「今天完成了什么」。

## E. 运行时架构（冻结，去 Docker 线依赖）

- 唯一外部依赖:**iii-engine**（WebSocket `49134`）。
- **启动方式（实测 `startEngine()` 决策链）**:原生二进制是**默认主路径**——PATH 有 `iii` → 直接用；没有 → 查 `~/.local/bin`；仍没有 → 默认推荐安装 ~6MB 二进制。**Docker 仅在显式 `AGENTMEMORY_USE_DOCKER=1` 或原生安装失败兜底时出现**，是 advanced 选项，非必需。
- **去 Docker 决策**:采用温和方案——本地只走原生二进制，保留 engine 与三原语，**不动 AGENTS.md 铁律**。详见方案 §12。
- 状态读写:`StateKV`（6 方法 `get/set/update/delete/list`）→ `sdk.trigger("state::*")` → iii-engine → 文件 SQLite `data/state_store.db`。
- 全项目 `sdk.trigger` 调用约 165 处，**全部收敛**在 `StateKV` + `registerFunction/trigger` 两个接口。
- AGENTS.md 铁律「never bypass iii-engine」**本轮不触动**（激进去 engine 方案为远期备选，方案 §12.5）。

## F. 一致性强约束（冻结，PR 必守）

来自 `agentmemory-lab/AGENTS.md`，**碰这些就要连带改多处，否则 CI 计数断言红**:
- 增删 MCP 工具 → 改 8 处（registry / server / api / index 计数 / test 断言 / README / 2× plugin manifest）。
- 增删 REST 端点 → 改 3 处（api / index 计数 / README）。
- 改版本号 → 改 7 处（package / version.ts / types.ts / export-import / test / 2× plugin manifest）。

## G. 设计文档与现实的已知偏差（冻结为事实，供审查）

1. `DESIGN.md`（兰博基尼风视觉系统，21KB）与实际 UI **完全脱节**，目前悬空未落地。
2. README/ROADMAP 并存两条叙事:开源社区项目（v1.0/基金会/11 语言 README） vs 中文本地工作台/公司交付。**[背景] 本仓库 fork 自上游开源记忆项目**，`READMEs/README.*.md` × 11 是上游原版多语言文档（非主中文 README 的翻译），含 Windows/Docker/自托管详解。处理这些文档属方案 §9「定位收敛」，**不在去 docker（STEP-07）范围**，且改动需顾及未来 rebase 上游的冲突。
3. AGENTS.md 的 Current Stats（v0.9.16）已过时。
4. ~~仓库内项目命名不一致:测试期望 `agentmemory`，manifest 用 `agent-memory-lab`，目录名 `agentmemory-lab`（导致基线 8 个测试失败）。~~ **[design-lock change] STEP-00 已修复**:规范名锁定为 `agentmemory`，3 个 manifest 已对齐，`hook-project` 测试改为动态取 git 顶层目录名；基线已全绿（128 文件 / 1384 用例 0 失败）。

---

## 审查清单（请你逐项确认后此文档即锁定）

- [ ] A 产品身份与受众准确
- [ ] B 导航/视图清单准确（6 主栏 + 6 隐藏视图）
- [ ] C 后端规模数字认可（以实测为准）
- [ ] D 待办/证据链路与两个缺口认可
- [ ] E 运行时架构与减重触点认可
- [ ] F 一致性约束清单认可
- [ ] G 已知偏差属实
- [ ] 权威项目名定为:________（`agentmemory` / `agentmemory-lab` / 其他）— 影响 STEP-00 修复方向
