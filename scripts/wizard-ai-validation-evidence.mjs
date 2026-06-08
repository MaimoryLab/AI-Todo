import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';

const evidenceDir = 'docs/validation/browser-extension-ai-sites';

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : '';
}

function readClipboard() {
  try {
    return execFileSync('pbpaste', { encoding: 'utf8' });
  } catch {
    throw new Error('Cannot read clipboard. Use --file diagnostics.json instead.');
  }
}

function readInput(args) {
  const file = argValue(args, '--file');
  if (file) return readFileSync(file, 'utf8');
  return readClipboard();
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

function yes(value) {
  return /^(y|yes|true|1|通过|是|成功|ok)$/i.test(String(value || '').trim());
}

async function askYesNo(rl, question, defaultYes = true) {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = await rl.question(`${question}${suffix}`);
  if (!answer.trim()) return defaultYes;
  return yes(answer);
}

async function askText(rl, question, fallback = '') {
  const answer = await rl.question(`${question}${fallback ? ` (${fallback})` : ''}: `);
  return answer.trim() || fallback;
}

function normalizeEvidence(data, answers) {
  const provider = answers.provider || data?.ai?.provider || data?.page?.host || 'Unknown';
  const generatedAt = data.generatedAt || new Date().toISOString();
  return {
    product: data.product || 'Agent Memory Lab Browser Extension',
    extension: data.extension || {},
    generatedAt,
    page: data.page || {},
    ai: {
      ...(data.ai || {}),
      provider,
      checkedAt: (data.ai && data.ai.checkedAt) || generatedAt
    },
    manualValidation: {
      memoryInsertPassed: answers.memoryInsertPassed,
      diagnosticsCopied: answers.diagnosticsCopied,
      siteInputStillWorks: answers.siteInputStillWorks,
      browser: answers.browser,
      notes: answers.notes
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

function printUsage() {
  console.log(`Usage:
  npm run wizard:ai-validation-evidence
  npm run wizard:ai-validation-evidence -- --file diagnostics.json
  npm run wizard:ai-validation-evidence -- --file diagnostics.json --yes --browser "Chrome 版本号" --notes "无隐私备注"

The wizard reads copied side-panel diagnostics, asks for manual pass checks,
and writes docs/validation/browser-extension-ai-sites/YYYY-MM-DD-provider.json.`);
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

async function collectAnswers(diagnostic) {
  const detectedProvider = diagnostic?.ai?.provider || diagnostic?.page?.host || 'Unknown';
  const providerFromArgs = argValue(args, '--provider');
  const browserFromArgs = argValue(args, '--browser');
  const notesFromArgs = argValue(args, '--notes');
  if (args.includes('--yes') || args.includes('--pass')) {
    return {
      provider: providerFromArgs || detectedProvider,
      diagnosticsCopied: true,
      memoryInsertPassed: true,
      siteInputStillWorks: true,
      browser: browserFromArgs || 'Chrome / Edge version',
      notes: notesFromArgs || 'No private chat content included'
    };
  }
  const rl = createInterface({ input, output });
  try {
    console.log(`Detected provider: ${detectedProvider}`);
    console.log(`Page: ${diagnostic?.page?.url || 'Unknown URL'}`);
    const provider = await askText(rl, 'Provider name', providerFromArgs || detectedProvider);
    const diagnosticsCopied = await askYesNo(rl, 'Did the side panel diagnostics copy successfully?', true);
    const memoryInsertPassed = await askYesNo(rl, 'Did inserting/copying a local memory work?', false);
    const siteInputStillWorks = await askYesNo(rl, 'Did the original AI site input and send flow still work?', false);
    const browser = await askText(rl, 'Browser and version', browserFromArgs || 'Chrome / Edge version');
    const notes = await askText(rl, 'Privacy-safe notes', notesFromArgs || 'No private chat content included');
    return { provider, diagnosticsCopied, memoryInsertPassed, siteInputStillWorks, browser, notes };
  } finally {
    rl.close();
  }
}

async function main() {
  const diagnostic = parseJson(readInput(args));
  const answers = await collectAnswers(diagnostic);
  const evidence = normalizeEvidence(diagnostic, answers);
  const out = outputPath(evidence, args);
  if (existsSync(out) && !args.includes('--force')) {
    throw new Error(`${out} already exists. Add --force or choose --out.`);
  }
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`AI validation evidence written: ${out}`);
  console.log('Next: npm run check:ai-validation-evidence && npm run sync:ai-validation-table');
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exitCode = 1;
});
