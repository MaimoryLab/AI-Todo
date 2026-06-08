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
  const matched = diagnostics.matchedSelectors || {};
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
      anchorSelector: diagnostics.anchorSelector || '',
      anchorSource: diagnostics.anchorSource || '',
      adjacentSelector: diagnostics.adjacentSelector || '',
      sendFound: !!diagnostics.sendFound,
      sendSelector: diagnostics.sendSelector || '',
      turnSelector: diagnostics.turnSelector || '',
      turnSelectorCount: diagnostics.turnSelectorCount || 0,
      matchedSelectors: {
        editor: matched.editor || diagnostics.editorSelector || '',
        anchor: matched.anchor || diagnostics.anchorSelector || '',
        anchorSource: matched.anchorSource || diagnostics.anchorSource || '',
        adjacent: matched.adjacent || diagnostics.adjacentSelector || '',
        send: matched.send || diagnostics.sendSelector || '',
        turn: matched.turn || diagnostics.turnSelector || ''
      },
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

function providerArg(value) {
  const provider = String(value || '').trim();
  return provider ? ` --provider "${provider.replace(/"/g, '\\"')}"` : '';
}

function buildEvidenceCommand(capture) {
  const diagnostics = capture && capture.diagnostics ? capture.diagnostics : {};
  const provider = diagnostics.provider || (capture && capture.conversation && capture.conversation.provider) || '';
  return `npm run wizard:ai-validation-evidence -- --clipboard${providerArg(provider)}`;
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

function cleanDraftText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncateText(text, limit = 180) {
  const value = cleanDraftText(text);
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function isUsefulFact(text) {
  if (!text || text.length < 6) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^(摘要|来源|URL|页面结构|网页记忆线索|浏览器候选记忆|浏览器候选经验|在\s*ChatGPT\s*中继续跟进)[:：]?/.test(text)) return false;
  if (/ChatGPT\s*是一款供日常使用的\s*AI\s*聊天机器人/i.test(text)) return false;
  return /(我|我的|我们|用户|希望|想要|需要|正在|计划|偏好|喜欢|不喜欢|不要|应该|必须|学习|备考|项目|产品|设计|插件|记忆|Skill|飞书|GitHub|雅思|IELTS)/i.test(text);
}

function splitFactSentences(text) {
  return String(text || '')
    .split(/[。！？!?\n]+/)
    .map(cleanDraftText)
    .filter(isUsefulFact)
    .filter((item) => item.length <= 220);
}

function uniqueTexts(items) {
  const seen = new Set();
  return items.map(cleanDraftText).filter(Boolean).filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildSourceNote(page) {
  const title = String(page.title || '当前页面').trim();
  const url = String(page.url || '').trim();
  return [title ? `来源页面：${title}` : '', url ? `来源链接：${url}` : ''].filter(Boolean).join('\n');
}

function buildMemoryDraft(capture) {
  const page = capture && capture.page ? capture.page : {};
  const conversation = capture && capture.conversation ? capture.conversation : {};
  const memories = capture && capture.candidates && Array.isArray(capture.candidates.memories) ? capture.candidates.memories : [];
  const fact = cleanDraftText(memories.find((item) => String(item || '').trim()) || `请从这个页面提炼一条具体事实：${page.title || '当前页面'}`);
  const provider = conversation.provider || page.typeLabel || page.host || '浏览器';
  return {
    title: fact.length > 42 ? `${fact.slice(0, 42)}...` : fact,
    content: [`候选事实：${fact}`, buildSourceNote(page), `来源类型：${provider}`].filter(Boolean).join('\n')
  };
}

function makeLessonFromEvidence(primary = '') {
  const text = cleanDraftText(primary);
  if (!text) return '';
  if (/(不要|不需要|看不懂|难以理解|太奇怪|太丑|加载.*慢|没懂)/.test(text)) return `界面经验：遇到用户反馈“${truncateText(text, 90)}”时，优先减少解释性/内部化元素，并把功能改成可直接理解的具体结果。`;
  if (/(自动|自己更新|基于.*聊天|对话记录|具体对话|提炼)/.test(text)) return '记忆经验：候选记忆和经验必须来自具体对话内容，先呈现可复用事实或结论，再把来源保留为上下文依据。';
  if (/(颜色|圆角|风格|卡片|排版|版式|icon|图标)/i.test(text)) return '设计经验：视觉调整要沿用既定风格，把颜色、圆角、图标和卡片层级统一到同一套界面语言里。';
  if (/(插件|浏览器|extension|网页|同步)/i.test(text)) return '产品经验：浏览器插件应作为网页到本地工作台的入口，保存具体事实并进入审阅，而不是只保存页面链接。';
  return `可沉淀经验：${truncateText(text, 160)}`;
}

function buildLessonDraft(capture, selectedText = '') {
  const page = capture && capture.page ? capture.page : {};
  const conversation = capture && capture.conversation ? capture.conversation : {};
  const turns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const userTurns = turns.filter((turn) => turn && turn.role === 'user').map((turn) => turn.text);
  const assistantTurns = turns.filter((turn) => turn && turn.role === 'assistant').map((turn) => turn.text);
  const evidence = uniqueTexts([
    ...splitFactSentences(page.selection),
    ...userTurns.flatMap(splitFactSentences),
    ...splitFactSentences(conversation.promptDraft),
    ...assistantTurns.flatMap(splitFactSentences)
  ]).slice(0, 3);
  const selected = isUsefulFact(selectedText) ? selectedText : '';
  const primary = selected || evidence[0] || '';
  if (!primary) {
    return {
      title: '需要具体对话后再提炼',
      content: '这段页面还没有读到足够的具体对话，暂时不能沉淀成经验。请先选择一段真实对话，或手动补充一句可复用结论。'
    };
  }
  const lesson = selected && /^(界面经验|记忆经验|设计经验|产品经验|可沉淀经验)[:：]/.test(selected) ? selected : makeLessonFromEvidence(primary);
  const lines = turns.slice(-4).map((turn) => {
    const role = turn.role === 'assistant' ? 'AI' : turn.role === 'user' ? '用户' : '对话';
    const text = truncateText(turn.text || '', 220);
    return text ? `${role}：${text}` : '';
  }).filter(Boolean);
  const evidenceText = lines.length ? lines.join('\n') : evidence.map((item) => `用户：${item}`).join('\n');
  const source = conversation.provider || page.typeLabel || page.host || '浏览器';
  return {
    title: lesson.replace(/^(界面经验|记忆经验|设计经验|产品经验|可沉淀经验)[:：]/, '').slice(0, 42),
    content: [`经验：${lesson}`, evidenceText ? `对话依据：\n${evidenceText}` : '', `来源类型：${source}`].filter(Boolean).join('\n')
  };
}

function buildDefaultDraft(capture) {
  const draft = buildMemoryDraft(capture);
  return {
    kind: 'memory',
    title: draft.title || '浏览器记忆候选',
    content: draft.content,
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
    $('copyEvidenceCommand').disabled = true;
    $('evidenceCommandHint').hidden = true;
    return;
  }
  section.hidden = false;
  $('copyDiagnostics').disabled = false;
  $('copyEvidenceCommand').disabled = false;
  $('evidenceCommandHint').hidden = false;
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
  const selectedText = target.dataset.draftText || '';
  const lessonDraft = kind === 'lesson' ? buildLessonDraft(latestCapture, selectedText) : null;
  setDraft({
    kind,
    title: lessonDraft ? lessonDraft.title : page.title || (kind === 'lesson' ? '经验候选' : '记忆候选'),
    content: lessonDraft ? lessonDraft.content : selectedText,
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
$('copyEvidenceCommand').addEventListener('click', async () => {
  try {
    await copyText(buildEvidenceCommand(latestCapture));
    setMessage('已复制证据向导命令', 'ok');
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
