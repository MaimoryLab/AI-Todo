import { getSettings } from './config.js';
import { buildBrowserLessonDraft, buildBrowserMemoryDraft } from './shared/schema.js';

const $ = (id) => document.getElementById(id);
const EXTERNAL_TESTER_GUIDE_URL = 'https://github.com/sznnnnn/agentmemory-lab/blob/szn-viewer-ui-iteration/docs/external-tester-guide-cn.md';
let settings = await getSettings();
let latestCapture = null;
let defaultDraft = { title: '', content: '', meta: {} };

function renderVersion() {
  const manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  $('versionInfo').textContent = `Extension v${manifest.version || '0.1.0'}`;
}

function setMessage(text, kind = '') {
  $('message').textContent = text || '';
  $('message').className = `message ${kind}`.trim();
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || !response.ok) throw new Error((response && response.error) || '操作失败');
  return response.data;
}

function renderPage(capture) {
  const page = capture && capture.page ? capture.page : capture;
  $('pageTitle').textContent = page.title || '当前页面';
  $('pageUrl').textContent = page.url || '';
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

function buildDraftMetaFields(capture, kind = 'memory') {
  const page = capture && capture.page ? capture.page : {};
  const provider = capture && capture.conversation && capture.conversation.provider ? capture.conversation.provider : '';
  const typeLabel = String(page.typeLabel || '').trim();
  const tags = ['browser', provider ? provider.toLowerCase() : '', typeLabel ? typeLabel.toLowerCase() : '', kind === 'lesson' ? 'lesson' : 'memory'];
  return {
    projectScope: provider ? 'page' : 'all',
    project: provider || page.host || 'browser',
    tags: normalizeTags(tags.join(', ')),
    asLesson: kind === 'lesson'
  };
}

function setDraftMetaFields(meta = {}) {
  $('draftProject').value = meta.projectScope === 'page' ? 'page' : 'all';
  $('draftTags').value = normalizeTags(meta.tags || '').join(', ');
  $('draftAsLesson').checked = !!meta.asLesson;
}

function getDraftMetaFields() {
  const page = latestCapture && latestCapture.page ? latestCapture.page : {};
  const provider = latestCapture && latestCapture.conversation && latestCapture.conversation.provider ? latestCapture.conversation.provider : '';
  const projectScope = $('draftProject').value === 'page' ? 'page' : 'all';
  return {
    projectScope,
    project: projectScope === 'page' ? (provider || page.host || 'browser') : 'all',
    tags: normalizeTags($('draftTags').value),
    asLesson: $('draftAsLesson').checked
  };
}

function buildDraft(capture) {
  const draft = buildBrowserMemoryDraft(capture);
  return {
    title: draft.title || '浏览器记忆候选',
    content: draft.content,
    meta: buildDraftMetaFields(capture, 'memory')
  };
}

function renderDraft(capture) {
  latestCapture = capture;
  defaultDraft = buildDraft(capture);
  $('draftTitle').value = defaultDraft.title;
  $('draftContent').value = defaultDraft.content;
  setDraftMetaFields(defaultDraft.meta);
  renderDraftMeta(capture);
}

function renderDraftMeta(capture) {
  const page = capture && capture.page ? capture.page : {};
  const provider = capture && capture.conversation && capture.conversation.provider ? capture.conversation.provider : '';
  const type = provider || page.typeLabel || page.host || '浏览器';
  const risk = capture && capture.privacy && capture.privacy.risk === 'medium' ? '可能含敏感信息，建议先删改' : '保存后仍需在工作台确认';
  const meta = getDraftMetaFields();
  const scope = meta.projectScope === 'all' ? '以后都能用' : '只和这个网页相关';
  const notes = meta.tags.length ? `已加备注：${meta.tags.join('、')}` : '还没有分类备注';
  const kind = meta.asLesson ? '会整理成经验' : '会保存为记忆';
  $('draftMeta').textContent = `${type} · ${scope} · ${notes} · ${kind} · ${risk}`;
}

function renderRecent(items) {
  if (!items || !items.length) {
    $('recentList').textContent = '暂无记录';
    return;
  }
  $('recentList').innerHTML = items.slice(0, 4).map((item) => `
    <div class="recent-item">
      <div class="recent-title">${escapeHtml(item.title || '未命名页面')}</div>
      <div class="recent-meta">${item.kind === 'review' ? '待确认' : item.kind === 'lesson' ? '经验' : '记忆'} · ${escapeHtml(item.host || '')}</div>
    </div>
  `).join('');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

async function refreshRecent() {
  try {
    renderRecent(await send('RECENT_CAPTURES'));
  } catch {
    renderRecent([]);
  }
}

async function refresh() {
  try {
    const health = await send('HEALTH');
    $('status').textContent = health && health.status === 'ok' ? '本地工作台已连接' : '本地工作台可访问';
    $('trialText').textContent = '保存内容会先放进本地工作台，你确认后才会变成长期记忆。';
  } catch {
    $('status').textContent = '未连接本地工作台';
    $('trialText').textContent = '先启动 Agent Memory Lab 工作台，再保存网页内容。';
  }

  try {
    const capture = await send('COLLECT_PAGE');
    renderPage(capture);
    renderDraft(capture);
  } catch (err) {
    $('pageTitle').textContent = '无法读取当前页面';
    $('pageUrl').textContent = err.message || '';
    $('draftTitle').value = '';
    $('draftContent').value = '';
    setDraftMetaFields({ projectScope: 'all', tags: [], asLesson: false });
    $('draftMeta').textContent = '当前页面不可读取';
  }

  await refreshRecent();
}

$('saveMemory').addEventListener('click', async () => {
  $('saveMemory').disabled = true;
  setMessage('正在加入待确认...');
  try {
    const text = $('draftContent').value.trim();
    const title = $('draftTitle').value.trim();
    if (!text) throw new Error('先确认一条要保存的记忆内容');
    const meta = getDraftMetaFields();
    await send('SAVE_CANDIDATE', { kind: meta.asLesson ? 'lesson' : 'memory', title, text, meta });
    await refreshRecent();
    setMessage('已加入工作台，稍后确认即可保存', 'ok');
  } catch (err) {
    setMessage(err.message || '保存失败', 'error');
  } finally {
    $('saveMemory').disabled = false;
  }
});

$('resetDraft').addEventListener('click', () => {
  $('draftTitle').value = defaultDraft.title || '';
  $('draftContent').value = defaultDraft.content || '';
  setDraftMetaFields(defaultDraft.meta || {});
  renderDraftMeta(latestCapture);
  setMessage('已恢复为自动整理的内容');
});

$('draftProject').addEventListener('change', () => renderDraftMeta(latestCapture));
$('draftTags').addEventListener('input', () => renderDraftMeta(latestCapture));
$('draftAsLesson').addEventListener('change', () => renderDraftMeta(latestCapture));
$('draftAsLesson').addEventListener('change', () => {
  if (!$('draftAsLesson').checked || !latestCapture) return;
  const draft = buildBrowserLessonDraft(latestCapture);
  $('draftTitle').value = draft.title || '经验候选';
  $('draftContent').value = draft.content || '';
  renderDraftMeta(latestCapture);
});

$('saveLesson').addEventListener('click', async () => {
  const note = $('lessonNote').value.trim();
  if (!note) return setMessage('先写一条可以复用的经验', 'error');
  $('saveLesson').disabled = true;
  setMessage('正在加入待确认...');
  try {
    await send('SAVE_PAGE_LESSON', { note });
    $('lessonNote').value = '';
    await refreshRecent();
    setMessage('已加入工作台，稍后确认即可保存', 'ok');
  } catch (err) {
    setMessage(err.message || '保存失败', 'error');
  } finally {
    $('saveLesson').disabled = false;
  }
});

$('openWorkbench').addEventListener('click', () => send('OPEN_VIEWER', { tab: 'memories' }).catch(() => chrome.tabs.create({ url: `${settings.viewerBase}/#memories` })));
$('openSkills').addEventListener('click', () => send('OPEN_VIEWER', { tab: 'lessons' }).catch(() => chrome.tabs.create({ url: `${settings.viewerBase}/#lessons` })));
$('openGuide').addEventListener('click', () => chrome.tabs.create({ url: EXTERNAL_TESTER_GUIDE_URL }));
$('openSidePanel').addEventListener('click', async () => {
  const win = await chrome.windows.getCurrent();
  await send('OPEN_SIDE_PANEL', { windowId: win.id });
  window.close();
});
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

renderVersion();
refresh();
