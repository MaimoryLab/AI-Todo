import { startViewerServer } from '../src/viewer/server.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForListening(server) {
  return new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

async function fetchText(base, path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers: { Accept: '*/*', ...headers } });
  const text = await res.text();
  assert(res.ok, `${path} returned HTTP ${res.status}: ${text.slice(0, 160)}`);
  return { res, text };
}

const server = startViewerServer(0, {}, {}, undefined, 0);
try {
  await waitForListening(server);
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  assert(port > 0, 'Viewer test server did not expose a port.');
  const base = `http://127.0.0.1:${port}`;

  const dashboard = await fetchText(base, '/');
  for (const marker of ['renderDeliveryStatusCard', '/docs/browser-extension-ai-site-test-cards-cn.md', 'delivery-status']) {
    assert(dashboard.text.includes(marker), `Viewer dashboard response missing ${marker}.`);
  }

  const delivery = await fetchText(base, '/agentmemory/delivery-status', { Accept: 'application/json' });
  const data = JSON.parse(delivery.text);
  assert(data.available === true, 'Delivery status endpoint must see generated artifacts.');
  assert(data.localDemo === 'ready', 'Delivery status endpoint must expose local demo readiness.');
  assert(data.externalTesting === 'mostly-ready', 'Delivery status endpoint must expose external testing state.');
  assert(data.publicRelease === 'not-ready', 'Delivery status endpoint must not mark public release ready without real site evidence.');
  assert(data.realSiteValidation && data.realSiteValidation.requiredCount === 4, 'Delivery status endpoint must expose required AI site count.');

  const cards = await fetchText(base, '/docs/browser-extension-ai-site-test-cards-cn.md');
  assert((cards.res.headers.get('content-type') || '').includes('text/markdown'), 'AI site test cards must be served as markdown.');
  for (const marker of ['真实 AI 站点测试卡', 'ChatGPT', 'Claude', 'Gemini', 'Perplexity']) {
    assert(cards.text.includes(marker), `AI site test card response missing ${marker}.`);
  }

  const demo = await fetchText(base, '/demo/browser-extension.html');
  assert(demo.text.includes('Agent Memory Demo'), 'Browser extension demo route must remain available.');

  console.log('viewer delivery runtime checks ok');
} finally {
  await new Promise((resolve) => server.close(resolve));
}
