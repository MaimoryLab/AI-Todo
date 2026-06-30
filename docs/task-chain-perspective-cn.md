# AI-Todo 的任务链视角

## 背景

AI-Todo 当前不是普通待办工具。它的核心场景是从 Codex、Claude Code、浏览器等 AI/Agent 会话中找回尚未收尾的工作，并让用户能回到证据判断下一步。

一个会话里，用户的一次需求、Agent 的回复、后续几轮补充、失败、验证和收尾，通常不是多条孤立消息，而是一条任务链。用户真正关心的不是“哪句话像待办”，而是“这件事推进到哪里了，还差什么”。

## 当前实现判断

项目已经部分采用了任务链思路，但还没有把它产品化。

已经存在的任务链迹象：

- LLM 提取 prompt 已要求以 `taskChains` 为主要单位。
- `buildTaskChains()` 会在同一 session 内把用户需求、assistant 回复、低信息 continuation 合成临时链。
- 前端已经有 evidence 跳转，可以从 todo 回到原始会话证据。

还缺失的部分：

- 数据库只有 `sessions`、`observations`、`todos`、`evidence`，没有持久化的任务链实体。
- `TodoCard` 仍是扁平卡片，只表达 title、description、status、evidenceIds。
- evidence 只指向单个 observation，不能表达一条链上的多轮上下文。
- UI 是 `To-Do + Evidence Browser`，能浏览会话，但没有直接呈现任务链的进展状态。

因此，当前系统能“临时推断任务链”，但不能“稳定表达、查询、追踪任务链”。

## 产品定位建议

AI-Todo 应从“从会话里抽 todo”调整为：

> 从 AI 会话中恢复未完成任务链的最新可继续状态。

一张 AI-Todo 卡代表一条任务链的下一步，而不是一条孤立待办。

每张卡应该围绕这些信息组织：

- 原始用户意图
- 最新 Agent 状态
- 当前状态：open、blocked、needs review、done、ignored
- 下一步行动
- 证据链：关联的 user/assistant observations
- 来源 session

这能解释为什么 evidence 和 session archive 是核心能力，而不是 todo 的附属信息。

## 最小数据模型方向

不要先引入复杂 workflow、graph 或跨 session 合并。最小可用模型是给现有 todo 加一层任务链引用。

建议新增：

```sql
CREATE TABLE task_chains (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  user_observation_id TEXT NOT NULL,
  latest_observation_id TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_chain_observations (
  chain_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (chain_id, observation_id)
);

ALTER TABLE todos ADD COLUMN chain_id TEXT;
```

实现上可以先复用现有 `buildTaskChains()` 的逻辑，把临时链落库。`todos` 继续作为用户看到的下一步卡片，只是多出 `chain_id`。

## 最小 UI 方向

前端不需要马上重做。

优先级更高的改动：

1. 把 `To-Do` 作为主入口，文案改成“Next actions from task chains”。
2. 把 `Evidence` 调整为 `Sessions` 或 `Chains`，保留现有 session rail 和 observation trail。
3. `/todos/:id/evidence` 返回 `sessionId`、`source`、`createdAt`，避免前端为定位 evidence 遍历所有 sessions。
4. 在卡片上显示来源 session 和首条 evidence 摘要。

等 `task_chains` 落库后，再把卡片扩展为：

- intent
- latest status
- next step
- evidence trail

## 风险

最大风险是核心对象错位。

如果继续把任务链压成普通 todo，系统会出现三个问题：

- 用户看到孤立卡片，难以判断真实进度。
- `todo/done/ignored` 不足以表达 blocked、needs review、in progress 等状态。
- LLM prompt 已经按任务链理解会话，但数据库和 UI 没有承接，抽取质量会被产品模型拖累。

## 结论

任务链不是额外功能，而应成为 AI-Todo 的核心产品对象。

短期最小路径是：

1. 承认 todo 是任务链的下一步卡片。
2. 持久化 `task_chains` 和 `task_chain_observations`。
3. 给 todo 和 evidence 补上 chain/session 关联。
4. 用现有 UI 轻量呈现任务链上下文。

跨 session 合并、复杂状态机、自动继续工作等能力先不做，等本地单 session 任务链跑顺后再加。

## 下一步分步计划

### Phase 1：锁定任务链契约

- 定义 `TaskChain`、`TaskChainObservation`、`TodoCard.chainId` 的最小字段。
- 明确状态只先覆盖 `open`、`blocked`、`needs_review`、`done`、`ignored`。
- 保持 LLM-only 卡片生成，不恢复 rules fallback。
- 不做跨 session 合并，不引入复杂 workflow 或 graph。

验收标准：

- 契约文档和 TS 类型能表达一张 todo 属于哪条任务链。
- 旧 todo 在没有 `chainId` 时仍可读取和展示。

### Phase 2：持久化单 session 任务链

- 新增 `task_chains` 和 `task_chain_observations` 迁移。
- 复用现有 `buildTaskChains()` 的 session 内链路识别结果落库。
- 只保存清洗后的 user/assistant observation 关联，不保存 raw JSONL 或工具 payload。
- organize 重跑时按 `dedupeKey + sessionId` 更新已有 chain。

验收标准：

- 同一 session 重复 organize 不重复创建 chain。
- 已有 todo 的 `done/ignored` 状态不因重扫、迁移或重新抽取丢失。

### Phase 3：让 todo 卡片绑定任务链

- LLM 输出仍生成 todo 候选，但写库时补 `chain_id`。
- evidence 继续保留 observation 级 quote，同时能通过 chain 找到上下文 trail。
- `/todos/:id/evidence` 返回 `sessionId`、`source`、`createdAt`，避免前端遍历所有 sessions 定位 evidence。

验收标准：

- Todo 卡片能从 `chainId` 定位 session 和 evidence trail。
- quote grounding 仍然有效；无效 quote 不创建卡片。

### Phase 4：最小 UI 呈现

- To-Do 仍是主入口，只把文案调整为任务链下一步。
- Todo 卡片增加来源 session、首条 evidence 摘要和当前链状态。
- Evidence 继续复用现有 session rail 和 observation trail，不新建复杂页面。

验收标准：

- 用户能从 todo 看出原始意图、最新状态和下一步。
- Evidence jump 不再依赖前端遍历所有 session。

### 暂不做

- 跨 session 任务链合并。
- 自动继续执行任务。
- 复杂状态机、review queue、agentmemory graph 或 iii-engine 迁移。
- rules fallback。
