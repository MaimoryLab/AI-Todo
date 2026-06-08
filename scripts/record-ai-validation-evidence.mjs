import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const evidenceDir = 'docs/validation/browser-extension-ai-sites';

function usage() {
  return `Usage:
  npm run record:ai-validation-evidence -- --file diagnostics.json
  npm run record:ai-validation-evidence -- --stdin
  npm run record:ai-validation-evidence -- --clipboard

Options:
  --provider <name>   Override provider name when the diagnostic JSON is incomplete
  --browser <text>    Fill manualValidation.browser
  --notes <text>      Fill manualValidation.notes
  --pass              Mark manualValidation memoryInsertPassed/siteInputStillWorks as true
  --out <file>        Write to a specific file path
`;
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function providerSlug(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text.includes('chatgpt')) return 'chatgpt';
  if (text.includes('claude')) return 'claude';
  if (text.includes('gemini')) return 'gemini';
  if (text.includes('perplexity')) return 'perplexity';
  if (text.includes('grok')) return 'grok';
  if (text.includes('deepseek')) return 'deepseek';
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

function readClipboard() {
  try {
    return execFileSync('pbpaste', { encoding: 'utf8' });
  } catch {
    throw new Error('Cannot read clipboard. Use --file or --stdin instead.');
  }
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function readInput(args) {
  const file = argValue(args, '--file');
  if (file) return readFileSync(file, 'utf8');
  if (args.includes('--stdin')) return readStdin();
  if (args.includes('--clipboard')) return readClipboard();
  throw new Error(`Missing input.\n${usage()}`);
}

function parseJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf('{');
    const last = trimmed.lastIndexOf('}');
    if (first >= 0 && last > first) return JSON.parse(trimmed.slice(first, last + 1));
    throw new Error('Input does not contain valid diagnostic JSON.');
  }
}

function normalizeEvidence(data, args) {
  const providerOverride = argValue(args, '--provider');
  const provider = providerOverride || data?.ai?.provider || data?.page?.host || 'Unknown';
  const passed = args.includes('--pass');
  const manual = data.manualValidation && typeof data.manualValidation === 'object' ? data.manualValidation : {};
  return {
    product: data.product || 'Agent Memory Lab Browser Extension',
    extension: data.extension || {},
    generatedAt: data.generatedAt || new Date().toISOString(),
    page: data.page || {},
    ai: {
      ...(data.ai || {}),
      provider,
      checkedAt: (data.ai && data.ai.checkedAt) || data.generatedAt || new Date().toISOString()
    },
    manualValidation: {
      memoryInsertPassed: passed ? true : manual.memoryInsertPassed === true,
      diagnosticsCopied: manual.diagnosticsCopied !== false,
      siteInputStillWorks: passed ? true : manual.siteInputStillWorks === true,
      browser: argValue(args, '--browser') || manual.browser || '填写浏览器名称和版本',
      notes: argValue(args, '--notes') || manual.notes || '填写无隐私信息的验收备注'
    }
  };
}

function outputPath(data, args) {
  const explicit = argValue(args, '--out');
  if (explicit) return explicit;
  const date = new Date().toISOString().slice(0, 10);
  const provider = providerSlug(data.ai && data.ai.provider);
  return path.join(evidenceDir, `${date}-${provider}.json`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
  process.exit(0);
}

try {
  const data = normalizeEvidence(parseJson(readInput(args)), args);
  const out = outputPath(data, args);
  mkdirSync(path.dirname(out), { recursive: true });
  if (existsSync(out) && !args.includes('--force')) {
    throw new Error(`${out} already exists. Add --force or choose --out.`);
  }
  writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`AI validation evidence written: ${out}`);
  console.log(`provider: ${data.ai.provider || 'Unknown'}`);
  console.log(`manual pass flags: insert=${data.manualValidation.memoryInsertPassed}, diagnostics=${data.manualValidation.diagnosticsCopied}, input=${data.manualValidation.siteInputStillWorks}`);
} catch (err) {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
}
