export const DEFAULTS = {
  apiBase: 'http://localhost:3111',
  viewerBase: 'http://localhost:3113'
};

export async function getSettings() {
  const stored = await chrome.storage.sync.get(['apiBase', 'viewerBase', 'secret']);
  return {
    apiBase: stored.apiBase || DEFAULTS.apiBase,
    viewerBase: stored.viewerBase || DEFAULTS.viewerBase,
    secret: stored.secret || ''
  };
}

export function authHeaders(settings) {
  const headers = { 'Content-Type': 'application/json' };
  if (settings.secret) headers.Authorization = `Bearer ${settings.secret}`;
  return headers;
}
