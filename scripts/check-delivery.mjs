import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

const requiredFiles = [
  'README.md',
  'browser-extension/README.md',
  'docs/demo-checklist-cn.md',
  'docs/product-delivery-plan-cn.md',
  'docs/feishu/agentmemory-project-intro-cn.md',
  'docs/browser-extension-privacy-cn.md',
  'docs/readme-assets/screenshots/dashboard.jpg',
  'docs/readme-assets/screenshots/skills.jpg',
  'browser-extension/manifest.json',
  'scripts/check-browser-extension.mjs',
  'scripts/package-browser-extension.mjs'
];

for (const file of requiredFiles) {
  assert(existsSync(file), `Missing required delivery file: ${file}`);
}

const readme = read('README.md');
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
assert(browserReadme.includes('docs/browser-extension-privacy-cn.md'), 'Browser extension README must link privacy doc.');

const checklist = read('docs/demo-checklist-cn.md');
for (const marker of ['审阅队列可用', 'AI 页面状态', '本地记忆', 'Skill 管理台']) {
  assert(checklist.includes(marker), `Demo checklist missing marker: ${marker}`);
}

const plan = read('docs/product-delivery-plan-cn.md');
for (const marker of ['本地预览包', '权限与隐私说明', 'Skill 草稿', 'AI 页面诊断']) {
  assert(plan.includes(marker), `Product delivery plan missing marker: ${marker}`);
}

const feishu = read('docs/feishu/agentmemory-project-intro-cn.md');
for (const marker of ['插件发布物料', 'AI 页面诊断', 'Skill 草稿', 'artifacts/agent-memory-lab-extension.zip']) {
  assert(feishu.includes(marker), `Feishu source doc missing marker: ${marker}`);
}

run(process.execPath, ['scripts/check-browser-extension.mjs']);
run(process.execPath, ['scripts/package-browser-extension.mjs']);
assert(existsSync('artifacts/agent-memory-lab-extension.zip'), 'Browser extension package was not created.');

console.log('delivery checks ok');
