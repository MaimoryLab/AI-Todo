(() => {
  function textFromMeta(name) {
    const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el ? (el.getAttribute('content') || '').trim() : '';
  }

  function collectPageContext() {
    const selection = String(window.getSelection ? window.getSelection() : '').trim();
    const description = textFromMeta('description') || textFromMeta('og:description');
    const title = document.title || textFromMeta('og:title') || location.hostname;
    const headings = Array.from(document.querySelectorAll('h1, h2')).slice(0, 8).map((el) => el.textContent.trim()).filter(Boolean);
    return {
      title,
      url: location.href,
      host: location.hostname,
      description,
      selection,
      headings
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === 'AGENT_MEMORY_LAB_COLLECT_PAGE') {
      sendResponse({ ok: true, page: collectPageContext() });
      return true;
    }
    return false;
  });
})();
