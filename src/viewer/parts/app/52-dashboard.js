    async function loadDashboard() {
      var el = document.getElementById('view-dashboard');
      el.innerHTML = '<div class="loading">加载总览中...</div>';
      var showDebug = new URLSearchParams(window.location.search).get('debug') === '1';
      try {
        var baseResults = await Promise.all([
          apiGet('health'),
          apiGet('sessions'),
          apiGet('actions'),
          apiGet('review?status=pending&kind=action&limit=200'),
          apiGet('inbox?status=awaiting&limit=50')
        ]);
        state.dashboard.health = baseResults[0];
        state.dashboard.sessions = ((baseResults[1] && baseResults[1].sessions) || []).filter(function(s) { return !isDemoSession(s); });
        state.dashboard.actions = ((baseResults[2] && baseResults[2].actions) || []).filter(isActionRenderable);
        state.dashboard.actionReviews = ((baseResults[3] && baseResults[3].items) || []).filter(isActionReviewRenderable);
        state.dashboard.inboxAwaiting = (baseResults[4] && baseResults[4].items) || [];
        if (showDebug) {
          var debugResults = await Promise.all([
            apiGet('memories?latest=true&limit=500'),
            apiGet('graph/stats'),
            apiGet('audit?limit=5'),
            apiGet('semantic'),
            apiGet('procedural'),
            apiGet('relations'),
            apiGet('lessons'),
            apiGet('delivery-status')
          ]);
          state.dashboard.memories = (debugResults[0] && debugResults[0].memories) || [];
          state.dashboard.graphStats = debugResults[1];
          state.dashboard.recentAudit = (debugResults[2] && debugResults[2].entries) || [];
          state.dashboard.semantic = (debugResults[3] && debugResults[3].facts) || (debugResults[3] && debugResults[3].semantic) || [];
          state.dashboard.procedural = (debugResults[4] && debugResults[4].procedures) || (debugResults[4] && debugResults[4].procedural) || [];
          state.dashboard.relations = (debugResults[5] && debugResults[5].relations) || [];
          state.dashboard.lessons = (debugResults[6] && debugResults[6].lessons) || [];
          state.dashboard.delivery = debugResults[7] || null;
        }
        state.dashboard.loaded = true;
        renderDashboard();
      } catch (err) {
        // Without this catch, any uncaught error in the await Promise.all
        // or the renderDashboard call leaves the dashboard stuck on
        // "Loading dashboard..." forever with no indication to the user
        // (#323). apiGet() already swallows network/HTTP errors and
        // returns null, but renderDashboard can still throw on shape
        // surprises (CSP-blocked event handler binding, undefined fields).
        // Surface the error in the panel + log full detail to console.
        var msg = (err && err.message) ? err.message : String(err);
        console.error('[viewer] loadDashboard failed:', err);
        el.innerHTML =
          '<div class="loading" style="color:var(--accent);">' +
          'Dashboard failed to load: ' + msg +
          '<br><br><span style="font-size:12px;color:var(--ink-muted);">' +
          'Check the browser console for the full error. If you see CSP ' +
          'violations, please open an issue with the AI Todo version ' +
          '(top-right of the viewer) and the violation text.' +
          '</span></div>';
      }
    }

    function deliveryBadgeClass(value) {
      if (value === 'ready') return 'badge-green';
      if (value === 'mostly-ready') return 'badge-yellow';
      return 'badge-muted';
    }
    function deliveryStatusLabel(value) {
      if (value === 'ready') return '已就绪';
      if (value === 'mostly-ready') return '基本可试';
      return '等待准备';
    }
    function publicReleaseLabel(value) {
      if (value === 'ready') return '可发布';
      return '等待证据';
    }
    function renderDeliveryStatusCard(delivery, options) {
      var showDebug = options && options.debug;
      if (!delivery) return '';
      if (delivery.available === false) {
        return '<div class="card" style="margin-bottom:16px;"><div class="card-title">浏览器入口</div><div style="font-size:13px;color:var(--ink-muted);line-height:1.55;">浏览器入口还没有打包。现在可以先在本机加载 <code>browser-extension/</code> 文件夹使用。</div></div>';
      }
      var real = delivery.realSiteValidation || {};
      var passed = Number(real.passedCount || 0);
      var required = Number(real.requiredCount || 4);
      var pct = required > 0 ? Math.round((passed / required) * 100) : 0;
      var external = delivery.externalTesting || 'not-ready';
      var publicState = delivery.publicRelease || 'not-ready';
      var notPassed = Array.isArray(real.notPassed) ? real.notPassed : [];
      var sites = Array.isArray(real.sites) ? real.sites : [];
      var zip = delivery.artifacts && delivery.artifacts.extensionZip ? delivery.artifacts.extensionZip : null;
      var zipLabel = zip && zip.exists ? '插件包已生成' : '插件包未生成';
      var version = delivery.extension && delivery.extension.version ? delivery.extension.version : '0.1.0';
      var next = notPassed.length ? notPassed.join('、') : '真实站点已齐';
      var html = '<div class="card" style="margin-bottom:16px;">';
      html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">';
      html += '<div><div class="card-title" style="margin-bottom:4px;">浏览器会话同步</div><div style="font-size:13px;color:var(--ink-muted);line-height:1.5;">打开 AI 会话页后自动同步，后续整理都在工作台完成。</div></div>';
      html += '<span class="badge ' + deliveryBadgeClass(external) + '">' + esc(zipLabel) + '</span>';
      html += '</div>';
      html += '<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--border-light);border-bottom:1px solid var(--border-light);margin-bottom:12px;">';
      html += '<div style="font-size:12px;color:var(--ink-muted);line-height:1.45;">' + esc(version) + ' · 支持 ChatGPT / Claude / Gemini 等 AI 会话页 · 真实页面证据 ' + passed + '/' + required + '</div>';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;"><a class="btn btn-primary" href="/artifacts/agent-memory-lab-extension.zip" target="_blank" rel="noopener">下载插件</a><a class="btn" href="#sessions">查看会话</a></div>';
      html += '</div>';
      if (!showDebug) {
        html += '<div style="font-size:12px;color:var(--ink-faint);line-height:1.45;">插件界面只显示同步状态，不在浏览器里做内容挑选。</div></div>';
        return html;
      }
      html += '<div class="stats-grid" style="margin-bottom:12px;">';
      html += '<div class="stat-card"><div class="label">插件自检</div><div class="value" style="font-size:22px;">' + esc(deliveryStatusLabel(delivery.localDemo)) + '</div><div class="sub">排错用预览页</div></div>';
      html += '<div class="stat-card"><div class="label">真实 AI 证据</div><div class="value" style="font-size:24px;">' + passed + '/' + required + '</div><div class="sub">公开发布必需</div></div>';
      html += '<div class="stat-card"><div class="label">公开发布</div><div class="value" style="font-size:22px;">' + esc(publicReleaseLabel(publicState)) + '</div><div class="sub">需真实站点通过</div></div>';
      html += '</div>';
      html += '<div style="border:1px solid var(--line);background:var(--surface-soft);padding:10px 12px;margin-bottom:12px;font-size:12px;color:var(--ink-secondary);line-height:1.45;">真实 AI 页面通过证据必须包含 <code>turnCount &gt; 0</code> 和会话区域 selector；插件只同步网页 AI 会话，不读取选中文本或输入草稿。</div>';
      html += '<div class="gauge" style="margin-bottom:10px;"><span class="gauge-label">AI 页面</span><div class="gauge-bar"><div class="gauge-fill" style="width:' + pct + '%;background:' + (pct >= 100 ? 'var(--green)' : 'var(--yellow)') + '"></div></div><span class="gauge-value">' + pct + '%</span></div>';
      if (sites.length) {
        html += '<div class="memory-card-grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:12px;">';
        sites.forEach(function(site) {
          var status = site.status || 'missing';
          var badge = status === 'passed' ? 'badge-green' : status === 'needs-fix' ? 'badge-yellow' : 'badge-muted';
          var label = status === 'passed' ? '已通过' : status === 'needs-fix' ? '待修复' : '待验收';
          var missing = Array.isArray(site.missing) && site.missing.length ? site.missing.join('、') : (status === 'passed' ? '证据完整' : '缺真实页面证据');
          html += '<div class="stat-card" style="padding:10px;">';
          html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;"><div class="label">' + esc(site.product || 'AI') + '</div><span class="badge ' + badge + '">' + label + '</span></div>';
          html += '<div class="sub" style="line-height:1.35;">' + esc(missing) + '</div>';
          if (site.file) html += '<div class="sub" style="margin-top:6px;overflow-wrap:anywhere;">' + esc(site.file) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }
      html += '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;">';
      html += '<div style="font-size:12px;color:var(--ink-muted);">下一步验收：' + esc(next) + '</div>';
      html += '<div style="display:flex;gap:8px;flex-wrap:wrap;"><a class="btn" href="/docs/external-tester-guide-cn.md" target="_blank" rel="noopener">外部试用指南</a><a class="btn" href="/docs/browser-extension-ai-site-test-cards-cn.md" target="_blank" rel="noopener">真实页面验收</a></div>';
      html += '</div></div>';
      return html;
    }
    function renderDashboard() {
      var el = document.getElementById('view-dashboard');
      var d = state.dashboard;
      var showDebug = new URLSearchParams(window.location.search).get('debug') === '1';
      var h = d.health || {};
      var snap = h.health || {};
      var healthStatus = h.status || 'unknown';
      var dotClass = healthStatus === 'healthy' ? 'healthy' : healthStatus === 'degraded' ? 'degraded' : healthStatus === 'critical' ? 'critical' : '';
      var activeSessions = d.sessions.filter(function(s) { return s.status === 'active'; }).length;
      var gs = d.graphStats || {};
      var nodeCount = gs.totalNodes !== undefined ? gs.totalNodes : (gs.nodes !== undefined ? gs.nodes : (gs.nodeCount || 0));
      var edgeCount = gs.totalEdges !== undefined ? gs.totalEdges : (gs.edges !== undefined ? gs.edges : (gs.edgeCount || 0));
      var fMetrics = h.functionMetrics || [];
      var cb = h.circuitBreaker || null;
      var workers = snap.workers || [];
      var actions = (d.actions || []).filter(isActionRenderable);
      var actionReviews = (d.actionReviews || []).filter(isActionReviewRenderable);
      var awaitingReplies = (d.inboxAwaiting || []).filter(function(i) { return i && i.kind === 'question'; });
      var followUps = actions.filter(function(a) { return a.status === 'pending' || a.status === 'blocked'; });

      var html = '';

      // First-run hero: empty dashboard = guided next step
      if (d.sessions.length === 0) {
        html += '<div class="card" style="margin-bottom:14px;padding:24px 28px;background:var(--bg-subtle);border-left:3px solid var(--accent);">' +
          '<div style="font-family:var(--font-ui);font-size:11px;letter-spacing:0.15em;text-transform:uppercase;color:var(--accent);font-weight:700;margin-bottom:8px;">' + t('dash.firstRun.kicker') + '</div>' +
          '<div style="font-family:var(--font-display,Lora,Georgia,serif);font-size:22px;font-weight:700;color:var(--ink);margin-bottom:8px;">' + t('dash.firstRun.title') + '</div>' +
          '<div style="font-size:13px;color:var(--ink-muted);margin-bottom:12px;line-height:1.5;max-width:640px;">' + t('dash.firstRun.body') + '</div>' +
          '<pre style="display:inline-block;margin:0;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:4px;font-family:var(--font-mono);font-size:12px;color:var(--ink);">node dist/cli.mjs demo</pre>' +
          '<div style="margin-top:10px;"><a class="empty-link" href="https://github.com/MaimoryLab/agentmemory-lab#quick-start" target="_blank" rel="noopener" style="font-size:12px;">' + t('dash.firstRun.link') + '</a></div>' +
          '</div>';
      }
      html += '<div class="stats-grid">';
      var latestSessionTime = d.sessions.length ? shortDateTime(sessionRecordTime(d.sessions.slice().sort(function(a, b) { return (sessionRecordTime(b) || '').localeCompare(sessionRecordTime(a) || ''); })[0])) : t('dash.noRecord');
      html += '<div class="stat-card"><div class="label">' + t('dash.stat.sessions') + '</div><div class="value">' + d.sessions.length + '</div><div class="sub">' + t('dash.stat.recent') + ' ' + esc(latestSessionTime) + '</div></div>';
      html += '<div class="stat-card"><div class="label">' + t('dash.stat.todos') + '</div><div class="value">' + actions.length + '</div><div class="sub"><a href="#actions">' + t('dash.stat.openWorkbench') + '</a></div></div>';
      html += '<div class="stat-card"><div class="label">' + t('act.metric.waiting') + '</div><div class="value">' + awaitingReplies.length + '</div><div class="sub"><a href="#actions">' + t('dash.stat.replyQueue') + '</a></div></div>';
      html += '<div class="stat-card"><div class="label">' + t('act.metric.review') + '</div><div class="value">' + actionReviews.length + '</div><div class="sub"><a href="#actions">' + t('dash.stat.actionCandidates') + '</a></div></div>';
      html += '<div class="stat-card"><div class="label">' + t('act.metric.followUp') + '</div><div class="value">' + followUps.length + '</div><div class="sub"><a href="#actions">' + t('dash.stat.pendingActions') + '</a></div></div>';
      var lessonCount = (d.lessons || []).length;
      if (showDebug) {
        html += '<div class="stat-card"><div class="label">' + t('dash.stat.memories') + '</div><div class="value">' + d.memories.length + '</div><div class="sub">' + t('dash.stat.latestVersion') + '</div></div>';
        html += '<div class="stat-card"><div class="label">' + t('dash.stat.lessons') + '</div><div class="value">' + lessonCount + '</div><div class="sub">' + t('dash.stat.lessonsSub') + '</div></div>';
      }
      if (showDebug && (nodeCount > 0 || edgeCount > 0)) {
        html += '<div class="stat-card"><div class="label">' + t('dash.stat.graphNodes') + '</div><div class="value">' + nodeCount + '</div><div class="sub">' + t('dash.stat.edges') + ' ' + edgeCount + '</div></div>';
      }
      if (showDebug) {
        html += '<div class="stat-card"><div class="label">' + t('dash.stat.status') + '</div><div class="value"><div class="health-bar"><span class="health-dot ' + dotClass + '"></span> ' + esc(healthStatus) + '</div></div>';
        html += '<div class="sub">' + esc(snap.connectionState || 'unknown') + '</div></div>';
      }
      if (showDebug) {
        var totalCalls = fMetrics.reduce(function(a, m) { return a + (m.totalCalls || 0); }, 0);
        html += '<div class="stat-card"><div class="label">' + t('dash.stat.toolCalls') + '</div><div class="value">' + totalCalls + '</div><div class="sub">' + t('dash.stat.tracking') + ' ' + fMetrics.length + ' ' + t('dash.stat.functions') + '</div></div>';
      }
      if (showDebug && cb) {
        var cbClass = cb.state === 'closed' ? 'cb-closed' : cb.state === 'open' ? 'cb-open' : 'cb-half-open';
        html += '<div class="stat-card"><div class="label">' + t('dash.stat.circuitBreaker') + '</div><div class="value"><span class="cb-indicator ' + cbClass + '">' + esc(cb.state) + '</span></div>';
        html += '<div class="sub">' + t('dash.stat.failed') + ' ' + (cb.failures || 0) + ' ' + t('dash.stat.times') + '</div></div>';
      }
      var totalObs = d.sessions.reduce(function(a, s) { return a + (s.observationCount || 0); }, 0);
      var tokenBudget = parseInt(new URLSearchParams(window.location.search).get('tokenBudget') || '2000', 10) || 2000;
      var estFull = totalObs * 80;
      var estInjected = d.sessions.length * tokenBudget;
      var savings = estFull > 0 ? Math.round((1 - estInjected / Math.max(estFull, 1)) * 100) : 0;
      if (savings < 0) savings = 0;
      html += '</div>';

      html += renderDeliveryStatusCard(d.delivery, { debug: showDebug });

      if (showDebug && (snap.memory || snap.cpu)) {
        html += '<div class="card" style="margin-bottom:16px"><div class="card-title">' + t('dash.systemResources') + '</div>';
        if (snap.memory) {
          var heapUsed = Math.round((snap.memory.heapUsed || 0) / 1024 / 1024);
          var heapTotal = Math.round((snap.memory.heapTotal || 0) / 1024 / 1024);
          var rss = Math.round((snap.memory.rss || 0) / 1024 / 1024);
          var heapPct = heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100) : 0;
          var rssAboveFloor = rss >= 512;
          var heapColor = (heapPct > 80 && rssAboveFloor) ? 'var(--red)' : (heapPct > 60 && rssAboveFloor) ? 'var(--yellow)' : 'var(--green)';
          html += '<div class="gauge"><span class="gauge-label">Heap</span><div class="gauge-bar"><div class="gauge-fill" style="width:' + heapPct + '%;background:' + heapColor + '"></div></div><span class="gauge-value">' + heapUsed + ' / ' + heapTotal + ' MB</span></div>';
          html += '<div class="gauge"><span class="gauge-label">RSS</span><div class="gauge-bar"><div class="gauge-fill" style="width:' + Math.min(100, Math.round(rss / 512 * 100)) + '%;background:var(--blue)"></div></div><span class="gauge-value">' + rss + ' MB</span></div>';
          if (snap.memory.external) {
            var ext = Math.round(snap.memory.external / 1024 / 1024);
            html += '<div class="gauge"><span class="gauge-label">External</span><div class="gauge-bar"><div class="gauge-fill" style="width:' + Math.min(100, Math.round(ext / 128 * 100)) + '%;background:var(--purple)"></div></div><span class="gauge-value">' + ext + ' MB</span></div>';
          }
        }
        if (snap.cpu) {
          var cpuPct = snap.cpu.percent || 0;
          var cpuColor = cpuPct > 80 ? 'var(--red)' : cpuPct > 50 ? 'var(--yellow)' : 'var(--green)';
          html += '<div class="gauge"><span class="gauge-label">CPU</span><div class="gauge-bar"><div class="gauge-fill" style="width:' + Math.min(100, cpuPct) + '%;background:' + cpuColor + '"></div></div><span class="gauge-value">' + cpuPct.toFixed(1) + '%</span></div>';
        }
        if (snap.eventLoopLagMs !== undefined) {
          var lag = snap.eventLoopLagMs;
          var lagColor = lag > 100 ? 'var(--red)' : lag > 20 ? 'var(--yellow)' : 'var(--green)';
          html += '<div class="gauge"><span class="gauge-label">Event Loop</span><div class="gauge-bar"><div class="gauge-fill" style="width:' + Math.min(100, lag) + '%;background:' + lagColor + '"></div></div><span class="gauge-value">' + lag.toFixed(1) + ' ms</span></div>';
        }
        if (snap.uptimeSeconds) {
          var mins = Math.floor(snap.uptimeSeconds / 60);
          var hrs = Math.floor(mins / 60);
          var upStr = hrs > 0 ? hrs + 'h ' + (mins % 60) + 'm' : mins + 'm';
          html += '<div style="font-size:10px;color:var(--ink-faint);margin-top:6px;font-family:var(--font-mono);letter-spacing:0.04em;">UPTIME: ' + upStr + '</div>';
        }
        html += '</div>';
      }

      if (showDebug && snap.alerts && snap.alerts.length > 0) {
        html += '<div class="card" style="margin-bottom:16px;border-color:var(--accent);border-width:2px;"><div class="card-title" style="color:var(--accent);border-bottom-color:var(--accent);">' + t('dash.alerts') + ' (' + snap.alerts.length + ')</div>';
        snap.alerts.forEach(function(al) {
          html += '<div style="font-size:12px;color:var(--accent);padding:4px 0;border-bottom:1px solid var(--border-light);font-family:var(--font-ui);">' + esc(al) + '</div>';
        });
        html += '</div>';
      }

      if (showDebug && snap.notes && snap.notes.length > 0) {
        html += '<div class="card" style="margin-bottom:16px;"><div class="card-title" style="color:var(--ink-muted);">' + t('dash.notes') + ' (' + snap.notes.length + ')</div>';
        snap.notes.forEach(function(n) {
          html += '<div style="font-size:12px;color:var(--ink-muted);padding:4px 0;border-bottom:1px solid var(--border-light);font-family:var(--font-ui);">' + esc(n) + '</div>';
        });
        html += '</div>';
      }

      html += '<div class="card"><div class="card-title">' + t('dash.recentSessions') + '</div>';
      if (d.sessions.length === 0) {
        html += '<div class="empty-state"><p>' + t('dash.emptySessions') + '</p></div>';
      } else {
        var recentGroups = groupSessionsByProject(d.sessions).slice(0, 5);
        html += '<div class="folder-grid">';
        recentGroups.forEach(function(g) {
          var latest = g.sessions && g.sessions[0];
          var latestId = sessionId(latest);
          var cardName = g.hasMissingId ? t('dash.unnamedSession') : g.name;
          html += '<button type="button" class="folder-card" data-action="open-session-group" data-session-id="' + esc(latestId || '') + '" title="' + esc(g.key) + '" aria-label="' + t('dash.openLatestSyncOf') + ' ' + esc(cardName) + '">';
          html += '<div class="folder-title">' + esc(cardName) + '</div>';
          html += '<div class="folder-path">' + esc(g.key) + '</div>';
          html += '<div class="folder-meta">';
          html += '<span><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/></svg>' + g.count + ' ' + t('dash.syncs') + '</span>';
          html += '<span><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5A2.5 2.5 0 0 1 7.5 2H19v20H7.5A2.5 2.5 0 0 1 5 19.5z"/><path d="M5 19.5A2.5 2.5 0 0 1 7.5 17H19"/></svg>' + g.observations + ' ' + t('dash.records') + '</span>';
          html += '</div>';
          html += '<div class="folder-time">' + t('dash.lastSync') + ' ' + esc(shortDateTime(g.latest)) + '</div>';
          html += '</button>';
        });
        html += '</div>';
      }
      html += '</div>';

      if (showDebug && fMetrics.length > 0) {
        var sorted = fMetrics.slice().sort(function(a, b) { return (b.totalCalls || 0) - (a.totalCalls || 0); });
        html += '<div class="card" style="margin-top:16px"><div class="card-title">' + t('dash.functionMetrics') + '</div>';
        html += '<table class="metric-table"><tr><th>Function</th><th style="text-align:right">Calls</th><th style="text-align:right">Success</th><th style="text-align:right">Fail</th><th style="text-align:right">Avg Latency</th><th style="text-align:right">Quality</th></tr>';
        sorted.forEach(function(m) {
          var successRate = m.totalCalls > 0 ? Math.round((m.successCount / m.totalCalls) * 100) : 0;
          var rateColor = successRate >= 95 ? 'var(--green)' : successRate >= 80 ? 'var(--yellow)' : 'var(--red)';
          var latencyColor = m.avgLatencyMs > 1000 ? 'var(--red)' : m.avgLatencyMs > 200 ? 'var(--yellow)' : 'var(--green)';
          html += '<tr>';
          html += '<td class="metric-fn">' + esc(m.functionId) + '</td>';
          html += '<td class="metric-num">' + m.totalCalls + '</td>';
          html += '<td class="metric-num" style="color:' + rateColor + '">' + m.successCount + ' (' + successRate + '%)</td>';
          html += '<td class="metric-num" style="color:' + (m.failureCount > 0 ? 'var(--red)' : 'var(--ink-faint)') + '">' + m.failureCount + '</td>';
          html += '<td class="metric-num" style="color:' + latencyColor + '">' + Math.round(m.avgLatencyMs) + ' ms</td>';
          html += '<td class="metric-num">' + (m.avgQualityScore > 0 ? m.avgQualityScore.toFixed(2) : '-') + '</td>';
          html += '</tr>';
        });
        html += '</table></div>';
      }

      if (showDebug && workers.length > 0) {
        html += '<div class="card" style="margin-top:16px"><div class="card-title">' + t('dash.workers') + '</div>';
        workers.forEach(function(w) {
          var statusClass = w.status === 'running' ? 'running' : w.status === 'starting' ? 'starting' : 'stopped';
          html += '<div class="worker-row"><span class="worker-dot ' + statusClass + '"></span>';
          html += '<span style="color:var(--ink);font-weight:600;font-family:var(--font-ui);font-size:12px;">' + esc(w.name) + '</span>';
          html += '<span class="badge ' + (w.status === 'running' ? 'badge-green' : 'badge-muted') + '">' + esc(w.status) + '</span>';
          html += '<span style="font-size:10px;color:var(--ink-faint);font-family:var(--font-mono);">' + esc(w.id) + '</span></div>';
        });
        html += '</div>';
      }

      if (showDebug && cb && cb.state !== 'closed') {
        html += '<div class="card" style="margin-top:16px;border-color:var(--accent);border-width:2px;"><div class="card-title" style="color:var(--accent);">' + t('dash.circuitBreakerDetail') + '</div>';
        html += '<div class="detail-row"><div class="dl">State</div><div class="dv"><span class="cb-indicator ' + (cb.state === 'open' ? 'cb-open' : 'cb-half-open') + '">' + esc(cb.state) + '</span></div></div>';
        html += '<div class="detail-row"><div class="dl">Failures</div><div class="dv" style="color:var(--accent);font-family:var(--font-mono);">' + (cb.failures || 0) + '</div></div>';
        if (cb.lastFailureAt) html += '<div class="detail-row"><div class="dl">Last Failure</div><div class="dv" style="font-family:var(--font-mono);font-size:12px;">' + esc(formatTime(cb.lastFailureAt)) + '</div></div>';
        if (cb.openedAt) html += '<div class="detail-row"><div class="dl">Opened At</div><div class="dv" style="font-family:var(--font-mono);font-size:12px;">' + esc(formatTime(cb.openedAt)) + '</div></div>';
        html += '</div>';
      }

      if (showDebug) {
      var semFacts = d.semantic || [];
      var procItems = d.procedural || [];
      var relItems = d.relations || [];

      html += '<hr class="section-rule">';
      html += '<div class="two-col">';

      html += '<div class="card"><div class="card-title">' + t('dash.semanticMemory') + '</div>';
      if (semFacts.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">' + t('dash.emptySemantic') + '</div>';
      } else {
          semFacts.slice(0, 5).forEach(function(f) {
            var conf = typeof f.confidence === 'number' ? Math.round(f.confidence * 100) : null;
            var str = typeof f.strength === 'number' ? Math.round(f.strength * 100) : null;
            var barColor = (str || 0) > 70 ? 'var(--green)' : (str || 0) > 40 ? 'var(--yellow)' : 'var(--red)';
            html += '<div class="memory-fact">';
            html += '<span style="color:var(--ink);">' + esc(f.fact || f.content || f.title || 'Fact') + '</span>';
            html += '<span style="display:flex;align-items:center;gap:6px;">';
            if (str !== null) html += '<span class="strength-bar" style="width:40px;"><span class="fill" style="width:' + str + '%;background:' + barColor + '"></span></span>';
            if (conf !== null) html += '<span style="font-size:10px;font-family:var(--font-mono);color:var(--ink-faint);">' + conf + '%</span>';
            html += '</span></div>';
          });
        }
        html += '</div>';

        html += '<div class="card"><div class="card-title">' + t('dash.proceduralMemory') + '</div>';
      if (procItems.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">' + t('dash.emptyProcedural') + '</div>';
      } else {
          procItems.slice(0, 5).forEach(function(p) {
            html += '<div class="procedure-item">';
            html += '<div style="font-weight:600;color:var(--ink);font-family:var(--font-display);font-size:13px;">' + esc(p.name || p.title || 'Procedure') + '</div>';
            if (p.trigger || p.triggerCondition) html += '<div style="font-size:11px;color:var(--ink-faint);font-family:var(--font-mono);margin-top:2px;">Trigger: ' + esc(p.trigger || p.triggerCondition) + '</div>';
            if (p.frequency) html += '<div style="font-size:11px;color:var(--ink-faint);margin-top:2px;">Freq: ' + p.frequency + '</div>';
            if (p.steps && p.steps.length > 0) {
              html += '<ol class="procedure-steps">';
              p.steps.slice(0, 4).forEach(function(s) { html += '<li>' + esc(typeof s === 'string' ? s : s.description || s.action || JSON.stringify(s)) + '</li>'; });
              if (p.steps.length > 4) html += '<li style="color:var(--ink-faint);font-style:italic;">+ ' + (p.steps.length - 4) + ' more...</li>';
              html += '</ol>';
            }
            html += '</div>';
          });
        }
      html += '</div>';

      html += '</div>';

      html += '<div class="card" style="margin-top:16px;"><div class="card-title">' + t('dash.consolidationStatus') + '</div>';
      html += '<div class="consolidation-row"><span class="cl">Semantic facts</span><span class="cv">' + semFacts.length + '</span></div>';
      html += '<div class="consolidation-row"><span class="cl">Procedures</span><span class="cv">' + procItems.length + '</span></div>';
      html += '<div class="consolidation-row"><span class="cl">Relations</span><span class="cv">' + relItems.length + '</span></div>';
      html += '</div>';

      if (relItems.length > 0) {
        html += '<div class="card" style="margin-top:16px;"><div class="card-title">' + t('dash.memoryRelations') + '</div>';
        relItems.slice(0, 8).forEach(function(r) {
          var relType = r.type || r.relationType || 'related';
          var badgeClass = relType === 'supersedes' ? 'badge-red' : relType === 'extends' ? 'badge-green' : relType === 'contradicts' ? 'badge-yellow' : 'badge-muted';
          html += '<div style="padding:4px 0;border-bottom:1px solid var(--border-light);font-size:12px;display:flex;align-items:center;gap:6px;">';
          html += '<span style="font-family:var(--font-mono);color:var(--blue);font-size:11px;">' + esc(truncate(r.sourceId || r.fromId || '', 8)) + '</span>';
          html += '<span class="badge ' + badgeClass + '">' + esc(relType) + '</span>';
          html += '<span style="font-family:var(--font-mono);color:var(--blue);font-size:11px;">' + esc(truncate(r.targetId || r.toId || '', 8)) + '</span>';
          html += '</div>';
        });
        html += '</div>';
      }
      }

      el.innerHTML = html;
    }

    var dashboardTimer = null;
    function refreshDashboard() {
      state.dashboard.loaded = false;
      loadDashboard();
    }
    function isViewingSessionDetail() {
      return state.activeTab === 'sessions' && !!state.sessions.selectedId;
    }
    function shouldDeferSessionsRefresh(reason) {
      return isViewingSessionDetail() && ['timer', 'poll', 'ws', 'visibility'].indexOf(reason || '') >= 0;
    }
    function sessionStaleNoticeMarkup() {
      if (!state.sessions.stale || !state.sessions.selectedId) return '';
      return '<div class="activity-status-card activity-status-warning" style="margin-bottom:12px;"><div class="activity-status-main"><span class="activity-status-dot"></span><span>有新记录，当前详情暂未自动刷新。</span></div><button class="btn btn-primary" data-action="refresh-sessions">刷新会话</button></div>';
    }
    function renderSessionsStaleNotice() {
      var host = document.getElementById('sessions-stale-notice');
      if (host) host.innerHTML = sessionStaleNoticeMarkup();
    }
    function markSessionsStale() {
      state.sessions.stale = true;
      if (state.activeTab === 'sessions') renderSessionsStaleNotice();
    }
    function markActionsStale(message) {
      state.actions.stale = true;
      if (message) state.actions.extractMessage = message;
      if (state.activeTab === 'actions' && !actionsScrolledAway()) renderActions();
    }
    function refreshActiveTab(reason) {
      reason = reason || 'manual';
      switch (state.activeTab) {
        case 'dashboard': state.dashboard.loaded = false; loadDashboard(); break;
        case 'memories': state.memories.loaded = false; loadMemories(); break;
        case 'sessions':
          if (shouldDeferSessionsRefresh(reason)) {
            markSessionsStale();
          } else {
            state.sessions.loaded = false;
            loadSessions({ showLoading: reason === 'manual', reason: reason });
          }
          break;
        case 'lessons': state.lessons.loaded = false; loadLessons(); break;
        case 'actions':
          if (reason === 'manual') {
            state.actions.loaded = false;
            loadActions({ generate: false });
          } else {
            markActionsStale('有新会话记录，待办暂未自动刷新。');
          }
          break;
        case 'activity': state.activity.loaded = false; loadActivity(); break;
      }
    }
    function markMemoryViewsStale() {
      state.dashboard.loaded = false;
      state.memories.loaded = false;
      state.sessions.loaded = false;
      state.lessons.loaded = false;
      state.actions.loaded = false;
      state.activity.loaded = false;
    }
    function saveDashboardRefreshPrefs() {
      try {
        localStorage.setItem('viewer_dashboard_refresh_enabled', state.dashboardRefresh.enabled ? '1' : '0');
        localStorage.setItem('viewer_dashboard_refresh_interval', String(state.dashboardRefresh.intervalMs));
      } catch {}
    }
    function loadDashboardRefreshPrefs() {
      try {
        var enabled = localStorage.getItem('viewer_dashboard_refresh_enabled');
        var interval = parseInt(localStorage.getItem('viewer_dashboard_refresh_interval') || '', 10);
        if (enabled === '0') state.dashboardRefresh.enabled = false;
        if (!Number.isNaN(interval) && interval >= 10000 && interval <= 120000) state.dashboardRefresh.intervalMs = interval;
      } catch {}
    }
    function startDashboardAutoRefresh() {
      if (dashboardTimer) clearInterval(dashboardTimer);
      if (!state.dashboardRefresh.enabled) return;
      dashboardTimer = setInterval(function() {
        if (pollTimer) return;
        if (state.activeTab === 'dashboard') refreshActiveTab('timer');
      }, state.dashboardRefresh.intervalMs || 30000);
    }

    var graphSim = { nodes: [], edges: [], running: false, canvas: null, ctx: null, raf: null, panX: 0, panY: 0, zoom: 1, dragNode: null, mouseX: 0, mouseY: 0, tickCount: 0, quietTicks: 0 };
    function wakeGraphSim() {
      graphSim.quietTicks = 0;
      if (graphSim.running && !graphSim.raf) {
        graphSim.raf = requestAnimationFrame(runSimulation);
      }
    }

