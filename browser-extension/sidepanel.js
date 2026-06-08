const $ = (id) => document.getElementById(id);
let latestCapture = null;

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
  return {
    product: 'Agent Memory Lab Browser Extension',
    generatedAt: new Date().toISOString(),
    page: {
      title: page.title || '',
      url: page.url || '',
      host: page.host || '',
      type: page.type || '',
      typeLabel: page.typeLabel || ''
    },
    ai: {
      supportedAiPage: !!diagnostics.supportedAiPage,
      provider: diagnostics.provider || conversation.provider || '',
      editorFound: !!diagnostics.editorFound,
      editorSelector: diagnostics.editorSelector || '',
      promptLength: diagnostics.promptLength || 0,
      turnCount: diagnostics.turnCount || 0
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
      <button data-save-kind="${kind}" data-save-text="${escapeHtml(text)}">送去审阅</button>
    </article>
  `).join('');
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
    { label: '输入草稿', value: `${diagnostics.promptLength || 0} 字`, ok: true },
    { label: '最近对话', value: `${diagnostics.turnCount || 0} 条`, ok: true }
  ];
  if (diagnostics.editorSelector) rows.push({ label: '命中规则', value: diagnostics.editorSelector, ok: true });
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
  const target = event.target.closest('[data-save-kind]');
  if (!target) return;
  target.disabled = true;
  setMessage('正在同步...');
  try {
    await send('SAVE_CANDIDATE', { kind: target.dataset.saveKind, text: target.dataset.saveText });
    setMessage('已加入待审阅队列', 'ok');
    await refresh();
  } catch (err) {
    setMessage(err.message || '同步失败', 'error');
  } finally {
    target.disabled = false;
  }
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
    await send('SAVE_PAGE_MEMORY');
    setMessage('页面已加入待审阅', 'ok');
    await refresh();
  } catch (err) {
    setMessage(err.message || '保存失败', 'error');
  } finally {
    $('savePage').disabled = false;
  }
});
$('openWorkbench').addEventListener('click', () => send('OPEN_VIEWER', { tab: 'dashboard' }).catch(() => {}));
$('openSkills').addEventListener('click', () => send('OPEN_VIEWER', { tab: 'lessons' }).catch(() => {}));

refresh();
