(() => {
  const AI_PROVIDERS = [
    { id: 'chatgpt', label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'], editorSelectors: ['#prompt-textarea', 'textarea', '[contenteditable="true"]'], turnSelectors: ['[data-message-author-role]', '[data-testid*="conversation-turn"]'] },
    { id: 'claude', label: 'Claude', hosts: ['claude.ai'], editorSelectors: ['div[contenteditable="true"]', 'textarea', 'p[data-placeholder]'], turnSelectors: ['[data-testid*="message"]', 'main [class*="font-claude"]', 'main article'] },
    { id: 'gemini', label: 'Gemini', hosts: ['gemini.google.com'], editorSelectors: ['rich-textarea [contenteditable="true"]', '[contenteditable="true"]', 'textarea'], turnSelectors: ['user-query', 'model-response', 'message-content', 'main article'] },
    { id: 'perplexity', label: 'Perplexity', hosts: ['perplexity.ai', 'www.perplexity.ai'], editorSelectors: ['textarea', '[contenteditable="true"]'], turnSelectors: ['[data-testid*="thread"]', '[class*="prose"]', 'main article'] },
    { id: 'grok', label: 'Grok', hosts: ['grok.com', 'x.ai'], editorSelectors: ['textarea', '[contenteditable="true"]'], turnSelectors: ['[data-testid*="message"]', 'main article'] },
    { id: 'deepseek', label: 'DeepSeek', hosts: ['chat.deepseek.com', 'deepseek.com'], editorSelectors: ['textarea', '[contenteditable="true"]'], turnSelectors: ['[class*="message"]', 'main article'] }
  ];

  function getProviderForHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    return AI_PROVIDERS.find((provider) => provider.hosts.some((item) => host === item || host.endsWith(`.${item}`))) || null;
  }

  function textFromMeta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function collectPageContext() {
    const selection = String(window.getSelection ? window.getSelection() : '').trim();
    const description = textFromMeta('description') || textFromMeta('og:description');
    const title = document.title || textFromMeta('og:title') || location.hostname;
    const headings = Array.from(document.querySelectorAll('h1, h2')).slice(0, 8).map((el) => el.textContent.trim()).filter(Boolean);
    const provider = getProviderForHost(location.hostname);
    const turns = collectAiChatTurns(provider);
    const promptDraft = collectPromptDraft(provider);
    return {
      title,
      url: location.href,
      host: location.hostname,
      description,
      selection,
      headings,
      aiProvider: provider ? provider.label : '',
      promptDraft,
      turns
    };
  }

  function collectAiChatTurns(provider) {
    if (!provider) return [];
    const selectors = provider.turnSelectors.concat(['main article']);
    const nodes = Array.from(document.querySelectorAll(selectors.join(',')));
    const turns = [];
    const seen = new Set();
    for (const node of nodes.slice(-18)) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length < 12 || seen.has(text)) continue;
      seen.add(text);
      const explicitRole = node.getAttribute('data-message-author-role');
      const role = explicitRole || inferRole(node, turns.length);
      turns.push({ role, text });
    }
    return turns.slice(-8);
  }

  function collectPromptDraft(provider) {
    if (!provider) return '';
    for (const selector of provider.editorSelectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const text = ('value' in el ? el.value : el.innerText || el.textContent || '').trim();
      if (text) return text;
    }
    return '';
  }

  function inferRole(node, index) {
    const label = `${node.getAttribute('aria-label') || ''} ${node.className || ''}`.toLowerCase();
    if (/user|human|you|用户/.test(label)) return 'user';
    if (/assistant|agent|model|claude|chatgpt|gemini|回答/.test(label)) return 'assistant';
    return index % 2 === 0 ? 'user' : 'assistant';
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'AGENT_MEMORY_LAB_COLLECT_PAGE') {
      sendResponse({ ok: true, page: collectPageContext() });
      return true;
    }
    return false;
  });
})();
