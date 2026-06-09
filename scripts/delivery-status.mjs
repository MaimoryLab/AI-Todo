import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function printStatus(label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'ready' : 'not-ready'}${detail ? ` (${detail})` : ''}`);
}

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

function hasTrackedChanges() {
  return git(['status', '--short'])
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => !line.startsWith('?? .learnings/') && !line.includes('index.html.bak-'));
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
const external = manifest.externalTesting || {};
const currentCommit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const artifactCommit = manifest.git?.commit || 'unknown';
const artifactStale = currentCommit !== 'unknown' && artifactCommit !== 'unknown' && currentCommit !== artifactCommit;
const trackedChangesPending = hasTrackedChanges();

function readyFromEntry(entry) {
  return !!(entry && entry.exists !== false && (entry.path || entry.command));
}

console.log('Agent Memory Lab delivery status');
console.log(`current commit: ${currentCommit}${trackedChangesPending ? ' (tracked changes pending)' : ''}`);
console.log(`artifact commit: ${artifactCommit}${artifactStale ? ' (stale; rerun npm run package:browser-extension)' : ''}`);
console.log(`extension: ${manifest.extension?.name || 'Agent Memory Lab'} ${manifest.extension?.version || ''}`.trim());
console.log(`zip: ${zipPath} (${zipBytes} bytes)`);
printStatus('local demo', release.localDemo === 'ready');
console.log(`external testing: ${release.externalTesting || 'not-ready'}`);
printStatus('review draft flow', !!(core.reviewDraft?.popup && core.reviewDraft?.sidePanel && core.reviewDraft?.savesToReviewQueue));
printStatus('tester entry', !!(core.externalTestingEntry?.popupVersionVisible && core.externalTestingEntry?.testerGuideUrl));
printStatus('zip tester checklist', readyFromEntry(external.zipLoadChecklist));
printStatus('feedback loop', !!(readyFromEntry(external.feedbackTemplate) && readyFromEntry(external.issueTemplate) && readyFromEntry(external.feedbackTriage)));
printStatus('AI evidence recorder', readyFromEntry(external.evidenceRecorder));
printStatus('AI site test cards', !!(readyFromEntry(external.aiSiteTestCards) && core.aiInputMemoryHint?.sidePanelTestCardsEntry && core.aiInputMemoryHint?.diagnosticValidationGuide));
printStatus('AI tester pack', readyFromEntry(external.aiValidationTesterPack) || readyFromEntry(manifest.artifacts?.aiValidationTesterPack));
console.log(`real site validation table: ${realSite.passedCount || 0}/${realSite.requiredCount || 4}`);
console.log(`real site evidence: ${evidence.passedCount || 0}/${evidence.requiredCount || 4}`);
printStatus('public release', release.publicRelease === 'ready' && evidence.publicReleaseReadyByEvidence);

const notPassed = realSite.evidenceNotPassed || evidence.notPassedRequired || realSite.notPassed || [];
if (notPassed.length) console.log(`next validation targets: ${notPassed.join(', ')}`);
if (release.publicRelease !== 'ready' || !evidence.publicReleaseReadyByEvidence) {
  console.log('next: collect real AI page diagnostics, run npm run check:ai-validation-evidence, then npm run sync:ai-validation-table.');
}
