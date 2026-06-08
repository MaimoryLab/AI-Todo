import { existsSync, readFileSync, statSync } from 'node:fs';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function printStatus(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'ready' : 'not-ready'}${detail ? ` (${detail})` : ''}`);
}

const manifestPath = 'artifacts/delivery-manifest.json';
const evidencePath = 'artifacts/ai-validation-evidence-summary.json';
const zipPath = 'artifacts/agent-memory-lab-extension.zip';

if (!existsSync(manifestPath) || !existsSync(evidencePath) || !existsSync(zipPath)) {
  console.log('Agent Memory Lab delivery status');
  printStatus('delivery artifacts', false, 'run npm run package:browser-extension');
  process.exit(1);
}

const manifest = readJson(manifestPath);
const evidence = readJson(evidencePath);
const zipBytes = fileSize(zipPath);
const release = manifest.releaseState || {};
const realSite = release.realSiteValidation || {};
const core = manifest.coreExperience || {};

console.log('Agent Memory Lab delivery status');
console.log(`commit: ${manifest.git?.commit || 'unknown'}${manifest.git?.trackedChangesPending ? ' (tracked changes pending)' : ''}`);
console.log(`extension: ${manifest.extension?.name || 'Agent Memory Lab'} ${manifest.extension?.version || ''}`.trim());
console.log(`zip: ${zipPath} (${zipBytes} bytes)`);
printStatus('local demo', release.localDemo === 'ready');
console.log(`external testing: ${release.externalTesting || 'not-ready'}`);
printStatus('review draft flow', !!(core.reviewDraft?.popup && core.reviewDraft?.sidePanel && core.reviewDraft?.savesToReviewQueue));
printStatus('tester entry', !!(core.externalTestingEntry?.popupVersionVisible && core.externalTestingEntry?.testerGuideUrl));
console.log(`real site validation table: ${realSite.passedCount || 0}/${realSite.requiredCount || 4}`);
console.log(`real site evidence: ${evidence.passedCount || 0}/${evidence.requiredCount || 4}`);
printStatus('public release', release.publicRelease === 'ready' && evidence.publicReleaseReadyByEvidence);

const notPassed = realSite.evidenceNotPassed || evidence.notPassedRequired || realSite.notPassed || [];
if (notPassed.length) console.log(`next validation targets: ${notPassed.join(', ')}`);
if (release.publicRelease !== 'ready' || !evidence.publicReleaseReadyByEvidence) {
  console.log('next: collect real AI page diagnostics, run npm run check:ai-validation-evidence, then npm run sync:ai-validation-table.');
}
