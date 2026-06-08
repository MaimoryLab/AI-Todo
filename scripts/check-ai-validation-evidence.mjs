import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function hasPass(value) {
  if (value === true) return true;
  const text = String(value || '').toLowerCase();
  return ['通过', '已通过', 'pass', 'passed', 'ok'].some((word) => text.includes(word));
}

function normalizeProvider(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('chatgpt')) return 'ChatGPT';
  if (text.includes('claude')) return 'Claude';
  if (text.includes('gemini')) return 'Gemini';
  if (text.includes('perplexity')) return 'Perplexity';
  if (text.includes('grok')) return 'Grok';
  if (text.includes('deepseek')) return 'DeepSeek';
  return value ? String(value).trim() : 'Unknown';
}

function evidencePassed(item) {
  const ai = item.ai || {};
  const manual = item.manualValidation || {};
  return !!(
    ai.supportedAiPage &&
    ai.provider &&
    ai.editorFound &&
    ai.anchorFound &&
    ai.memoryWidgetVisible &&
    ai.placement &&
    ai.checkedAt &&
    hasPass(manual.memoryInsertPassed) &&
    hasPass(manual.diagnosticsCopied) &&
    hasPass(manual.siteInputStillWorks)
  );
}

const evidenceDir = 'docs/validation/browser-extension-ai-sites';
const requiredProducts = ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'];
const optionalProducts = ['Grok', 'DeepSeek'];
const files = existsSync(evidenceDir)
  ? readdirSync(evidenceDir).filter((file) => file.endsWith('.json')).map((file) => path.join(evidenceDir, file))
  : [];

const evidence = files.map((file) => {
  const data = readJson(file);
  const provider = normalizeProvider(data.ai && data.ai.provider);
  const passed = evidencePassed(data);
  return {
    file,
    provider,
    url: data.page && data.page.url ? data.page.url : '',
    checkedAt: data.ai && data.ai.checkedAt ? data.ai.checkedAt : data.generatedAt || '',
    extensionVersion: data.extension && data.extension.version ? data.extension.version : '',
    editorFound: !!(data.ai && data.ai.editorFound),
    anchorFound: !!(data.ai && data.ai.anchorFound),
    memoryWidgetVisible: !!(data.ai && data.ai.memoryWidgetVisible),
    memoryInsertPassed: hasPass(data.manualValidation && data.manualValidation.memoryInsertPassed),
    diagnosticsCopied: hasPass(data.manualValidation && data.manualValidation.diagnosticsCopied),
    siteInputStillWorks: hasPass(data.manualValidation && data.manualValidation.siteInputStillWorks),
    passed
  };
});

const passedRequired = requiredProducts.filter((product) => evidence.some((item) => item.provider === product && item.passed));
const notPassedRequired = requiredProducts.filter((product) => !passedRequired.includes(product));
const summary = {
  source: evidenceDir,
  generatedAt: new Date().toISOString(),
  requiredProducts,
  optionalProducts,
  files: evidence,
  passedRequired,
  notPassedRequired,
  passedCount: passedRequired.length,
  requiredCount: requiredProducts.length,
  publicReleaseReadyByEvidence: passedRequired.length === requiredProducts.length
};

mkdirSync('artifacts', { recursive: true });
writeFileSync('artifacts/ai-validation-evidence-summary.json', `${JSON.stringify(summary, null, 2)}\n`);

console.log(`AI validation evidence: ${passedRequired.length}/${requiredProducts.length} required products passed`);
if (notPassedRequired.length) console.log(`not passed: ${notPassedRequired.join(', ')}`);
console.log('evidence summary: artifacts/ai-validation-evidence-summary.json');
