# STEP-04：Markdown 渲染

- 线:A（前端三栏）
- 状态:✅ 已合并 PR#10
- 依赖:STEP-01（可与 02/03 并行）
- 对应 PR:`Claude/markdown-render`

## 目标（一句话）

Agent 回复/观测正文用**手写安全子集 Markdown 渲染器**呈现（标题/粗斜体/行内码/代码块/列表/链接），替代当前 `esc()` 纯文本展示。

## 路线拍板（2026-06-12 实测后）

viewer 是 **nonce-CSP 锁死的单文件** `src/viewer/index.html`，由 `document.ts` 直接 `readFileSync` 原样下发，**无打包器把 npm 包注入 HTML**。`buildViewerCsp`(src/auth.ts):`script-src 'nonce-...'`（无 CDN/外链）、`style-src 'unsafe-inline'`、`img-src 'self'`。

→ 引 marked/DOMPurify 必须把压缩源（~50KB+）手动内联进 nonce script 块，巨文件更难维护、升级麻烦、供应链面增加。Agent 文本只需安全子集。**已拍板:手写 ~60 行安全子集渲染器**（在 `esc()` 转义后的文本上做受控替换，先转义、后加标签，杜绝 XSS）。

## 改动面

- 文件:仅 `src/viewer/index.html`。新增 `renderMarkdownSafe(text)`:**先 `esc()` 全文转义**（杜绝原始 HTML/`<script>`），再在转义后的安全文本上用正则加 `<h*>/<strong>/<em>/<code>/<pre>/<ul><li>/<a>` 等白名单标签;链接只放行 `http(s)://` 且加 `rel="noopener noreferrer"`。
- 接入点:`sessionDialogueHighlights` 渲染(7205 `item.summary`)、观测正文(`renderSessionDetail` 逐条 `display.body`)。其余纯文本点暂不动。
- 不动:CSP（`style-src 'unsafe-inline'` 已够内联样式;不放行外链/图片）、数据来源、其他视图。
- AGENTS 连带项:无。

## 结果预测（执行前填）

- 构建:通过;产物**不增第三方体积**（纯手写，无新依赖）。
- 测试:维持 0 失败;新增 `test/viewer-markdown.test.ts`:① `<script>alert(1)</script>` 等恶意输入渲染后不含可执行标签（XSS 看门）② 标题/代码块/列表/链接正确成标签 ③ `javascript:` 链接被拒。`viewer-security.test.ts` 必须仍绿（CSP 不动，应天然绿）。
- 行为:代码块、列表、标题、行内码、加粗正确呈现;可读性提升。
- 风险:
  - **XSS 是头号风险**:必须「先 esc 全文、再受控加标签」，绝不把原始文本塞进 innerHTML。单测锁定。
  - **CSP 不放行 img/外链**:Markdown 图片/外链样式会被拦;Agent 文本几乎无图，可接受（链接渲染为可点 `<a>`，但资源加载受 `connect-src`/`img-src` 限制）。
  - **锚点**（STEP-03 连带）:观测正文外层 `id="obs-anchor-<id>"` 必须保留在最外层容器，别被 Markdown 包裹打散。

## 验证命令

```bash
npm run build
npm test -- --run test/viewer-security.test.ts
# 手动:渲染含代码块/列表/恶意标签的样本，确认安全+正确
```

## 回滚

revert 单 PR；正文回到纯文本展示。独立、低耦合。

## 实际反馈（执行后由你回填）

- 构建:✅ `npm run build` 通过（~3.1s）。**零第三方体积增加**（纯手写渲染器，无新依赖）。
- 测试:✅ `npm test` **126 文件 / 1347 用例全绿，0 回归**。新增 `test/viewer-markdown.test.ts` 9 用例:4 个 XSS 看门（`<script>`/`onerror`/`javascript:` 链接/代码块内 HTML 均被转义）+ 5 个渲染正确性（标题→h3-h5、代码块、行内码、列表、粗斜体、安全 http 链接）。`viewer-security.test.ts` 15 用例仍全绿（CSP 未动）。
- 浏览器实证:`preview_eval` 实跑 `renderMarkdownSafe`——标题/粗体/列表/行内码/代码块/链接全部正确成标签;`<script>alert(1)</script>` 渲染后 `has_script_tag: false`、整段转义为 `&lt;script&gt;...`。
- 实际改动（仅 `src/viewer/index.html`）:
  1. 新增 `renderMarkdownSafe(text)`:**先抽代码块占位 → 全文 esc() 转义 → 在安全文本上加白名单标签**（行内码/链接/粗斜体/标题/列表）→ 还原代码块。链接仅放行 `https?://` 且加 `rel="noopener noreferrer"`。标题映射到 h3-h5 避免与页面 h1/h2 抢层级。
  2. 接入 2 处 Agent 文本:`sessionDialogueHighlights` 的 `item.summary`、`renderSessionDetail` 逐条观测 `display.body`，去掉原 `white-space:pre-wrap`，加 `class="md-body"`。
  3. 新增 `.md-pre`/`.md-code`/`.md-h`/`.md-ul` CSS（用 `style-src 'unsafe-inline'`，未动 CSP）。
- 与预测的差异:
  - **路线变更（已拍板）**:原计划引 marked/markdown-it，实测 viewer 是 nonce-CSP 锁死单文件、`document.ts` 直接 readFileSync、无打包器注入 → 引库须手动内联 ~50KB 压缩源，巨文件难维护+供应链面。改为手写安全子集（你已确认）。已同步 STEP-04 路线拍板段。
  - 观测正文的 `obs-anchor-<id>`（STEP-03 连带）在最外层 `<div>`，Markdown 只动内层 body div，**锚点完整保留**，跳转高亮不受影响。
- 下一步影响（下游待更新清单）:
  - **STEP-05（专家模式）**:被收纳视图里若也展示 Agent 文本，可复用 `renderMarkdownSafe`，无需重写。
  - 若未来要支持图片，需放宽 CSP `img-src`（当前 `'self'` 会拦外链图）——独立决策，非本步范围。
  - 无对 STEP-06 影响。
