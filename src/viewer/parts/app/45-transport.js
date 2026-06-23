    async function api(path, opts) {
      try {
        var headers = Object.assign({ 'Cache-Control': 'no-cache' }, (opts && opts.headers) || {});
        var fetchOpts = Object.assign({}, opts || {}, { headers: headers });
        var urls = [REST + '/agentmemory/' + path, REST + '/' + path];
        for (var i = 0; i < urls.length; i++) {
          var res = await fetch(urls[i], fetchOpts);
          if (res.ok) return await res.json();
        }
        console.warn('[viewer] API ' + (fetchOpts.method || 'GET') + ' ' + path + ' failed on all route variants');
        return null;
      } catch (err) {
        console.warn('[viewer] API error on ' + path + ':', err);
        return null;
      }
    }
    async function apiGet(path) { return api(path); }
    async function apiPost(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    }
    async function apiDelete(path, body) {
      return api(path, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    }
    async function apiPatch(path, body) {
      return api(path, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    }
    async function loadLocalCodexSessions(limit) {
      var count = limit || 120;
      var result = await apiGet('local-agent-sessions?limit=' + encodeURIComponent(count));
      if (!result) result = await apiGet('local-codex-sessions?limit=' + encodeURIComponent(count));
      return (result && result.sessions) || [];
    }
    async function settledData(label, fallback, loader) {
      try {
        var data = await loader();
        return { label: label, data: data, failed: false };
      } catch (err) {
        console.warn('[viewer] ' + label + ' failed:', err);
        return { label: label, data: fallback, failed: true };
      }
    }
    function renderDataWarnings(warnings, retryAction) {
      if (!warnings || warnings.length === 0) return '';
      var html = '<div class="activity-status-card activity-status-warning"><div class="activity-status-main"><span class="activity-status-dot"></span><span>' + esc(warnings.join('、')) + ' 暂时没读到，已先展示可用数据。</span></div>';
      html += '<button class="btn" data-action="' + esc(retryAction) + '">重试</button></div>';
      return html;
    }
    function mergeSessions(primary, local) {
      var seen = {};
      var out = [];
      (primary || []).forEach(function(s) {
        var id = sessionId(s);
        if (!id) return;
        seen[id] = true;
        out.push(s);
      });
      (local || []).forEach(function(s) {
        var id = sessionId(s).replace(/^codex_local_/, 'codex_');
        if (!sessionId(s)) return;
        if (!seen[id] && !seen[sessionId(s)]) out.push(s);
      });
      return out;
    }

