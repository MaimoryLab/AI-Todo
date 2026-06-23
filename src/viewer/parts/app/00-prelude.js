    // 通过 file:// 打开时会触发跨域限制，导致本地接口数据不可用。
    // 自动跳转到本地服务地址，保留当前 hash 路由。
    if (window.location.protocol === 'file:') {
      var target = 'http://localhost:3114/' + (window.location.hash || '#dashboard');
      window.location.replace(target);
    }

    var params = new URLSearchParams(window.location.search);
    var paramPort = params.get('port');
    var locPort = window.location.port;
    var hasHost = !!window.location.hostname;
    var hostName = hasHost ? window.location.hostname : 'localhost';
    var wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var REST, WS_URL, WS_DIRECT_URL, wsPort;
    if (paramPort) {
      var resolvedPort = parseInt(paramPort) === 3111 ? '3114' : paramPort;
      REST = window.location.protocol + '//' + hostName + ':' + resolvedPort;
      wsPort = params.get('wsPort') || String(parseInt(resolvedPort) - 1);
      WS_URL = wsProto + '//' + hostName + ':' + wsPort;
      WS_DIRECT_URL = WS_URL + '/stream/mem-live/viewer';
    } else if (locPort) {
      var resolvedPort = parseInt(locPort) === 3111 ? '3114' : locPort;
      REST = window.location.protocol + '//' + hostName + ':' + resolvedPort;
      wsPort = params.get('wsPort') || String(parseInt(resolvedPort) - 1);
      WS_URL = wsProto + '//' + hostName + ':' + wsPort;
      WS_DIRECT_URL = WS_URL + '/stream/mem-live/viewer';
    } else {
      // file:// 场景下，origin/host 为空；默认回退到本地 agentmemory 服务。
      var fallbackPort = parseInt(params.get('port') || '3114', 10);
      if (Number.isNaN(fallbackPort)) fallbackPort = 3114;
      REST = 'http://' + hostName + ':' + fallbackPort;
      wsPort = params.get('wsPort') || String(fallbackPort - 1);
      WS_URL = wsProto + '//' + hostName + ':' + wsPort;
      WS_DIRECT_URL = WS_URL + '/stream/mem-live/viewer';
    }

    function isDarkMode() { return document.documentElement.dataset.theme === 'dark'; }
    function applyTheme(dark, persist) {
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      var btn = document.getElementById('theme-toggle');
      if (btn) btn.textContent = dark ? 'LIGHT' : 'DARK';
      if (persist) localStorage.setItem('agentmemory-theme', dark ? 'dark' : 'light');
    }
    window.toggleTheme = function() { applyTheme(!isDarkMode(), true); };
    var savedTheme = localStorage.getItem('agentmemory-theme');
    if (savedTheme) {
      applyTheme(savedTheme === 'dark', false);
    } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      applyTheme(true, false);
    }

    var NODE_COLORS = {
      file: '#2D6A4F', function: '#1D4E89', concept: '#B8860B', error: '#CC0000',
      decision: '#6B3FA0', pattern: '#2563EB', library: '#C2410C', person: '#111111'
    };
    var OP_BADGES = {
      observe: 'badge-blue', compress: 'badge-cyan', remember: 'badge-green',
      forget: 'badge-red', evolve: 'badge-purple', consolidate: 'badge-yellow',
      share: 'badge-orange', delete: 'badge-red', import: 'badge-blue', export: 'badge-blue'
    };
    var TYPE_BADGES = {
      pattern: 'badge-purple', preference: 'badge-blue', architecture: 'badge-cyan',
      bug: 'badge-red', workflow: 'badge-green', fact: 'badge-yellow',
      profile: 'badge-muted', history: 'badge-muted', project: 'badge-green'
    };
    var OBS_TYPE_COLORS = {
      file_read: '#1D4E89', file_write: '#2D6A4F', file_edit: '#B8860B',
      command_run: '#C2410C', search: '#2563EB', web_fetch: '#6B3FA0',
      conversation: '#111111', error: '#CC0000', decision: '#B8860B',
      discovery: '#2D6A4F', subagent: '#6B3FA0', notification: '#0E7490',
      task: '#1D4E89', other: '#666666'
    };
    var OBS_TYPE_ICONS = {
      file_read: '&#128196;', file_write: '&#9999;', file_edit: '&#128221;',
      command_run: '&#9889;', search: '&#128270;', web_fetch: '&#127760;',
      conversation: '&#128172;', error: '&#9888;', decision: '&#129300;',
      discovery: '&#128161;', subagent: '&#129302;', notification: '&#128276;',
      task: '&#9745;', other: '&#128196;'
    };
    // === i18n base (PLAN-001 STEP-01) ===
    // Lightweight inline i18n: a keyed {en, zh} catalog + t(key) lookup.
    // Display labels live here, keyed BY the stored lowercase enum, so switching
    // language never touches Action.status / statusFilter literals.
    // ponytail: inline single-file base; promote to a shared module only if a
    // second surface (extension) needs the same catalog.
    /* i18n-core:start */
