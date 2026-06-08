import { getProviderForHost } from './site-config.js';

export function detectAiProvider(page) {
  const provider = getProviderForHost(page.host || page.url || '');
  return provider ? provider.label : '';
}

export function detectPageType(page) {
  const host = String(page.host || '').toLowerCase();
  const url = String(page.url || '').toLowerCase();
  if (detectAiProvider(page)) return 'ai-chat';
  if (host.includes('github.com')) return 'github';
  if (host.includes('feishu.cn') || host.includes('larksuite.com')) return 'feishu';
  if (host.includes('notion.so')) return 'notion';
  if (url.endsWith('.pdf') || host.includes('arxiv.org') || host.includes('doi.org')) return 'paper';
  if (host.includes('chrome.google.com') || host.includes('chromewebstore.google.com')) return 'extension-store';
  return 'webpage';
}

export const PAGE_TYPE_LABELS = {
  'ai-chat': 'AI 对话',
  github: 'GitHub',
  feishu: '飞书',
  notion: 'Notion',
  paper: '论文 / PDF',
  'extension-store': '插件商店',
  webpage: '网页'
};
