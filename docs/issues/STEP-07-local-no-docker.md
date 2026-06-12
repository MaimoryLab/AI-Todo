# STEP-07：本地去 Docker（完备计划）

- 线:B（去 Docker，独立于线 A，可并行）
- 状态:✅ 路线 A 完成（07a/07b/07c），07d 不做（保留物料）
- 依赖:STEP-00（已跳过，基线已绿）
- 对应 PR:`Claude/no-docker-local`

## 目标（一句话）

让**个人本地用户**的启动路径完全不涉及 Docker（默认走原生 iii 二进制），并清理由此变得过时/误导的指导文档；同时**不破坏**面向自托管者的容器部署能力（`deploy/`）。保留 iii-engine 与三原语，**不动 AGENTS.md 铁律**。

## 路线拍板（先定这一个，决定后续全部子步骤）

| 路线 | 含义 | 影响面 | 风险 |
|---|---|---|---|
| **A. 保留隐藏（推荐）** | docker 物料保留，但默认路径、文档、提示全部以原生二进制为主；docker 降为「附录/自托管」 | 文档 + CLI 提示文案 + 默认行为 | 低 |
| **B. 本地彻底删除** | 删根级 `docker-compose.yml`/`iii-config.docker.yaml`，移除 CLI 的 docker 分支，`deploy/` 自带 compose 保留 | 上面全部 + 代码删除 + 测试改写 + 发布清单 | 中 |

> 默认按 **路线 A** 规划（与方案 §12.4、你此前选择一致）。下面同时标出「若选 B 额外要做什么」。

## Docker 渗透全景（实测，2026-06-12 origin/main）

分六层，按是否属于「本地启动」分类:

### 第 1 层 — CLI 启动/停止逻辑（核心，`src/cli.ts`，67 处）
- `startEngine()`（763–855）:docker 作为「显式 opt-in 或安装失败兜底」分支。
- `EngineState`（414, 483, 843）:状态持久化含 `kind:"docker"`。
- `spawnEngineBackground`（678–708）:`docker-crashed` 崩溃分类。
- `stopDockerEngine` / stop 流程（2016, 2067）:`docker compose down` + `docker pull` 兜底。
- `discoverComposeFile`（498–502）+ 启动失败提示（624, 634, 659, 882–900, 1044–1063）。
- 帮助文本 `AGENTMEMORY_USE_DOCKER`（162）。

### 第 2 层 — 本地配置与发布物料（根级）
- `docker-compose.yml`（根）、`iii-config.docker.yaml`（根）。
- `package.json`:`build` 脚本 `cp docker-compose.yml dist/` + `cp iii-config.docker.yaml dist/`；`files` 清单含这两者（66–68）。

### 第 3 层 — 测试守卫
- `test/consistency.test.ts:77`（#136 回归）:**强制** docker-compose.yml 的 bind mount 都在 `files` 里，且 `sources.length > 0`。删 compose 必须同步删/改此测试。
- `test/integration.test.ts:37`:提示文案 `docker compose up -d && npm start`（仅文案）。

### 第 4 层 — 自托管部署（`deploy/`，**不属于本地，需保留**）
- `deploy/{coolify,fly,railway,render}/` 各有 `Dockerfile` + `entrypoint.sh` + 平台配置 + `README.md`。
- 这是给想自托管的人用的容器化路径，**与「本地去 docker」正交**，路线 A/B 都应保留。

### 第 5 层 — 文档/指导（量大）
- 主 `README.md`:实测**不含** docker（已引导 `npm run start:local-memory`）✓
- `READMEs/README.*.md` × 11 语言:各 ~13–14 处 docker 启动说明，**与主 README 不一致**（需同步为原生优先）。
- `deploy/README.md`、`deploy/*/README.md`:自托管文档，保留。
- `ROADMAP.md`、`CHANGELOG.md`、`benchmark/*`:历史/路线提及，多数无需动。
- `.github/security-advisories/`:docker bind 安全说明，保留（历史记录）。

### 第 6 层 — 噪音（非 docker 实质）
- `src/state/synonyms.ts`、`eval/data/*`、`benchmark/dataset.ts`、`src/logger.ts`、`src/cli/preferences.ts:112`(注释)：仅字面命中，**不动**。

## 拆分子步骤（每个 = 一个 PR，由小到大、互不阻塞）

> 单 PR 体积可控、可独立回滚。建议合并顺序 07a → 07b → 07c →（07d 仅路线 B）。

> ⚠️ **范围修正（fork 背景）**:`READMEs/README.*.md` × 11 是 **fork 自上游开源记忆项目的原版多语言文档**，不是当前中文本地工作台的翻译。它们面向上游通用项目的用户（含 Windows/Docker/自托管详解），且未来可能 rebase 上游。**07a 不改这些文件**——改它们既偏离「去 docker」本意，又会制造上游冲突，且 docker 在那个语境是合理的。当前产品的真实入口是主 `README.md`（已原生优先、不含 docker）。

### STEP-07a — 当前产品文案对齐（极小、零 CI 风险）
- ❌ **不碰** `READMEs/README.*.md` × 11（上游 fork 资产，保持原样）。
- ✅ 改 `test/integration.test.ts:37` 提示文案 `docker compose up -d && npm start` → 原生 `npm run start:local-memory`（当前仓库测试，属本产品）。integration 测试默认被 `npm test` 排除，但文案应正确。
- ✅ 主 `README.md` 已是原生优先，**无需改**（复核确认）。
- **风险**:极低。一处测试文案。

### STEP-07b — CLI 默认与提示收敛（路线 A 核心）
- `src/cli.ts`:确保非交互/默认路径永不自动选 docker（现状已是，加固 + 注释）；把面向用户的 docker 提示统一改为「自托管才需要，见 deploy/」。
- 不删 docker 分支代码（保留 opt-in 与兜底），只调整默认与文案。
- **风险**:低。需手验 `start`/`stop`/`--help` 文案与非交互启动仍走原生。

### STEP-07c — 自托管文档归位（澄清边界）
- `deploy/README.md` 顶部明确:这是**自托管/容器**路径，个人本地用户用 `npm run start:local-memory` 即可，不需要 docker。
- `docs/` 与 README 增加一句「本地 vs 自托管」的指引。
- **风险**:极低。纯文档。

### STEP-07d —（仅路线 B）本地物料删除 + 测试改写
- 删根级 `docker-compose.yml`、`iii-config.docker.yaml`。
- `package.json`:`build` 去掉两处 `cp ... dist/`；`files` 移除两项。
- `test/consistency.test.ts:77`:删除或改写 #136 守卫（它以根 compose 存在为前提，`sources.length>0` 会失败）。
- `src/cli.ts`:移除 `discoverComposeFile`、`EngineState` 的 docker 分支、`stopDockerEngine`、docker 兜底提示。
- **风险**:中。删除面广，须确保 `npm test` 全绿、`npm run build` 不再引用已删文件、`deploy/` 自带 compose 不受影响（deploy 的 compose 在子目录，不被根级测试扫描——需确认）。

## 结果预测（执行前填）

- 构建:各子步 `npm run build` 通过（07d 需先改 build 脚本再删文件，否则 `cp` 失败——注意顺序）。
- 测试:07a/07b/07c 维持 0 失败（124/1334）。07d 需同步改 `consistency.test.ts`，预期净变化为该用例删除/改写后仍全绿。
- 行为:个人用户 `npm run start:local-memory` 全程无 docker；`--help`/错误提示不再把 docker 当主选项；自托管者仍可用 `deploy/`。
- 风险:
  - **顺序陷阱（07d）**:必须先改 `package.json` build 的 `cp docker-compose.yml dist/`，再删文件，否则 build 报错。
  - **测试守卫（07d）**:`consistency.test.ts:77` 的 `sources.length>0` 在 compose 删除后必失败，必须同改。
  - **deploy 边界**:确认根级去 docker 不波及 `deploy/*/docker-compose.yml`（子目录、独立）。

## 验证命令

```bash
npm run build
npm test                       # 期望 0 失败
npm run start:local-memory     # 确认全程走原生二进制、无 docker 调用
node dist/cli.mjs --help       # 确认 docker 不再是主选项
node dist/cli.mjs stop         # 确认 stop 流程在无 docker 时正常
```

## 回滚

每个子步独立 PR，`git revert` 即可。07d 删除类改动回滚后需 `npm install`/`build` 复原 dist。

## 待你拍板

1. **路线 A（保留隐藏）还是 B（本地删除）?**（决定是否做 07d）
2. 是否本期就做，还是排在线 A（STEP-02/03）之后？（两条线不阻塞）

## 实际反馈（执行后由你回填）

- 构建:✅ `npm run build` 通过（~3.3s）。
- 测试:✅ `npm test` **124 文件 / 1334 用例全绿，0 回归**。
- 行为:`node dist/cli.mjs --help` 实测——`AGENTMEMORY_USE_DOCKER` 现明确标注「native 是默认与推荐路径，Docker 用于自托管，见 deploy/」；Quick start 段本就原生优先。
- 实际改动（路线 A，未删任何物料）:
  - **07a**:`test/integration.test.ts:37` 提示 `docker compose up -d && npm start` → `npm run build && npm run start:local-memory`。**未碰** 11 个上游 fork 的 `READMEs/README.*.md`（见范围修正）。主 README 复核确认已原生优先、无需改。
  - **07b**:`src/cli.ts` 帮助文本 `AGENTMEMORY_USE_DOCKER` 改写为「自托管用、原生为默认」；交互选项 docker 的 hint `advanced` → `advanced · self-host`。**未删** docker 分支代码（opt-in 与安装失败兜底保留）。
  - **07c**:`deploy/README.md` 顶部加「本地不需要 Docker，本目录是自托管路径」的中文指引。
- 与预测的差异:
  - **范围收窄（fork 漂移）**:发现 11 个语言 README 是 fork 自上游开源项目的原版文档（非本产品翻译），改它们会偏离去 docker 本意并制造未来 rebase 冲突 → 07a 收窄为只改本仓库测试文案。已记入 design-lock G 第 2 条与本步范围修正。
  - 其余按预测，零回归。
- 下一步影响（下游待更新清单）:
  - **启动方式现已统一**:个人本地路径 = `npm run start:local-memory`，无 docker 干扰——为 **STEP-02 真实数据排查**铺平（这是本期优先做 07 的原因）。
  - 未触及 `deploy/` 容器能力、根级 docker 物料、`consistency.test.ts` #136 守卫——路线 A 全部完整保留，未来若要彻底删除（07d）仍可独立进行。
  - 无对线 A（STEP-02/03/04/05）的代码影响。
