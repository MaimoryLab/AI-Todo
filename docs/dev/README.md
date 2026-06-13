# 开发环境文档结构（dev docs）

本目录是 **重构期间** 的开发环境文档与执行索引。它服务于一个目标:在一次盘子很大、过程必然频繁出错的重构里，让每一步都**小、可验证、可回滚**，并把每一步的「预测结果 vs 实际结果」沉淀下来。

## 目录结构

```text
docs/
├── product-restructure-plan-cn.md   ← 产品方案(为什么/做什么，方向源头)
├── dev/                             ← 开发环境文档(怎么做/在哪做)
│   ├── README.md                    本文件:索引 + 工作流约定
│   ├── environment.md               开发环境、命令、CI 实情、基线状态
│   ├── design-lock-cn.md            🔒 锁定的产品设计文档(冻结基线，改动需走变更流程)
│   ├── tooling-and-skills-cn.md     提效工具/Skill/MCP 整理与吸纳建议
│   └── workflow-review-cn.md        工作流全面审查(含 doc-drift 清单 + 用户视角方向)
└── issues/                          ← 重构步骤拆解(每个文件 = 一步 = 一个 PR)
    ├── README.md                    issue 看板:状态、依赖、合并顺序
    ├── STEP-00-*.md … STEP-NN-*.md  每步:目标/改动面/结果预测/验证/回滚
    └── TEMPLATE.md                  新步骤模板
```

## 三层文档的分工

| 文档 | 回答的问题 | 改动频率 |
|---|---|---|
| `product-restructure-plan-cn.md` | 为什么重构、最终形态是什么 | 低（方向变才改） |
| `dev/design-lock-cn.md` | 当前基线**确切**是什么样（被冻结的事实） | 🔒 冻结，走变更流程 |
| `dev/environment.md` | 在什么环境、用什么命令、CI 怎么跑 | 中 |
| `dev/tooling-and-skills-cn.md` | 用什么工具/Skill/MCP 提效、怎么固化 | 中 |
| `dev/workflow-review-cn.md` | 工作流哪里会绊脚、doc-drift、下一方向 | 阶段性复盘时 |
| `issues/STEP-*.md` | 具体每一步怎么做、预测什么结果 | 每步执行时更新 |

## 工作流约定（重要）

1. **方向已锁**:产品形态见方案文档，本目录只管「怎么落地」，不重开方向讨论。
2. **一步 = 一个 STEP 文件 = 一个 PR**:不跨 STEP 混改。
3. **每步先预测后执行**:STEP 文件里「结果预测」一节先写好，执行后由你把**实际结果**回填到「实际反馈」一节。预测与实际的差异是下一步决策的输入。
4. **基线必须全绿后才开工**:见 `environment.md` 的基线状态与 STEP-00。
5. **设计锁文档不随手改**:`design-lock-cn.md` 是冻结基线，任何「原来不是这样」的发现都记到对应 STEP 的「实际反馈」，而不是直接改锁文档；确需更新锁文档时在 PR 里显式说明。

## 当前状态

- 方案文档:v2，待 review。
- 设计锁文档:见 `design-lock-cn.md`（v1，待你审查并锁定）。
- 重构步骤:见 `issues/README.md`。
