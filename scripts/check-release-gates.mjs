import { existsSync, readFileSync } from 'node:fs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function readJson(path) {
  return JSON.parse(read(path));
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

function isPassed(row) {
  const passWords = ['通过', '已通过', 'pass', 'passed', 'ok'];
  return [row.provider, row.editor, row.hint, row.insert, row.diagnostics, row.result].every((value) => {
    const lower = String(value || '').toLowerCase();
    return passWords.some((word) => lower.includes(word));
  }) && row.date !== '-' && row.evidence !== '-';
}

const requirePublic = process.argv.includes('--public');
const manifestPath = 'artifacts/delivery-manifest.json';
const validationPath = 'docs/browser-extension-ai-validation-cn.md';
const evidenceSummaryPath = 'artifacts/ai-validation-evidence-summary.json';

assert(existsSync(manifestPath), `Missing ${manifestPath}. Run npm run package:browser-extension first.`);
assert(existsSync(validationPath), `Missing ${validationPath}.`);
assert(existsSync(evidenceSummaryPath), `Missing ${evidenceSummaryPath}. Run npm run check:ai-validation-evidence first.`);

const manifest = readJson(manifestPath);
const evidenceSummary = readJson(evidenceSummaryPath);
const validation = read(validationPath);
const rows = parseValidationRows(validation);
const requiredProducts = ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'];
const requiredRows = requiredProducts.map((product) => rows.find((row) => row.product === product)).filter(Boolean);
const passedRows = requiredRows.filter(isPassed);
const missingProducts = requiredProducts.filter((product) => !requiredRows.some((row) => row.product === product));
const notPassed = requiredRows.filter((row) => !isPassed(row)).map((row) => row.product);

const localDemoReady = manifest.releaseState?.localDemo === 'ready';
const externalTestingReady = manifest.releaseState?.externalTesting === 'mostly-ready' || manifest.releaseState?.externalTesting === 'ready';
const evidenceReady = evidenceSummary.passedCount === requiredProducts.length;
const publicReleaseReady = requiredRows.length === requiredProducts.length && passedRows.length === requiredProducts.length && evidenceReady;

console.log('Agent Memory Lab release gates');
console.log(`localDemo: ${localDemoReady ? 'ready' : 'not-ready'}`);
console.log(`externalTesting: ${externalTestingReady ? manifest.releaseState.externalTesting : 'not-ready'}`);
console.log(`publicRelease: ${publicReleaseReady ? 'ready' : 'not-ready'}`);
console.log(`realSiteValidation: ${passedRows.length}/${requiredProducts.length} required products passed`);
console.log(`realSiteEvidence: ${evidenceSummary.passedCount || 0}/${requiredProducts.length} required products passed`);
if (missingProducts.length) console.log(`missing rows: ${missingProducts.join(', ')}`);
if (notPassed.length) console.log(`not passed: ${notPassed.join(', ')}`);

if (!localDemoReady || !externalTestingReady) {
  console.log('Next: run npm run package:browser-extension && npm run check:delivery, then inspect artifacts/delivery-manifest.json.');
  process.exit(1);
}

if (requirePublic && !publicReleaseReady) {
  console.log('Next: complete real AI site validation rows and evidence JSON before public release.');
  process.exit(1);
}

if (!publicReleaseReady) {
  console.log('Public release is intentionally blocked until real AI site evidence is recorded. External testing can continue.');
}
