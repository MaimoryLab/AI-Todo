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
const popupHtml = readFileSync('browser-extension/popup.html', 'utf8');
const popupJs = readFileSync('browser-extension/popup.js', 'utf8');
const sidepanelHtml = readFileSync('browser-extension/sidepanel.html', 'utf8');
const sidepanel = readFileSync('browser-extension/sidepanel.js', 'utf8');
const schema = readFileSync('browser-extension/shared/schema.js', 'utf8');
const siteConfig = readFileSync('browser-extension/shared/site-config.js', 'utf8');
const sharedApi = readFileSync('browser-extension/shared/api.js', 'utf8');
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
if (!popupHtml.includes('待审阅草稿') || !popupHtml.includes('draftContent') || !popupHtml.includes('resetDraft')) {
  throw new Error('Popup must expose an editable review draft before saving.');
}
for (const field of ['draftProject', 'draftTags', 'draftAsLesson']) {
  if (!popupHtml.includes(field)) throw new Error(`Popup review draft missing ${field}.`);
}
if (!popupJs.includes('buildDraft') || !popupJs.includes('SAVE_CANDIDATE') || !popupJs.includes('resetDraft')) {
  throw new Error('Popup must save the edited review draft via SAVE_CANDIDATE.');
}
if (!popupJs.includes('getDraftMetaFields') || !serviceWorker.includes('message.meta')) {
  throw new Error('Popup draft metadata must be sent with review candidates.');
}
if (!popupHtml.includes('本地工作台') || !popupHtml.includes('versionInfo') || !popupHtml.includes('openGuide')) {
  throw new Error('Popup must expose local workbench status, version, and guide entry.');
}
if (!popupJs.includes('getManifest') || !popupJs.includes('external-tester-guide-cn.md')) {
  throw new Error('Popup must render extension version and link the guide.');
}
if (!popupJs.includes('buildBrowserMemoryDraft') || !serviceWorker.includes('buildBrowserMemoryDraft') || !sidepanel.includes('buildMemoryDraft')) {
  throw new Error('Browser extension must draft concrete facts before sending review candidates.');
}
if (!schema.includes('buildBrowserLessonDraft') || !serviceWorker.includes('buildBrowserLessonDraft') || !sidepanel.includes('buildLessonDraft')) {
  throw new Error('Browser extension must draft lessons from concrete conversation evidence.');
}
for (const marker of ['对话依据', '这段对话还没有足够内容提炼经验', 'ChatGPT\\s*是一款供日常使用']) {
  if (!schema.includes(marker)) throw new Error(`Shared lesson drafting guard missing ${marker}.`);
}
if (!sidepanelHtml.includes('审阅草稿') || !sidepanelHtml.includes('draftContent') || !sidepanelHtml.includes('resetDraft')) {
  throw new Error('Side panel must expose an editable review draft before saving.');
}
for (const field of ['draftProject', 'draftTags', 'draftAsLesson']) {
  if (!sidepanelHtml.includes(field)) throw new Error(`Side panel review draft missing ${field}.`);
}
if (!sidepanel.includes('buildDefaultDraft') || !sidepanel.includes('data-draft-kind') || !sidepanel.includes('SAVE_CANDIDATE')) {
  throw new Error('Side panel must route candidates through the editable review draft.');
}
if (!sidepanel.includes('getDraftMetaFields') || !serviceWorker.includes('normalizeCandidateMeta')) {
  throw new Error('Side panel draft metadata must reach the review queue payload.');
}
if (!sidepanelHtml.includes('openTestCards') || !sidepanel.includes('AI_SITE_TEST_CARDS_PATH')) {
  throw new Error('Side panel must expose the local AI site test cards entry.');
}
if (!sidepanelHtml.includes('copyEvidenceCommand') || !sidepanelHtml.includes('复制向导') || !sidepanel.includes('buildEvidenceCommand') || !sidepanel.includes('wizard:ai-validation-evidence')) {
  throw new Error('Side panel must expose a copyable AI validation evidence wizard command.');
}
if (!sharedApi.includes('path =') || !serviceWorker.includes('message.path')) {
  throw new Error('OPEN_VIEWER must support local viewer document paths.');
}

for (const field of ['anchorFound', 'placement', 'memoryWidgetVisible', 'checkedAt', 'anchorSelector', 'anchorSource', 'adjacentSelector', 'sendFound', 'sendSelector', 'turnSelector', 'turnSelectorCount', 'matchedSelectors']) {
  if (!contentScript.includes(field)) throw new Error(`Content script diagnostics missing ${field}.`);
  if (!schema.includes(field)) throw new Error(`Shared schema diagnostics must preserve ${field}.`);
  if (!sidepanel.includes(field)) throw new Error(`Side panel diagnostics must expose ${field}.`);
}
for (const label of ['输入规则', '锚点规则', '相邻控件', '发送规则', '会话规则']) {
  if (!sidepanel.includes(label)) throw new Error(`Side panel diagnostics must show ${label}.`);
}
for (const field of ['getManifest', 'manifestVersion', 'version']) {
  if (!sidepanel.includes(field)) throw new Error(`Diagnostic report must include extension ${field}.`);
}
for (const field of ['manualValidation', 'memoryInsertPassed', 'diagnosticsCopied', 'siteInputStillWorks']) {
  if (!sidepanel.includes(field)) throw new Error(`Diagnostic report must include manual validation template field ${field}.`);
}
for (const field of ['validationGuide', 'requiredProducts', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity', '/docs/browser-extension-ai-site-test-cards-cn.md']) {
  if (!sidepanel.includes(field)) throw new Error(`Diagnostic report must include validation guide field ${field}.`);
}

console.log('browser extension checks ok');
