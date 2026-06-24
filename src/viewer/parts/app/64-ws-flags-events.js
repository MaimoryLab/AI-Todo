    function connectWs() {
      if (wsRetries >= WS_MAX_RETRIES) {
        startPolling();
        return;
      }
      var useDirect = !directFailed;
      var ws;
      try {
        ws = new WebSocket(useDirect ? WS_DIRECT_URL : WS_URL);
        ws.__direct = useDirect;
      } catch (_) {
        ws = new WebSocket(WS_URL);
        ws.__direct = false;
      }
      var connectTimer = setTimeout(function() {
        if (ws.readyState === WebSocket.CONNECTING) {
          try { ws.close(); } catch {}
        }
      }, WS_CONNECT_TIMEOUT_MS);
      try {
        ws.onopen = function() {
          clearTimeout(connectTimer);
          if (state.ws !== ws) return;
          wsRetries = 0;
          stopPolling();
          if (ws.__direct) {
            directFailures = 0;
            directFailed = false;
          }
          if (!ws.__direct) {
            ws.send(JSON.stringify({
              type: 'join',
              data: {
                subscriptionId: 'viewer-' + Date.now(),
                streamName: 'mem-live',
                groupId: 'viewer'
              }
            }));
          }
          setWsStatus('live', 'connected');
        };
        ws.onmessage = function(e) {
          if (state.ws !== ws) return;
          try {
            var msg = JSON.parse(e.data);
            if (msg.type === 'stream' && msg.event) {
              handleStreamEvent(msg);
            } else if (msg.event_type && msg.data) {
              handleStreamEvent({ event: { type: 'create', data: msg.data, event_type: msg.event_type } });
            }
          } catch {}
        };
        ws.onclose = function() {
          clearTimeout(connectTimer);
          if (state.ws !== ws) return;
          if (ws.__direct) {
            directFailures += 1;
            if (directFailures >= DIRECT_FAILURE_THRESHOLD) {
              directFailed = true;
            }
          }
          wsRetries++;
          if (wsRetries < WS_MAX_RETRIES) {
            setWsStatus('connecting...', 'disconnected');
            wsReconnectTimer = setTimeout(connectWs, 2000 + Math.min(wsRetries * 1000, 8000));
          } else {
            startPolling();
          }
        };
        ws.onerror = function() {
          if (state.ws !== ws) return;
          try { ws.close(); } catch {}
        };
        state.ws = ws;
      } catch {
        wsRetries++;
        if (wsRetries < WS_MAX_RETRIES) {
          wsReconnectTimer = setTimeout(connectWs, 2000 + Math.min(wsRetries * 1000, 8000));
        } else {
          startPolling();
        }
      }
    }

    function looksLikeObservation(obj) {
      return !!(obj && typeof obj === 'object' && obj.id && obj.timestamp);
    }

    function handleStreamEvent(msg) {
      var evt = msg.event;
      var observation;
      if (!evt) return;
      if (evt.event_type && evt.event_type !== 'observation' && evt.event_type !== 'create' && evt.event_type !== 'update') {
        return;
      }
      if (evt.type === 'event' && evt.data) {
        observation = evt.data.observation || evt.data;
        if (looksLikeObservation(observation)) {
          routeWsMessage({ observation: observation });
        }
        return;
      }
      if ((evt.type === 'create' || evt.type === 'update') && evt.data) {
        var payload = evt.data;
        observation = payload.observation || payload;
        if (looksLikeObservation(observation)) {
          routeWsMessage({ observation: observation });
        }
      } else if (evt.type === 'sync') {
        var items = Array.isArray(evt.data) ? evt.data : [];
        items.forEach(function(item) {
          var payload = item.data || item;
          observation = payload.observation || payload;
          if (looksLikeObservation(observation)) {
            routeWsMessage({ observation: observation });
          }
        });
      }
    }

    function routeWsMessage(msg) {
      markMemoryViewsStale();
      if (state.activeTab === 'timeline' && msg.observation) {
        if (!state.timeline.sessionId || msg.observation.sessionId === state.timeline.sessionId) {
          var existing = state.timeline.observations.findIndex(function(o) { return o.id === msg.observation.id; });
          if (existing >= 0) {
            state.timeline.observations[existing] = msg.observation;
          } else {
            state.timeline.observations.unshift(msg.observation);
          }
          renderObservations();
        }
      }
      if (state.activeTab === 'dashboard') {
        loadDashboard();
      }
      if (state.activeTab === 'memories') loadMemories();
      if (state.activeTab === 'sessions') {
        if (isViewingSessionDetail()) {
          markSessionsStale();
        } else {
          state.sessions.loaded = false;
          loadSessions({ showLoading: false, reason: 'ws' });
        }
      }
      if (state.activeTab === 'lessons') loadLessons();
      if (state.activeTab === 'actions') markActionsStale('有新会话记录，待办暂未自动刷新。');
      if (state.activeTab === 'activity' && msg.observation) {
        state.activity.observations.unshift(msg.observation);
        renderActivity();
      }
    }

    document.getElementById('tab-bar').addEventListener('click', function(e) {
      var toggle = e.target instanceof Element ? e.target.closest('#expert-toggle') : null;
      if (toggle) {
        toggleExpertMode();
        return;
      }
      var btn = e.target instanceof Element ? e.target.closest('button[data-tab]') : null;
      if (btn) {
        switchTab(btn.dataset.tab);
        return;
      }
    });

    document.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var jump = e.target.closest('[data-dashboard-jump]');
      if (!jump) return;
      var tab = jump.getAttribute('data-dashboard-jump');
      if (!tab) return;
      switchTab(tab);
    });

    document.querySelectorAll('[data-tab-link]').forEach(function(link) {
      link.addEventListener('click', function(e) {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        switchTab(link.getAttribute('data-tab-link'));
      });
    });

    function syncTabFromRoute() {
      switchTab(tabFromRoute(), { replaceRoute: true });
    }
    window.addEventListener('hashchange', syncTabFromRoute);
    window.addEventListener('popstate', syncTabFromRoute);

    // --- Feature flag banners ---------------------------------------------
    function getDismissedFlags() {
      if (!state.flagsDismissed) state.flagsDismissed = {};
      return state.flagsDismissed;
    }
    function dismissFlags(keys) {
      var dismissed = getDismissedFlags();
      keys.forEach(function(key) {
        if (key) dismissed[key] = true;
      });
    }
    function renderFlagBanners(cfg) {
      var host = document.getElementById('flag-banners');
      if (!host) return;
      var dismissed = getDismissedFlags();
      var banners = [];
      function toHumanTitle(raw) {
        if (!raw) return '功能未开启';
        var key = String(raw).toLowerCase();
        if (key.indexOf('knowledge graph') >= 0) return '关系图自动提取未开启';
        if (key.indexOf('llm provider') >= 0) return '智能分析未开启';
        if (key.indexOf('bm25-only') >= 0) return '仅关键词检索模式';
        return raw;
      }
      function toHumanDesc(raw) {
        if (!raw) return '开启后可获得更完整的记忆分析能力。';
        var s = String(raw);
        if (s.indexOf('Compression, summarization, and graph extraction') >= 0) {
          return '当前只能使用基础能力；摘要、压缩和关系图能力暂不可用。';
        }
        if (s.indexOf('Extracts entities and relations') >= 0) {
          return '系统暂不会自动生成关系图。';
        }
        if (s.indexOf('Semantic vector search is off') >= 0) {
          return '当前搜索偏向关键词匹配，语义理解能力较弱。';
        }
        return s;
      }
      // Per-flag banner (only for off flags, affecting current tab or dashboard)
      (cfg.flags || []).forEach(function(f) {
        if (f.enabled) return;
        if (dismissed[f.key]) return;
        var tabsAffected = (f.affects || []).map(function(t) { return t.toLowerCase(); });
        if (tabsAffected.length && tabsAffected.indexOf(state.activeTab) === -1 && state.activeTab !== 'dashboard') return;
        banners.push({
          kind: 'warn',
          icon: '&#9673;',
          title: toHumanTitle(f.label),
          keyLabel: f.key,
          desc: toHumanDesc(f.description) + (f.needsLlm ? ' 需要先连接智能模型。' : ''),
          enable: f.enableHow,
          docs: f.docsHref,
          dismissKey: f.key,
        });
      });
      if (cfg.provider === 'noop' && !dismissed['__provider_noop']) {
        banners.unshift({
          kind: 'warn',
          icon: '&#9673;',
          title: '智能分析未开启',
          keyLabel: 'ANTHROPIC_API_KEY',
          desc: '当前只能用基础功能；摘要、关系图与自动提炼暂不可用。',
          enable: 'export ANTHROPIC_API_KEY=sk-ant-...\n# then restart: npm run start:local-memory',
          docs: 'https://github.com/MaimoryLab/agentmemory-lab#quick-start',
          dismissKey: '__provider_noop',
        });
      }
      if (cfg.embeddingProvider === 'none' && !dismissed['__embedding_none']) {
        banners.push({
          kind: 'info',
          icon: '&#9673;',
          title: '仅关键词检索模式',
          keyLabel: 'OPENAI_API_KEY',
          desc: '当前搜索偏向关键词匹配，语义理解能力较弱。',
          enable: 'export OPENAI_API_KEY=sk-...\n# or VOYAGE_API_KEY, COHERE_API_KEY, OLLAMA_HOST',
          docs: 'https://github.com/MaimoryLab/agentmemory-lab#embedding-providers',
          dismissKey: '__embedding_none',
        });
      }
      if (banners.length === 0) { host.innerHTML = ''; return; }
      var warnCount = banners.filter(function(b) { return b.kind === 'warn'; }).length;
      var infoCount = banners.filter(function(b) { return b.kind === 'info'; }).length;
      var expanded = host.getAttribute('data-expanded') === '1';
      var pills = '';
      if (warnCount) pills += '<span class="flag-pill">' + warnCount + ' 项待开启</span>';
      if (infoCount) pills += '<span class="flag-pill info">' + infoCount + ' 条提示</span>';
      var escHtml = function(s) {
        return String(s).replace(/[<>&"]/g, function(c) {
          return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c];
        });
      };
      var listHtml = banners.map(function(b) {
        return '<div class="flag-banner ' + b.kind + '" data-flag="' + escHtml(b.dismissKey) + '">' +
          '<span class="flag-icon">' + b.icon + '</span>' +
          '<div class="flag-body">' +
            '<div class="flag-title">' + escHtml(b.title) + '</div>' +
            '<div class="flag-desc">' + escHtml(b.desc) + '</div>' +
            '<code class="flag-enable">' + escHtml(b.enable) + '</code>' +
            (b.docs ? ' <a class="empty-link" href="' + escHtml(b.docs) + '" target="_blank" rel="noopener">查看设置步骤</a>' : '') +
          '</div>' +
          '<button type="button" class="flag-close" data-dismiss-flag="' + escHtml(b.dismissKey) + '" aria-label="关闭">&times;</button>' +
        '</div>';
      }).join('');
      host.innerHTML = '<button type="button" class="flag-summary" data-action="toggle-flags" aria-expanded="' + (expanded ? 'true' : 'false') + '" aria-controls="flag-list">' +
          pills +
          '<span class="flag-count">高级能力设置</span>' +
          '<span style="color:var(--ink-faint);">— ' + (expanded ? '收起' : '展开') + '</span>' +
          '<span class="flag-toggle" aria-hidden="true">' + (expanded ? '&#9650;' : '&#9660;') + '</span>' +
        '</button>' +
        '<div class="flag-list' + (expanded ? ' open' : '') + '" id="flag-list">' + listHtml + '</div>';
    }
    async function fetchFlags() {
      var res = await apiGet('config/flags');
      if (!res) return;
      state.flagsConfig = res;
      renderFlagBanners(res);
      updateFooter(res);
    }
    function updateFooter(cfg) {
      var fbEl = document.getElementById('footer-feedback');
      if (fbEl) {
        var flagSummary = (cfg.flags || []).map(function(f) { return f.key + '=' + (f.enabled ? 'on' : 'off'); }).join(', ');
        var body = encodeURIComponent(
          '**Version:** ' + (cfg.version || '?') + '\n' +
          '**Provider:** ' + (cfg.provider || '?') + '\n' +
          '**Embedding:** ' + (cfg.embeddingProvider || '?') + '\n' +
          '**Flags:** ' + flagSummary + '\n' +
          '**User agent:** ' + navigator.userAgent + '\n\n' +
          '### What went wrong\n\n' +
          '(describe the issue)\n\n' +
          '### Steps to reproduce\n\n' +
          '1. \n2. \n3. \n'
        );
        fbEl.href = 'https://github.com/MaimoryLab/agentmemory-lab/issues/new?title=' +
          encodeURIComponent('[viewer] ') + '&body=' + body;
      }
    }
    document.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var btn = e.target.closest('[data-dismiss-flag]');
      if (btn) {
        e.preventDefault();
        e.stopPropagation();
        var key = btn.getAttribute('data-dismiss-flag');
        dismissFlags([key]);
        if (state.flagsConfig) renderFlagBanners(state.flagsConfig);
        return;
      }
      var toggle = e.target.closest('[data-action="toggle-flags"]');
      if (toggle) {
        var host = document.getElementById('flag-banners');
        var cur = host.getAttribute('data-expanded') === '1';
        host.setAttribute('data-expanded', cur ? '0' : '1');
        if (state.flagsConfig) renderFlagBanners(state.flagsConfig);
      }
    });
    fetchFlags();
    document.addEventListener('click', function(e) {
      if (!(e.target instanceof Element)) return;
      var target = e.target.closest('[data-action]');
      if (!target) return;
      var action = target.getAttribute('data-action');
      if (!action) return;

      if (action === 'toggle-theme') {
        toggleTheme();
        return;
      }
      if (action === 'clear-audit-filter') {
        state.audit.opFilter = '';
        renderAudit();
        return;
      }
      if (action === 'refresh-audit') {
        state.audit.loaded = false;
        loadAudit();
        return;
      }
      if (action === 'refresh-dashboard') {
        refreshDashboard();
        return;
      }
      if (action === 'refresh-activity') {
        state.activity.loaded = false;
        loadActivity();
        return;
      }
      if (action === 'refresh-actions') {
        state.actions.loaded = false;
        loadActions({ generate: false });
        return;
      }
      if (action === 'extract-actions') {
        startTodoExtraction(true);
        return;
      }
      if (action === 'update-cards') {
        startTodoUpdate();
        return;
      }
      if (action === 'toggle-settings') {
        state.settings.open = !state.settings.open;
        renderSettingsPanel();
        if (state.settings.open && !state.actions.config) {
          loadTodoExtractorConfig().then(renderSettingsPanel).catch(function() {});
        }
        return;
      }
      if (action === 'close-settings') {
        state.settings.open = false;
        renderSettingsPanel();
        return;
      }
      if (action === 'set-ui-language') {
        var lang = target.getAttribute('data-lang') || '';
        if (lang === 'zh' || lang === 'en') {
          I18N_LANG = lang;
          try { localStorage.setItem('agentmemory-lang', lang); } catch (_) {}
          applyI18n(document);
          renderSettingsPanel();
          if (state.activeTab === 'actions') renderActions();
          if (state.activeTab === 'dashboard') renderDashboard();
          if (state.activeTab === 'sessions') renderSessions();
        }
        return;
      }
      if (action === 'save-todo-config') {
        saveTodoExtractorConfig();
        return;
      }
      if (action === 'action-status') {
        updateActionStatus(target.getAttribute('data-action-id') || '', target.getAttribute('data-status') || '');
        return;
      }
      if (action === 'refresh-action-card') {
        refreshActionCard(target.getAttribute('data-action-id') || '');
        return;
      }
      if (action === 'refresh-sessions') {
        state.sessions.loaded = false;
        loadSessions({ showLoading: true, reason: 'manual' });
        return;
      }
      if (action === 'open-session-group') {
        var openSessionId = target.getAttribute('data-session-id') || '';
        if (openSessionId) state.sessions.selectedId = openSessionId;
        state.sessions.loaded = false;
        switchTab('sessions');
        return;
      }
      if (action === 'jump-to-evidence') {
        jumpToEvidence(target.getAttribute('data-obs-id') || '');
        return;
      }
      if (action === 'inbox-reply') {
        openInboxReply(target.getAttribute('data-inbox-id') || '');
        return;
      }
      if (action === 'inbox-reply-submit') {
        submitInboxReply(target.getAttribute('data-inbox-id') || '');
        return;
      }
      if (action === 'inbox-reply-cancel') {
        cancelInboxReply();
        return;
      }
      if (action === 'inbox-ack') {
        ackInboxItem(target.getAttribute('data-inbox-id') || '');
        return;
      }
      if (action === 'inbox-to-todo') {
        convertInboxToTodo(target.getAttribute('data-inbox-id') || '');
        return;
      }
      if (action === 'toggle-done-today') {
        state.actions.doneExpanded = !state.actions.doneExpanded;
        renderActions();
        return;
      }
      if (action === 'toggle-earlier-open') {
        state.actions.earlierOpenExpanded = !state.actions.earlierOpenExpanded;
        renderActions();
        return;
      }
      if (action === 'toggle-older-backlog') {
        state.actions.olderBacklogExpanded = !state.actions.olderBacklogExpanded;
        renderActions();
        return;
      }
      if (action === 'toggle-briefings') {
        state.inbox.briefingExpanded = !state.inbox.briefingExpanded;
        renderActions();
        return;
      }
      if (action === 'toggle-inbox-archive') {
        state.inbox.answeredExpanded = !state.inbox.answeredExpanded;
        renderActions();
        return;
      }
      if (action === 'toggle-session-detail-section') {
        toggleSessionDetailSection(
          target.getAttribute('data-session-id') || state.sessions.selectedId || '',
          target.getAttribute('data-section') || '',
        );
        return;
      }
      if (action === 'toggle-session-preview') {
        toggleSessionPreview(target.getAttribute('data-session-id') || state.sessions.selectedId || '');
        return;
      }
      if (action === 'zoom-graph') {
        zoomGraph(parseInt(target.getAttribute('data-dir') || '0', 10));
        return;
      }
      if (action === 'recenter-graph') {
        recenterGraph();
        return;
      }
      if (action === 'rebuild-graph') {
        rebuildGraph();
        return;
      }
      if (action === 'expand-node') {
        var nodeId = target.getAttribute('data-node-id');
        if (nodeId) expandNode(nodeId);
        return;
      }
      if (action === 'delete-memory') {
        deleteMemory(
          target.getAttribute('data-memory-id') || '',
          target.getAttribute('data-memory-title') || '',
        );
        return;
      }
      if (action === 'edit-memory') {
        var editMemoryId = target.getAttribute('data-memory-id');
        if (editMemoryId) editMemory(editMemoryId);
        return;
      }
      if (action === 'copy-agent-prompt') {
        copyAgentPrompt();
        return;
      }
      if (action === 'copy-skill-path') {
        var skillPath = target.getAttribute('data-skill-path') || '';
        copyTextToClipboard(skillPath).then(function() {
          target.setAttribute('title', '已复制');
          setTimeout(function() { target.setAttribute('title', '复制路径'); }, 1400);
        });
        return;
      }
      if (action === 'open-skill-draft') {
        openSkillDraft(target.getAttribute('data-skill-draft-key') || '通用经验');
        return;
      }
      if (action === 'copy-skill-draft') {
        var draftEl = document.getElementById('skill-draft-preview');
        copyTextToClipboard(draftEl ? draftEl.textContent || '' : '').then(function() {
          target.textContent = '已复制';
          setTimeout(function() { target.textContent = '复制草稿'; }, 1400);
        });
        return;
      }
      if (action === 'open-add-memory') {
        openAddMemory();
        return;
      }
      if (action === 'open-add-lesson') {
        openAddLesson();
        return;
      }
      if (action === 'open-skill-detail') {
        openSkillDetail(target.getAttribute('data-skill-path') || '');
        return;
      }
      if (action === 'filter-skill-root') {
        state.lessons.skillRootFilter = target.getAttribute('data-root') || 'all';
        renderLessons();
        return;
      }
      if (action === 'filter-actions-status') {
        var nextFilter = target.getAttribute('data-status') || '';
        if (['attention', 'awaiting', 'review', 'pending', 'blocked', 'active'].indexOf(nextFilter) >= 0) nextFilter = 'todo';
        // STEP-13: clicking the already-active filter clears it — with the chip
        // row gone, this is how the metric cards restore the "show all" view.
        state.actions.statusFilter = (state.actions.statusFilter || '') === nextFilter ? '' : nextFilter;
        renderActions();
        return;
      }
      if (action === 'close-modal') {
        closeModal();
        return;
      }
      if (action === 'save-new-memory') {
        saveNewMemory();
        return;
      }
      if (action === 'save-new-lesson') {
        saveNewLesson();
        return;
      }
      if (action === 'save-memory') {
        var saveMemoryId = target.getAttribute('data-memory-id');
        if (saveMemoryId) saveMemory(saveMemoryId);
        return;
      }
      if (action === 'confirm-delete-memory') {
        var memoryId = target.getAttribute('data-memory-id');
        if (memoryId) confirmDeleteMemory(memoryId);
        return;
      }
      if (action === 'edit-review') {
        var editReviewId = target.getAttribute('data-review-id');
        if (editReviewId) editReviewItem(editReviewId);
        return;
      }
      if (action === 'approve-review') {
        var approveId = target.getAttribute('data-review-id');
        if (approveId) approveReviewItem(approveId);
        return;
      }
      if (action === 'dismiss-review') {
        var dismissId = target.getAttribute('data-review-id');
        if (dismissId) dismissReviewItem(dismissId);
        return;
      }
	      if (action === 'timeline-filter') {
	        setTlTypeFilter(target.getAttribute('data-type-filter') || '');
	        return;
	      }
	      if (action === 'episode-filter') {
	        state.timeline.episodeFilter = target.getAttribute('data-episode-filter') || 'all';
	        state.timeline.page = 0;
	        renderObservations();
	        return;
	      }
	      if (action === 'episode-toggle') {
	        var episodeKey = target.getAttribute('data-episode-key');
	        if (episodeKey) {
	          state.timeline.expandedEpisodes[episodeKey] = !state.timeline.expandedEpisodes[episodeKey];
	          renderObservations();
	        }
	        return;
	      }
		      if (action === 'timeline-page') {
	        var page = parseInt(target.getAttribute('data-page') || '', 10);
	        if (!Number.isNaN(page)) tlPage(page);
	        return;
	      }
	      if (action === 'timeline-mode') {
	        var mode = target.getAttribute('data-mode') || 'episodes';
	        state.timeline.mode = mode === 'events' ? 'events' : 'episodes';
	        state.timeline.page = 0;
	        renderTimelineToolbar(groupSessionsByProject(state.timeline.sessions || []));
	        renderObservations();
	        return;
	      }
      if (action === 'select-session') {
        var sessionId = target.getAttribute('data-session-id');
        if (sessionId) selectSession(sessionId);
        return;
      }
      if (action === 'session-group-mode') {
        var sessionMode = target.getAttribute('data-mode') === 'source' ? 'source' : 'folder';
        state.sessions.groupMode = sessionMode;
        renderSessions();
        return;
      }
      if (action === 'select-session-group') {
        var groupKey = target.getAttribute('data-group-key') || 'all';
        if (state.sessions.groupMode === 'source') state.sessions.sourceKey = groupKey;
        else state.sessions.folderKey = groupKey;
        renderSessions();
        return;
      }
      if (action === 'session-jump') {
        var jumpTarget = target.getAttribute('data-target') === 'bottom' ? 'session-detail-bottom' : 'session-detail-top';
        var jumpEl = document.getElementById(jumpTarget);
        if (jumpEl) jumpEl.scrollIntoView({ behavior: 'smooth', block: target.getAttribute('data-target') === 'bottom' ? 'end' : 'start' });
        return;
      }
      if (action === 'end-session') {
        var endSessionId = target.getAttribute('data-session-id');
        if (endSessionId) endSession(endSessionId);
        return;
      }
      if (action === 'summarize-session') {
        var summarizeSessionId = target.getAttribute('data-session-id');
        if (summarizeSessionId) summarizeSession(summarizeSessionId, target);
        return;
      }
      if (action === 'toggle-audit') {
        var auditIndex = parseInt(target.getAttribute('data-audit-index') || '', 10);
        if (!Number.isNaN(auditIndex)) toggleAuditDetail(auditIndex);
      }
      if (action === 'replay-select') {
        var rSid = target.getAttribute('data-session-id');
        if (rSid) selectReplaySession(rSid);
        return;
      }
      if (action === 'replay-toggle-play') { toggleReplayPlay(); return; }
      if (action === 'replay-step') {
        var d = parseInt(target.getAttribute('data-dir') || '1', 10);
        stepReplay(d);
        return;
      }
      if (action === 'replay-speed') {
        var sp = parseFloat(target.getAttribute('data-speed') || '1');
        setReplaySpeed(sp);
        return;
      }
      if (action === 'replay-reset') { resetReplay(); return; }
      if (action === 'replay-import') { runReplayImport(); return; }
      if (action === 'replay-refresh') { refreshReplaySessions(); return; }
    });
    document.getElementById('modal-overlay').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });
    document.addEventListener('input', function(e) {
      var target = e.target;
      if (!target || !target.id || String(target.id).indexOf('todo-config-') !== 0) return;
      state.actions.configDraft = state.actions.configDraft || {};
      state.actions.configDraft[String(target.id).slice('todo-config-'.length)] = String(target.value || '');
    });
