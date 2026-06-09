import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const outDir = 'artifacts/ai-validation-run';
const evidenceDir = 'docs/validation/browser-extension-ai-sites';
const requiredProducts = [
  {
    product: 'ChatGPT',
    domains: 'chatgpt.com / chat.openai.com',
    prompt: '帮我找一下我们之前关于浏览器插件和本地记忆的产品决策。',
    focus: '输入框底部工具栏、发送按钮、语音按钮、模型选择入口。'
  },
  {
    product: 'Claude',
    domains: 'claude.ai',
    prompt: '总结一下 Agent Memory Lab 的插件交付还差哪些真实站点证据。',
    focus: '富文本输入框、附件按钮、发送按钮、项目页和普通聊天页差异。'
  },
  {
    product: 'Gemini',
    domains: 'gemini.google.com',
    prompt: '基于我的本地记忆，帮我整理浏览器插件的下一步验收计划。',
    focus: 'rich-textarea 输入区、发送按钮、语音/图片入口、多语言按钮文本。'
  },
  {
    product: 'Perplexity',
    domains: 'perplexity.ai / www.perplexity.ai',
    prompt: '检索并结合我的本地记忆，说明多 AI 网页记忆插件应该怎么验收。',
    focus: '搜索输入框、追问输入框、来源面板和结果页滚动。'
  }
];

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function readJson(path, fallback = {}) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function slug(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const branch = git(['branch', '--show-current']);
const commit = git(['rev-parse', '--short', 'HEAD']);
const delivery = readJson('artifacts/delivery-manifest.json');
const evidence = readJson('artifacts/ai-validation-evidence-summary.json', { passedRequired: [], passedCount: 0, requiredCount: 4 });
const passed = new Set(Array.isArray(evidence.passedRequired) ? evidence.passedRequired : []);
const date = today();
const rows = requiredProducts.map((item) => ({
  ...item,
  slug: slug(item.product),
  passed: passed.has(item.product),
  evidencePath: `${evidenceDir}/${date}-${slug(item.product)}.json`
}));

mkdirSync(outDir, { recursive: true });

const testerPack = `# Agent Memory Lab 真实 AI 站点外测包

这份文档给测试者使用。它只覆盖真实 AI 网页验收，不用本地 demo 冒充通过证据。

| 项目 | 当前值 |
| --- | --- |
| Branch | ${branch} |
| Commit | ${commit} |
| 插件版本 | ${delivery.extension?.name || 'Agent Memory Lab'} ${delivery.extension?.version || ''} |
| 当前真实证据 | ${evidence.passedCount || 0}/${evidence.requiredCount || requiredProducts.length} |
| 公开发布状态 | ${(delivery.releaseState && delivery.releaseState.publicRelease) || 'not-ready'} |

## 先做 3 件事

1. 启动本地工作台，并确认 Viewer 可以打开。
2. 在 Chrome / Edge 开发者模式加载 \`browser-extension/\` 或解压后的插件目录。
3. 打开插件同步侧栏，确认本地连接正常，并能看到“复制问题信息”和“复制检查步骤”。

如果真实 AI 页面没有出现记忆建议，先打开本地自检页：

\`启动输出里的 Viewer 地址 + /demo/browser-extension.html\`

自检页只用于确认插件注入是否正常，不能替代 ChatGPT、Claude、Gemini、Perplexity 的真实站点证据。

## 每个站点都这样测

1. 登录目标 AI 产品。
2. 在真实对话页输入建议 prompt。
3. 看输入框附近是否出现“记忆建议”。
4. 尝试插入或复制一条本地记忆。
5. 确认原站输入、发送、滚动、附件和模型选择没有被插件破坏。
6. 点击同步侧栏“复制问题信息”。
7. 点击同步侧栏“复制检查步骤”，在项目终端运行。
8. 按实际结果回答向导问题。只有真实成功才填通过。

向导会把人工验收结果写入 \`manualValidation\`，其中 \`memoryInsertPassed\`、\`diagnosticsCopied\`、\`siteInputStillWorks\` 三项都为 true 时，该站点才可能计入通过。

隐私边界：诊断默认只包含结构字段、selector、计数和人工验收结果，不需要提交 prompt 草稿、完整聊天正文、账号信息、Cookie、Token 或私人材料。如果页面标题或 URL 暴露敏感信息，可以先删改。

## 必测站点

${rows.map((item, index) => `### ${index + 1}. ${item.product}

| 项目 | 内容 |
| --- | --- |
| 目标域名 | ${item.domains} |
| 建议 prompt | ${item.prompt} |
| 重点观察 | ${item.focus} |
| 当前状态 | ${item.passed ? '已有通过证据' : '待验收'} |
| 建议证据文件 | \`${item.evidencePath}\` |

推荐保存命令：

\`\`\`bash
npm run wizard:ai-validation-evidence -- --clipboard --provider "${item.product}"
npm run check:ai-validation-evidence
npm run sync:ai-validation-table
\`\`\`

通过前必须确认：Provider 正确、输入框已找到、输入框附近出现记忆建议、记忆可插入或复制、原站输入和发送不受影响。`).join('\n\n')}

## 最后交回什么

- 生成的证据 JSON 文件名。
- 不含敏感内容的截图或短录屏。
- 如果失败，交回“复制问题信息”的 JSON 和失败页面说明。
- 运行 \`npm run status:delivery\` 的结果。

四个必测站点都通过后，真实站点证据会从 \`0/4\` 变成 \`4/4\`，公开发布门槛才可能解除。
`;

const json = {
  generatedAt: new Date().toISOString(),
  branch,
  commit,
  extension: delivery.extension || {},
  releaseState: delivery.releaseState || {},
  currentEvidence: {
    passedCount: evidence.passedCount || 0,
    requiredCount: evidence.requiredCount || requiredProducts.length,
    passedRequired: Array.from(passed)
  },
  targets: rows
};

writeFileSync(`${outDir}/tester-pack-cn.md`, testerPack);
writeFileSync(`${outDir}/tester-pack.json`, `${JSON.stringify(json, null, 2)}\n`);

console.log('AI validation tester pack written');
console.log(`${outDir}/tester-pack-cn.md`);
console.log(`${outDir}/tester-pack.json`);
