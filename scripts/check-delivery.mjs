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
  'docs/release-gates-cn.md',
  'docs/browser-extension-ai-validation-cn.md',
  'docs/browser-extension-privacy-en.md',
  'docs/browser-extension-store-listing-en.md',
  'docs/feishu/agentmemory-project-intro-cn.md',
  'docs/browser-extension-privacy-cn.md',
  'docs/readme-assets/screenshots/dashboard.jpg',
  'docs/readme-assets/screenshots/skills.jpg',
  'src/viewer/demo/browser-extension.html',
  'dist/viewer/demo/browser-extension.html',
  'browser-extension/manifest.json',
  'browser-extension/icons/icon16.png',
  'browser-extension/icons/icon32.png',
  'browser-extension/icons/icon48.png',
  'browser-extension/icons/icon128.png',
  'scripts/check-browser-extension.mjs',
  'scripts/check-browser-extension-fixtures.mjs',
  'scripts/check-browser-extension-demo-interaction.mjs',
  'scripts/check-browser-extension-package.mjs',
  'scripts/check-workbench-status.mjs',
  'scripts/package-browser-extension.mjs'
];

for (const file of requiredFiles) {
  assert(existsSync(file), `Missing required delivery file: ${file}`);
}

const readme = read('README.md');
assert(readme.includes('npm run preview:browser-extension'), 'README must mention browser extension preview command.');
assert(readme.includes('npm run build && npm run start'), 'README must mention full workbench start command.');
assert(readme.includes('npm run check:workbench'), 'README must mention workbench status check command.');
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
assert(browserReadme.includes('npm run preview:browser-extension'), 'Browser extension README must mention preview command.');
assert(browserReadme.includes('docs/browser-extension-privacy-cn.md'), 'Browser extension README must link privacy doc.');
assert(browserReadme.includes('/demo/browser-extension.html'), 'Browser extension README must mention local demo page.');

const checklist = read('docs/demo-checklist-cn.md');
for (const marker of ['审阅队列可用', 'AI 页面状态', '记忆建议', 'Skill 管理台']) {
  assert(checklist.includes(marker), `Demo checklist missing marker: ${marker}`);
}

const testerGuide = read('docs/external-tester-guide-cn.md');
for (const marker of ['外部试用指南', 'npm run preview:browser-extension', 'npm run check:workbench', '记忆建议', '诊断 JSON', '从仓库试用', '从 zip 试用', 'browser-extension/']) {
  assert(testerGuide.includes(marker), `External tester guide missing marker: ${marker}`);
}

const plan = read('docs/product-delivery-plan-cn.md');
for (const marker of ['本地预览包', '权限与隐私说明', 'Skill 草稿', 'AI 页面诊断']) {
  assert(plan.includes(marker), `Product delivery plan missing marker: ${marker}`);
}

const releaseGates = read('docs/release-gates-cn.md');
for (const marker of ['本地可演示', '外部可试用', '公开可发布', '未达到', '真实 AI 站点逐站验收', '入口位置策略']) {
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
run(process.execPath, ['scripts/check-browser-extension-fixtures.mjs']);
run(process.execPath, ['scripts/check-browser-extension-demo-interaction.mjs']);
run(process.execPath, ['scripts/package-browser-extension.mjs']);
run(process.execPath, ['scripts/check-browser-extension-package.mjs']);
assert(existsSync('artifacts/agent-memory-lab-extension.zip'), 'Browser extension package was not created.');

console.log('delivery checks ok');
