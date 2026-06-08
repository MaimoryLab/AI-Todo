import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const manifest = JSON.parse(readFileSync('browser-extension/manifest.json', 'utf8'));
if ((manifest.content_scripts || []).some((script) => script.type === 'module')) {
  throw new Error('Chrome content scripts must not be declared as module scripts.');
}

const files = [
  'browser-extension/content-script.js',
  'browser-extension/service-worker.js',
  'browser-extension/popup.js',
  'browser-extension/options.js',
  'browser-extension/sidepanel.js',
  'browser-extension/shared/schema.js',
  'browser-extension/shared/api.js',
  'browser-extension/shared/page-types.js',
  'browser-extension/shared/site-config.js'
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${file} failed syntax check.`);
}

function readPngSize(file) {
  const buf = readFileSync(file);
  const signature = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== signature) throw new Error(`${file} is not a PNG.`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

for (const size of [16, 32, 48, 128]) {
  const iconPath = manifest.icons && manifest.icons[String(size)];
  if (iconPath !== `icons/icon${size}.png`) throw new Error(`Manifest icon ${size} must point to icons/icon${size}.png.`);
  const actual = readPngSize(`browser-extension/${iconPath}`);
  if (actual.width !== size || actual.height !== size) {
    throw new Error(`${iconPath} must be ${size}x${size}, got ${actual.width}x${actual.height}.`);
  }
}

const contentScript = readFileSync('browser-extension/content-script.js', 'utf8');
const serviceWorker = readFileSync('browser-extension/service-worker.js', 'utf8');
const sidepanel = readFileSync('browser-extension/sidepanel.js', 'utf8');
const schema = readFileSync('browser-extension/shared/schema.js', 'utf8');
const siteConfig = readFileSync('browser-extension/shared/site-config.js', 'utf8');
if (!contentScript.includes('DEMO_MEMORIES') || !contentScript.includes("provider.id === 'agentmemoryDemo'")) {
  throw new Error('Content script must provide local demo memories for the Agent Memory Demo page.');
}
const contentProviders = [...contentScript.matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]);
const sharedProviders = [...siteConfig.matchAll(/\n\s*([a-z0-9_-]+):\s*\{\s*\n\s*id:\s*'([^']+)'/g)].map((match) => match[2]);

const missingInContent = sharedProviders.filter((id) => !contentProviders.includes(id));
const missingInShared = contentProviders.filter((id) => !sharedProviders.includes(id));
if (missingInContent.length || missingInShared.length) {
  throw new Error(`Provider config mismatch. Missing in content: ${missingInContent.join(', ') || 'none'}; missing in shared: ${missingInShared.join(', ') || 'none'}`);
}

const menuContexts = JSON.stringify(manifest.permissions || []) + serviceWorker;
if (!serviceWorker.includes('saveContextSelection') || !serviceWorker.includes('browser-extension-selection')) {
  throw new Error('Service worker must save selected text into the same review queue.');
}
if (!serviceWorker.includes('browser-extension-link') || !serviceWorker.includes('browser-context:link')) {
  throw new Error('Service worker must preserve right-click link context.');
}
if (!menuContexts.includes("contexts: ['page', 'selection', 'link']")) {
  throw new Error('Context menu must expose page, selection, and link save actions.');
}

for (const field of ['anchorFound', 'placement', 'memoryWidgetVisible', 'checkedAt']) {
  if (!contentScript.includes(field)) throw new Error(`Content script diagnostics missing ${field}.`);
  if (!schema.includes(field)) throw new Error(`Shared schema diagnostics must preserve ${field}.`);
  if (!sidepanel.includes(field)) throw new Error(`Side panel diagnostics must expose ${field}.`);
}
for (const field of ['getManifest', 'manifestVersion', 'version']) {
  if (!sidepanel.includes(field)) throw new Error(`Diagnostic report must include extension ${field}.`);
}

console.log('browser extension checks ok');
