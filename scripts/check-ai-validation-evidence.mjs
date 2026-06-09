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

function jsonText(value) {
  return JSON.stringify(value || {});
}

function hasPrivateDiagnosticContent(item) {
  const text = jsonText(item);
  const forbiddenKeys = [
    'promptDraft',
    'turns',
    'conversation',
    'selection',
    'description',
    'headings',
    'candidates',
    'memories',
    'lessons',
    'draftContent'
  ];
  return forbiddenKeys.some((key) => text.includes(`"${key}"`));
}

function isRequiredProvider(value) {
  return ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'].includes(normalizeProvider(value));
}

function evidencePrivacySafe(item) {
  return !hasPrivateDiagnosticContent(item);
}

function evidenceDomainMatchesProvider(item) {
  const provider = normalizeProvider(item.ai && item.ai.provider);
  const host = String(item.page && (item.page.host || item.page.url) || '').toLowerCase();
  if (provider === 'ChatGPT') return host.includes('chatgpt.com') || host.includes('chat.openai.com');
  if (provider === 'Claude') return host.includes('claude.ai');
  if (provider === 'Gemini') return host.includes('gemini.google.com');
  if (provider === 'Perplexity') return host.includes('perplexity.ai');
  return true;
}

function evidencePassed(item) {
  const ai = item.ai || {};
  const manual = item.manualValidation || {};
  const matched = ai.matchedSelectors || {};
  return !!(
    evidencePrivacySafe(item) &&
    evidenceDomainMatchesProvider(item) &&
    ai.supportedAiPage &&
    ai.provider &&
    ai.editorFound &&
    matched.editor &&
    ai.anchorFound &&
    matched.anchor &&
    ai.memoryWidgetVisible &&
    ai.placement &&
    matched.send &&
    matched.turn &&
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
    editorSelector: data.ai?.matchedSelectors?.editor || data.ai?.editorSelector || '',
    anchorFound: !!(data.ai && data.ai.anchorFound),
    anchorSelector: data.ai?.matchedSelectors?.anchor || data.ai?.anchorSelector || '',
    sendSelector: data.ai?.matchedSelectors?.send || data.ai?.sendSelector || '',
    turnSelector: data.ai?.matchedSelectors?.turn || data.ai?.turnSelector || '',
    memoryWidgetVisible: !!(data.ai && data.ai.memoryWidgetVisible),
    memoryInsertPassed: hasPass(data.manualValidation && data.manualValidation.memoryInsertPassed),
    diagnosticsCopied: hasPass(data.manualValidation && data.manualValidation.diagnosticsCopied),
    siteInputStillWorks: hasPass(data.manualValidation && data.manualValidation.siteInputStillWorks),
    privacySafe: evidencePrivacySafe(data),
    domainMatchesProvider: evidenceDomainMatchesProvider(data),
    passed
  };
});

const invalidRequiredEvidence = evidence.filter((item) => isRequiredProvider(item.provider) && (!item.privacySafe || !item.domainMatchesProvider));
if (invalidRequiredEvidence.length) {
  for (const item of invalidRequiredEvidence) {
    console.error(`Invalid ${item.provider} evidence: ${item.file}`);
    if (!item.privacySafe) console.error('- copied diagnostic contains private/raw page or conversation fields');
    if (!item.domainMatchesProvider) console.error('- page host does not match provider');
  }
  process.exitCode = 1;
}

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
