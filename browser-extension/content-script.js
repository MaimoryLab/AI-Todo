(() => {
  const AI_PROVIDERS = [
    { id: 'agentmemoryDemo', label: 'Agent Memory Demo', hosts: ['localhost', '127.0.0.1'], pathIncludes: ['/demo/browser-extension.html'], editorSelectors: ['#agentmemory-demo-input', '[data-agentmemory-demo-input]', '[contenteditable="true"]'], anchorSelectors: ['#agentmemory-demo-input', 'form', 'main'], placement: 'input-corner', turnSelectors: ['[data-message-author-role]', 'main article'], sendSelectors: ['button.primary'] },
    { id: 'chatgpt', label: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com'], editorSelectors: ['#prompt-textarea', '[data-testid="prompt-textarea"]', 'textarea[placeholder]', 'textarea', '[contenteditable="true"]'], anchorSelectors: ['[data-testid="composer-trailing-actions"]', '.composer-trailing-actions', 'form', 'main form'], adjacentSelectors: ['button[aria-label="Dictate button"]', 'button[aria-label*="mic" i]', 'button[aria-label*="voice" i]'], placement: 'toolbar-end', turnSelectors: ['[data-message-author-role]', '[data-testid*="conversation-turn"]', 'main article'], sendSelectors: ['button[data-testid="send-button"]', 'button[aria-label*="Send"]'] },
    { id: 'claude', label: 'Claude', hosts: ['claude.ai'], editorSelectors: ['div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"]', 'textarea', 'p[data-placeholder]'], anchorSelectors: ['form', '[data-testid*="input"]', '[contenteditable="true"]'], placement: 'input-corner', turnSelectors: ['[data-testid*="message"]', 'main [class*="font-claude"]', 'main article'], sendSelectors: ['button[aria-label*="Send"]', 'button[type="submit"]'] },
    { id: 'gemini', label: 'Gemini', hosts: ['gemini.google.com'], editorSelectors: ['rich-textarea [contenteditable="true"]', 'rich-textarea textarea', '[contenteditable="true"]', 'textarea'], anchorSelectors: ['rich-textarea', '.input-area-container', 'form', '[contenteditable="true"]'], placement: 'input-corner', turnSelectors: ['user-query', 'model-response', 'message-content', 'main article'], sendSelectors: ['button[aria-label*="Send"]', 'button[aria-label*="提交"]'] },
    { id: 'perplexity', label: 'Perplexity', hosts: ['perplexity.ai', 'www.perplexity.ai'], editorSelectors: ['textarea[placeholder]', 'textarea', '[contenteditable="true"]'], anchorSelectors: ['form', 'textarea[placeholder]', '[contenteditable="true"]'], placement: 'input-corner', turnSelectors: ['[data-testid*="thread"]', '[class*="prose"]', 'main article'], sendSelectors: ['button[aria-label*="Submit"]', 'button[aria-label*="Send"]'] },
    { id: 'grok', label: 'Grok', hosts: ['grok.com', 'x.ai'], editorSelectors: ['textarea', '[contenteditable="true"]'], anchorSelectors: ['form', 'textarea', '[contenteditable="true"]'], placement: 'input-corner', turnSelectors: ['[data-testid*="message"]', 'main article'], sendSelectors: ['button[aria-label*="Send"]'] },
    { id: 'deepseek', label: 'DeepSeek', hosts: ['chat.deepseek.com', 'deepseek.com'], editorSelectors: ['textarea', '[contenteditable="true"]'], anchorSelectors: ['form', 'textarea', '[contenteditable="true"]'], placement: 'input-corner', turnSelectors: ['[class*="message"]', 'main article'], sendSelectors: ['button[aria-label*="Send"]'] }
  ];
  let memoryWidget = null;
  let searchTimer = null;
  let latestQuery = '';
  const DEMO_MEMORIES = [
    {
      title: '产品原则：先审阅再沉淀',
      text: 'Agent Memory Lab 不把网页内容直接写入长期记忆。插件只生成候选和召回建议，长期记忆需要在本地 Viewer 里审阅、编辑、确认。'
    },
    {
      title: '浏览器插件方向',
      text: '参考 Mem0 / OpenMemory 的跨 AI 输入框记忆入口，但保持本地优先：ChatGPT、Claude、Gemini、Perplexity 等页面只负责召回和送审。'
    },
    {
      title: '交付检查',
      text: '对外演示前要跑 npm run check:delivery，并确认插件预览页、README、飞书文档、隐私说明、AI 站点验收记录都保持同步。'
    }
  ];

  function getProviderForHost(hostname) {
    const host = String(hostname || '').toLowerCase();
    const path = String(location.pathname || '');
    return AI_PROVIDERS.find((provider) => {
      const hostMatches = provider.hosts.some((item) => host === item || host.endsWith(`.${item}`));
      if (!hostMatches) return false;
      return !provider.pathIncludes || provider.pathIncludes.some((item) => path.includes(item));
    }) || null;
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
    const diagnostics = collectDiagnostics(provider, promptDraft, turns);
    return {
      title,
      url: location.href,
      host: location.hostname,
      description,
      selection,
      headings,
      aiProvider: provider ? provider.label : '',
      promptDraft,
      turns,
      diagnostics
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

  function findSelectorMatch(selectors) {
    for (const selector of selectors || []) {
      const el = document.querySelector(selector);
      if (el) return { el, selector };
    }
    return null;
  }

  function findTurnSelectorMatch(provider) {
    if (!provider) return null;
    for (const selector of provider.turnSelectors || []) {
      const count = document.querySelectorAll(selector).length;
      if (count) return { selector, count };
    }
    return null;
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

  function findEditor(provider) {
    const match = findEditorMatch(provider);
    return match ? match.el : null;
  }

  function findEditorMatch(provider) {
    if (!provider) return null;
    return findSelectorMatch(provider.editorSelectors);
  }

  function findAnchor(provider) {
    const match = findAnchorMatch(provider);
    return match ? match.el : null;
  }

  function findAnchorMatch(provider) {
    if (!provider) return null;
    const editorMatch = findEditorMatch(provider);
    const configuredMatch = findSelectorMatch(provider.anchorSelectors || []);
    if (configuredMatch) return { ...configuredMatch, source: 'configured' };
    const editor = editorMatch ? editorMatch.el : null;
    if (editor) {
      const fallback = editor.closest('form') || editor.parentElement || editor;
      if (fallback) return { el: fallback, selector: editorMatch.selector, source: 'editor-fallback' };
    }
    return null;
  }

  function findAdjacentAnchor(provider) {
    const match = findSelectorMatch(provider && provider.adjacentSelectors ? provider.adjacentSelectors : []);
    return match ? match.el : null;
  }

  function collectDiagnostics(provider, promptDraft, turns) {
    const editorMatch = findEditorMatch(provider);
    const anchorMatch = findAnchorMatch(provider);
    const adjacentMatch = findSelectorMatch(provider && provider.adjacentSelectors ? provider.adjacentSelectors : []);
    const sendMatch = findSelectorMatch(provider && provider.sendSelectors ? provider.sendSelectors : []);
    const turnMatch = findTurnSelectorMatch(provider);
    return {
      supportedAiPage: !!provider,
      provider: provider ? provider.label : '',
      editorFound: !!editorMatch,
      editorSelector: editorMatch ? editorMatch.selector : '',
      anchorFound: !!anchorMatch,
      anchorSelector: anchorMatch ? anchorMatch.selector : '',
      anchorSource: anchorMatch ? anchorMatch.source || 'configured' : '',
      adjacentSelector: adjacentMatch ? adjacentMatch.selector : '',
      sendFound: !!sendMatch,
      sendSelector: sendMatch ? sendMatch.selector : '',
      turnSelector: turnMatch ? turnMatch.selector : '',
      turnSelectorCount: turnMatch ? turnMatch.count : 0,
      matchedSelectors: {
        editor: editorMatch ? editorMatch.selector : '',
        anchor: anchorMatch ? anchorMatch.selector : '',
        anchorSource: anchorMatch ? anchorMatch.source || 'configured' : '',
        adjacent: adjacentMatch ? adjacentMatch.selector : '',
        send: sendMatch ? sendMatch.selector : '',
        turn: turnMatch ? turnMatch.selector : ''
      },
      placement: provider ? provider.placement || 'input-corner' : '',
      promptLength: String(promptDraft || '').length,
      turnCount: Array.isArray(turns) ? turns.length : 0,
      memoryWidgetVisible: !!memoryWidget,
      checkedAt: new Date().toISOString()
    };
  }

  function createMemoryWidget(provider) {
    if (memoryWidget) return memoryWidget;
    const host = document.createElement('agent-memory-lab-widget');
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        .wrap { width: 296px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #292521; }
        button { font: inherit; cursor: pointer; }
        .trigger { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 10px; border: 1px solid #11100f; border-radius: 7px; background: #11100f; color: #fff; font-weight: 750; box-shadow: 0 8px 24px rgba(0,0,0,.14); }
        .trigger svg { width: 15px; height: 15px; }
        .panel { display: none; margin-top: 8px; border: 1px solid #ded7cf; border-radius: 8px; background: #fffefb; box-shadow: 0 16px 44px rgba(0,0,0,.18); overflow: hidden; }
        .panel.open { display: block; }
        .head { display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 10px 11px; border-bottom: 1px solid #ded7cf; background: #f7f3ee; }
        .title { font-weight: 780; }
        .provider { color: #72685e; font-size: 12px; }
        .body { display: grid; gap: 8px; max-height: 290px; overflow: auto; padding: 10px; }
        .empty { color: #9a9188; padding: 2px; }
        .item { border: 1px solid #ded7cf; border-radius: 8px; padding: 8px; background: #fff; }
        .item-title { font-weight: 720; margin-bottom: 3px; }
        .item-text { color: #5f574f; display: -webkit-box; overflow: hidden; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
        .actions { display: flex; gap: 6px; margin-top: 7px; }
        .copy { min-height: 28px; padding: 0 8px; border: 1px solid #ded7cf; border-radius: 7px; background: #fffefb; color: #292521; font-weight: 700; }
        .insert { min-height: 28px; padding: 0 8px; border: 1px solid #11100f; border-radius: 7px; background: #11100f; color: #fff; font-weight: 700; }
        .close { border: 0; background: transparent; color: #72685e; font-size: 18px; line-height: 1; padding: 0; }
        .status { margin-left: 1px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: #fff; color: #11100f; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
      </style>
      <div class="wrap">
        <button class="trigger" type="button" aria-label="打开本地记忆建议"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3.5c-3.6 0-6.5 2.6-6.5 5.9 0 2.1 1.2 3.9 3 5l-.5 3 3-1.6c.3.1.7.1 1 .1 3.6 0 6.5-2.6 6.5-5.9S15.6 3.5 12 3.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.2 9.7h5.6M9.2 12.2h3.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span>记忆建议</span><span class="status count">0</span></button>
        <div class="panel">
          <div class="head"><div><div class="title">可引用的本地记忆</div><div class="provider"></div></div><button class="close" type="button" aria-label="关闭">×</button></div>
          <div class="body"><div class="empty">继续输入后，会自动找相关记忆。</div></div>
        </div>
      </div>`;
    document.documentElement.appendChild(host);
    memoryWidget = { host, root, provider, results: [] };
    root.querySelector('.provider').textContent = provider.label;
    root.querySelector('.trigger').addEventListener('click', () => root.querySelector('.panel').classList.toggle('open'));
    root.querySelector('.close').addEventListener('click', () => root.querySelector('.panel').classList.remove('open'));
    root.addEventListener('click', (event) => {
      const insertButton = event.target && event.target.closest ? event.target.closest('[data-insert-memory]') : null;
      if (insertButton) {
        const index = Number(insertButton.getAttribute('data-insert-memory'));
        const item = memoryWidget.results[index];
        if (item) insertMemoryIntoEditor(provider, item);
        insertButton.textContent = '已插入';
        setTimeout(() => { insertButton.textContent = '插入'; }, 1200);
        return;
      }
      const button = event.target && event.target.closest ? event.target.closest('[data-copy-memory]') : null;
      if (!button) return;
      const index = Number(button.getAttribute('data-copy-memory'));
      const item = memoryWidget.results[index];
      if (item) navigator.clipboard.writeText(item.text || item.title || '').catch(() => {});
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = '复制'; }, 1200);
    });
    positionMemoryWidget(provider);
    return memoryWidget;
  }

  function positionMemoryWidget(provider) {
    if (!memoryWidget) return;
    const editor = findEditor(provider);
    const anchor = findAdjacentAnchor(provider) || findAnchor(provider) || editor;
    if (!anchor) {
      memoryWidget.host.style.right = '18px';
      memoryWidget.host.style.bottom = '88px';
      memoryWidget.host.style.left = 'auto';
      memoryWidget.host.style.top = 'auto';
      return;
    }
    const rect = anchor.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const width = 296;
    const margin = 12;
    const placement = provider && provider.placement ? provider.placement : 'input-corner';
    const leftBase = placement === 'toolbar-end' ? rect.right - 128 : rect.right - width;
    const left = Math.max(margin, Math.min(window.innerWidth - width - margin, leftBase));
    const top = placement === 'toolbar-end'
      ? Math.max(margin, rect.top - 2)
      : rect.top > 96 ? rect.top - 44 : rect.bottom + 10;
    memoryWidget.host.style.left = `${left}px`;
    memoryWidget.host.style.top = `${Math.max(margin, top)}px`;
    memoryWidget.host.style.right = 'auto';
    memoryWidget.host.style.bottom = 'auto';
  }

  function memorySnippet(item) {
    return `[本地记忆]\n${item.title ? item.title + '\n' : ''}${item.text || ''}`.trim();
  }

  function insertMemoryIntoEditor(provider, item) {
    const editor = findEditor(provider);
    if (!editor) return false;
    const snippet = memorySnippet(item);
    const insertion = `\n\n${snippet}`;
    if ('value' in editor) {
      const start = typeof editor.selectionStart === 'number' ? editor.selectionStart : editor.value.length;
      const end = typeof editor.selectionEnd === 'number' ? editor.selectionEnd : editor.value.length;
      const before = editor.value.slice(0, start).trimEnd();
      const after = editor.value.slice(end).trimStart();
      editor.value = `${before}\n\n${snippet}${after ? '\n\n' + after : ''}`.trim();
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: snippet }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      editor.focus();
      return true;
    }
    editor.focus();
    const ok = insertTextWithSelection(editor, insertion);
    if (!ok) {
      const current = (editor.innerText || editor.textContent || '').trimEnd();
      editor.textContent = `${current}\n\n${snippet}`.trim();
    }
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: insertion }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: insertion }));
    return true;
  }

  function insertTextWithSelection(editor, text) {
    try {
      const selection = window.getSelection();
      if (!selection) return false;
      if (!selection.rangeCount || !editor.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (document.queryCommandSupported && document.queryCommandSupported('insertText')) {
        return document.execCommand('insertText', false, text);
      }
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      return true;
    } catch (_err) {
      return false;
    }
  }

  function normalizeSearchResults(data) {
    const raw = data && (data.results || data.memories || data.items || data.observations || []);
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => {
      const memory = item.memory || item.observation || item;
      return {
        title: memory.title || memory.type || '相关记忆',
        text: memory.content || memory.narrative || memory.memory || item.text || ''
      };
    }).filter((item) => item.text || item.title).slice(0, 5);
  }

  function demoSearchResults(query) {
    const q = String(query || '').toLowerCase();
    const compact = q.replace(/\s+/g, '');
    const parts = q.split(/\s+/).filter(Boolean);
    if (!parts.length && compact.length >= 2) parts.push(compact);
    for (let i = 0; i < compact.length - 1; i += 1) {
      parts.push(compact.slice(i, i + 2));
      if (i < compact.length - 2) parts.push(compact.slice(i, i + 3));
    }
    return DEMO_MEMORIES.filter((item) => {
      const haystack = `${item.title} ${item.text}`.toLowerCase();
      return !q || parts.some((part) => part && haystack.includes(part));
    }).slice(0, 3);
  }

  function renderMemoryResults(results, loading) {
    const provider = getProviderForHost(location.hostname);
    if (!provider) return;
    const widget = createMemoryWidget(provider);
    widget.results = results || [];
    widget.root.querySelector('.count').textContent = String(widget.results.length);
    const body = widget.root.querySelector('.body');
    if (loading) {
      body.innerHTML = '<div class="empty">正在查找本地记忆...</div>';
      return;
    }
    if (!widget.results.length) {
      body.innerHTML = '<div class="empty">暂时没有找到相关记忆。</div>';
      return;
    }
    body.innerHTML = widget.results.map((item, index) => `
      <article class="item">
        <div class="item-title">${escapeHtml(item.title || '相关记忆')}</div>
        <div class="item-text">${escapeHtml(item.text || '')}</div>
        <div class="actions"><button class="insert" type="button" data-insert-memory="${index}">插入</button><button class="copy" type="button" data-copy-memory="${index}">复制</button></div>
      </article>
    `).join('');
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[char]));
  }

  function scheduleMemorySearch(provider) {
    positionMemoryWidget(provider);
    const draft = collectPromptDraft(provider);
    if (draft === latestQuery) return;
    latestQuery = draft;
    if (searchTimer) clearTimeout(searchTimer);
    if (!draft || draft.length < 8) {
      renderMemoryResults([], false);
      return;
    }
    searchTimer = setTimeout(() => {
      if (provider.id === 'agentmemoryDemo') {
        renderMemoryResults(demoSearchResults(draft), false);
        return;
      }
      renderMemoryResults([], true);
      chrome.runtime.sendMessage({ type: 'SEARCH_MEMORIES', query: draft }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          renderMemoryResults([], false);
          return;
        }
        renderMemoryResults(normalizeSearchResults(response.data), false);
      });
    }, 450);
  }

  function bootMemoryAssist() {
    const provider = getProviderForHost(location.hostname);
    if (!provider) return;
    createMemoryWidget(provider);
    const attach = () => {
      const editor = findEditor(provider);
      if (!editor || editor.__agentMemoryBound) return;
      editor.__agentMemoryBound = true;
      ['input', 'keyup', 'paste', 'compositionend'].forEach((eventName) => {
        editor.addEventListener(eventName, () => scheduleMemorySearch(provider), true);
      });
      scheduleMemorySearch(provider);
    };
    attach();
    window.addEventListener('resize', () => positionMemoryWidget(provider), { passive: true });
    window.addEventListener('scroll', () => positionMemoryWidget(provider), { passive: true, capture: true });
    new MutationObserver(attach).observe(document.documentElement, { childList: true, subtree: true });
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

  bootMemoryAssist();
})();
