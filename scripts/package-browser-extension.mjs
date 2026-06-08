import { existsSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const outDir = 'artifacts/browser-extension';
const zipPath = 'artifacts/agent-memory-lab-extension.zip';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function sha256(path) {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function writePackageManifest(targetDir) {
  const manifest = readJson('browser-extension/manifest.json');
  const delivery = existsSync('artifacts/delivery-manifest.json') ? readJson('artifacts/delivery-manifest.json') : null;
  const evidence = existsSync('artifacts/ai-validation-evidence-summary.json') ? readJson('artifacts/ai-validation-evidence-summary.json') : null;
  const commit = git(['rev-parse', '--short', 'HEAD']) || (delivery && delivery.git && delivery.git.commit) || 'unknown';
  const branch = git(['branch', '--show-current']) || (delivery && delivery.git && delivery.git.branch) || 'unknown';
  const required = evidence && evidence.requiredCount ? evidence.requiredCount : 4;
  const passed = evidence && Number.isFinite(Number(evidence.passedCount)) ? Number(evidence.passedCount) : 0;
  const missing = evidence && Array.isArray(evidence.notPassedRequired) ? evidence.notPassedRequired : ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'];
  const text = `# Agent Memory Lab Extension Package

Generated: ${new Date().toISOString()}

## Version

- Extension: ${manifest.name} ${manifest.version}
- Branch: ${branch}
- Commit: ${commit}

## What This Package Is

This zip is for local external testing. It is not a Chrome Web Store public release.

Use it to verify:

- The extension loads in Chrome / Edge developer mode.
- Memory suggestions appear near supported AI input boxes.
- Candidate memories can be edited before they enter the local review queue.
- AI-page diagnostics and evidence commands can be copied from the side panel.

## First Steps

1. Read \`LOAD-THIS-FIRST.md\`.
2. Load this \`browser-extension/\` folder from \`chrome://extensions\`.
3. Open \`http://localhost:3113/demo/browser-extension.html\`.
4. Try the side panel and confirm the review draft can be edited.
5. For real AI sites, follow \`AI-SITE-TEST-CARDS.md\`.

## Real AI Evidence Status

- Required products: ChatGPT, Claude, Gemini, Perplexity
- Passed evidence: ${passed}/${required}
- Still needed: ${missing.length ? missing.join(', ') : 'none'}

Public release remains blocked until all required products have reproducible real-page evidence.

## Evidence Flow

On each real AI page:

1. Open the extension side panel.
2. Click \`复制诊断\`.
3. Click \`复制向导\`.
4. Paste and run the copied wizard command from the repository root.
5. Mark the three manual checks as passed only after memory insertion/copy, diagnostics copy, and original site input all work.

Passing evidence must include \`matchedSelectors.editor\`, \`matchedSelectors.anchor\`, \`matchedSelectors.send\`, and \`matchedSelectors.turn\`.

## Privacy

Before sharing diagnostics, remove private prompt text, conversation snippets, account details, and sensitive page titles. Keep the non-sensitive \`ai\` selector/status fields and \`manualValidation\` result so site issues can be reproduced.
`;
  writeFileSync(`${targetDir}/PACKAGE-MANIFEST.md`, text);
}

rmSync(outDir, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync('artifacts', { recursive: true });

const copy = spawnSync('ditto', ['browser-extension', outDir], { stdio: 'inherit' });
if (copy.status !== 0) throw new Error('Failed to copy browser-extension.');

writePackageManifest(outDir);

for (const name of ['.DS_Store', '__MACOSX']) {
  rmSync(`${outDir}/${name}`, { recursive: true, force: true });
}

const zip = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', outDir, zipPath], { stdio: 'inherit' });
if (zip.status !== 0) throw new Error('Failed to package browser extension zip.');
if (!existsSync(zipPath)) throw new Error('Extension zip was not created.');

console.log(`browser extension package: ${zipPath}`);
console.log(`browser extension package sha256: ${sha256(zipPath)}`);
console.log(`browser extension package bytes: ${statSync(zipPath).size}`);
