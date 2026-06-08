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
  return {
    supportedAiPage: !!input.supportedAiPage,
    provider: String(input.provider || ''),
    editorFound: !!input.editorFound,
    editorSelector: String(input.editorSelector || ''),
    anchorFound: !!input.anchorFound,
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

function buildMemoryCandidates(page, normalized) {
  const type = detectPageType({ ...page, ...normalized });
  const provider = detectAiProvider({ ...page, ...normalized });
  const candidates = [];
  if (provider) {
    candidates.push(`在 ${provider} 中继续跟进：${String(page.title || '当前对话').trim()}`);
    if (page.promptDraft) candidates.push(`当前输入可能需要记忆辅助：${String(page.promptDraft).trim().slice(0, 180)}`);
  }
  if (page.selection) candidates.push(`选中文本可能值得保留：${String(page.selection).trim().slice(0, 180)}`);
  if (type === 'github') candidates.push(`GitHub 项目线索：${String(page.title || '').trim()}`);
  if (type === 'paper') candidates.push(`论文 / PDF 阅读线索：${String(page.title || '').trim()}`);
  if (!candidates.length) candidates.push(`网页线索：${String(page.title || '当前页面').trim()}`);
  return candidates.slice(0, 4);
}

function buildLessonCandidates(page, normalized) {
  const type = detectPageType({ ...page, ...normalized });
  if (type === 'ai-chat') return ['把这段 AI 对话沉淀成可复用偏好、项目背景或下一步行动'];
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
  const selected = page.selection ? `\n\n选中文本：\n${page.selection}` : '';
  const headings = page.headings.length ? `\n\n页面结构：${page.headings.join(' / ')}` : '';
  const provider = capture.conversation && capture.conversation.provider ? capture.conversation.provider : '';
  const sourceKind = provider || page.typeLabel || page.host || '浏览器';
  return {
    content: `网页记忆线索：${page.title}\nURL：${page.url}\n摘要：${page.description || '无'}${selected}${headings}`,
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
  return {
    content: note || `从网页 ${page.title} 提炼一条可复用经验`,
    context: `${page.title}\n${page.url}`,
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
