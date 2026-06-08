import { createCaptureRecord, createPageCapture, captureToLessonPayload, captureToMemoryPayload, buildBrowserLessonDraft, buildBrowserMemoryDraft } from './shared/schema.js';
import { agentMemoryApi, openViewer } from './shared/api.js';

const RECENT_KEY = 'recentCaptures';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function collectPage() {
  const tab = await getActiveTab();
  if (!tab || !tab.id) throw new Error('没有可读取的当前页面');
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'AGENT_MEMORY_LAB_COLLECT_PAGE' });
    if (response && response.ok) return createPageCapture(response.page);
  } catch {}
  return createPageCapture({
    title: tab.title || '当前页面',
    url: tab.url || '',
    description: '',
    selection: '',
    headings: []
  });
}

async function collectPageFromContext(info = {}, tab = null) {
  let capture = null;
  try {
    if (tab && tab.id) {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'AGENT_MEMORY_LAB_COLLECT_PAGE' });
      if (response && response.ok) capture = createPageCapture(response.page);
    }
  } catch {}
  if (!capture) {
    capture = createPageCapture({
      title: (tab && tab.title) || '当前页面',
      url: info.pageUrl || (tab && tab.url) || '',
      description: '',
      selection: '',
      headings: []
    });
  }
  const selection = String(info.selectionText || '').trim();
  const linkUrl = String(info.linkUrl || '').trim();
  if (selection || linkUrl) {
    capture = createPageCapture({
      ...capture.page,
      selection: selection || capture.page.selection,
      description: capture.page.description,
      headings: capture.page.headings,
      aiProvider: capture.conversation && capture.conversation.provider,
      promptDraft: capture.conversation && capture.conversation.promptDraft,
      turns: capture.conversation && capture.conversation.turns,
      diagnostics: capture.diagnostics,
      url: info.pageUrl || capture.page.url
    });
    capture.context = {
      kind: selection ? 'selection' : 'link',
      selection,
      linkUrl
    };
  }
  return capture;
}

async function rememberRecent(capture, kind, result) {
  const stored = await chrome.storage.local.get([RECENT_KEY]);
  const list = Array.isArray(stored[RECENT_KEY]) ? stored[RECENT_KEY] : [];
  const next = [createCaptureRecord(capture, kind, result), ...list].slice(0, 8);
  await chrome.storage.local.set({ [RECENT_KEY]: next });
  return next;
}

function normalizeTags(tags) {
  const seen = new Set();
  return String(Array.isArray(tags) ? tags.join(',') : tags || '')
    .split(/[,，\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeCandidateMeta(meta = {}, capture = null, kind = 'memory') {
  const page = capture && capture.page ? capture.page : {};
  const provider = capture && capture.conversation && capture.conversation.provider ? capture.conversation.provider : '';
  const projectScope = meta.projectScope === 'page' ? 'page' : 'all';
  const project = projectScope === 'page' ? String(meta.project || provider || page.host || 'browser') : 'all';
  const baseTags = ['browser', kind === 'lesson' ? 'lesson' : 'memory'];
  if (provider) baseTags.push(provider.toLowerCase());
  if (page.type) baseTags.push(`page:${page.type}`);
  return {
    projectScope,
    project,
    tags: normalizeTags([...baseTags, ...normalizeTags(meta.tags || [])]),
    asLesson: !!meta.asLesson || kind === 'lesson'
  };
}

function applyCandidateMeta(payload, meta, capture, kind) {
  const normalized = normalizeCandidateMeta(meta, capture, kind);
  return {
    ...payload,
    project: normalized.project,
    projectScope: normalized.projectScope,
    tags: normalized.tags,
    asLesson: normalized.asLesson,
    concepts: normalizeTags([...(payload.concepts || []), ...normalized.tags])
  };
}

async function savePageMemory() {
  const capture = await collectPage();
  const payload = captureToMemoryPayload(capture);
  const result = await agentMemoryApi('/agentmemory/review', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'memory',
      title: capture.page.title,
      content: payload.content,
      source: 'browser-extension',
      page: capture.page,
      conversation: capture.conversation,
      payload
    })
  });
  await rememberRecent(capture, 'review', result);
  return { capture, result };
}

async function savePageLesson(note) {
  const capture = await collectPage();
  const payload = captureToLessonPayload(capture, note);
  const draft = buildBrowserLessonDraft(capture);
  const result = await agentMemoryApi('/agentmemory/review', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'lesson',
      title: draft.title || capture.page.title,
      content: payload.content,
      source: 'browser-extension',
      page: capture.page,
      conversation: capture.conversation,
      payload
    })
  });
  await rememberRecent(capture, 'review', result);
  return { capture, result };
}

async function saveCandidate(kind, text, title = '', meta = {}) {
  const capture = await collectPage();
  const trimmed = String(text || '').trim();
  const requestedKind = kind === 'lesson' || meta.asLesson ? 'lesson' : 'memory';
  const draft = requestedKind === 'lesson' ? buildBrowserLessonDraft(capture) : buildBrowserMemoryDraft(capture);
  const draftTitle = String(title || '').trim() || draft.title || capture.page.title;
  if (!trimmed) throw new Error('没有可保存的候选内容');
  if (requestedKind === 'lesson') {
    const payload = applyCandidateMeta(captureToLessonPayload(capture, trimmed), meta, capture, 'lesson');
    const result = await agentMemoryApi('/agentmemory/review', {
      method: 'POST',
      body: JSON.stringify({ kind: 'lesson', title: draftTitle, content: payload.content, source: 'browser-extension', page: capture.page, conversation: capture.conversation, payload, meta: payload })
    });
    await rememberRecent(capture, 'review', result);
    return { capture, result };
  }
  const payload = applyCandidateMeta({
    ...captureToMemoryPayload(capture),
    content: trimmed
  }, meta, capture, 'memory');
  const result = await agentMemoryApi('/agentmemory/review', {
    method: 'POST',
    body: JSON.stringify({ kind: 'memory', title: draftTitle, content: payload.content, source: 'browser-extension', page: capture.page, conversation: capture.conversation, payload, meta: payload })
  });
  await rememberRecent(capture, 'review', result);
  return { capture, result };
}

async function saveContextSelection(info = {}, tab = null) {
  const capture = await collectPageFromContext(info, tab);
  const selection = String(info.selectionText || capture.page.selection || '').trim();
  const linkUrl = String(info.linkUrl || '').trim();
  const title = selection ? `选中文本：${capture.page.title}` : `网页链接：${capture.page.title}`;
  const content = selection
    ? `浏览器选中文本候选：${selection}\n来源：${capture.page.title}\nURL：${capture.page.url}`
    : `浏览器链接候选：${linkUrl || capture.page.url}\n来源页面：${capture.page.title}\nURL：${capture.page.url}`;
  const basePayload = captureToMemoryPayload(capture);
  const payload = {
    ...basePayload,
    content,
    concepts: [
      ...basePayload.concepts,
      selection ? 'browser-context:selection' : 'browser-context:link'
    ]
  };
  const result = await agentMemoryApi('/agentmemory/review', {
    method: 'POST',
    body: JSON.stringify({
      kind: 'memory',
      title,
      content,
      source: selection ? 'browser-extension-selection' : 'browser-extension-link',
      page: capture.page,
      payload
    })
  });
  await rememberRecent(capture, 'review', result);
  return { capture, result };
}

async function getRecentCaptures() {
  const stored = await chrome.storage.local.get([RECENT_KEY]);
  return Array.isArray(stored[RECENT_KEY]) ? stored[RECENT_KEY] : [];
}

async function searchMemories(query) {
  const text = String(query || '').trim();
  if (text.length < 3) return { results: [] };
  return agentMemoryApi('/agentmemory/search', {
    method: 'POST',
    body: JSON.stringify({ query: text, limit: 5, format: 'compact', token_budget: 900 })
  });
}

async function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'save-page-memory',
      title: '保存到 Agent Memory Lab',
      contexts: ['page', 'selection', 'link']
    });
    chrome.contextMenus.create({
      id: 'open-workbench',
      title: '打开 Agent Memory Lab',
      contexts: ['action']
    });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-page-memory') {
    if (info.selectionText || info.linkUrl) saveContextSelection(info, tab).catch(() => {});
    else savePageMemory().catch(() => {});
  }
  if (info.menuItemId === 'open-workbench') openViewer('dashboard').catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'HEALTH') return agentMemoryApi('/agentmemory/health', { method: 'GET' });
    if (message.type === 'COLLECT_PAGE') return collectPage();
    if (message.type === 'RECENT_CAPTURES') return getRecentCaptures();
    if (message.type === 'SAVE_PAGE_MEMORY') return savePageMemory();
    if (message.type === 'SAVE_PAGE_LESSON') return savePageLesson(message.note || '');
    if (message.type === 'SAVE_CANDIDATE') return saveCandidate(message.kind || 'memory', message.text || '', message.title || '', message.meta || {});
    if (message.type === 'SEARCH_MEMORIES') return searchMemories(message.query || '');
    if (message.type === 'OPEN_SIDE_PANEL') return chrome.sidePanel.open({ windowId: message.windowId });
    if (message.type === 'OPEN_VIEWER') return openViewer(message.tab || 'dashboard', message.path || '');
    throw new Error('未知操作');
  })().then((data) => sendResponse({ ok: true, data })).catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
