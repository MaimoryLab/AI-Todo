import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  assert(result.status === 0, `${command} ${args.join(' ')} failed`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, attempts = 20) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.text();
      lastError = new Error(`${url} returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await wait(150);
  }
  throw lastError || new Error(`Failed to fetch ${url}`);
}

const requiredFiles = [
  'README.md',
  'browser-extension/README.md',
  'docs/demo-checklist-cn.md',
  'docs/product-delivery-plan-cn.md',
  'docs/project-delivery-guide-cn.md',
  'docs/external-tester-guide-cn.md',
  'docs/external-feedback-template-cn.md',
  'docs/external-feedback-triage-cn.md',
  '.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml',
  'docs/release-gates-cn.md',
  'docs/browser-extension-ai-validation-cn.md',
  'docs/browser-extension-ai-site-test-cards-cn.md',
  'docs/browser-extension-mem0-reference-cn.md',
  'docs/browser-extension-privacy-en.md',
  'docs/browser-extension-store-listing-en.md',
  'docs/feishu/agentmemory-project-intro-cn.md',
  'docs/feishu/whiteboards/workflow.mmd',
  'docs/feishu/whiteboards/workbench-workflow.mmd',
  'docs/feishu/whiteboards/structure.mmd',
  'docs/browser-extension-privacy-cn.md',
  'docs/readme-assets/screenshots/dashboard.jpg',
  'docs/readme-assets/screenshots/skills.jpg',
  'src/viewer/demo/browser-extension.html',
  'dist/viewer/demo/browser-extension.html',
  'browser-extension/manifest.json',
  'browser-extension/LOAD-THIS-FIRST.md',
  'browser-extension/AI-SITE-TEST-CARDS.md',
  'browser-extension/icons/icon16.png',
  'browser-extension/icons/icon32.png',
  'browser-extension/icons/icon48.png',
  'browser-extension/icons/icon128.png',
  'scripts/check-browser-extension.mjs',
  'scripts/check-browser-extension-site-config-sync.mjs',
  'scripts/check-browser-extension-review-draft.mjs',
  'scripts/check-browser-extension-memory-drafts.mjs',
  'scripts/check-browser-extension-diagnostics-privacy.mjs',
  'scripts/check-browser-extension-fixtures.mjs',
  'scripts/check-browser-extension-demo-interaction.mjs',
  'scripts/check-browser-extension-package.mjs',
  'scripts/check-remote-delivery.mjs',
  'scripts/check-release-gates.mjs',
  'scripts/record-ai-validation-evidence.mjs',
  'scripts/wizard-ai-validation-evidence.mjs',
  'scripts/prepare-ai-validation-run.mjs',
  'scripts/make-ai-validation-tester-pack.mjs',
  'scripts/check-ai-validation-evidence.mjs',
  'scripts/check-ai-validation-evidence-guards.mjs',
  'scripts/sync-ai-validation-table.mjs',
  'scripts/delivery-status.mjs',
  'scripts/check-viewer-delivery-runtime.mjs',
  'scripts/check-workbench-status.mjs',
  'scripts/package-browser-extension.mjs',
  'scripts/write-delivery-summary.mjs',
  'scripts/fixtures/ai-validation-diagnostic.json'
];

for (const file of requiredFiles) {
  assert(existsSync(file), `Missing required delivery file: ${file}`);
}

const readme = read('README.md');
const packageJson = JSON.parse(read('package.json'));
assert(String(packageJson.scripts?.['package:browser-extension'] || '').includes('make:ai-validation-tester-pack'), 'package:browser-extension must refresh the AI validation tester pack.');
assert(readme.includes('npm run preview:browser-extension'), 'README must mention browser extension self-check command.');
assert(readme.includes('npm run build && npm run start:local-memory'), 'README must mention local memory workbench start command.');
assert(readme.includes('npm run check:workbench'), 'README must mention workbench status check command.');
assert(readme.includes('cd agentmemory-lab'), 'README must show project directory before npm commands.');
assert(readme.includes('你的本地记忆数据目录'), 'README must explain which local memory store is used.');
for (const marker of ['本地可用路径', '真实网页和 AI 页面', '回到 Viewer 的记忆库确认保存', '自检页']) {
  assert(readme.includes(marker), `README missing usable workflow marker: ${marker}`);
}
assert(readme.includes('npm run check:release-gates'), 'README must mention release gates check command.');
assert(readme.includes('npm run check:release-public'), 'README must mention public release check command.');
assert(readme.includes('npm run status:delivery'), 'README must mention delivery status command.');
assert(readme.includes('.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml'), 'README must link external tester issue template.');
for (const marker of ['演示检查清单', '试用指南', '验收一页纸', '反馈模板', '发布门槛']) {
  assert(readme.includes(marker), `README missing product doc marker: ${marker}`);
}
const imageRefs = [...readme.matchAll(/<img\s+src="([^"]+)"/g)].map((match) => match[1]);
const allowedImages = new Set([
  'assets/banner.png',
  'docs/readme-assets/screenshots/dashboard.jpg',
  'docs/readme-assets/screenshots/skills.jpg'
]);
for (const ref of imageRefs) {
  assert(allowedImages.has(ref), `Unexpected README image reference: ${ref}`);
  assert(existsSync(ref), `README image does not exist: ${ref}`);
}
assert(imageRefs.includes('docs/readme-assets/screenshots/dashboard.jpg'), 'README must include dashboard screenshot.');
assert(imageRefs.includes('docs/readme-assets/screenshots/skills.jpg'), 'README must include skills screenshot.');

const browserReadme = read('browser-extension/README.md');
const deliveryGuide = read('docs/project-delivery-guide-cn.md');
for (const marker of ['项目交付说明', 'szn-viewer-ui-iteration', 'npm run check:remote-delivery', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity', '当前不能承诺']) {
  assert(deliveryGuide.includes(marker), `Project delivery guide missing marker: ${marker}`);
}
assert(existsSync('iii-config.local-memory.yaml'), 'Local memory config must exist.');
const localMemoryConfig = read('iii-config.local-memory.yaml');
assert(localMemoryConfig.includes('state_store.db') && localMemoryConfig.includes('stream_store'), 'Local memory config must define state and stream stores.');
assert(read('package.json').includes('start:local-memory'), 'package.json must expose start:local-memory.');
assert(browserReadme.includes('npm run package:browser-extension'), 'Browser extension README must mention packaging command.');
assert(browserReadme.includes('npm run status:delivery'), 'Browser extension README must mention delivery status command.');
assert(browserReadme.includes('npm run preview:browser-extension'), 'Browser extension README must mention self-check command.');
assert(browserReadme.includes('cd agentmemory-lab'), 'Browser extension README must show project directory before npm commands.');
assert(browserReadme.includes('docs/browser-extension-privacy-cn.md'), 'Browser extension README must link privacy doc.');
assert(browserReadme.includes('docs/browser-extension-mem0-reference-cn.md'), 'Browser extension README must link Mem0 reference doc.');
assert(browserReadme.includes('docs/browser-extension-ai-site-test-cards-cn.md'), 'Browser extension README must link AI site test cards doc.');
assert(browserReadme.includes('保存前编辑'), 'Browser extension README must mention edit-before-save flow.');
assert(browserReadme.includes('插件是浏览器入口层，本地工作台是记忆中枢'), 'Browser extension README must explain extension/workbench relationship.');
assert(browserReadme.includes('复制检查步骤'), 'Browser extension README must mention the copy evidence wizard flow.');
for (const marker of ['项目', '标签', '经验候选']) {
  assert(browserReadme.includes(marker), `Browser extension README must mention draft ${marker}.`);
}
assert(browserReadme.includes('同步侧栏'), 'Browser extension README must mention the side panel flow.');
for (const marker of ['本地使用', '真实网页和 AI 页面', '本地自检页', '/demo/browser-extension.html']) {
  assert(browserReadme.includes(marker), `Browser extension README missing usable flow marker: ${marker}`);
}

const loadGuide = read('browser-extension/LOAD-THIS-FIRST.md');
for (const marker of ['五步验收', '保存范围、分类备注', '经验候选', 'AI-SITE-TEST-CARDS.md', 'cd agentmemory-lab', 'npm run wizard:ai-validation-evidence', 'external-test-loop-cn.md', 'external-tester-feedback-cn.yml']) {
  assert(loadGuide.includes(marker), `Zip loading guide missing marker: ${marker}`);
}

const siteCards = read('docs/browser-extension-ai-site-test-cards-cn.md');
for (const marker of ['真实 AI 站点测试卡', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity', '复制检查步骤', 'manualValidation.memoryInsertPassed', 'manualValidation.diagnosticsCopied', 'manualValidation.siteInputStillWorks', 'npm run wizard:ai-validation-evidence', 'npm run prepare:ai-validation', 'turnCount > 0', 'matchedSelectors.turn', '用户选中的文字', '输入框草稿']) {
  assert(siteCards.includes(marker), `AI site test cards missing marker: ${marker}`);
}
const zipSiteCards = read('browser-extension/AI-SITE-TEST-CARDS.md');
for (const marker of ['ChatGPT', 'Claude', 'Gemini', 'Perplexity', '公开发布', 'npm run wizard:ai-validation-evidence', 'turnCount > 0', 'matchedSelectors.turn', '用户选中的文字', '输入框草稿']) {
  assert(zipSiteCards.includes(marker), `Zip AI site test cards missing marker: ${marker}`);
}

const checklist = read('docs/demo-checklist-cn.md');
for (const marker of ['审阅队列可用', 'AI 页面状态', '记忆建议', 'Skill 管理台', 'cd agentmemory-lab']) {
  assert(checklist.includes(marker), `Demo checklist missing marker: ${marker}`);
}

const testerGuide = read('docs/external-tester-guide-cn.md');
for (const marker of ['外部试用指南', '外部测试闭环', 'cd agentmemory-lab', 'npm run build && npm run start', 'npm run check:workbench', 'npm run check:release-gates', '记忆建议', '诊断 JSON', '复制检查步骤', '从仓库试用', '从 zip 试用', 'browser-extension/', '插件自检页', '/demo/browser-extension.html', 'Viewer 首页', '下载插件包', '验收一页纸', 'quickstart-cn.md', '反馈模板', '分诊指南', '外部试用反馈模板', 'external-tester-feedback-cn.yml', '外部反馈分诊指南', 'browser-extension-ai-site-test-cards-cn.md', 'npm run make:ai-validation-tester-pack', 'tester-pack-cn.md', 'turnCount', 'matchedSelectors.turn', '用户选中的文字', '输入框草稿']) {
  assert(testerGuide.includes(marker), `External tester guide missing marker: ${marker}`);
}

const testLoop = read('docs/external-test-loop-cn.md');
for (const marker of ['外部测试闭环', '四步闭环', '加载插件', '真实页面使用', '逐站验收', '提交反馈', '最少要回收的信息', '交付判断', 'npm run check:ai-validation-evidence', 'turnCount > 0', '会话区域 selector', '输入框草稿']) {
  assert(testLoop.includes(marker), `External test loop missing marker: ${marker}`);
}

const issueTemplate = read('.github/ISSUE_TEMPLATE/external-tester-feedback-cn.yml');
for (const marker of ['外部试用反馈', '试用路径', 'diagnostics', 'manualValidation', 'memoryInsertPassed', 'siteInputStillWorks', '我已确认反馈内容不包含敏感信息', 'turnCount', 'matchedSelectors', '真实对话', '输入框草稿']) {
  assert(issueTemplate.includes(marker), `External tester issue template missing marker: ${marker}`);
}

const feedbackTemplate = read('docs/external-feedback-template-cn.md');
for (const marker of ['外部试用反馈模板', '外部反馈分诊指南', '基本信息', '试用路径', '问题描述', '诊断信息', 'manualValidation', '影响程度', 'turnCount', 'matchedSelectors.turn', '具体对话', '输入框草稿']) {
  assert(feedbackTemplate.includes(marker), `External feedback template missing marker: ${marker}`);
}

const feedbackTriage = read('docs/external-feedback-triage-cn.md');
for (const marker of ['外部反馈分诊指南', 'docs/external-feedback-template-cn.md', 'manualValidation', '站点适配', '输入事件', '审阅队列', '隐私/信任', 'npm run check:browser-extension', 'turnCount', 'matchedSelectors.turn', '会话抽取']) {
  assert(feedbackTriage.includes(marker), `External feedback triage guide missing marker: ${marker}`);
}

const plan = read('docs/product-delivery-plan-cn.md');
for (const marker of ['本地预览包', '权限与隐私说明', '插件对标说明', '外部测试闭环', '外部反馈分诊指南', 'GitHub 外部试用 Issue 模板', 'Skill 草稿', 'AI 页面诊断', '真实站点测试卡', 'AI-SITE-TEST-CARDS.md']) {
  assert(plan.includes(marker), `Product delivery plan missing marker: ${marker}`);
}

const mem0Reference = read('docs/browser-extension-mem0-reference-cn.md');
for (const marker of ['mem0ai/mem0-chrome-extension', 'supported sites', '输入框附近', '待审阅队列', '真实 AI 站点验收', '插件迭代工作流', '站点适配层', '输入框入口', '后台协调', '管理界面', '何时拆 adapter', '/agentmemory/review', 'check-browser-extension-site-config-sync']) {
  assert(mem0Reference.includes(marker), `Mem0 reference doc missing marker: ${marker}`);
}

const releaseGates = read('docs/release-gates-cn.md');
for (const marker of ['本地可演示', '外部可试用', '公开可发布', '未达到', '真实 AI 站点逐站验收', 'GitHub 外部试用 Issue 模板', '外部反馈分诊指南', '入口位置策略', '保存范围', '分类备注', '经验候选', 'npm run check:release-public', 'npm run make:ai-validation-tester-pack', 'turnCount > 0', '会话区域 selector', '输入框草稿']) {
  assert(releaseGates.includes(marker), `Release gates doc missing marker: ${marker}`);
}

const aiValidation = read('docs/browser-extension-ai-validation-cn.md');
for (const marker of ['ChatGPT', 'Claude', 'Gemini', 'Perplexity', '复制问题信息', '通过标准', 'npm run wizard:ai-validation-evidence', 'anchorFound', 'placement', 'memoryWidgetVisible', 'matchedSelectors', 'turnCount', '具体对话', '输入框草稿', 'browser-extension-ai-site-test-cards-cn.md']) {
  assert(aiValidation.includes(marker), `AI validation doc missing marker: ${marker}`);
}

const evidenceReadme = read('docs/validation/browser-extension-ai-sites/README.md');
for (const marker of ['npm run wizard:ai-validation-evidence', '--clipboard', '--file diagnostics.json', '--pass', '证据质量门槛', 'matchedSelectors.editor', 'matchedSelectors.anchor', 'matchedSelectors.send', 'matchedSelectors.turn', 'turnCount > 0', '用户选中的文字', '输入框草稿', '诊断默认不包含 prompt 草稿']) {
  assert(evidenceReadme.includes(marker), `AI validation evidence README missing marker: ${marker}`);
}

const evidenceWizard = read('scripts/wizard-ai-validation-evidence.mjs');

const viewerHtml = read('src/viewer/index.html');
for (const marker of ['1. 先看预览', '/demo/browser-extension.html', '2. 装到浏览器', '3. 验收 AI 页面', '4. 回来审阅']) {
  assert(viewerHtml.includes(marker), `Viewer dashboard trial route missing marker: ${marker}`);
}
for (const marker of ['createInterface', '--yes', 'Did inserting/copying a local memory work?', 'siteInputStillWorks', 'npm run check:ai-validation-evidence']) {
  assert(evidenceWizard.includes(marker), `AI validation evidence wizard missing marker: ${marker}`);
}

const validationPrep = read('scripts/prepare-ai-validation-run.mjs');
for (const marker of ['ChatGPT', 'Claude', 'Gemini', 'Perplexity', 'artifacts/ai-validation-run', 'wizard:ai-validation-evidence']) {
  assert(validationPrep.includes(marker), `AI validation preparation script missing marker: ${marker}`);
}

const demoPage = read('src/viewer/demo/browser-extension.html');
for (const marker of ['agentmemory-demo-input', 'Agent Memory Demo', '记忆建议']) {
  assert(demoPage.includes(marker), `Browser extension demo page missing marker: ${marker}`);
}

const viewer = read('src/viewer/index.html');
for (const marker of ['function reviewProject', 'function reviewTags', 'function reviewSourceLabel', 'payload.asLesson', '经验候选']) {
  assert(viewer.includes(marker), `Viewer review queue missing browser draft metadata marker: ${marker}`);
}
for (const marker of ['browserReviewSessions', 'browserSessionObservations', 'embeddedObservations', '浏览器对话']) {
  assert(viewer.includes(marker), `Viewer sessions must include browser conversations: ${marker}`);
}
for (const marker of ['function sessionSourceSummary', '记录来源', '查看技术细节', '工具使用', '记录类型', '浏览器对话', '本地 Agent 会话']) {
  assert(viewer.includes(marker), `Viewer sessions page missing readable session marker: ${marker}`);
}
assert(!viewer.includes('<div class="card" style="margin-bottom:12px;"><div class="card-title">来源信息</div>'), 'Viewer sessions page must not expose source internals by default.');
const apiSource = read('src/triggers/api.ts');
for (const marker of ['recordBrowserSessionFromReview', 'browserSessionId', 'browser_conversation', 'browser_memory_candidate']) {
  assert(apiSource.includes(marker), `Browser reviews must be recorded as real sessions first: ${marker}`);
}
for (const marker of ['delivery-status', 'renderDeliveryStatusCard', '浏览器记忆入口', '打开预览', '安装说明', '测试卡', '查看待审阅', '不要把链接当记忆', '真实 AI 证据', '等待证据', '待验收', '待修复', '/docs/browser-extension-ai-site-test-cards-cn.md']) {
  assert(viewer.includes(marker), `Viewer dashboard missing delivery status marker: ${marker}`);
}
for (const marker of ['function actionAttentionText', 'function actionDescriptionText', 'function actionSourceText', '继续推进', '制作 30 秒 README 演示', '留学申请 Skill', '待跟进', '正在推进', '需要处理', '已完成', '来自 ']) {
  assert(viewer.includes(marker), `Viewer actions page missing non-technical action marker: ${marker}`);
}
assert(!viewer.includes('function priorityLabel'), 'Viewer actions page must not render priority as a user-facing field.');
for (const marker of ['先看本机能力', '再整理经验', '最后生成草稿', '人工确认后复制到本地 Skill 目录']) {
  assert(viewer.includes(marker), `Viewer skill page missing workflow marker: ${marker}`);
}

const viewerServer = read('src/viewer/server.ts');
for (const marker of ['deliveryArtifactRoot', 'process.cwd()', 'readProjectDoc', '/docs/browser-extension-ai-site-test-cards-cn.md', 'text/markdown', 'readDeliveryStatus', 'readDeliveryArtifact', '/artifacts/', 'agent-memory-lab-extension.zip', 'external-tester-handout.md', 'external-feedback-template-cn.md', 'external-feedback-triage-cn.md', 'tester-pack-cn.md', '/agentmemory/delivery-status', 'delivery-manifest.json', 'ai-validation-evidence-summary.json', 'requiredProducts', 'sites', '未录入真实页面证据']) {
  assert(viewerServer.includes(marker), `Viewer server missing delivery status marker: ${marker}`);
}

const deliveryStatusScript = read('scripts/delivery-status.mjs');
for (const marker of ['current commit', 'artifact commit', 'stale; rerun npm run package:browser-extension', 'AI tester pack']) {
  assert(deliveryStatusScript.includes(marker), `Delivery status script missing freshness marker: ${marker}`);
}

const workbenchStatusScript = read('scripts/check-workbench-status.mjs');
for (const marker of ['view-dashboard', 'agentmemory-demo-input', 'start:local-memory']) {
  assert(workbenchStatusScript.includes(marker), `Workbench status script missing runtime marker: ${marker}`);
}

const cliSource = read('src/cli.ts');
for (const marker of ['workerRecoveryNote', 'stop --force', 'npm run start:local-memory', 'portInUseDiagnostic(port)']) {
  assert(cliSource.includes(marker), `CLI missing worker recovery marker: ${marker}`);
}

const privacyEn = read('docs/browser-extension-privacy-en.md');
for (const marker of ['Privacy Policy', 'local-first', 'Data We Process', 'Where Data Goes', 'AI Diagnostics', 'does not include prompt draft text', 'matchedSelectors.editor/anchor/send/turn']) {
  assert(privacyEn.includes(marker), `English privacy policy missing marker: ${marker}`);
}

const privacyCn = read('docs/browser-extension-privacy-cn.md');
for (const marker of ['外部测试诊断脱敏', 'ai.matchedSelectors.editor', 'ai.matchedSelectors.anchor', 'ai.matchedSelectors.send', 'ai.matchedSelectors.turn', '不会复制输入框草稿']) {
  assert(privacyCn.includes(marker), `Chinese privacy policy missing marker: ${marker}`);
}

const storeListing = read('docs/browser-extension-store-listing-en.md');
for (const marker of ['Store Listing Draft', 'Short Description', 'Permission Justification', 'Pre-release Checklist']) {
  assert(storeListing.includes(marker), `Store listing draft missing marker: ${marker}`);
}

const previewPort = 32113;
const preview = spawn(process.execPath, ['scripts/preview-browser-extension.mjs'], {
  stdio: 'ignore',
  env: { ...process.env, AGENTMEMORY_EXTENSION_PREVIEW_PORT: String(previewPort) }
});
try {
  const html = await fetchText(`http://127.0.0.1:${previewPort}/demo/browser-extension.html`);
  for (const marker of ['agentmemory-demo-input', 'Agent Memory Demo', '记忆建议']) {
    assert(html.includes(marker), `Preview server response missing marker: ${marker}`);
  }
} finally {
  preview.kill();
}

const feishu = read('docs/feishu/agentmemory-project-intro-cn.md');
for (const marker of ['插件发布物料', 'AI 页面诊断', '本地工作台工作流', '待审阅队列', 'Skill 草稿', 'artifacts/agent-memory-lab-extension.zip']) {
  assert(feishu.includes(marker), `Feishu source doc missing marker: ${marker}`);
}
const workbenchWhiteboard = read('docs/feishu/whiteboards/workbench-workflow.mmd');
for (const marker of ['入口层', '工作台主流程', '浏览器插件', '待审阅', '记忆库', '会话时间线', '经验', '行动', 'Skill 草稿', '下一次对话']) {
  assert(workbenchWhiteboard.includes(marker), `Workbench whiteboard missing marker: ${marker}`);
}

run(process.execPath, ['scripts/check-browser-extension.mjs']);
run(process.execPath, ['scripts/check-browser-extension-review-draft.mjs']);
run(process.execPath, ['scripts/check-browser-extension-diagnostics-privacy.mjs']);
run(process.execPath, ['scripts/check-browser-extension-fixtures.mjs']);
run(process.execPath, ['scripts/check-browser-extension-demo-interaction.mjs']);
run(process.execPath, ['scripts/record-ai-validation-evidence.mjs', '--file', 'scripts/fixtures/ai-validation-diagnostic.json', '--out', 'artifacts/example-ai-validation-evidence.json', '--force']);
run(process.execPath, ['scripts/prepare-ai-validation-run.mjs']);
run(process.execPath, ['scripts/package-browser-extension.mjs']);
run(process.execPath, ['scripts/check-browser-extension-package.mjs']);
run(process.execPath, ['scripts/check-ai-validation-evidence.mjs']);
run(process.execPath, ['scripts/check-ai-validation-evidence-guards.mjs']);
run(process.execPath, ['scripts/sync-ai-validation-table.mjs', '--check']);
run(process.execPath, ['scripts/write-delivery-summary.mjs']);
run(process.execPath, ['scripts/make-ai-validation-tester-pack.mjs']);
run(process.execPath, ['scripts/delivery-status.mjs']);
run(process.execPath, ['--import', 'tsx', 'scripts/check-viewer-delivery-runtime.mjs']);
run(process.execPath, ['scripts/check-release-gates.mjs']);
assert(existsSync('artifacts/agent-memory-lab-extension.zip'), 'Browser extension package was not created.');
assert(existsSync('artifacts/delivery-summary.md'), 'Delivery summary was not created.');
assert(existsSync('artifacts/delivery-manifest.json'), 'Delivery manifest was not created.');
assert(existsSync('artifacts/external-tester-handout.md'), 'External tester handout was not created.');
assert(existsSync('artifacts/release-notes.md'), 'Release notes were not created.');
assert(existsSync('artifacts/ai-validation-evidence-summary.json'), 'AI validation evidence summary was not created.');
assert(existsSync('artifacts/ai-validation-run/tester-pack-cn.md'), 'AI validation tester pack was not created.');
const deliverySummary = read('artifacts/delivery-summary.md');
for (const marker of ['Agent Memory Lab Delivery Summary', 'Extension zip', 'Extension zip sha256', 'Delivery manifest', 'External Testing Loop', 'Release Gates', 'Reviewer Checklist', 'feedback template', 'triage guide', 'check:release-public', 'Real AI Site Validation', 'External tester guide', 'External tester issue template', 'AI validation log', 'AI validation tester pack']) {
  assert(deliverySummary.includes(marker), `Delivery summary missing marker: ${marker}`);
}
const deliveryManifest = JSON.parse(read('artifacts/delivery-manifest.json'));
assert(deliveryManifest.product === 'Agent Memory Lab', 'Delivery manifest product mismatch.');
assert(deliveryManifest.coreExperience?.externalTestingEntry?.popupVersionVisible === true, 'Delivery manifest must record popup version visibility.');
assert(deliveryManifest.coreExperience?.externalTestingEntry?.popupLocalTestingStatusVisible === true, 'Delivery manifest must record popup local testing status.');
assert(String(deliveryManifest.coreExperience?.externalTestingEntry?.testerGuideUrl || '').includes('external-tester-guide-cn.md'), 'Delivery manifest must record tester guide URL.');
assert(deliveryManifest.coreExperience?.reviewDraft?.popup === true, 'Delivery manifest must record popup review draft support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.sidePanel === true, 'Delivery manifest must record side panel review draft support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.editableProject === true, 'Delivery manifest must record editable project support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.editableTags === true, 'Delivery manifest must record editable tags support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.editableLessonFlag === true, 'Delivery manifest must record editable lesson flag support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.savesToReviewQueue === true, 'Delivery manifest must record review queue save behavior.');
assert(deliveryManifest.coreExperience?.aiInputMemoryHint?.sidePanelTestCardsEntry === true, 'Delivery manifest must record side panel test cards entry.');
assert(deliveryManifest.coreExperience?.aiInputMemoryHint?.diagnosticValidationGuide === true, 'Delivery manifest must record diagnostic validation guide support.');
assert(deliveryManifest.externalTesting?.zipLoadChecklist?.exists === true, 'Delivery manifest must record zip load checklist support.');
assert(deliveryManifest.externalTesting?.feedbackTemplate?.exists === true, 'Delivery manifest must record external feedback template support.');
assert(deliveryManifest.externalTesting?.issueTemplate?.exists === true, 'Delivery manifest must record external issue template support.');
assert(deliveryManifest.externalTesting?.feedbackTriage?.exists === true, 'Delivery manifest must record feedback triage support.');
assert(deliveryManifest.externalTesting?.evidenceRecorder?.exists === true, 'Delivery manifest must record AI evidence recorder support.');
assert(deliveryManifest.externalTesting?.aiValidationTesterPack?.exists === true, 'Delivery manifest must record AI validation tester pack support.');
assert(deliveryManifest.externalTesting?.aiSiteTestCards?.exists === true, 'Delivery manifest must record AI site test cards support.');
assert(deliveryManifest.externalTesting?.aiSiteTestCards?.viewerPath === '/docs/browser-extension-ai-site-test-cards-cn.md', 'Delivery manifest must record local viewer test cards path.');
assert(deliveryManifest.externalTesting?.aiSiteTestCards?.diagnosticField === 'validationGuide', 'Delivery manifest must record diagnostic validationGuide field.');
assert(deliveryManifest.artifacts?.extensionZip?.exists, 'Delivery manifest must mark extension zip as existing.');
assert(deliveryManifest.artifacts?.loadInstructions?.exists, 'Delivery manifest must mark zip load instructions as existing.');
assert(deliveryManifest.artifacts?.externalTesterHandout?.exists === true, 'Delivery manifest must mark external tester handout as existing.');
assert(deliveryManifest.artifacts?.aiValidationTesterPack?.path === 'artifacts/ai-validation-run/tester-pack-cn.md', 'Delivery manifest must mark AI validation tester pack artifact.');
assert(deliveryManifest.artifacts?.aiValidationQuickstart?.path === 'artifacts/ai-validation-run/quickstart-cn.md', 'Delivery manifest must mark AI validation quickstart artifact.');
assert(deliveryManifest.externalTesting?.aiValidationQuickstart?.exists === true, 'Delivery manifest must record AI validation quickstart support.');
assert(deliveryManifest.artifacts?.releaseNotes?.exists === true, 'Delivery manifest must mark release notes as existing.');
assert(deliveryManifest.artifacts?.githubReleaseDraft?.exists === true, 'Delivery manifest must mark GitHub release draft as existing.');
assert(deliveryManifest.coreExperience?.aiInputMemoryHint?.mem0Reference?.documentedIn === 'docs/browser-extension-mem0-reference-cn.md', 'Delivery manifest must record Mem0 reference documentation.');
assert(String(deliveryManifest.coreExperience?.aiInputMemoryHint?.mem0Reference?.inputPlacement || '').includes('prompt'), 'Delivery manifest must record prompt-adjacent placement.');
assert(String(deliveryManifest.coreExperience?.aiInputMemoryHint?.mem0Reference?.reviewFirstDifference || '').includes('/agentmemory/review'), 'Delivery manifest must record review-first difference.');
assert(deliveryManifest.artifacts.extensionZip.bytes > 0, 'Delivery manifest extension zip size must be positive.');
assert(/^[a-f0-9]{64}$/.test(deliveryManifest.artifacts.extensionZip.sha256 || ''), 'Delivery manifest extension zip sha256 is invalid.');
assert(deliveryManifest.releaseState?.publicRelease === 'not-ready', 'Delivery manifest must mark public release as not-ready until real site evidence exists.');
assert(deliveryManifest.releaseState.realSiteValidation?.requiredCount === 4, 'Delivery manifest must track four required AI products.');
assert(Array.isArray(deliveryManifest.releaseState.realSiteValidation.notPassed), 'Delivery manifest must list AI products not yet passed.');
assert(deliveryManifest.releaseState.realSiteValidation.source === 'docs/browser-extension-ai-validation-cn.md', 'Delivery manifest must cite the AI validation source.');
assert(deliveryManifest.releaseState.realSiteValidation.evidenceSummary === 'artifacts/ai-validation-evidence-summary.json', 'Delivery manifest must cite AI evidence summary artifact.');

const handout = read('artifacts/external-tester-handout.md');
for (const marker of ['Agent Memory Lab 外部试用说明', 'agent-memory-lab-extension.zip', '先做这 5 步', '真实 AI 页面验收', 'GitHub Issue 模板', '公开发布：not-ready']) {
  assert(handout.includes(marker), `External tester handout missing marker: ${marker}`);
}

const testerPack = read('artifacts/ai-validation-run/tester-pack-cn.md');
for (const marker of ['真实 AI 站点外测包', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity', '不能替代', 'prompt 草稿', '具体对话', '输入框草稿', '真实对话计数', 'npm run wizard:ai-validation-evidence', 'manualValidation']) {
  assert(testerPack.includes(marker), `AI validation tester pack missing marker: ${marker}`);
}
const quickstart = read('artifacts/ai-validation-run/quickstart-cn.md');
for (const marker of ['真实 AI 站点验收一页纸', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity', '复制问题信息', '具体对话', '输入框草稿', 'turnCount', 'npm run wizard:ai-validation-evidence', '隐私边界']) {
  assert(quickstart.includes(marker), `AI validation quickstart missing marker: ${marker}`);
}

const releaseNotes = read('artifacts/release-notes.md');
for (const marker of ['Release Notes', '版本信息', 'Extension zip', '本版新增和已就绪能力', '已知边界', '真实 AI 页面证据', 'npm run check:delivery', 'npm run check:release-public', '反馈入口']) {
  assert(releaseNotes.includes(marker), `Release notes missing marker: ${marker}`);
}

const githubReleaseDraft = read('artifacts/github-release-draft.md');
for (const marker of ['外部试用包', 'GitHub Release 草稿', 'Extension zip', 'Mem0 / OpenMemory', '输入框附近', '待审阅队列', '公开发布仍是 `not-ready`', 'browser-extension/shared/site-config.js', 'npm run check:release-public']) {
  assert(githubReleaseDraft.includes(marker), `GitHub release draft missing marker: ${marker}`);
}

console.log('delivery checks ok');
