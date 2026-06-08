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
  'docs/external-tester-guide-cn.md',
  'docs/external-feedback-template-cn.md',
  'docs/external-feedback-triage-cn.md',
  'docs/release-gates-cn.md',
  'docs/browser-extension-ai-validation-cn.md',
  'docs/browser-extension-mem0-reference-cn.md',
  'docs/browser-extension-privacy-en.md',
  'docs/browser-extension-store-listing-en.md',
  'docs/feishu/agentmemory-project-intro-cn.md',
  'docs/browser-extension-privacy-cn.md',
  'docs/readme-assets/screenshots/dashboard.jpg',
  'docs/readme-assets/screenshots/skills.jpg',
  'src/viewer/demo/browser-extension.html',
  'dist/viewer/demo/browser-extension.html',
  'browser-extension/manifest.json',
  'browser-extension/LOAD-THIS-FIRST.md',
  'browser-extension/icons/icon16.png',
  'browser-extension/icons/icon32.png',
  'browser-extension/icons/icon48.png',
  'browser-extension/icons/icon128.png',
  'scripts/check-browser-extension.mjs',
  'scripts/check-browser-extension-review-draft.mjs',
  'scripts/check-browser-extension-fixtures.mjs',
  'scripts/check-browser-extension-demo-interaction.mjs',
  'scripts/check-browser-extension-package.mjs',
  'scripts/check-release-gates.mjs',
  'scripts/check-ai-validation-evidence.mjs',
  'scripts/sync-ai-validation-table.mjs',
  'scripts/delivery-status.mjs',
  'scripts/check-workbench-status.mjs',
  'scripts/package-browser-extension.mjs',
  'scripts/write-delivery-summary.mjs'
];

for (const file of requiredFiles) {
  assert(existsSync(file), `Missing required delivery file: ${file}`);
}

const readme = read('README.md');
assert(readme.includes('npm run preview:browser-extension'), 'README must mention browser extension preview command.');
assert(readme.includes('npm run build && npm run start'), 'README must mention full workbench start command.');
assert(readme.includes('npm run check:workbench'), 'README must mention workbench status check command.');
assert(readme.includes('npm run check:release-gates'), 'README must mention release gates check command.');
assert(readme.includes('npm run check:release-public'), 'README must mention public release check command.');
assert(readme.includes('npm run status:delivery'), 'README must mention delivery status command.');
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
assert(browserReadme.includes('npm run package:browser-extension'), 'Browser extension README must mention packaging command.');
assert(browserReadme.includes('npm run status:delivery'), 'Browser extension README must mention delivery status command.');
assert(browserReadme.includes('npm run preview:browser-extension'), 'Browser extension README must mention preview command.');
assert(browserReadme.includes('docs/browser-extension-privacy-cn.md'), 'Browser extension README must link privacy doc.');
assert(browserReadme.includes('docs/browser-extension-mem0-reference-cn.md'), 'Browser extension README must link Mem0 reference doc.');
assert(browserReadme.includes('保存前编辑'), 'Browser extension README must mention edit-before-save flow.');
assert(browserReadme.includes('同步侧栏'), 'Browser extension README must mention the side panel flow.');
assert(browserReadme.includes('/demo/browser-extension.html'), 'Browser extension README must mention local demo page.');

const checklist = read('docs/demo-checklist-cn.md');
for (const marker of ['审阅队列可用', 'AI 页面状态', '记忆建议', 'Skill 管理台']) {
  assert(checklist.includes(marker), `Demo checklist missing marker: ${marker}`);
}

const testerGuide = read('docs/external-tester-guide-cn.md');
for (const marker of ['外部试用指南', 'npm run preview:browser-extension', 'npm run check:workbench', 'npm run check:release-gates', '记忆建议', '诊断 JSON', '从仓库试用', '从 zip 试用', 'browser-extension/', '外部试用反馈模板', '外部反馈分诊指南']) {
  assert(testerGuide.includes(marker), `External tester guide missing marker: ${marker}`);
}

const feedbackTemplate = read('docs/external-feedback-template-cn.md');
for (const marker of ['外部试用反馈模板', '外部反馈分诊指南', '基本信息', '试用路径', '问题描述', '诊断信息', 'manualValidation', '影响程度']) {
  assert(feedbackTemplate.includes(marker), `External feedback template missing marker: ${marker}`);
}

const feedbackTriage = read('docs/external-feedback-triage-cn.md');
for (const marker of ['外部反馈分诊指南', 'docs/external-feedback-template-cn.md', 'manualValidation', '站点适配', '输入事件', '审阅队列', '隐私/信任', 'npm run check:browser-extension']) {
  assert(feedbackTriage.includes(marker), `External feedback triage guide missing marker: ${marker}`);
}

const plan = read('docs/product-delivery-plan-cn.md');
for (const marker of ['本地预览包', '权限与隐私说明', '插件对标说明', '外部反馈分诊指南', 'Skill 草稿', 'AI 页面诊断']) {
  assert(plan.includes(marker), `Product delivery plan missing marker: ${marker}`);
}

const mem0Reference = read('docs/browser-extension-mem0-reference-cn.md');
for (const marker of ['mem0ai/mem0-chrome-extension', 'supported sites', '输入框附近', '待审阅队列', '真实 AI 站点验收', '插件迭代工作流']) {
  assert(mem0Reference.includes(marker), `Mem0 reference doc missing marker: ${marker}`);
}

const releaseGates = read('docs/release-gates-cn.md');
for (const marker of ['本地可演示', '外部可试用', '公开可发布', '未达到', '真实 AI 站点逐站验收', '外部反馈分诊指南', '入口位置策略', 'npm run check:release-public']) {
  assert(releaseGates.includes(marker), `Release gates doc missing marker: ${marker}`);
}

const aiValidation = read('docs/browser-extension-ai-validation-cn.md');
for (const marker of ['ChatGPT', 'Claude', 'Gemini', 'Perplexity', '复制诊断', '通过标准', 'anchorFound', 'placement', 'memoryWidgetVisible']) {
  assert(aiValidation.includes(marker), `AI validation doc missing marker: ${marker}`);
}

const demoPage = read('src/viewer/demo/browser-extension.html');
for (const marker of ['agentmemory-demo-input', 'Agent Memory Demo', '记忆建议']) {
  assert(demoPage.includes(marker), `Browser extension demo page missing marker: ${marker}`);
}

const privacyEn = read('docs/browser-extension-privacy-en.md');
for (const marker of ['Privacy Policy', 'local-first', 'Data We Process', 'Where Data Goes', 'AI Diagnostics']) {
  assert(privacyEn.includes(marker), `English privacy policy missing marker: ${marker}`);
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
for (const marker of ['插件发布物料', 'AI 页面诊断', 'Skill 草稿', 'artifacts/agent-memory-lab-extension.zip']) {
  assert(feishu.includes(marker), `Feishu source doc missing marker: ${marker}`);
}

run(process.execPath, ['scripts/check-browser-extension.mjs']);
run(process.execPath, ['scripts/check-browser-extension-review-draft.mjs']);
run(process.execPath, ['scripts/check-browser-extension-fixtures.mjs']);
run(process.execPath, ['scripts/check-browser-extension-demo-interaction.mjs']);
run(process.execPath, ['scripts/package-browser-extension.mjs']);
run(process.execPath, ['scripts/check-browser-extension-package.mjs']);
run(process.execPath, ['scripts/check-ai-validation-evidence.mjs']);
run(process.execPath, ['scripts/sync-ai-validation-table.mjs', '--check']);
run(process.execPath, ['scripts/write-delivery-summary.mjs']);
run(process.execPath, ['scripts/delivery-status.mjs']);
run(process.execPath, ['scripts/check-release-gates.mjs']);
assert(existsSync('artifacts/agent-memory-lab-extension.zip'), 'Browser extension package was not created.');
assert(existsSync('artifacts/delivery-summary.md'), 'Delivery summary was not created.');
assert(existsSync('artifacts/delivery-manifest.json'), 'Delivery manifest was not created.');
assert(existsSync('artifacts/ai-validation-evidence-summary.json'), 'AI validation evidence summary was not created.');
const deliverySummary = read('artifacts/delivery-summary.md');
for (const marker of ['Agent Memory Lab Delivery Summary', 'Extension zip', 'Extension zip sha256', 'Delivery manifest', 'Release Gates', 'Real AI Site Validation', 'External tester guide', 'AI validation log']) {
  assert(deliverySummary.includes(marker), `Delivery summary missing marker: ${marker}`);
}
const deliveryManifest = JSON.parse(read('artifacts/delivery-manifest.json'));
assert(deliveryManifest.product === 'Agent Memory Lab', 'Delivery manifest product mismatch.');
assert(deliveryManifest.coreExperience?.externalTestingEntry?.popupVersionVisible === true, 'Delivery manifest must record popup version visibility.');
assert(deliveryManifest.coreExperience?.externalTestingEntry?.popupLocalTestingStatusVisible === true, 'Delivery manifest must record popup local testing status.');
assert(String(deliveryManifest.coreExperience?.externalTestingEntry?.testerGuideUrl || '').includes('external-tester-guide-cn.md'), 'Delivery manifest must record tester guide URL.');
assert(deliveryManifest.coreExperience?.reviewDraft?.popup === true, 'Delivery manifest must record popup review draft support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.sidePanel === true, 'Delivery manifest must record side panel review draft support.');
assert(deliveryManifest.coreExperience?.reviewDraft?.savesToReviewQueue === true, 'Delivery manifest must record review queue save behavior.');
assert(deliveryManifest.artifacts?.extensionZip?.exists, 'Delivery manifest must mark extension zip as existing.');
assert(deliveryManifest.artifacts?.loadInstructions?.exists, 'Delivery manifest must mark zip load instructions as existing.');
assert(deliveryManifest.artifacts.extensionZip.bytes > 0, 'Delivery manifest extension zip size must be positive.');
assert(/^[a-f0-9]{64}$/.test(deliveryManifest.artifacts.extensionZip.sha256 || ''), 'Delivery manifest extension zip sha256 is invalid.');
assert(deliveryManifest.releaseState?.publicRelease === 'not-ready', 'Delivery manifest must mark public release as not-ready until real site evidence exists.');
assert(deliveryManifest.releaseState.realSiteValidation?.requiredCount === 4, 'Delivery manifest must track four required AI products.');
assert(Array.isArray(deliveryManifest.releaseState.realSiteValidation.notPassed), 'Delivery manifest must list AI products not yet passed.');
assert(deliveryManifest.releaseState.realSiteValidation.source === 'docs/browser-extension-ai-validation-cn.md', 'Delivery manifest must cite the AI validation source.');
assert(deliveryManifest.releaseState.realSiteValidation.evidenceSummary === 'artifacts/ai-validation-evidence-summary.json', 'Delivery manifest must cite AI evidence summary artifact.');

console.log('delivery checks ok');
