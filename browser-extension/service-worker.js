import { getSettings, authHeaders } from './config.js';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function collectPage() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error('没有可读取的当前页面');
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'AGENT_MEMORY_LAB_COLLECT_PAGE' });
    if (response && response.ok) return response.page;
  } catch {}
  return {
    title: tab.title || '当前页面',
    url: tab.url || '',
    host: tab.url ? new URL(tab.url).hostname : '',
    description: '',
    selection: '',
    headings: []
  };
}

async function api(path, options = {}) {
  const settings = await getSettings();
  const res = await fetch(`${settings.apiBase}${path}`, {
    ...options,
    headers: { ...authHeaders(settings), ...(options.headers || {}) }
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${res.status}`);
  return data;
}

async function savePageMemory() {
  const page = await collectPage();
  const selected = page.selection ? `\n\n选中文本：\n${page.selection}` : '';
  const headings = page.headings && page.headings.length ? `\n\n页面结构：${page.headings.join(' / ')}` : '';
  const content = `网页记忆线索：${page.title}\nURL：${page.url}\n摘要：${page.description || '无'}${selected}${headings}`;
  return api('/agentmemory/remember', {
    method: 'POST',
    body: JSON.stringify({
      content,
      concepts: ['browser-context', page.host].filter(Boolean),
      files: [],
      project: 'browser'
    })
  });
}

async function savePageLesson(note) {
  const page = await collectPage();
  return api('/agentmemory/lessons', {
    method: 'POST',
    body: JSON.stringify({
      content: note || `从网页 ${page.title} 提炼一条可复用经验`,
      context: `${page.title}\n${page.url}`,
      tags: ['browser', 'web-context'],
      project: 'browser',
      confidence: 0.75
    })
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'HEALTH') return api('/agentmemory/health', { method: 'GET' });
    if (message.type === 'COLLECT_PAGE') return collectPage();
    if (message.type === 'SAVE_PAGE_MEMORY') return savePageMemory();
    if (message.type === 'SAVE_PAGE_LESSON') return savePageLesson(message.note || '');
    throw new Error('未知操作');
  })().then((data) => sendResponse({ ok: true, data })).catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
