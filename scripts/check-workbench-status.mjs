const apiPort = Number(process.env.III_REST_PORT || process.env.AGENTMEMORY_API_PORT || 3111);
const expectedViewerPort = Number(process.env.AGENTMEMORY_VIEWER_PORT || apiPort + 2);
const apiBase = `http://127.0.0.1:${apiPort}`;

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

async function fetchStatus(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

function printSummary(summary) {
  console.log('Agent Memory Lab workbench status');
  console.log(`API:    ${summary.api.url} -> ${summary.api.ok ? 'ok' : 'not reachable'}`);
  if (summary.api.status) console.log(`        HTTP ${summary.api.status}`);
  if (summary.api.version) console.log(`        version ${summary.api.version}`);
  console.log(`Viewer: ${summary.viewer.url} -> ${summary.viewer.ok ? 'ok' : 'not reachable'}`);
  if (summary.viewer.status) console.log(`        HTTP ${summary.viewer.status}`);
  if (summary.viewer.skipped) console.log('        viewerSkipped=true');
  console.log(`Demo:   ${summary.demo.url} -> ${summary.demo.ok ? 'ok' : 'not reachable'}`);
  if (summary.demo.status) console.log(`        HTTP ${summary.demo.status}`);
}

let health = null;
try {
  health = await fetchJson(`${apiBase}/agentmemory/health`);
} catch (err) {
  const summary = {
    api: { url: `${apiBase}/agentmemory/health`, ok: false, error: err && err.message ? err.message : String(err) },
    viewer: { url: `http://127.0.0.1:${expectedViewerPort}/#dashboard`, ok: false },
    demo: { url: `http://127.0.0.1:${expectedViewerPort}/demo/browser-extension.html`, ok: false }
  };
  printSummary(summary);
  console.log('Next: start the workbench with `npm run build && npm run start`, or check whether another process already uses the API port.');
  process.exit(1);
}

const body = health.body || {};
const viewerPort = Number(body.viewerPort || expectedViewerPort);
const viewerUrl = `http://127.0.0.1:${viewerPort}/#dashboard`;
const demoUrl = `http://127.0.0.1:${viewerPort}/demo/browser-extension.html`;
const viewer = await fetchStatus(`http://127.0.0.1:${viewerPort}/`);
const demo = await fetchStatus(demoUrl);

const summary = {
  api: { url: `${apiBase}/agentmemory/health`, ok: health.ok, status: health.status, version: body.version || '' },
  viewer: { url: viewerUrl, ok: viewer.ok && !body.viewerSkipped, status: viewer.status, skipped: !!body.viewerSkipped },
  demo: { url: demoUrl, ok: demo.ok && !body.viewerSkipped, status: demo.status }
};
printSummary(summary);

if (!summary.api.ok) {
  console.log('Next: the API port responded, but not as a healthy Agent Memory Lab service. Another process may be using the API port, or the workbench may need a restart.');
  process.exit(1);
}
if (body.viewerSkipped || !summary.viewer.ok) {
  console.log('Next: API is running, but the Viewer is not reachable. Another process may be using the viewer port; restart the workbench after freeing the port.');
  process.exit(1);
}
if (!summary.demo.ok) {
  console.log('Next: Viewer is reachable, but the plugin demo page is missing. Run `npm run build` and restart the workbench.');
  process.exit(1);
}

console.log(`Open: ${viewerUrl}`);
console.log(`Plugin demo: ${demoUrl}`);
