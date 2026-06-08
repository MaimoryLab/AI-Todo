import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function sha256(path) {
  if (!existsSync(path)) return '';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function extractGateTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '| 状态 | 结论 | 证据 |');
  if (start < 0) return '';
  return lines.slice(start, start + 5).join('\n');
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

function validationPassed(row) {
  const passWords = ['通过', '已通过', 'pass', 'passed', 'ok'];
  return [row.provider, row.editor, row.hint, row.insert, row.diagnostics, row.result].every((value) => {
    const lower = String(value || '').toLowerCase();
    return passWords.some((word) => lower.includes(word));
  }) && row.date !== '-' && row.evidence !== '-';
}

mkdirSync('artifacts', { recursive: true });

const pkg = readJson('package.json');
const manifest = readJson('browser-extension/manifest.json');
const releaseGates = read('docs/release-gates-cn.md');
const aiValidation = read('docs/browser-extension-ai-validation-cn.md');
const zipPath = 'artifacts/agent-memory-lab-extension.zip';
const generatedAt = new Date().toISOString();
const branch = git(['branch', '--show-current']) || 'unknown';
const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const dirty = git(['status', '--short']).split(/\r?\n/).filter((line) => line && !line.startsWith('?? .learnings/') && !line.includes('index.html.bak-')).length > 0;
const zipSize = fileSize(zipPath);
const zipSha256 = sha256(zipPath);
const aiEvidenceSummaryPath = 'artifacts/ai-validation-evidence-summary.json';
const aiEvidenceSummary = existsSync(aiEvidenceSummaryPath) ? readJson(aiEvidenceSummaryPath) : null;
const requiredAiProducts = ['ChatGPT', 'Claude', 'Gemini', 'Perplexity'];
const aiRows = parseValidationRows(aiValidation);
const requiredAiRows = requiredAiProducts.map((product) => aiRows.find((row) => row.product === product)).filter(Boolean);
const passedAiRows = requiredAiRows.filter(validationPassed);
const missingAiProducts = requiredAiProducts.filter((product) => !requiredAiRows.some((row) => row.product === product));
const notPassedAiProducts = requiredAiRows.filter((row) => !validationPassed(row)).map((row) => row.product);
const deliveryManifest = {
  product: 'Agent Memory Lab',
  generatedAt,
  package: {
    name: pkg.name,
    version: pkg.version
  },
  extension: {
    name: manifest.name,
    version: manifest.version,
    manifestVersion: manifest.manifest_version
  },
  git: {
    branch,
    commit,
    trackedChangesPending: dirty
  },
  artifacts: {
    extensionZip: {
      path: zipPath,
      exists: existsSync(zipPath),
      bytes: zipSize,
      sha256: zipSha256
    },
    extensionFolder: {
      path: 'browser-extension/',
      exists: existsSync('browser-extension/manifest.json')
    },
    loadInstructions: {
      path: 'browser-extension/LOAD-THIS-FIRST.md',
      exists: existsSync('browser-extension/LOAD-THIS-FIRST.md')
    },
    demoPage: {
      path: 'dist/viewer/demo/browser-extension.html',
      exists: existsSync('dist/viewer/demo/browser-extension.html')
    },
    screenshots: {
      dashboard: existsSync('docs/readme-assets/screenshots/dashboard.jpg'),
      skills: existsSync('docs/readme-assets/screenshots/skills.jpg')
    }
  },
  coreExperience: {
    externalTestingEntry: {
      popupVersionVisible: true,
      popupLocalTestingStatusVisible: true,
      testerGuideUrl: 'https://github.com/sznnnnn/agentmemory-lab/blob/szn-viewer-ui-iteration/docs/external-tester-guide-cn.md'
    },
    reviewDraft: {
      popup: true,
      sidePanel: true,
      editableTitle: true,
      editableContent: true,
      candidateToDraft: true,
      savesToReviewQueue: true
    },
    aiInputMemoryHint: {
      localDemo: true,
      supportedSitesSource: 'browser-extension/shared/site-config.js',
      diagnosticsCopy: true
    },
    reviewQueue: {
      source: 'browser-extension',
      longTermWriteRequiresViewerReview: true
    }
  },
  releaseState: {
    localDemo: 'ready',
    externalTesting: 'mostly-ready',
    publicRelease: 'not-ready',
    realSiteValidation: {
      requiredProducts: requiredAiProducts,
      passed: passedAiRows.map((row) => row.product),
      notPassed: notPassedAiProducts,
      missingRows: missingAiProducts,
      passedCount: passedAiRows.length,
      requiredCount: requiredAiProducts.length,
      source: 'docs/browser-extension-ai-validation-cn.md',
      evidenceDirectory: 'docs/validation/browser-extension-ai-sites',
      evidenceSummary: aiEvidenceSummaryPath,
      evidencePassedCount: aiEvidenceSummary ? aiEvidenceSummary.passedCount : 0,
      evidenceRequiredCount: aiEvidenceSummary ? aiEvidenceSummary.requiredCount : requiredAiProducts.length,
      evidenceNotPassed: aiEvidenceSummary ? aiEvidenceSummary.notPassedRequired : requiredAiProducts
    },
    publicReleaseBlockers: [
      'real AI site validation evidence',
      'public privacy policy URL',
      'non-sensitive store screenshots',
      'store review materials'
    ]
  },
  commands: [
    'npm run package:browser-extension',
    'npm run check:delivery',
    'npm run check:workbench'
  ]
};

const summary = `# Agent Memory Lab Delivery Summary

Generated: ${generatedAt}

## Version

| Item | Value |
| --- | --- |
| Package | ${pkg.name}@${pkg.version} |
| Extension | ${manifest.name} ${manifest.version} |
| Branch | ${branch} |
| Commit | ${commit}${dirty ? ' (tracked changes pending)' : ''} |

## Artifacts

| Artifact | Status |
| --- | --- |
| Extension zip | ${existsSync(zipPath) ? `${zipPath} (${zipSize} bytes)` : 'missing'} |
| Extension zip sha256 | ${zipSha256 || 'missing'} |
| Delivery manifest | artifacts/delivery-manifest.json |
| Extension source folder | ${existsSync('browser-extension/manifest.json') ? 'browser-extension/' : 'missing'} |
| Zip load instructions | ${existsSync('browser-extension/LOAD-THIS-FIRST.md') ? 'browser-extension/LOAD-THIS-FIRST.md' : 'missing'} |
| Demo page | ${existsSync('dist/viewer/demo/browser-extension.html') ? 'dist/viewer/demo/browser-extension.html' : 'missing'} |
| Dashboard screenshot | ${existsSync('docs/readme-assets/screenshots/dashboard.jpg') ? 'docs/readme-assets/screenshots/dashboard.jpg' : 'missing'} |
| Skills screenshot | ${existsSync('docs/readme-assets/screenshots/skills.jpg') ? 'docs/readme-assets/screenshots/skills.jpg' : 'missing'} |

## Core Experience

| Capability | Status |
| --- | --- |
| Popup version and tester guide entry | ready |
| Popup editable review draft | ready |
| Side panel editable review draft | ready |
| Candidate-to-draft flow | ready |
| Save to Viewer review queue | ready |
| Local AI input memory hint demo | ready |
| Real AI site validation | ${passedAiRows.length}/${requiredAiProducts.length} passed |

## Release Gates

${extractGateTable(releaseGates)}

## Real AI Site Validation

| Item | Value |
| --- | --- |
| Required products | ${requiredAiProducts.join(', ')} |
| Passed | ${passedAiRows.length}/${requiredAiProducts.length} |
| Not passed | ${notPassedAiProducts.length ? notPassedAiProducts.join(', ') : 'none'} |
| Missing rows | ${missingAiProducts.length ? missingAiProducts.join(', ') : 'none'} |
| Source | docs/browser-extension-ai-validation-cn.md |
| Evidence directory | docs/validation/browser-extension-ai-sites |
| Evidence summary | ${existsSync(aiEvidenceSummaryPath) ? aiEvidenceSummaryPath : 'generated by npm run check:ai-validation-evidence'} |
| Evidence passed | ${aiEvidenceSummary ? `${aiEvidenceSummary.passedCount}/${aiEvidenceSummary.requiredCount}` : '0/4'} |

## Verification Commands

- \`npm run package:browser-extension\`
- \`npm run check:delivery\`
- \`npm run status:delivery\`
- \`npm run check:ai-validation-evidence\`
- \`npm run check:workbench\` when the full local workbench should be running

## Useful Links

- README: \`README.md\`
- External tester guide: \`docs/external-tester-guide-cn.md\`
- External feedback template: \`docs/external-feedback-template-cn.md\`
- External feedback triage: \`docs/external-feedback-triage-cn.md\`
- AI validation log: \`docs/browser-extension-ai-validation-cn.md\`
- Release gates: \`docs/release-gates-cn.md\`
- Feishu source: \`docs/feishu/agentmemory-project-intro-cn.md\`
`;

writeFileSync('artifacts/delivery-summary.md', summary);
writeFileSync('artifacts/delivery-manifest.json', `${JSON.stringify(deliveryManifest, null, 2)}\n`);
console.log('delivery summary: artifacts/delivery-summary.md');
console.log('delivery manifest: artifacts/delivery-manifest.json');
