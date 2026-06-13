# 工作流全面审查（从用户视角发现问题与方向）

> 在三栏重构（线 A STEP-01–06 + 线 B STEP-07 全部合并）告一段落后，全面梳理当前**开发工作流**与**产品工作流**，从「个人重度 Agent 用户」视角找问题、定方向。本文不重开方向讨论（方向见 `../product-restructure-plan-cn.md`），只审查「流程与现状是否对得上、哪里会绊脚」。

## 1. 开发工作流现状（已验证有效）

一步一分支一 PR 的薄切流程跑通了 7 个 STEP、0 回归:

```
origin/main 起干净 Claude/<name> 分支
  → 改（先复核 STEP 文件的「结果预测」）
  → npm run build + npm test（本地）
  → 回填 STEP「实际反馈 + 与预测差异 + 下游待更新清单」+ 更新看板
  → commit → gh pr create → 等 4 格 CI 绿 → merge
  → 下一步从 main 重新起分支
```

**有效的关键点**:
- 预测在开工前复核（不是写完冻结）——靠这个抓到了 STEP-02「上游已做完」、STEP-06「signals 语义不对」。
- 浏览器实证（preview）补单测覆盖不到的 UI 行为。
- 文档类 PR 走 paths-ignore 零 CI 成本，可单独合（PR#11 看板校正）。

## 2. CI 与验证面的真实形态

| 层 | 事实 | 含义 |
|---|---|---|
| CI 触发 | push/PR to main + 手动 | 文档(`**/*.md`、`docs/**`)paths-ignore 不触发 |
| 矩阵 | ubuntu/macos × node 20/22 = 4 格，全量 `npm test` | 没有分片，红就整格红；一格 ~1.5–2min |
| CI 跑什么 | 只 `build + test` | **20+ 个 `check:*` 脚本一个都不在 CI 跑** |
| 一致性保障 | 全靠 `test/consistency.test.ts` 在 `npm test` 里 | 事后兜底，4 格跑完才知道 |
| 贡献者 pre-PR | install/build/test（CONTRIBUTING） | **无聚合命令，check:* 不在默认流程** |

**问题 1（流程缺口）**:`check:*` 验证面庞大（browser-extension 7 连、delivery、workbench、ai-validation 全家）但**游离在 CI 和默认流程之外**。新人/未来的自己不知道何时该跑哪个。→ 见 §5 改进项。

**问题 2（反馈延迟）**:一致性铁律(改 8/3/7 处)只在 CI 兜底，本地无快反馈。碰 MCP/REST/版本就有「推上去等 ~7min 才发现计数断言红」的风险。→ §5 建议本地自检。

## 3. 文档与现实的漂移（审查重点发现）

审查中发现多处 doc-drift，**会误导未来决策**，应择机校正:

| 漂移项 | 文档说 | 实际 | 影响 |
|---|---|---|---|
| 版本号 | AGENTS.md: v0.9.16 | package.json: v0.9.24 | 中——Current Stats 整段过时 |
| MCP 工具数 | AGENTS.md: 53；design-lock: 53 | 实际 51（getAllTools 动态） | 中——改工具时基数错 |
| Skill 数 | AGENTS.md: 4 | 实际 12（plugin/skills/） | 低 |
| REST 端点 | 硬编码 "131"（src/index.ts、AGENTS、README） | consistency.test 动态数比对 | 高——三处文本不一致就 CI 红 |
| 版本改动文件数 | AGENTS.md: 7 处 | CONTRIBUTING: 8 处（多算 lock） | 低——两文档自相矛盾 |
| 基线失败 | （旧 memory）8 个失败 | STEP-00 已修，128/1384 全绿 | 已在本轮 memory 沉淀中删除 |

**判断**:这些不在任何 STEP 范围内、又确实会绊脚。建议单独一个**文档校正 PR**（零 CI 成本）统一对齐 AGENTS.md Current Stats + design-lock C 节计数 + CONTRIBUTING 版本文件数。注意 `READMEs/README.*.md` × 11 是上游 fork 资产，不动（rebase 冲突风险）。

## 4. 从用户视角看产品工作流（个人重度 Agent 用户）

把自己当目标用户走一遍，看「三栏重构后，用户的真实使用回路是否闭环」:

### 4.1 已闭环
- **总览 → 待办 → 证据** 三栏导航成立，待办首位。
- 待办卡「看原文 →」跳证据（STEP-03），Agent 回复 Markdown 渲染（STEP-04），专家模式收纳被砍视图（STEP-05）。

### 4.2 缺口（design-lock D 节 + STEP-06 暴露）
1. **「待回应」是空壳**:UI 形态立了（STEP-06），但后端无「Agent 提问、等用户回应」语义。**这是用户最在意的一类**（会议明确:Agent 运行中抛问题、时间敏感）——目前完全没有真实能力。
2. **「已完成识别」缺失**:`action.status:done` 字段在，但抽取器不主动从会话识别「今天完成了什么」。用户看不到「已完成简报」。
3. **投递出口未接**:待办/待回应只在 viewer 里看，会议设想的 `lark-cli + openclaw → 飞书机器人` 推到手机这条出口完全没动。用户离开工作台就收不到提醒。

### 4.3 用户视角的优先级判断
对「个人重度 Agent 用户」，**离开工作台仍能收到时间敏感问题**（4.2.3 投递出口 + 4.2.1 待回应语义）比「工作台内多一个视图」价值高得多。当前所有重构都在「工作台内」，真正的用户痛点（异步触达）还没碰。

## 5. 改进建议（按性价比排序）

1. **加 `npm run pre-pr` 聚合命令**（build + test）写进 CONTRIBUTING——把口头约定变命令。低成本、每步都受益。
2. **本地一致性自检**（`scripts/check-consistency-local.mjs` 或 PreToolUse hook）——碰 MCP/REST/版本时秒级提示要同步的 N 处，不必等 CI。
3. **文档校正 PR**（§3 漂移项，零 CI 成本）——一次对齐计数与版本。
4. **viewer preview 代理脚本入仓 + launch.json 固化**（见 tooling-and-skills-cn.md §4）。
5. **下一产品方向定位**:把「待回应后端语义 + 飞书投递出口」作为下一条线（线 C？），这是用户视角的真痛点；线 A 已交付工作台形态，该往「异步触达」走了。

## 6. 下一步建议（供拍板）

- **流程侧**:落地 §5.1–§5.4（都是小、独立、可零 CI 成本的改进），把这次重构验证的工作流固化下来。
- **产品侧**:规划「线 C:Agent→用户异步触达」——后端定义待回应/已完成语义 + REST 端点，前端把 STEP-06 空壳接真实数据，并接 lark-cli/openclaw 飞书投递。这是从用户视角看最该做的下一件事。
- 沉淀已完成:工作方法论已写入 memory（[[agentmemory-restructure-workflow]] / [[agentmemory-consistency-rules]]），下次可直接复用。
