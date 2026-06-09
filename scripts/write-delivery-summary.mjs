import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function sha256(path) {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function extractGateTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '| 状态 | 结论 | 证据 |');
  if (start < 0) return '';
  return lines.slice(start, start + 5).join('\n');
}

function parseValidationRows(markdown) {
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.startsWith('| 产品 | 目标域名 | Provider |'));
  if (headerIndex < 0) return [];
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 10) continue;
    rows.push({
      product: cells[0],
      domain: cells[1],
      provider: cells[2],
      editor: cells[3],
      hint: cells[4],
      insert: cells[5],
      diagnostics: cells[6],
      result: cells[7],
      date: cells[8],
      evidence: cells[9]
    });
  }
  return rows;
}

function validationPassed(row) {
  const passWords = ['通过', '已通过', 'pass', 'passed', 'ok'];
  return [row.provider, row.editor, row.hint, row.insert, row.diagnostics, row.result].every((value) => {
    const lower = String(value || '').toLowerCase();
    return passWords.some((word) => lower.includes(word));
  }) && row.date !== '-' && row.evidence !== '-';
}

mkdirSync('artifacts', { recursive: true });

const pkg = readJson('package.json');
const manifest = readJson('browser-extension/manifest.json');
const releaseGates = read('docs/release-gates-cn.md');
const aiValidation = read('docs/browser-extension-ai-validation-cn.md');
const zipPath = 'artifacts/agent-memory-lab-extension.zip';
const aiTesterPackPath = 'artifacts/ai-validation-run/tester-pack-cn.md';
const generatedAt = new Date().toISOString();
const branch = git(['branch', '--show-current']) || 'unknown';
const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const dirty = git(['status', '--short']).split(/\r?\n/).filter((line) => line && !line.startsWith('?? .learnings/') && !line.includes('index.html.bak-')).length > 0;
const zipSize = fileSize(zipPath);
const zipSha256 = sha256(zipPath);
const aiEvidenceSummaryPath = 'artifacts/ai-validation-evidence-summary.json';
const aiEvidenceSummary = existsSync(aiEvidenceSummaryPath) ? readJson(aiEvidenceSummaryPath) : null;
const requiredAiProducts = ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'];
const aiRows = parseValidationRows(aiValidation);
const requiredAiRows = requiredAiProducts.map((product) => aiRows.find((row) => row.product === product)).filter(Boolean);
const passedAiRows = requiredAiRows.filter(validationPassed);
const missingAiProducts = requiredAiProducts.filter((product) => !requiredAiRows.some((row) => row.product === product));
const notPassedAiProducts = requiredAiRows.filter((row) => !validationPassed(row)).map((row) => row.product);
const deliveryManifest = {
  product: 'Agent Memory Lab',
  generatedAt,
  package: {
    name: pkg.name,
    version: pkg.version
  },
  extension: {
    name: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifest_version
  },
  git: {
    branch,
    commit,
    trackedChangesPending: dirty
  },
  artifacts: {
    extensionZip: {
      path: zipPath,
      exists: existsSync(zipPath),
      bytes: zipSize,
      sha256: zipSha256
    },
    extensionFolder: {
      path: 'browser-extension/',
      exists: existsSync('browser-extension/manifest.json')
    },
    loadInstructions: {
      path: 'browser-extension/LOAD-THIS-FIRST.md',
      exists: existsSync('browser-extension/LOAD-THIS-FIRST.md')
    },
    demoPage: {
      path: 'dist/viewer/demo/browser-extension.html',
      exists: existsSync('dist/viewer/demo/browser-extension.html')
    },
    externalTesterHandout: {
      path: 'artifacts/external-tester-handout.md',
      exists: true
    },
    aiValidationTesterPack: {
      path: aiTesterPackPath,
      command: 'npm run make:ai-validation-tester-pack',
      exists: existsSync(aiTesterPackPath)
    },
    releaseNotes: {
      path: 'artifacts/release-notes.md',
      exists: true
    },
    githubReleaseDraft: {
      path: 'artifacts/github-release-draft.md',
      exists: true
    },
    screenshots: {
      dashboard: existsSync('docs/readme-assets/screenshots/dashboard.jpg'),
      skills: existsSync('docs/readme-assets/screenshots/skills.jpg')
    }
  },
  coreExperience: {
    externalTestingEntry: {
      popupVersionVisible: true,
      popupLocalTestingStatusVisible: true,
      testerGuideUrl: 'https://github.com/novitalabs/agentmemory-lab/blob/szn-viewer-ui-iteration/docs/external-tester-guide-cn.md'
    },
    reviewDraft: {
      popup: true,
      sidePanel: true,
      editableTitle: true,
      editableContent: true,
      editableProject: true,
      editableTags: true,
      editableLessonFlag: true,
      candidateToDraft: true,
      savesToReviewQueue: true
    },
    aiInputMemoryHint: {
      localDemo: true,
      supportedSitesSource: 'browser-extension/shared/site-config.js',
      diagnosticsCopy: true,
      sidePanelTestCardsEntry: true,
      diagnosticValidationGuide: true,
      mem0Reference: {
        source: 'https://github.com/mem0ai/mem0-chrome-extension',
        documentedIn: 'docs/browser-extension-mem0-reference-cn.md',
        adapterPattern: 'supported-sites config first, split provider adapter when DOM logic grows',
        inputPlacement: 'near AI prompt editor',
        reviewFirstDifference: 'all captured candidates save to /agentmemory/review before long-term memory'
      }
    },
    reviewQueue: {
      source: 'browser-extension',
      longTermWriteRequiresViewerReview: true
    }
  },
  externalTesting: {
    zipLoadChecklist: {
      path: 'browser-extension/LOAD-THIS-FIRST.md',
      exists: existsSync('browser-extension/LOAD-THIS-FIRST.md')
    },
    testerGuide: {
      path: 'docs/external-tester-guide-cn.md',
      exists: existsSync('docs/external-tester-guide-cn.md')
    },
    feedbackTemplate: {
      path: 'docs/external-feedback-template-cn.md',
      exists: existsSync('docs/external-feedback-template-cn.md')
    },
    issueTemplate: {
      path: '.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml',
      exists: existsSync('.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml')
    },
    feedbackTriage: {
      path: 'docs/external-feedback-triage-cn.md',
      exists: existsSync('docs/external-feedback-triage-cn.md')
    },
    evidenceRecorder: {
      command: 'npm run wizard:ai-validation-evidence',
      exists: existsSync('scripts/record-ai-validation-evidence.mjs')
    },
    aiValidationTesterPack: {
      path: aiTesterPackPath,
      command: 'npm run make:ai-validation-tester-pack',
      exists: existsSync('scripts/make-ai-validation-tester-pack.mjs')
    },
    aiSiteTestCards: {
      path: 'docs/browser-extension-ai-site-test-cards-cn.md',
      viewerPath: '/docs/browser-extension-ai-site-test-cards-cn.md',
      zipPath: 'browser-extension/AI-SITE-TEST-CARDS.md',
      sidePanelEntry: true,
      diagnosticField: 'validationGuide',
      exists: existsSync('docs/browser-extension-ai-site-test-cards-cn.md') && existsSync('browser-extension/AI-SITE-TEST-CARDS.md')
    }
  },
  releaseState: {
    localDemo: 'ready',
    externalTesting: 'mostly-ready',
    publicRelease: 'not-ready',
    realSiteValidation: {
      requiredProducts: requiredAiProducts,
      passed: passedAiRows.map((row) => row.product),
      notPassed: notPassedAiProducts,
      missingRows: missingAiProducts,
      passedCount: passedAiRows.length,
      requiredCount: requiredAiProducts.length,
      source: 'docs/browser-extension-ai-validation-cn.md',
      evidenceDirectory: 'docs/validation/browser-extension-ai-sites',
      evidenceSummary: aiEvidenceSummaryPath,
      evidencePassedCount: aiEvidenceSummary ? aiEvidenceSummary.passedCount : 0,
      evidenceRequiredCount: aiEvidenceSummary ? aiEvidenceSummary.requiredCount : requiredAiProducts.length,
      evidenceNotPassed: aiEvidenceSummary ? aiEvidenceSummary.notPassedRequired : requiredAiProducts
    },
    publicReleaseBlockers: [
      'real AI site validation evidence',
      'public privacy policy URL',
      'non-sensitive store screenshots',
      'store review materials'
    ]
  },
  commands: [
    'npm run package:browser-extension',
    'npm run check:delivery',
    'npm run make:ai-validation-tester-pack',
    'npm run check:workbench'
  ]
};

const summary = `# Agent Memory Lab Delivery Summary

Generated: ${generatedAt}

## Version

| Item | Value |
| --- | --- |
| Package | ${pkg.name}@${pkg.version} |
| Extension | ${manifest.name} ${manifest.version} |
| Branch | ${branch} |
| Commit | ${commit}${dirty ? ' (tracked changes pending)' : ''} |

## Artifacts

| Artifact | Status |
| --- | --- |
| Extension zip | ${existsSync(zipPath) ? `${zipPath} (${zipSize} bytes)` : 'missing'} |
| Extension zip sha256 | ${zipSha256 || 'missing'} |
| Delivery manifest | artifacts/delivery-manifest.json |
| Extension source folder | ${existsSync('browser-extension/manifest.json') ? 'browser-extension/' : 'missing'} |
| Zip load instructions | ${existsSync('browser-extension/LOAD-THIS-FIRST.md') ? 'browser-extension/LOAD-THIS-FIRST.md' : 'missing'} |
| AI validation tester pack | ${existsSync(aiTesterPackPath) ? aiTesterPackPath : 'run npm run make:ai-validation-tester-pack'} |
| Demo page | ${existsSync('dist/viewer/demo/browser-extension.html') ? 'dist/viewer/demo/browser-extension.html' : 'missing'} |
| Dashboard screenshot | ${existsSync('docs/readme-assets/screenshots/dashboard.jpg') ? 'docs/readme-assets/screenshots/dashboard.jpg' : 'missing'} |
| Skills screenshot | ${existsSync('docs/readme-assets/screenshots/skills.jpg') ? 'docs/readme-assets/screenshots/skills.jpg' : 'missing'} |

## Core Experience

| Capability | Status |
| --- | --- |
| Popup version and tester guide entry | ready |
| Popup editable review draft | ready |
| Side panel editable review draft | ready |
| Draft project / tags / lesson flag | ready |
| Candidate-to-draft flow | ready |
| Save to Viewer review queue | ready |
| Local AI input memory hint demo | ready |
| Real AI site validation | ${passedAiRows.length}/${requiredAiProducts.length} passed |

## External Testing Loop

| Item | Status |
| --- | --- |
| Zip load checklist | ${existsSync('browser-extension/LOAD-THIS-FIRST.md') ? 'ready' : 'missing'} |
| External tester guide | ${existsSync('docs/external-tester-guide-cn.md') ? 'ready' : 'missing'} |
| Feedback template | ${existsSync('docs/external-feedback-template-cn.md') ? 'ready' : 'missing'} |
| GitHub issue template | ${existsSync('.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml') ? 'ready' : 'missing'} |
| Feedback triage guide | ${existsSync('docs/external-feedback-triage-cn.md') ? 'ready' : 'missing'} |
| AI evidence recorder | ${existsSync('scripts/record-ai-validation-evidence.mjs') ? 'ready' : 'missing'} |
| AI validation tester pack | ${existsSync('scripts/make-ai-validation-tester-pack.mjs') ? 'ready' : 'missing'} |

## Release Gates

${extractGateTable(releaseGates)}

## Real AI Site Validation

| Item | Value |
| --- | --- |
| Required products | ${requiredAiProducts.join(', ')} |
| Passed | ${passedAiRows.length}/${requiredAiProducts.length} |
| Not passed | ${notPassedAiProducts.length ? notPassedAiProducts.join(', ') : 'none'} |
| Missing rows | ${missingAiProducts.length ? missingAiProducts.join(', ') : 'none'} |
| Source | docs/browser-extension-ai-validation-cn.md |
| Evidence directory | docs/validation/browser-extension-ai-sites |
| Evidence summary | ${existsSync(aiEvidenceSummaryPath) ? aiEvidenceSummaryPath : 'generated by npm run check:ai-validation-evidence'} |
| Evidence passed | ${aiEvidenceSummary ? `${aiEvidenceSummary.passedCount}/${aiEvidenceSummary.requiredCount}` : '0/4'} |

## Verification Commands

- \`npm run package:browser-extension\`
- \`npm run check:delivery\`
- \`npm run status:delivery\`
- \`npm run make:ai-validation-tester-pack\`
- \`npm run check:ai-validation-evidence\`
- \`npm run check:workbench\` when the full local workbench should be running

## Useful Links

- README: \`README.md\`
- External tester guide: \`docs/external-tester-guide-cn.md\`
- External feedback template: \`docs/external-feedback-template-cn.md\`
- External tester issue template: \`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml\`
- External feedback triage: \`docs/external-feedback-triage-cn.md\`
- AI validation log: \`docs/browser-extension-ai-validation-cn.md\`
- AI validation tester pack: \`artifacts/ai-validation-run/tester-pack-cn.md\`
- Release gates: \`docs/release-gates-cn.md\`
- Feishu source: \`docs/feishu/agentmemory-project-intro-cn.md\`
`;

const externalHandout = `# Agent Memory Lab 外部试用说明

生成时间：${generatedAt}

这是一份给外部试用者的快速说明。当前版本适合本地试用和反馈，不是 Chrome Web Store 公开发布版。

## 你会拿到什么

- 插件压缩包：\`artifacts/agent-memory-lab-extension.zip\`
- 插件版本：${manifest.name} ${manifest.version}
- 当前提交：${commit}${dirty ? '（本地还有未提交改动）' : ''}
- zip sha256：\`${zipSha256 || 'missing'}\`

## 先做这 5 步

1. 解压 \`artifacts/agent-memory-lab-extension.zip\`。
2. 打开解压后的 \`browser-extension/LOAD-THIS-FIRST.md\`。
3. 在 Chrome / Edge 开发者模式加载解压后的 \`browser-extension/\` 文件夹。
4. 打开 \`启动输出里的 Viewer 地址 + /demo/browser-extension.html\`，确认输入框旁出现“记忆建议”。
5. 在弹窗或同步侧栏里编辑草稿的标题、正文、保存范围、分类备注和经验候选状态，再加入 Viewer 待审阅。

## 通过时应该看到

- 插件弹窗能显示版本和本地连接状态。
- 同步侧栏能显示当前页面、候选记忆、候选经验和隐私提示。
- 记忆建议能出现在 demo 输入框旁，并能插入或复制。
- 保存内容不会直接写入长期记忆，而是先进入 Viewer 待审阅队列。
- Viewer 待审阅卡片能看到保存范围、分类备注、来源和经验候选状态。

## 真实 AI 页面验收

当前真实站点证据：${aiEvidenceSummary ? `${aiEvidenceSummary.passedCount}/${aiEvidenceSummary.requiredCount}` : '0/4'}。

公开发布前仍需 ChatGPT、Claude、Gemini、Perplexity 都通过真实页面验收。试用这些站点时，请打开同步侧栏，点击“复制问题信息”，然后用下面命令记录证据：

\`\`\`bash
npm run wizard:ai-validation-evidence -- --clipboard
\`\`\`

只有你真实确认“插入成功、诊断已复制、原站输入仍正常”以后，才加 \`--pass\`。

## 反馈问题

推荐使用 GitHub Issue 模板：\`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml\`。

也可以复制：\`docs/external-feedback-template-cn.md\`。

反馈时请尽量提供：浏览器版本、试用页面、问题步骤、同步侧栏诊断 JSON、截图或录屏。请不要提交私人聊天全文、Cookie、访问令牌、API Key、学校申请材料或任何敏感信息。

## 当前边界

- 本地 demo：ready
- 外部试用闭环：ready
- 公开发布：not-ready
- 未通过的真实 AI 站点：${(aiEvidenceSummary ? aiEvidenceSummary.notPassedRequired : requiredAiProducts).join(', ')}
`;

const releaseNotes = `# Agent Memory Lab ${manifest.version} Release Notes

生成时间：${generatedAt}

## 版本信息

- Package：${pkg.name}@${pkg.version}
- Browser extension：${manifest.name} ${manifest.version}
- Branch：${branch}
- Commit：${commit}${dirty ? '（本地还有未提交改动）' : ''}
- Extension zip：
  - 路径：
    
    \`artifacts/agent-memory-lab-extension.zip\`
  - 大小：${zipSize} bytes
  - SHA256：\`${zipSha256 || 'missing'}\`

## 本版可以交付给谁

这个版本适合给外部测试者做本地试用，目标是验证浏览器插件、Viewer 待审阅队列、真实 AI 页面诊断和反馈闭环。

这个版本不适合作为 Chrome Web Store 公开发布版，因为真实 AI 页面证据仍是 ${aiEvidenceSummary ? `${aiEvidenceSummary.passedCount}/${aiEvidenceSummary.requiredCount}` : '0/4'}。

## 本版新增和已就绪能力

- Viewer 总览可以显示外部试用状态、插件包状态、真实 AI 证据进度和测试卡入口。
- 插件弹窗和同步侧栏都支持保存前编辑审阅草稿。
- 草稿可编辑标题、正文、保存范围、分类备注，并可标记为可沉淀经验。
- 浏览器插件保存内容默认进入 Viewer 待审阅队列，不直接写入长期记忆。
- 同步侧栏可以复制真实 AI 页面诊断 JSON。
- 同步侧栏提供本地测试卡入口：\`/docs/browser-extension-ai-site-test-cards-cn.md\`。
- 诊断 JSON 带有 \`validationGuide\`，标明必测站点：ChatGPT、Claude、Gemini、Perplexity。
- 插件 zip 内包含 \`browser-extension/LOAD-THIS-FIRST.md\` 和 \`browser-extension/AI-SITE-TEST-CARDS.md\`。
- 交付检查会真实启动 Viewer，验证交付状态接口、测试卡文档和插件 demo 路由。

## 试用路径

1. 运行 \`npm run package:browser-extension\` 生成插件 zip。
2. 解压 \`artifacts/agent-memory-lab-extension.zip\`。
3. 在 Chrome / Edge 开发者模式加载解压后的 \`browser-extension/\` 文件夹。
4. 打开 \`启动输出里的 Viewer 地址 + /demo/browser-extension.html\`，先验证本地 demo。
5. 打开 ChatGPT、Claude、Gemini、Perplexity，按测试卡逐站验收。
6. 复制同步侧栏诊断，用 \`npm run wizard:ai-validation-evidence\` 保存证据。

## 已知边界

- 真实 AI 页面证据：${aiEvidenceSummary ? `${aiEvidenceSummary.passedCount}/${aiEvidenceSummary.requiredCount}` : '0/4'}。
- 未通过 / 待验证站点：${(aiEvidenceSummary ? aiEvidenceSummary.notPassedRequired : requiredAiProducts).join(', ')}。
- 公开发布仍缺：真实 AI 站点通过证据、公开隐私政策 URL、无隐私商店截图、商店审核材料。
- 本地 fixture 和 demo 只能防回归，不能替代真实站点验收。

## 验证命令

- \`npm run check:browser-extension\`
- \`npm run package:browser-extension\`
- \`npm run check:delivery\`
- \`npm run status:delivery\`
- \`npm run check:release-gates\`
- \`npm run check:release-public\`：当前预期失败，直到真实 AI 站点证据齐全。

## 反馈入口

- 外部试用指南：\`docs/external-tester-guide-cn.md\`
- 反馈模板：\`docs/external-feedback-template-cn.md\`
- GitHub Issue 模板：\`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml\`
- 反馈分诊指南：\`docs/external-feedback-triage-cn.md\`
`;

const githubReleaseDraft = `# Agent Memory Lab ${manifest.version} 外部试用包

> 这是 GitHub Release 草稿，面向小范围外部试用；不是 Chrome Web Store 公开发布说明。

## 本次包

- Extension zip：\`${zipPath}\`
- SHA256：\`${zipSha256 || 'missing'}\`
- Branch：\`${branch}\`
- Commit：\`${commit}\`${dirty ? '（存在未提交的跟踪文件变更，发布前需复查）' : ''}
- 详细 Release Notes：\`artifacts/release-notes.md\`
- 外部试用手册：\`artifacts/external-tester-handout.md\`

## 这版解决什么

- 提供一个本地优先的 Agent 记忆插件预览包，让用户在 AI 网页对话中收集候选记忆。
- 参考 Mem0 / OpenMemory 的浏览器插件结构，把记忆入口放到 AI 输入框附近，而不是只藏在弹窗里。
- 保留 Agent Memory Lab 的差异点：候选内容先进入 Viewer 待审阅队列，用户确认后再成为长期记忆。
- 支持本地 demo、插件 popup、side panel、诊断 JSON、真实 AI 站点测试卡和反馈模板。

## 已就绪

- 本地演示页：\`/demo/browser-extension.html\`
- 插件加载说明：\`browser-extension/LOAD-THIS-FIRST.md\`
- 多站点配置：\`browser-extension/shared/site-config.js\`
- Mem0 参考说明：\`docs/browser-extension-mem0-reference-cn.md\`
- 真实 AI 站点测试卡：\`docs/browser-extension-ai-site-test-cards-cn.md\`
- 外部反馈模板：\`.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml\`

## 已知边界

- 公开发布仍是 \`not-ready\`。
- ChatGPT、Claude、Gemini、Perplexity 的真实页面证据还没有全部通过。
- AI 网页 DOM 变化频繁，外部试用反馈必须附带 side panel 诊断 JSON。
- 这版用于小范围加载未打包插件测试，不用于商店上架。

## 发布前检查

\`\`\`bash
npm run check:delivery
npm run package:browser-extension
npm run status:delivery
npm run check:release-gates
\`\`\`

公开发布前还必须通过：

\`\`\`bash
npm run check:release-public
\`\`\`

当前它预期失败，因为真实 AI 站点证据尚未齐全。

## 给测试者的第一句话

请先按 \`browser-extension/LOAD-THIS-FIRST.md\` 加载插件，再打开 Viewer 的本地 demo 完成一次“生成候选记忆 -> 修改草稿 -> 保存到待审阅队列”的闭环。真实 AI 页面测试请按 \`docs/browser-extension-ai-site-test-cards-cn.md\` 逐站记录。
`;

writeFileSync('artifacts/delivery-summary.md', summary);
writeFileSync('artifacts/external-tester-handout.md', externalHandout);
writeFileSync('artifacts/release-notes.md', releaseNotes);
writeFileSync('artifacts/github-release-draft.md', githubReleaseDraft);
writeFileSync('artifacts/delivery-manifest.json', `${JSON.stringify(deliveryManifest, null, 2)}\n`);
console.log('delivery summary: artifacts/delivery-summary.md');
console.log('external tester handout: artifacts/external-tester-handout.md');
console.log('release notes: artifacts/release-notes.md');
console.log('github release draft: artifacts/github-release-draft.md');
console.log('delivery manifest: artifacts/delivery-manifest.json');
