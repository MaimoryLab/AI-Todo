const $ = (id) => document.getElementById(id);
const AI_SITE_TEST_CARDS_PATH = '/docs/browser-extension-ai-site-test-cards-cn.md';
let latestCapture = null;
let defaultDraft = { kind: 'memory', title: '', content: '', meta: {} };

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

async function send(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response || !response.ok) throw new Error((response && response.error) || '操作失败');
  return response.data;
}

function setMessage(text, kind = '') {
  $('message').textContent = text || '';
  $('message').className = `message ${kind}`.trim();
}

async function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function buildDiagnosticReport(capture) {
  const page = capture && capture.page ? capture.page : {};
  const diagnostics = capture && capture.diagnostics ? capture.diagnostics : {};
  const conversation = capture && capture.conversation ? capture.conversation : {};
  const manifest = chrome.runtime && chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  return {
    product: 'Agent Memory Lab Browser Extension',
    extension: {
      name: manifest.name || 'Agent Memory Lab',
      version: manifest.version || '',
      manifestVersion: manifest.manifest_version || 3
    },
    generatedAt: new Date().toISOString(),
    validationGuide: {
      title: '浏览器插件真实 AI 站点测试卡',
      path: AI_SITE_TEST_CARDS_PATH,
      requiredProducts: ['ChatGPT', 'Claude', 'Gemini', 'Perplexity']
    },
    page: {
      title: page.title || '',
      url: page.url || '',
      host: page.host || '',
      origin: page.origin || '',
      type: page.type || '',
      typeLabel: page.typeLabel || ''
    },
    ai: {
      supportedAiPage: !!diagnostics.supportedAiPage,
      provider: diagnostics.provider || conversation.provider || '',
      editorFound: !!diagnostics.editorFound,
      editorSelector: diagnostics.editorSelector || '',
      anchorFound: !!diagnostics.anchorFound,
      placement: diagnostics.placement || '',
      memoryWidgetVisible: !!diagnostics.memoryWidgetVisible,
      promptLength: diagnostics.promptLength || 0,
      turnCount: diagnostics.turnCount || 0,
      checkedAt: diagnostics.checkedAt || ''
    },
    manualValidation: {
      memoryInsertPassed: false,
      diagnosticsCopied: true,
      siteInputStillWorks: false,
      browser: '填写浏览器名称和版本',
      notes: '填写无隐私信息的验收备注'
    }
  };
}

function setConnectionState(state, text) {
  const card = $('connectionCard');
  card.className = `connection-card ${state}`;
  if (state === 'connected') {
    $('connectionTitle').textContent = '审阅队列可用';
    $('connectionText').textContent = text || '保存内容会先进入本地工作台，由你确认后再写入长期记忆。';
    $('connectionAction').textContent = '刷新';
    $('savePage').disabled = false;
    return;
  }
  if (state === 'offline') {
    $('connectionTitle').textContent = '本地工作台未连接';
    $('connectionText').textContent = text || '先启动 Agent Memory Lab，再把网页内容送去审阅。';
    $('connectionAction').textContent = '重试';
    $('savePage').disabled = true;
    return;
  }
  $('connectionTitle').textContent = '检查连接中';
  $('connectionText').textContent = '正在确认本地审阅队列是否可用。';
  $('connectionAction').textContent = '重试';
}

function renderCandidateList(node, items, kind) {
  if (!items || !items.length) {
    node.className = 'candidate-list empty';
    node.textContent = '暂无候选';
    return;
  }
  node.className = 'candidate-list';
  node.innerHTML = items.map((text) => `
    <article class="candidate">
      <p>${escapeHtml(text)}</p>
      <button data-draft-kind="${kind}" data-draft-text="${escapeHtml(text)}">填入草稿</button>
    </article>
  `).join('');
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

function buildDefaultDraft(capture) {
  const page = capture && capture.page ? capture.page : {};
  const memories = capture && capture.candidates && Array.isArray(capture.candidates.memories) ? capture.candidates.memories : [];
  const firstMemory = memories.find((item) => String(item || '').trim()) || '';
  const parts = [
    firstMemory || `网页线索：${page.title || '当前页面'}`,
    page.description ? `摘要：${page.description}` : '',
    page.selection ? `选中文本：${String(page.selection).slice(0, 600)}` : '',
    page.url ? `来源：${page.url}` : ''
  ].filter(Boolean);
  return {
    kind: 'memory',
    title: page.title || '浏览器记忆候选',
    content: parts.join('\n'),
    meta: buildDraftMetaFields(capture, 'memory')
  };
}

function draftMetaText(capture, kind) {
  const page = capture && capture.page ? capture.page : {};
  const provider = capture && capture.conversation && capture.conversation.provider ? capture.conversation.provider : '';
  const source = provider || page.typeLabel || page.host || '浏览器';
  const meta = getDraftMetaFields();
  const type = meta.asLesson || kind === 'lesson' ? '经验候选' : '记忆候选';
  const project = meta.projectScope === 'all' ? '全部项目' : `项目：${meta.project}`;
  const tags = meta.tags.length ? `标签：${meta.tags.join(', ')}` : '未加标签';
  const privacy = capture && capture.privacy && capture.privacy.risk === 'medium' ? '可能含敏感信息，建议先删改' : '保存后仍需在工作台确认';
  return `${source} · ${project} · ${tags} · ${type} · ${privacy}`;
}

function setDraft(draft, options = {}) {
  defaultDraft = options.defaultDraft ? draft : defaultDraft;
  $('draftTitle').value = draft.title || '';
  $('draftContent').value = draft.content || '';
  $('draftContent').dataset.kind = draft.kind || 'memory';
  setDraftMetaFields(draft.meta || buildDraftMetaFields(latestCapture, draft.kind || 'memory'));
  $('draftMeta').textContent = draftMetaText(latestCapture, draft.kind || 'memory');
}

function renderTurns(turns) {
  const chatSection = $('chatSection');
  if (!turns || !turns.length) {
    chatSection.hidden = true;
    return;
  }
  chatSection.hidden = false;
  $('turnCount').textContent = String(turns.length);
  $('turnList').innerHTML = turns.map((turn) => `
    <article class="turn">
      <div class="turn-label">${turn.role === 'user' ? '用户' : turn.role === 'assistant' ? 'AI' : '对话'}</div>
      <p>${escapeHtml(turn.text)}</p>
    </article>
  `).join('');
}

function renderDiagnostics(capture) {
  const diagnostics = capture && capture.diagnostics ? capture.diagnostics : {};
  const section = $('aiDiagnostics');
  if (!diagnostics.supportedAiPage) {
    section.hidden = true;
    $('copyDiagnostics').disabled = true;
    return;
  }
  section.hidden = false;
  $('copyDiagnostics').disabled = false;
  $('aiProvider').textContent = diagnostics.provider || 'AI 页面';
  const rows = [
    { label: '页面识别', value: diagnostics.provider || '已识别', ok: true },
    { label: '输入框', value: diagnostics.editorFound ? '已找到' : '未找到', ok: !!diagnostics.editorFound },
    { label: '入口锚点', value: diagnostics.anchorFound ? '已找到' : '未找到', ok: !!diagnostics.anchorFound },
    { label: '发送按钮', value: diagnostics.sendFound ? '已找到' : '未确认', ok: !!diagnostics.sendFound },
    { label: '入口位置', value: diagnostics.placement || '自动', ok: true },
    { label: '输入草稿', value: `${diagnostics.promptLength || 0} 字`, ok: true },
    { label: '最近对话', value: `${diagnostics.turnCount || 0} 条`, ok: true }
  ];
  const matched = diagnostics.matchedSelectors || {};
  if (matched.editor || diagnostics.editorSelector) rows.push({ label: '输入规则', value: matched.editor || diagnostics.editorSelector, ok: true });
  if (matched.anchor || diagnostics.anchorSelector) rows.push({ label: '锚点规则', value: [matched.anchor || diagnostics.anchorSelector, matched.anchorSource || diagnostics.anchorSource].filter(Boolean).join(' · '), ok: true });
  if (matched.adjacent || diagnostics.adjacentSelector) rows.push({ label: '相邻控件', value: matched.adjacent || diagnostics.adjacentSelector, ok: true });
  if (matched.send || diagnostics.sendSelector) rows.push({ label: '发送规则', value: matched.send || diagnostics.sendSelector, ok: true });
  if (matched.turn || diagnostics.turnSelector) rows.push({ label: '会话规则', value: `${matched.turn || diagnostics.turnSelector}${diagnostics.turnSelectorCount ? ` · ${diagnostics.turnSelectorCount} 个节点` : ''}`, ok: true });
  $('aiDiagnosticList').innerHTML = rows.map((row) => `
    <div class="diagnostic-row${row.ok ? '' : ' warn'}">
      <span>${escapeHtml(row.label)}</span>
      <strong>${escapeHtml(row.value)}</strong>
    </div>
  `).join('');
}

function renderRecent(items) {
  const node = $('recentList');
  if (!items || !items.length) {
    node.className = 'recent-list empty';
    node.textContent = '暂无记录';
    return;
  }
  node.className = 'recent-list';
  node.innerHTML = items.slice(0, 6).map((item) => `
    <article class="recent-item">
      <div class="recent-meta">${escapeHtml(item.typeLabel || item.host || '')} · ${item.kind === 'review' ? '待审阅' : item.kind === 'lesson' ? '经验' : '记忆'}</div>
      <div class="recent-title">${escapeHtml(item.title || '未命名页面')}</div>
    </article>
  `).join('');
}

function renderCapture(capture) {
  latestCapture = capture;
  const page = capture.page || {};
  $('pageType').textContent = page.typeLabel || '网页';
  $('pageTitle').textContent = page.title || '当前页面';
  $('pageUrl').textContent = page.url || '';
  const reasons = capture.privacy && capture.privacy.reasons ? capture.privacy.reasons : [];
  $('privacy').textContent = reasons.length ? reasons.join('、') : '隐私风险低';
  $('privacy').className = `privacy ${capture.privacy && capture.privacy.risk === 'medium' ? 'medium' : 'low'}`;
  const memories = capture.candidates && capture.candidates.memories ? capture.candidates.memories : [];
  const lessons = capture.candidates && capture.candidates.lessons ? capture.candidates.lessons : [];
  $('memoryCount').textContent = String(memories.length);
  $('lessonCount').textContent = String(lessons.length);
  renderCandidateList($('memoryCandidates'), memories, 'memory');
  renderCandidateList($('lessonCandidates'), lessons, 'lesson');
  setDraft(buildDefaultDraft(capture), { defaultDraft: true });
  renderDiagnostics(capture);
  renderTurns(capture.conversation && capture.conversation.turns ? capture.conversation.turns : []);
}

async function refresh() {
  setMessage('');
  setConnectionState('checking');
  try {
    const health = await send('HEALTH');
    $('status').textContent = health && health.status === 'ok' ? '本地工作台已连接' : '本地工作台可访问';
    setConnectionState('connected');
  } catch {
    $('status').textContent = '未连接本地工作台';
    setConnectionState('offline');
  }
  try {
    renderCapture(await send('COLLECT_PAGE'));
  } catch (err) {
    $('pageTitle').textContent = '无法读取当前页面';
    $('pageUrl').textContent = err.message || '';
  }
  try {
    renderRecent(await send('RECENT_CAPTURES'));
  } catch {
    renderRecent([]);
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-draft-kind]');
  if (!target) return;
  const kind = target.dataset.draftKind || 'memory';
  const page = latestCapture && latestCapture.page ? latestCapture.page : {};
  setDraft({
    kind,
    title: page.title || (kind === 'lesson' ? '经验候选' : '记忆候选'),
    content: target.dataset.draftText || '',
    meta: buildDraftMetaFields(latestCapture, kind)
  });
  setMessage('已填入审阅草稿');
});

$('refresh').addEventListener('click', refresh);
$('connectionAction').addEventListener('click', refresh);
$('copyDiagnostics').addEventListener('click', async () => {
  try {
    await copyText(JSON.stringify(buildDiagnosticReport(latestCapture), null, 2));
    setMessage('已复制诊断信息', 'ok');
  } catch (err) {
    setMessage(err.message || '复制失败', 'error');
  }
});
$('savePage').addEventListener('click', async () => {
  $('savePage').disabled = true;
  setMessage('正在加入待审阅...');
  try {
    const title = $('draftTitle').value.trim();
    const text = $('draftContent').value.trim();
    const meta = getDraftMetaFields();
    const kind = meta.asLesson ? 'lesson' : ($('draftContent').dataset.kind || 'memory');
    if (!text) throw new Error('先确认一条要送审的内容');
    await send('SAVE_CANDIDATE', { kind, title, text, meta });
    setMessage('页面已加入待审阅', 'ok');
    await refresh();
  } catch (err) {
    setMessage(err.message || '保存失败', 'error');
  } finally {
    $('savePage').disabled = false;
  }
});
$('resetDraft').addEventListener('click', () => {
  setDraft(defaultDraft);
  setMessage('已恢复为自动生成草稿');
});
$('draftProject').addEventListener('change', () => {
  $('draftMeta').textContent = draftMetaText(latestCapture, $('draftContent').dataset.kind || 'memory');
});
$('draftTags').addEventListener('input', () => {
  $('draftMeta').textContent = draftMetaText(latestCapture, $('draftContent').dataset.kind || 'memory');
});
$('draftAsLesson').addEventListener('change', () => {
  $('draftMeta').textContent = draftMetaText(latestCapture, $('draftContent').dataset.kind || 'memory');
});
$('openWorkbench').addEventListener('click', () => send('OPEN_VIEWER', { tab: 'dashboard' }).catch(() => {}));
$('openSkills').addEventListener('click', () => send('OPEN_VIEWER', { tab: 'lessons' }).catch(() => {}));
$('openTestCards').addEventListener('click', () => send('OPEN_VIEWER', { path: AI_SITE_TEST_CARDS_PATH }).catch(() => {}));

refresh();
