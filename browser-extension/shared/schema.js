import { PAGE_TYPE_LABELS, detectAiProvider, detectPageType } from './page-types.js';

export const CAPTURE_SCHEMA_VERSION = 1;

export function normalizeUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || '');
    return {
      url: url.href,
      host: url.hostname,
      origin: url.origin
    };
  } catch {
    return { url: rawUrl || '', host: '', origin: '' };
  }
}

export function createPageCapture(page = {}) {
  const normalized = normalizeUrl(page.url);
  const now = new Date().toISOString();
  return {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    capturedAt: now,
    source: 'browser-extension',
    page: {
      type: detectPageType({ ...page, ...normalized }),
      typeLabel: PAGE_TYPE_LABELS[detectPageType({ ...page, ...normalized })] || '网页',
      title: String(page.title || '当前页面').trim(),
      url: normalized.url,
      host: page.host || normalized.host,
      origin: normalized.origin,
      description: String(page.description || '').trim(),
      selection: String(page.selection || '').trim(),
      headings: Array.isArray(page.headings) ? page.headings.map(String).map((x) => x.trim()).filter(Boolean).slice(0, 12) : []
    },
    conversation: {
      provider: String(page.aiProvider || detectAiProvider({ ...page, ...normalized }) || ''),
      promptDraft: String(page.promptDraft || '').trim().slice(0, 1500),
      turns: Array.isArray(page.turns) ? page.turns.map(normalizeTurn).filter(Boolean).slice(-8) : []
    },
    diagnostics: normalizeDiagnostics(page.diagnostics),
    candidates: {
      memories: buildMemoryCandidates(page, normalized),
      lessons: buildLessonCandidates(page, normalized)
    },
    privacy: {
      risk: detectPrivacyRisk(page),
      reasons: detectPrivacyReasons(page)
    }
  };
}

function normalizeDiagnostics(value) {
  const input = value && typeof value === 'object' ? value : {};
  const matched = input.matchedSelectors && typeof input.matchedSelectors === 'object' ? input.matchedSelectors : {};
  return {
    supportedAiPage: !!input.supportedAiPage,
    provider: String(input.provider || ''),
    editorFound: !!input.editorFound,
    editorSelector: String(input.editorSelector || ''),
    anchorFound: !!input.anchorFound,
    anchorSelector: String(input.anchorSelector || ''),
    anchorSource: String(input.anchorSource || ''),
    adjacentSelector: String(input.adjacentSelector || ''),
    sendFound: !!input.sendFound,
    sendSelector: String(input.sendSelector || ''),
    turnSelector: String(input.turnSelector || ''),
    turnSelectorCount: Number.isFinite(Number(input.turnSelectorCount)) ? Number(input.turnSelectorCount) : 0,
    matchedSelectors: {
      editor: String(matched.editor || input.editorSelector || ''),
      anchor: String(matched.anchor || input.anchorSelector || ''),
      anchorSource: String(matched.anchorSource || input.anchorSource || ''),
      adjacent: String(matched.adjacent || input.adjacentSelector || ''),
      send: String(matched.send || input.sendSelector || ''),
      turn: String(matched.turn || input.turnSelector || '')
    },
    placement: String(input.placement || ''),
    promptLength: Number.isFinite(Number(input.promptLength)) ? Number(input.promptLength) : 0,
    turnCount: Number.isFinite(Number(input.turnCount)) ? Number(input.turnCount) : 0,
    memoryWidgetVisible: !!input.memoryWidgetVisible,
    checkedAt: String(input.checkedAt || '')
  };
}

function normalizeTurn(turn) {
  if (!turn || !turn.text) return null;
  return {
    role: turn.role === 'user' || turn.role === 'assistant' ? turn.role : 'unknown',
    text: String(turn.text).trim().slice(0, 1200)
  };
}

function cleanCandidateText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^(Gemini|ChatGPT|Claude|Perplexity)\s+said\s+/i, '')
    .replace(/^(用户|User|我)[:：]\s*/i, '')
    .replace(/^我知道你是([^，。；;]+)([，。；;])/i, '$1$2')
    .replace(/^你是([^，。；;]+)([，。；;])/i, '$1$2')
    .trim();
}

function isUsefulFact(text) {
  if (!text || text.length < 6) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^(摘要|来源|URL|页面结构|网页记忆线索|浏览器候选记忆|浏览器候选经验|在\s*ChatGPT\s*中继续跟进)[:：]?/.test(text)) return false;
  if (/ChatGPT\s*是一款供日常使用的\s*AI\s*聊天机器人/i.test(text)) return false;
  return /(我|我的|我们|你是|你叫|用户|刘欣|Liu Xin|coco|szn|背景|学生|设计师|UI\/?UX|交互设计|产品设计|希望|想要|需要|正在|计划|偏好|喜欢|不喜欢|不要|应该|必须|学习|备考|项目|产品|设计|插件|记忆|Skill|飞书|GitHub|雅思|IELTS)/i.test(text);
}

function splitFactSentences(text) {
  return String(text || '')
    .split(/[。！？!?\n]+/)
    .map(cleanCandidateText)
    .filter(isUsefulFact)
    .filter((item) => item.length <= 220);
}

function uniqueCandidates(items) {
  const seen = new Set();
  return items
    .map(cleanCandidateText)
    .filter(Boolean)
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function truncateText(text, limit = 180) {
  const value = cleanCandidateText(text);
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function conversationLinesFromPage(page = {}) {
  const turns = Array.isArray(page.turns) ? page.turns : [];
  return turns
    .map((turn) => {
      const role = turn && turn.role === 'assistant' ? 'AI' : turn && turn.role === 'user' ? '用户' : '对话';
      const text = truncateText(turn && turn.text ? turn.text : '', 220);
      return text ? `${role}：${text}` : '';
    })
    .filter(Boolean);
}

function lessonEvidenceFromPage(page = {}) {
  const turns = Array.isArray(page.turns) ? page.turns : [];
  const userTurns = turns.filter((turn) => turn && turn.role === 'user').map((turn) => turn.text);
  const assistantTurns = turns.filter((turn) => turn && turn.role === 'assistant').map((turn) => turn.text);
  const evidence = uniqueCandidates([
    ...splitFactSentences(page.selection),
    ...userTurns.flatMap(splitFactSentences),
    ...splitFactSentences(page.promptDraft),
    ...assistantTurns.flatMap(splitFactSentences)
  ]);
  const conversation = conversationLinesFromPage(page).slice(-4);
  return {
    evidence: evidence.slice(0, 3),
    conversation
  };
}

function memoryEvidenceFromPage(page = {}) {
  const turns = Array.isArray(page.turns) ? page.turns : [];
  const userTurns = turns.filter((turn) => turn && turn.role === 'user').map((turn) => turn.text);
  const assistantTurns = turns.filter((turn) => turn && turn.role === 'assistant').map((turn) => turn.text);
  return uniqueCandidates([
    ...conversationSummaryFacts(turns),
    ...splitFactSentences(page.selection),
    ...userTurns.flatMap(splitFactSentences),
    ...assistantTurns.flatMap(splitFactSentences),
    ...splitFactSentences(page.promptDraft)
  ]).slice(0, 4);
}

function conversationSummaryFacts(turns = []) {
  const text = turns.map((turn) => cleanCandidateText(turn && turn.text ? turn.text : '')).filter(Boolean).join('。');
  const facts = [];
  const identity = text.match(/(?:你是|我知道你是|用户是)?\s*(刘欣（Liu Xin）|刘欣|Liu Xin|coco|szn)[，,、\s]*(?:是)?\s*([^。！？!?]{8,140})/i);
  if (identity) {
    var name = identity[1];
    var desc = cleanCandidateText(identity[2]).replace(/^(是|一位|一个)\s*/, '');
    if (desc) facts.push(`${name}是一位${desc}`);
  }
  const background = text.match(/(?:有着|具有|拥有)([^。！？!?]{0,120}?(?:UI\/?UX|交互设计|产品设计|用户体验)[^。！？!?]{0,120}?)(?:背景|经验|经历|能力)?/i);
  if (background && !facts.some((item) => item.includes(background[1]))) {
    facts.push(`用户具有${cleanCandidateText(background[1])}背景`);
  }
  const preference = text.match(/(?:希望|想要|需要|偏好|喜欢|不喜欢|不要)([^。！？!?]{6,160})/i);
  if (preference) facts.push(`用户偏好或需求：${cleanCandidateText(preference[0])}`);
  return facts.filter(isUsefulFact);
}

function makeLessonFromEvidence(primary = '') {
  const text = cleanCandidateText(primary);
  if (!text) return '';
  if (/(不要|不需要|看不懂|难以理解|太奇怪|太丑|加载.*慢|没懂)/.test(text)) {
    return `界面经验：遇到用户反馈“${truncateText(text, 90)}”时，优先减少解释性/内部化元素，并把功能改成可直接理解的具体结果。`;
  }
  if (/(自动|自己更新|基于.*聊天|对话记录|具体对话|提炼)/.test(text)) {
    return `记忆经验：候选记忆和经验必须来自具体对话内容，先呈现可复用事实或结论，再把来源保留为上下文依据。`;
  }
  if (/(颜色|圆角|风格|卡片|排版|版式|icon|图标)/i.test(text)) {
    return `设计经验：视觉调整要沿用既定风格，把颜色、圆角、图标和卡片层级统一到同一套界面语言里。`;
  }
  if (/(插件|浏览器|extension|网页|同步)/i.test(text)) {
    return `产品经验：浏览器插件应作为网页到本地工作台的入口，保存具体事实并进入审阅，而不是只保存页面链接。`;
  }
  return `可沉淀经验：${truncateText(text, 160)}`;
}

function buildSourceNote(page) {
  const title = String(page.title || '当前页面').trim();
  const url = String(page.url || '').trim();
  return [title ? `来源页面：${title}` : '', url ? `来源链接：${url}` : ''].filter(Boolean).join('\n');
}

export function buildBrowserMemoryDraft(capture) {
  const page = capture && capture.page ? capture.page : {};
  const conversation = capture && capture.conversation ? capture.conversation : {};
  const candidates = capture && capture.candidates && Array.isArray(capture.candidates.memories) ? capture.candidates.memories : [];
  const evidence = memoryEvidenceFromPage({
    ...page,
    turns: Array.isArray(conversation.turns) ? conversation.turns : [],
    promptDraft: conversation.promptDraft || page.promptDraft || ''
  });
  const first = evidence.find((item) => String(item || '').trim()) || candidates.find((item) => isUsefulFact(item)) || '';
  const fact = cleanCandidateText(first) || `请从这个页面提炼一条具体事实：${page.title || '当前页面'}`;
  const provider = conversation.provider || page.typeLabel || page.host || '浏览器';
  return {
    title: fact.length > 42 ? `${fact.slice(0, 42)}...` : fact,
    content: [`候选事实：${fact}`, `依据：来自 ${provider} 的具体对话`].filter(Boolean).join('\n'),
    fact,
    source: buildSourceNote(page)
  };
}

export function buildBrowserLessonDraft(capture) {
  const page = capture && capture.page ? capture.page : {};
  const conversation = capture && capture.conversation ? capture.conversation : {};
  const pageForEvidence = {
    ...page,
    turns: Array.isArray(conversation.turns) ? conversation.turns : [],
    promptDraft: conversation.promptDraft || page.promptDraft || ''
  };
  const candidates = capture && capture.candidates && Array.isArray(capture.candidates.lessons) ? capture.candidates.lessons : [];
  const first = candidates.find((item) => isUsefulFact(item)) || '';
  const { evidence, conversation: lines } = lessonEvidenceFromPage(pageForEvidence);
  const primary = first || evidence[0] || '';
  if (!primary) {
    return {
      title: '需要具体对话后再提炼',
      content: '这段页面还没有读到足够的具体对话，暂时不能沉淀成经验。请先选择一段真实对话，或手动补充一句可复用结论。',
      lesson: '',
      evidence: ''
    };
  }
  const lesson = makeLessonFromEvidence(primary);
  const evidenceText = lines.length ? lines.join('\n') : evidence.map((item) => `用户：${item}`).join('\n');
  const provider = conversation.provider || page.typeLabel || page.host || '浏览器';
  return {
    title: lesson.replace(/^(界面经验|记忆经验|设计经验|产品经验|可沉淀经验)[:：]/, '').slice(0, 42),
    content: [`经验：${lesson}`, evidenceText ? `对话依据：\n${evidenceText}` : '', `来源类型：${provider}`].filter(Boolean).join('\n'),
    lesson,
    evidence: evidenceText
  };
}

function buildMemoryCandidates(page, normalized) {
  const type = detectPageType({ ...page, ...normalized });
  const provider = detectAiProvider({ ...page, ...normalized });
  const turns = Array.isArray(page.turns) ? page.turns : [];
  const userTurns = turns.filter((turn) => turn && turn.role === 'user').map((turn) => turn.text);
  const assistantTurns = turns.filter((turn) => turn && turn.role === 'assistant').map((turn) => turn.text);
  const candidates = uniqueCandidates([
    ...splitFactSentences(page.selection),
    ...userTurns.flatMap(splitFactSentences),
    ...assistantTurns.flatMap(splitFactSentences),
    ...splitFactSentences(page.promptDraft)
  ]);
  if (provider) {
    if (!candidates.length && page.promptDraft) candidates.push(`用户在 ${provider} 中正在处理：${cleanCandidateText(page.promptDraft).slice(0, 180)}`);
  }
  if (page.selection && !candidates.length) candidates.push(cleanCandidateText(page.selection).slice(0, 180));
  if (type === 'github') candidates.push(`GitHub 项目线索：${String(page.title || '').trim()}`);
  if (type === 'paper') candidates.push(`论文 / PDF 阅读线索：${String(page.title || '').trim()}`);
  if (!candidates.length) candidates.push(`从当前页面提炼具体事实：${String(page.title || '当前页面').trim()}`);
  return candidates.slice(0, 4);
}

function buildLessonCandidates(page, normalized) {
  const type = detectPageType({ ...page, ...normalized });
  const { evidence } = lessonEvidenceFromPage(page);
  if (type === 'ai-chat') {
    return evidence.length ? evidence.map(makeLessonFromEvidence).filter(Boolean).slice(0, 3) : ['这段对话还没有足够内容提炼经验，请选择具体对话或补充一句经验'];
  }
  if (evidence.length) return evidence.map(makeLessonFromEvidence).filter(Boolean).slice(0, 3);
  if (type === 'github') return ['记录这个开源项目的结构、功能模块或可借鉴交互'];
  if (type === 'feishu' || type === 'notion') return ['从这份文档提炼项目介绍、需求或决策记录'];
  if (type === 'paper') return ['把论文观点整理成研究线索或设计依据'];
  return ['从当前网页提炼一条可复用经验'];
}

function pageText(page) {
  return [page.title, page.description, page.selection, ...(Array.isArray(page.headings) ? page.headings : [])].join('\n');
}

function detectPrivacyReasons(page) {
  const text = pageText(page);
  const reasons = [];
  if (/(token|api[_ -]?key|secret|password|密码|密钥)/i.test(text)) reasons.push('可能包含密钥或密码');
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) reasons.push('可能包含邮箱');
  if (/(身份证|护照|手机号|银行卡|地址)/.test(text)) reasons.push('可能包含个人信息');
  return reasons;
}

function detectPrivacyRisk(page) {
  return detectPrivacyReasons(page).length ? 'medium' : 'low';
}

export function captureToMemoryPayload(capture) {
  const page = capture.page;
  const provider = capture.conversation && capture.conversation.provider ? capture.conversation.provider : '';
  const sourceKind = provider || page.typeLabel || page.host || '浏览器';
  const draft = buildBrowserMemoryDraft(capture);
  return {
    content: draft.content,
    concepts: ['browser-context', page.host, `browser-page:${page.type}`, provider ? `browser-source:${provider.toLowerCase()}` : ''].filter(Boolean),
    files: [],
    project: 'browser',
    sourceKind,
    sourceLabel: provider ? provider : page.typeLabel || '浏览器',
    pageType: page.type,
    provider
  };
}

export function captureToLessonPayload(capture, note) {
  const page = capture.page;
  const draft = buildBrowserLessonDraft(capture);
  const content = cleanCandidateText(note) || draft.content;
  return {
    content,
    context: draft.evidence || `${page.title}\n${page.url}`,
    tags: ['browser', 'web-context'],
    project: 'browser',
    sourceKind: capture.conversation && capture.conversation.provider ? capture.conversation.provider : page.typeLabel || '浏览器',
    sourceLabel: capture.conversation && capture.conversation.provider ? capture.conversation.provider : page.typeLabel || '浏览器',
    pageType: page.type,
    provider: capture.conversation && capture.conversation.provider ? capture.conversation.provider : '',
    confidence: 0.75
  };
}

export function createCaptureRecord(capture, kind, result) {
  const item = result && result.item ? result.item : null;
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    title: capture.page.title,
    url: capture.page.url,
    host: capture.page.host,
    type: capture.page.type,
    typeLabel: capture.page.typeLabel,
    savedAt: new Date().toISOString(),
    resultId: result && (result.id || result.memoryId || result.lessonId || result.actionId || (item && item.id) || '')
  };
}
