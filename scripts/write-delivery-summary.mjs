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

mkdirSync('artifacts', { recursive: true });

const pkg = readJson('package.json');
const manifest = readJson('browser-extension/manifest.json');
const releaseGates = read('docs/release-gates-cn.md');
const zipPath = 'artifacts/agent-memory-lab-extension.zip';
const generatedAt = new Date().toISOString();
const branch = git(['branch', '--show-current']) || 'unknown';
const commit = git(['rev-parse', '--short', 'HEAD']) || 'unknown';
const dirty = git(['status', '--short']).split(/\r?\n/).filter((line) => line && !line.startsWith('?? .learnings/') && !line.includes('index.html.bak-')).length > 0;
const zipSize = fileSize(zipPath);
const zipSha256 = sha256(zipPath);
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
    demoPage: {
      path: 'dist/viewer/demo/browser-extension.html',
      exists: existsSync('dist/viewer/demo/browser-extension.html')
    },
    screenshots: {
      dashboard: existsSync('docs/readme-assets/screenshots/dashboard.jpg'),
      skills: existsSync('docs/readme-assets/screenshots/skills.jpg')
    }
  },
  releaseState: {
    localDemo: 'ready',
    externalTesting: 'mostly-ready',
    publicRelease: 'not-ready',
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
| Demo page | ${existsSync('dist/viewer/demo/browser-extension.html') ? 'dist/viewer/demo/browser-extension.html' : 'missing'} |
| Dashboard screenshot | ${existsSync('docs/readme-assets/screenshots/dashboard.jpg') ? 'docs/readme-assets/screenshots/dashboard.jpg' : 'missing'} |
| Skills screenshot | ${existsSync('docs/readme-assets/screenshots/skills.jpg') ? 'docs/readme-assets/screenshots/skills.jpg' : 'missing'} |

## Release Gates

${extractGateTable(releaseGates)}

## Verification Commands

- \`npm run package:browser-extension\`
- \`npm run check:delivery\`
- \`npm run check:workbench\` when the full local workbench should be running

## Useful Links

- README: \`README.md\`
- External tester guide: \`docs/external-tester-guide-cn.md\`
- AI validation log: \`docs/browser-extension-ai-validation-cn.md\`
- Release gates: \`docs/release-gates-cn.md\`
- Feishu source: \`docs/feishu/agentmemory-project-intro-cn.md\`
`;

writeFileSync('artifacts/delivery-summary.md', summary);
writeFileSync('artifacts/delivery-manifest.json', `${JSON.stringify(deliveryManifest, null, 2)}\n`);
console.log('delivery summary: artifacts/delivery-summary.md');
console.log('delivery manifest: artifacts/delivery-manifest.json');
