import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DELIVERY_REMOTE = process.env.AGENTMEMORY_DELIVERY_REMOTE || 'company';
const DELIVERY_REMOTE_URL = 'https://github.com/novitalabs/agentmemory-lab.git';
const REQUIRED_BRANCH = 'szn-viewer-ui-iteration';
const DELIVERY_PR_BRANCH = process.env.AGENTMEMORY_DELIVERY_PR_BRANCH || 'codex/diagnostic-privacy-20260609';

function runGit(args, options = {}) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    if (options.optional) return '';
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hasTrackedChanges() {
  return runGit(['status', '--short'])
    .split(/\r?\n/)
    .filter(Boolean)
    .some((line) => !line.startsWith('?? .learnings/') && !line.includes('index.html.bak-'));
}

const manifestPath = 'artifacts/delivery-manifest.json';
const evidencePath = 'artifacts/ai-validation-evidence-summary.json';
const zipPath = 'artifacts/agent-memory-lab-extension.zip';

assert(existsSync(manifestPath), `Missing ${manifestPath}. Run npm run package:browser-extension first.`);
assert(existsSync(evidencePath), `Missing ${evidencePath}. Run npm run check:ai-validation-evidence first.`);
assert(existsSync(zipPath), `Missing ${zipPath}. Run npm run package:browser-extension first.`);

const branch = runGit(['branch', '--show-current']);
const head = runGit(['rev-parse', 'HEAD']);
const shortHead = runGit(['rev-parse', '--short', 'HEAD']);
const remoteUrl = runGit(['remote', 'get-url', DELIVERY_REMOTE]);
const remoteRef = runGit(['ls-remote', DELIVERY_REMOTE, `refs/heads/${branch}`], { optional: true });
const prRef = runGit(['ls-remote', DELIVERY_REMOTE, `refs/heads/${DELIVERY_PR_BRANCH}`], { optional: true });
const manifest = readJson(manifestPath);
const evidence = readJson(evidencePath);
const artifactCommit = manifest.git?.commit || '';
const deliveredDirectly = remoteRef.startsWith(head);
const deliveredByPr = prRef.startsWith(head);

assert(branch === REQUIRED_BRANCH, `Expected branch ${REQUIRED_BRANCH}, got ${branch || 'unknown'}.`);
assert(remoteUrl === DELIVERY_REMOTE_URL, `Delivery remote ${DELIVERY_REMOTE} must point to ${DELIVERY_REMOTE_URL}, got ${remoteUrl || 'missing'}.`);
assert(deliveredDirectly || deliveredByPr, `Delivery remote does not contain current commit ${shortHead}. Push to ${DELIVERY_REMOTE}/${branch} or PR branch ${DELIVERY_REMOTE}/${DELIVERY_PR_BRANCH}.`);
assert(artifactCommit === shortHead, `Delivery artifact commit is ${artifactCommit || 'missing'}, expected ${shortHead}. Run npm run package:browser-extension.`);
assert(!hasTrackedChanges(), 'Tracked changes are pending. Commit or discard them before remote delivery.');

const release = manifest.releaseState || {};
assert(release.localDemo === 'ready', 'Local demo must be ready.');
assert(['ready', 'mostly-ready'].includes(release.externalTesting), 'External testing loop must be ready enough for remote delivery.');
assert((evidence.requiredCount || 4) === 4, 'AI validation evidence summary must track the four required AI products.');

if (release.publicRelease === 'ready' || evidence.publicReleaseReadyByEvidence) {
  assert((evidence.passedCount || 0) === (evidence.requiredCount || 4), 'Public release cannot be ready unless all required AI products passed evidence.');
} else {
  assert((evidence.passedCount || 0) < (evidence.requiredCount || 4), 'Public release is blocked, but evidence summary does not show missing required products.');
}

console.log('remote delivery checks ok');
console.log(`branch: ${branch}`);
console.log(`commit: ${shortHead}`);
console.log(`remote: ${DELIVERY_REMOTE} ${DELIVERY_REMOTE_URL}`);
console.log(`delivery path: ${deliveredDirectly ? `${DELIVERY_REMOTE}/${branch}` : `${DELIVERY_REMOTE}/${DELIVERY_PR_BRANCH} pull request`}`);
console.log(`external testing: ${release.externalTesting}`);
console.log(`public release: ${release.publicRelease || 'not-ready'} (${evidence.passedCount || 0}/${evidence.requiredCount || 4} real AI evidence)`);
