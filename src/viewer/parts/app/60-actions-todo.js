    async function loadActions(opts) {
      opts = opts || {};
      var el = document.getElementById('view-actions');
      el.innerHTML = '<div class="loading">' + esc(t('act.extract.loading')) + '</div>';
      var results = await Promise.all([
        apiGet('actions'),
        apiGet('frontier'),
        apiGet('inbox?status=awaiting&limit=50'),
        apiGet('inbox?status=answered&limit=50'),
        apiGet('inbox?status=dismissed&limit=50')
      ]);
      var explicitActions = (results[0] && results[0].actions) || [];
      var frontier = (results[1] && (results[1].frontier || results[1].actions)) || [];

      state.actions.items = explicitActions;
      state.actions.todoExtract = results[0] && results[0].todoExtract;
      syncTodoExtractStatus();
      state.actions.reviewItems = [];
      state.actions.frontier = frontier;
      state.actions.loaded = true;
      state.actions.stale = false;
      state.inbox.awaitingItems = (results[2] && results[2].items) || [];
      state.inbox.answeredItems = (results[3] && results[3].items) || [];
      state.inbox.dismissedItems = (results[4] && results[4].items) || [];
      state.inbox.items = state.inbox.awaitingItems;
      state.inbox.loaded = true;
      renderActions();
      if (state.settings.open) {
        loadTodoExtractorConfig().then(renderSettingsPanel).catch(function() {});
      }
      if (opts.generate === true) startTodoExtraction(opts.force === true);
    }

    function todoExtractionDelta(result) {
      if (!result || result.success !== true) return 0;
      return Number(result.directCreated || 0) + Number(result.reviewCreated || 0);
    }

    function todoExtractionSummary(result) {
      if (!result || result.success !== true) return t('act.extract.failedExisting');
      var delta = todoExtractionDelta(result);
      var hidden = Number(result.hiddenHistory || 0);
      var discarded = Number(result.discarded || 0);
      var cleaned = Number(result.cleanedActions || 0) + Number(result.cleanedReviews || 0);
      var engine = result.engine || 'rules';
      var prefix = engine === 'langextract' ? t('act.extract.doneLlm') : (engine === 'mixed' ? t('act.extract.doneMixed') : t('act.extract.doneRules'));
      var parts = [prefix, t('act.extract.created') + ' ' + delta, t('act.extract.history') + ' ' + hidden, t('act.extract.discarded') + ' ' + discarded];
      if (cleaned > 0) parts.push(t('act.extract.cleaned') + ' ' + cleaned);
      if (result.fallbackReason) parts.push(t('act.extract.reason') + ': ' + result.fallbackReason);
      return parts.join(' · ');
    }

    function todoExtractionUsedLlm(result) {
      return !!result && (result.engine === 'langextract' || result.engine === 'mixed') && !result.llmFallback;
    }

    function clearTodoExtractStatusPoll() {
      if (!state.actions.extractStatusPollTimer) return;
      clearTimeout(state.actions.extractStatusPollTimer);
      state.actions.extractStatusPollTimer = null;
    }

    function scheduleTodoExtractStatusPoll() {
      if (state.actions.extractStatusPollTimer) return;
      state.actions.extractStatusPollTimer = setTimeout(function() {
        state.actions.extractStatusPollTimer = null;
        if (!state.actions.extractInFlight) return;
        refreshActionListsAfterExtract().then(function() {
          if (state.activeTab === 'actions' && !actionsScrolledAway()) renderActions();
          else if (state.activeTab === 'actions') state.actions.stale = true;
        }).catch(function() {
          if (state.actions.extractInFlight) scheduleTodoExtractStatusPoll();
        });
      }, 3000);
    }

    function syncTodoExtractStatus() {
      var st = state.actions.todoExtract || {};
      if (st.status === 'running') {
        state.actions.extractInFlight = true;
        state.actions.extractStatus = 'running';
        state.actions.extractMessage = t('act.extract.background');
        scheduleTodoExtractStatusPoll();
        return;
      }
      clearTodoExtractStatusPoll();
      if (state.actions.extractInFlight && st.status !== 'running') state.actions.extractInFlight = false;
      if (st.status === 'done' && st.summary) {
        state.actions.extractStatus = 'done';
        state.actions.extractFallback = !todoExtractionUsedLlm(st.summary);
        state.actions.extractPartial = st.summary && st.summary.engine === 'mixed';
        state.actions.extractMessage = todoExtractionSummary(st.summary);
      } else if (st.status === 'error') {
        state.actions.extractStatus = 'error';
        state.actions.extractMessage = st.error || t('act.extract.failedExisting');
      }
    }

    function refreshActionListsAfterExtract() {
      return Promise.all([
        apiGet('actions'),
        apiGet('frontier')
      ]).then(function(results) {
        state.actions.items = (results[0] && results[0].actions) || state.actions.items || [];
        state.actions.todoExtract = results[0] && results[0].todoExtract;
        syncTodoExtractStatus();
        state.actions.frontier = (results[1] && (results[1].frontier || results[1].actions)) || state.actions.frontier || [];
        state.actions.reviewItems = [];
        return null;
      });
    }

    function actionsScrolledAway() {
      try {
        var y = window.pageYOffset ||
          (document.documentElement && document.documentElement.scrollTop) ||
          (document.body && document.body.scrollTop) ||
          0;
        return state.activeTab === 'actions' && y > 80;
      } catch (_) {
        return false;
      }
    }

    function loadTodoExtractorConfig() {
      return apiGet('config/todo-extractor').then(function(res) {
        if (res && res.config) state.actions.config = res;
        return res;
      });
    }

    function renderSettingsPanel() {
      var panel = document.getElementById('settings-panel');
      var gear = document.getElementById('settings-gear');
      if (!panel) return;
      if (gear) gear.setAttribute('aria-expanded', state.settings.open ? 'true' : 'false');
      panel.setAttribute('aria-hidden', state.settings.open ? 'false' : 'true');
      panel.classList.toggle('open', !!state.settings.open);
      if (!state.settings.open) {
        panel.innerHTML = '';
        return;
      }
      var cfg = (state.actions.config && state.actions.config.config) || {};
      var draft = state.actions.configDraft || {};
      var value = function(key, fallback) {
        if (Object.prototype.hasOwnProperty.call(draft, key)) return esc(draft[key] || '');
        return esc(cfg[key] || fallback || '');
      };
      var keyLabel = cfg.LANGEXTRACT_API_KEY_CONFIGURED ? t('settings.apiKeyKeep') : t('settings.apiKeyMissing');
      var maskedKey = cfg.LANGEXTRACT_API_KEY_MASKED || '';
      var html = '<div class="settings-head">';
      html += '<div><div class="settings-title">' + esc(t('settings.title')) + '</div><div class="settings-sub">' + esc(t('settings.subtitle')) + '</div></div>';
      html += '<button class="btn" data-action="close-settings" type="button">' + esc(t('settings.close')) + '</button>';
      html += '</div>';
      html += '<section class="settings-section"><div class="settings-section-title">' + esc(t('settings.language')) + '</div>';
      html += '<div class="settings-language">';
      html += '<button class="btn' + (I18N_LANG === 'zh' ? ' active' : '') + '" data-action="set-ui-language" data-lang="zh" type="button">中文</button>';
      html += '<button class="btn' + (I18N_LANG === 'en' ? ' active' : '') + '" data-action="set-ui-language" data-lang="en" type="button">English</button>';
      html += '</div></section>';
      html += '<section class="settings-section"><div class="settings-section-title">' + esc(t('settings.extractor')) + '</div>';
      html += '<div class="settings-grid">';
      html += '<input id="todo-config-AGENTMEMORY_TODO_EXTRACTOR" class="search-input" value="' + value('AGENTMEMORY_TODO_EXTRACTOR', 'auto') + '" placeholder="auto|rules|langextract" />';
      html += '<input id="todo-config-LANGEXTRACT_PYTHON" class="search-input" value="' + value('LANGEXTRACT_PYTHON', 'python3') + '" placeholder="python3" />';
      html += '<input id="todo-config-LANGEXTRACT_PROVIDER" class="search-input" value="' + value('LANGEXTRACT_PROVIDER', 'openai') + '" placeholder="openai" />';
      html += '<input id="todo-config-LANGEXTRACT_MODEL" class="search-input" value="' + value('LANGEXTRACT_MODEL', 'deepseek/deepseek-v4-flash') + '" placeholder="model" />';
      html += '<input id="todo-config-LANGEXTRACT_BASE_URL" class="search-input" value="' + value('LANGEXTRACT_BASE_URL', 'https://api.novita.ai/openai/v1') + '" placeholder="https://api.novita.ai/openai/v1" />';
      html += '<input id="todo-config-LANGEXTRACT_THINKING_DEPTH" class="search-input" value="' + value('LANGEXTRACT_THINKING_DEPTH', 'medium') + '" placeholder="medium" />';
      html += '<input id="todo-config-AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS" class="search-input" value="' + value('AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS', '120000') + '" placeholder="120000" />';
      html += '<div><div class="action-meta-text" style="margin-bottom:4px;">' + esc(t('settings.sinceDays')) + '</div><input id="todo-config-AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS" class="search-input" type="number" min="1" value="' + value('AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS', '7') + '" placeholder="7" /></div>';
      html += '<div><div class="action-meta-text" style="margin-bottom:4px;">' + esc(t('settings.maxInteractions')) + '</div><input id="todo-config-AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION" class="search-input" type="number" min="1" value="' + value('AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION', '10') + '" placeholder="10" /></div>';
      html += '<div><input id="todo-config-LANGEXTRACT_API_KEY" class="search-input" type="password" placeholder="' + esc(keyLabel) + '" />';
      if (maskedKey) html += '<div class="action-meta-text" style="margin-top:4px;">' + esc(t('settings.apiKeyLabel')) + ' ' + esc(maskedKey) + '</div>';
      html += '</div></div>';
      html += '<div class="settings-sub" style="margin-top:8px;">' + esc(cfg.LANGEXTRACT_RUNTIME_READY ? t('settings.runtimeReady') : t('settings.runtimeMissing')) + (cfg.LANGEXTRACT_RUNTIME_ERROR ? ': ' + esc(cfg.LANGEXTRACT_RUNTIME_ERROR) : '') + '</div>';
      html += '<div style="display:flex;gap:8px;margin-top:12px;align-items:center;flex-wrap:wrap;">';
      html += '<button class="btn btn-primary" data-action="save-todo-config" type="button"' + (state.actions.configSaving ? ' disabled' : '') + '>' + esc(state.actions.configSaving ? t('settings.saving') : t('settings.save')) + '</button>';
      if (state.actions.config && state.actions.config.envPath) html += '<span class="action-meta-text">' + esc(state.actions.config.envPath) + '</span>';
      html += '</div>';
      if (state.actions.extractMessage) html += '<div class="settings-sub" style="margin-top:8px;">' + esc(state.actions.extractMessage) + '</div>';
      html += '</section>';
      panel.innerHTML = html;
    }

    function captureTodoConfigDraft() {
      var draft = state.actions.configDraft || {};
      [
        'AGENTMEMORY_TODO_EXTRACTOR',
        'LANGEXTRACT_PYTHON',
        'LANGEXTRACT_PROVIDER',
        'LANGEXTRACT_MODEL',
        'LANGEXTRACT_BASE_URL',
        'LANGEXTRACT_THINKING_DEPTH',
        'AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS',
        'AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS',
        'AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION',
        'LANGEXTRACT_API_KEY'
      ].forEach(function(key) {
        var el = document.getElementById('todo-config-' + key);
        if (el) draft[key] = String(el.value || '');
      });
      state.actions.configDraft = draft;
      return draft;
    }

    function saveTodoExtractorConfig() {
      var fields = [
        'AGENTMEMORY_TODO_EXTRACTOR',
        'LANGEXTRACT_PYTHON',
        'LANGEXTRACT_PROVIDER',
        'LANGEXTRACT_MODEL',
        'LANGEXTRACT_BASE_URL',
        'LANGEXTRACT_THINKING_DEPTH',
        'AGENTMEMORY_TODO_EXTRACT_TIMEOUT_MS',
        'AGENTMEMORY_TODO_EXTRACT_SINCE_DAYS',
        'AGENTMEMORY_TODO_EXTRACT_MAX_INTERACTIONS_PER_SESSION',
        'LANGEXTRACT_API_KEY'
      ];
      var body = {};
      var draft = captureTodoConfigDraft();
      fields.forEach(function(key) {
        if (String(draft[key] || '').trim()) body[key] = String(draft[key] || '').trim();
      });
      state.actions.configSaving = true;
      renderSettingsPanel();
      apiPost('config/todo-extractor', body).then(function(res) {
        if (res && res.config) state.actions.config = res;
        state.actions.configDraft = {};
        state.actions.forceNextExtract = true;
        state.actions.extractMessage = t('settings.savedReady');
      }).catch(function() {
        state.actions.extractStatus = 'error';
        state.actions.extractMessage = t('settings.saveFailed');
      }).then(function() {
        state.actions.configSaving = false;
        renderSettingsPanel();
        if (state.activeTab === 'actions') renderActions();
      });
    }

    function updateActionStatus(actionId, status) {
      if (!actionId || !status) return;
      apiPost('actions/update', { actionId: actionId, status: status }).then(function(res) {
        if (!res || res.success === false) {
          state.actions.extractStatus = 'error';
          state.actions.extractMessage = t('act.status.updateFailed');
          renderActions();
          return;
        }
        state.actions.items = (state.actions.items || []).map(function(a) {
          return a.id === actionId ? Object.assign({}, a, { status: status, updatedAt: new Date().toISOString() }) : a;
        });
        renderActions();
      }).catch(function() {
        state.actions.extractStatus = 'error';
        state.actions.extractMessage = t('act.status.updateFailed');
        renderActions();
      });
    }

    function cardRefreshKeptNotice(reason) {
      var key = {
        'incomplete-title': 'act.cardRefresh.kept.incompleteTitle',
        'evidence-invalid': 'act.cardRefresh.kept.evidenceInvalid',
        'low-quality': 'act.cardRefresh.kept.lowQuality',
        'low-confidence': 'act.cardRefresh.kept.lowQuality',
        'completed-or-history': 'act.cardRefresh.kept.completedOrHistory',
        'polluted': 'act.cardRefresh.kept.polluted'
      }[String(reason || '')];
      return key ? t(key) : t('act.cardRefresh.kept');
    }

    function refreshActionCard(actionId) {
      if (!actionId) return;
      state.actions.cardRefreshInFlight = state.actions.cardRefreshInFlight || {};
      if (state.actions.cardRefreshInFlight[actionId]) return;
      state.actions.cardRefreshInFlight[actionId] = true;
      state.actions.cardRefreshNotice = '';
      renderActions();
      apiPost('todo/action-refresh', { actionId: actionId }).then(function(res) {
        if (!res || res.success === false) {
          state.actions.cardRefreshNotice = t('act.cardRefresh.error');
          return null;
        }
        if (res.action && res.action.id) {
          state.actions.items = (state.actions.items || []).map(function(a) {
            return a.id === res.action.id ? res.action : a;
          });
          state.actions.cardRefreshNotice = t('act.cardRefresh.done');
          return null;
        }
        state.actions.cardRefreshNotice = cardRefreshKeptNotice(res.reason);
        return null;
      }).catch(function() {
        state.actions.cardRefreshNotice = t('act.cardRefresh.error');
      }).then(function() {
        delete state.actions.cardRefreshInFlight[actionId];
        renderActions();
      });
    }

    function startTodoExtraction(force) {
      if (state.actions.extractInFlight) return;
      var shouldForce = force === true || state.actions.forceNextExtract === true;
      state.actions.forceNextExtract = false;
      state.actions.extractInFlight = true;
      state.actions.extractStatus = 'running';
      state.actions.extractMessage = t('act.extract.starting');
      if (state.activeTab === 'actions') renderActions();
      var softRefreshDone = false;
      var softRefreshTimer = setTimeout(function() {
        if (!state.actions.extractInFlight || softRefreshDone) return;
        softRefreshDone = true;
        state.actions.extractMessage = t('act.extract.background');
        if (actionsScrolledAway()) {
          state.actions.stale = true;
          return;
        }
        if (state.activeTab === 'actions') renderActions();
        refreshActionListsAfterExtract().then(function() {
          if (!state.actions.extractInFlight) return;
          if (actionsScrolledAway()) {
            state.actions.stale = true;
            return;
          }
          if (state.activeTab === 'actions') renderActions();
        }).catch(function() {});
      }, 12000);
      // STEP-11: scope is governed by saved settings (sinceDays + max
      // interactions per session) which the backend reads from env config;
      // don't hard-code maxSessions/maxObservationsPerSession here or the
      // settings would never take effect on this primary extraction path.
      apiPost('todo-extract/generate', {
        force: shouldForce
      }).then(function(result) {
        var delta = todoExtractionDelta(result);
        if (!result || result.success !== true) {
          state.actions.extractStatus = 'error';
          state.actions.extractMessage = t('act.extract.failedExisting');
          return null;
        }
        state.actions.extractStatus = 'done';
        state.actions.extractFallback = !todoExtractionUsedLlm(result);
        state.actions.extractPartial = result && result.engine === 'mixed';
        state.actions.extractMessage = todoExtractionSummary(result);
        if (actionsScrolledAway()) {
          state.actions.stale = delta > 0;
          return null;
        }
        return refreshActionListsAfterExtract();
      }).catch(function() {
        state.actions.extractStatus = 'error';
        state.actions.extractMessage = t('act.extract.failedExisting');
      }).then(function() {
        clearTimeout(softRefreshTimer);
        state.actions.extractInFlight = false;
        if (state.activeTab === 'actions' && !actionsScrolledAway()) {
          renderActions();
        } else if (state.activeTab !== 'actions') {
          state.actions.loaded = false;
        }
      });
    }

    function todoCleanupSummary(r) {
      if (!r) return '';
      return t('act.cleanup.summary')
        .replace('{dropped}', r.dropped || 0)
        .replace('{completed}', r.completed || 0)
        .replace('{rewritten}', r.rewritten || 0)
        .replace('{merged}', r.merged || 0);
    }

    // LLM card update (STEP-12): re-judge cards whose source session changed.
    // Always dry-run first so the user confirms before anything is dropped/closed;
    // apply only on confirm (or silently when there is nothing to confirm — see
    // the all-KEEP branch below).
    function startTodoUpdate() {
      if (state.actions.cleanupInFlight || state.actions.extractInFlight) return;
      state.actions.cleanupInFlight = true;
      state.actions.cleanupStatus = 'running';
      state.actions.cleanupMessage = t('act.cleanup.running');
      if (state.activeTab === 'actions') renderActions();
      apiPost('todo/update', { mode: 'dry-run' }).then(function(preview) {
        state.actions.cleanupInFlight = false;
        if (!preview || typeof preview.scanned !== 'number') {
          state.actions.cleanupStatus = 'error';
          state.actions.cleanupMessage = t('act.cleanup.failed');
          if (state.activeTab === 'actions') renderActions();
          return;
        }
        var touched = (preview.dropped || 0) + (preview.completed || 0) + (preview.rewritten || 0) + (preview.merged || 0);
        if (touched === 0) {
          if (preview.fallbackReason) {
            // LLM unavailable — nothing ran, nothing to advance.
            state.actions.cleanupStatus = 'done';
            state.actions.cleanupMessage = t('act.cleanup.llmUnavailable');
            if (state.activeTab === 'actions') renderActions();
            return;
          }
          if ((preview.scanned || 0) > 0) {
            // Changed cards existed but the LLM kept them all. Silently apply so
            // their checkpoints advance and they aren't re-evaluated (and re-sent
            // to the LLM) on every future click. No card content changes, so no
            // confirmation is needed.
            state.actions.cleanupInFlight = true;
            apiPost('todo/update', { mode: 'apply', decisions: preview.decisions }).then(function() {
              return refreshActionListsAfterExtract();
            }).catch(function() {}).then(function() {
              state.actions.cleanupInFlight = false;
              state.actions.cleanupStatus = 'done';
              state.actions.cleanupMessage = t('act.cleanup.clean');
              if (state.activeTab === 'actions') renderActions();
            });
            return;
          }
          // Nothing changed at all.
          state.actions.cleanupStatus = 'idle';
          state.actions.cleanupMessage = t('act.cleanup.none');
          if (state.activeTab === 'actions') renderActions();
          return;
        }
        if (!window.confirm(t('act.cleanup.confirm') + '\n\n' + todoCleanupSummary(preview))) {
          state.actions.cleanupStatus = 'idle';
          state.actions.cleanupMessage = '';
          if (state.activeTab === 'actions') renderActions();
          return;
        }
        state.actions.cleanupInFlight = true;
        state.actions.cleanupStatus = 'running';
        state.actions.cleanupMessage = t('act.cleanup.applying');
        if (state.activeTab === 'actions') renderActions();
        apiPost('todo/update', { mode: 'apply', decisions: preview.decisions }).then(function(result) {
          state.actions.cleanupStatus = 'done';
          state.actions.cleanupMessage = todoCleanupSummary(result || preview);
          return refreshActionListsAfterExtract();
        }).catch(function() {
          state.actions.cleanupStatus = 'error';
          state.actions.cleanupMessage = t('act.cleanup.failed');
        }).then(function() {
          state.actions.cleanupInFlight = false;
          if (state.activeTab === 'actions') renderActions();
        });
      }).catch(function() {
        state.actions.cleanupInFlight = false;
        state.actions.cleanupStatus = 'error';
        state.actions.cleanupMessage = t('act.cleanup.failed');
        if (state.activeTab === 'actions') renderActions();
      });
    }

    // 待办→证据跳转:待办卡指向裸 obs_id,证据栏按 session 组织,
    // 后端无 obs_id→session 反查端点。遍历已加载会话,缓存优先、未命中才请求,命中即停。
    async function resolveObsSession(obsId) {
      if (!obsId) return null;
      var sessions = state.sessions.items || [];
      for (var i = 0; i < sessions.length; i++) {
        var s = sessions[i];
        var id = sessionId(s);
        if (!id) continue;
        var obs = null;
        var cached = state.sessions.detailCacheById && state.sessions.detailCacheById[id];
        if (cached && Array.isArray(cached.observations)) {
          obs = cached.observations;
        } else if (Array.isArray(s.embeddedObservations) && s.embeddedObservations.length) {
          obs = s.embeddedObservations;
        }
        if (obs && obs.some(function(o) { return o && o.id === obsId; })) return id;
        if (obs) continue;
        try {
          var res = await apiGet('observations?sessionId=' + encodeURIComponent(id));
          var list = (res && res.observations) || [];
          if (list.some(function(o) { return o && o.id === obsId; })) return id;
        } catch (e) { /* 单个会话取失败不阻断扫描 */ }
      }
      return null;
    }

    async function jumpToEvidence(obsId) {
      if (!obsId) return;
      if (!state.sessions.loaded) await loadSessions({ showLoading: false, reason: 'jump' });
      var targetSessionId = await resolveObsSession(obsId);
      if (!targetSessionId) {
        flashHint('未找到这条待办的来源会话（可能尚未同步或已被过滤）');
        return;
      }
      state.sessions.selectedId = targetSessionId;
      state.sessions.pendingHighlightObsId = obsId;
      // 来源观测画在「完整对话过程」区,默认折叠 → 跳转前强制展开,否则锚点不存在
      if (!state.sessions.detailSectionsById) state.sessions.detailSectionsById = {};
      var sec = state.sessions.detailSectionsById[targetSessionId] || { highlights: true, process: false };
      sec.process = true;
      state.sessions.detailSectionsById[targetSessionId] = sec;
      switchTab('sessions');
      renderSessions();
      await renderSessionDetail();
    }

    function flashHint(message) {
      var el = document.getElementById('jump-hint');
      if (!el) {
        el = document.createElement('div');
        el.id = 'jump-hint';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--ink,#1a1a1a);color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,0.2);max-width:80vw;';
        (document.body || document.documentElement).appendChild(el);
      }
      el.textContent = message;
      el.style.opacity = '1';
      if (flashHint._t) clearTimeout(flashHint._t);
      flashHint._t = setTimeout(function() { if (el) el.style.opacity = '0'; }, 2600);
    }

    function applyPendingHighlight() {
      var obsId = state.sessions.pendingHighlightObsId;
      if (!obsId) return;
      state.sessions.pendingHighlightObsId = null;
      var anchor = document.getElementById('obs-anchor-' + obsId);
      if (!anchor) return;
      if (typeof anchor.scrollIntoView === 'function') anchor.scrollIntoView({ behavior: 'smooth', block: 'center' });
      anchor.classList.add('obs-jump-highlight');
      setTimeout(function() { anchor.classList.remove('obs-jump-highlight'); }, 2400);
    }

    // STEP-C2/C3 待回应分区:接真实 inbox 数据(GET /agentmemory/inbox?status=awaiting)。
    // 按 kind 分两子区——question(🔴 Agent 在等你回)与 briefing(📋 Agent 主动整理),
    // 均按 createdAt 倒序(本轮不按 priority)。C3 加动作:question 可「回应」(行内输入
    // → inbox-answer)/「转待处理」(inbox-dismiss + action-create)/「知道了」(空 answer);
    // briefing 可「知道了」/「转待处理」。「看原文 →」复用 STEP-03。
    function inboxFromLabel(item) {
      var from = item && item.fromAgent ? String(item.fromAgent) : '';
      return from ? '来自 ' + esc(from) : '';
    }
    function inboxEvidenceButton(item) {
      var ids = (item && item.sourceObservationIds) || [];
      if (!ids.length) return '';
      return '<button type="button" class="btn inbox-evidence-link" style="font-size:10px;padding:2px 8px;" ' +
        'data-action="jump-to-evidence" data-obs-id="' + esc(ids[0]) + '">看原文 →</button>';
    }
    // STEP-D4 飞书投递状态徽标(只读,低干扰)。数据来自 GET /inbox 里 join 的 delivery
    // 台账(mem:delivery)。sent→已推送✓;failed→推送失败⚠+短错误摘要;skipped(投递
    // 未开启/无配置)默认不显示,避免污染 UI。
    function inboxDeliveryBadge(item) {
      var d = item && item.delivery;
      if (!d || !d.status) return '';
      if (d.status === 'sent') {
        var u = d.urgent ? ' · 加急' : '';
        return '<span class="inbox-delivery inbox-delivery-sent" title="已推送到飞书' + esc(u) + '">已推送 ✓' + esc(u) + '</span>';
      }
      if (d.status === 'failed') {
        var err = d.error ? String(d.error) : '';
        if (err.length > 60) err = err.slice(0, 60) + '…';
        var titleErr = d.error ? ' title="' + esc(String(d.error)) + '"' : '';
        return '<span class="inbox-delivery inbox-delivery-failed"' + titleErr + '>推送失败 ⚠' +
          (err ? ' <span class="inbox-delivery-err">' + esc(err) + '</span>' : '') + '</span>';
      }
      return ''; // skipped → silent
    }
    function inboxAwaiting() {
      var s = state.inbox || {};
      if (Array.isArray(s.awaitingItems) && s.awaitingItems.length) return s.awaitingItems;
      return Array.isArray(s.items) ? s.items : [];
    }
    function inboxAnswered() {
      var s = state.inbox || {};
      return Array.isArray(s.answeredItems) ? s.answeredItems : [];
    }
    function inboxDismissed() {
      var s = state.inbox || {};
      return Array.isArray(s.dismissedItems) ? s.dismissedItems : [];
    }
    function sortInboxItems(items) {
      return (items || []).slice().sort(function(a, b) {
        return new Date((b && (b.answeredAt || b.dismissedAt || b.updatedAt || b.createdAt)) || 0).getTime() -
          new Date((a && (a.answeredAt || a.dismissedAt || a.updatedAt || a.createdAt)) || 0).getTime();
      });
    }
    function inboxSearchText(item) {
      return [
        item && item.body,
        item && item.answer,
        item && item.fromAgent,
        item && item.status,
        item && item.kind,
      ].filter(Boolean).join(' ').toLowerCase();
    }
    function filterInboxItems(items, search) {
      if (!search) return items || [];
      return (items || []).filter(function(item) { return inboxSearchText(item).indexOf(search) >= 0; });
    }
    function inboxRecent(item) {
      var ts = item && (item.answeredAt || item.dismissedAt || item.updatedAt || item.createdAt);
      if (!ts) return false;
      var t = new Date(ts).getTime();
      return Number.isFinite(t) && Date.now() - t <= 24 * 60 * 60 * 1000;
    }
    function renderInboxCard(item, kind) {
      var marker = kind === 'question' ? '🔴' : '📋';
      var from = inboxFromLabel(item);
      var id = (item && item.id) || '';
      var html = '<article class="inbox-card inbox-card-' + kind + '" data-inbox-id="' + esc(id) + '">';
      html += '<div class="inbox-card-head">';
      html += '<span class="inbox-card-marker" aria-hidden="true">' + marker + '</span>';
      if (from) html += '<span class="inbox-card-from">' + from + '</span>';
      if (item && item.createdAt) html += '<span class="inbox-card-time">' + esc(shortTime(item.createdAt)) + '</span>';
      html += inboxDeliveryBadge(item);
      html += '</div>';
      html += '<div class="md-body inbox-card-body">' + renderMarkdownSafe((item && item.body) || '') + '</div>';

      var pending = isInboxPending(id);
      var dis = pending ? ' disabled aria-busy="true"' : '';
      html += '<div class="inbox-card-actions">';
      if (kind === 'question') {
        html += '<button type="button" class="btn btn-primary" style="font-size:10px;padding:2px 10px;" data-action="inbox-reply" data-inbox-id="' + esc(id) + '"' + dis + '>回应…</button>';
        html += '<button type="button" class="btn" style="font-size:10px;padding:2px 8px;" data-action="inbox-to-todo" data-inbox-id="' + esc(id) + '"' + dis + '>' + (pending ? '处理中…' : '转待处理') + '</button>';
        html += '<button type="button" class="btn" style="font-size:10px;padding:2px 8px;" data-action="inbox-ack" data-inbox-id="' + esc(id) + '"' + dis + '>知道了</button>';
      } else {
        html += '<button type="button" class="btn btn-primary" style="font-size:10px;padding:2px 10px;" data-action="inbox-ack" data-inbox-id="' + esc(id) + '"' + dis + '>知道了</button>';
        html += '<button type="button" class="btn" style="font-size:10px;padding:2px 8px;" data-action="inbox-to-todo" data-inbox-id="' + esc(id) + '"' + dis + '>' + (pending ? '处理中…' : '转待处理') + '</button>';
      }
      html += inboxEvidenceButton(item);
      html += '</div>';

      if (kind === 'question' && state.inbox.replyingId === id) {
        var sd = pending ? ' disabled aria-busy="true"' : '';
        html += '<div class="inbox-reply-box">';
        html += '<textarea class="inbox-reply-input" id="inbox-reply-input-' + esc(id) + '" rows="2" placeholder="回一句…"' + (pending ? ' disabled' : '') + '></textarea>';
        html += '<div class="inbox-reply-actions">';
        html += '<button type="button" class="btn btn-primary" style="font-size:10px;padding:3px 12px;" data-action="inbox-reply-submit" data-inbox-id="' + esc(id) + '"' + sd + '>' + (pending ? '提交中…' : '提交') + '</button>';
        html += '<button type="button" class="btn" style="font-size:10px;padding:3px 8px;" data-action="inbox-reply-cancel" data-inbox-id="' + esc(id) + '"' + sd + '>取消</button>';
        html += '</div></div>';
      }
      html += '</article>';
      return html;
    }
    function renderInboxArchiveCard(item) {
      var kind = item && item.kind === 'question' ? 'question' : 'briefing';
      var answered = item && item.status === 'answered';
      var marker = kind === 'question' ? '✅' : '✓';
      var cls = answered && kind === 'question' ? 'inbox-card-answered' : 'inbox-card-known';
      var from = inboxFromLabel(item);
      var ts = (item && (item.answeredAt || item.dismissedAt || item.updatedAt || item.createdAt)) || '';
      var html = '<article class="inbox-card ' + cls + '" data-inbox-id="' + esc((item && item.id) || '') + '">';
      html += '<div class="inbox-card-head">';
      html += '<span class="inbox-card-marker" aria-hidden="true">' + marker + '</span>';
      if (from) html += '<span class="inbox-card-from">' + from + '</span>';
      if (ts) html += '<span class="inbox-card-time">' + esc(shortTime(ts)) + '</span>';
      html += '</div>';
      html += '<div class="md-body inbox-card-body inbox-card-body-muted">' + renderMarkdownSafe((item && item.body) || '') + '</div>';
      if (answered && kind === 'question') {
        html += '<div class="inbox-card-answer"><span class="inbox-card-answer-label">你已回复：</span>' + esc((item && item.answer) || '知道了') + '</div>';
      }
      html += '</article>';
      return html;
    }
    function renderAwaitingQuestionSection() {
      var search = (state.actions.search || '').toLowerCase();
      var items = filterInboxItems(sortInboxItems(inboxAwaiting()), search);
      var questions = items.filter(function(i) { return i && i.kind === 'question'; });
      if (!questions.length) return '';
      var html = '<section class="card memory-section awaiting-reply-section" style="padding:14px 16px;margin-bottom:14px;background:#ffffff;">';
      html += '<div class="memory-section-head"><div>';
      html += '<div class="memory-section-title"><span class="awaiting-dot" aria-hidden="true"></span>' + t('act.section.awaiting') + ' (' + questions.length + ')</div>';
      html += '<div class="memory-summary-sub" style="margin-top:3px;">Agent 运行中抛给你的、时间敏感的问题会汇集到这里。</div>';
      html += '</div><span class="badge badge-muted">Agent 在等你回</span></div>';
      html += '<div class="inbox-card-list">';
      questions.forEach(function(it) { html += renderInboxCard(it, 'question'); });
      html += '</div></section>';
      return html;
    }
    function renderAwaitingBriefingSection() {
      var search = (state.actions.search || '').toLowerCase();
      var items = filterInboxItems(sortInboxItems(inboxAwaiting()), search);
      var briefings = items.filter(function(i) { return i && i.kind === 'briefing'; });
      if (!briefings.length) return '';
      var bExpanded = !!state.inbox.briefingExpanded || !!search;
      var html = '<section class="card memory-section awaiting-reply-section" style="padding:14px 16px;margin-bottom:14px;background:#ffffff;">';
      html += '<button type="button" class="inbox-subhead inbox-subhead-toggle" data-action="toggle-briefings" aria-expanded="' + (bExpanded ? 'true' : 'false') + '">';
      html += '<span class="inbox-subhead-marker" aria-hidden="true">📋</span>Agent 整理 (' + briefings.length + ')<span class="inbox-subhead-note">知悉即可</span>';
      html += '<span class="inbox-subhead-caret">' + (bExpanded ? '▾' : '▸') + '</span>';
      html += '</button>';
      if (bExpanded) {
        html += '<div class="inbox-card-list">';
        briefings.forEach(function(it) { html += renderInboxCard(it, 'briefing'); });
        html += '</div>';
      }
      html += '</section>';
      return html;
    }
    function renderInboxArchiveSection() {
      var search = (state.actions.search || '').toLowerCase();
      var answered = inboxAnswered();
      var dismissed = inboxDismissed();
      var all = sortInboxItems(answered.concat(dismissed));
      var visible = filterInboxItems(all, search);
      if (!visible.length) return '';
      var answeredQuestions = visible.filter(function(i) { return i && i.kind === 'question' && i.status === 'answered'; });
      var known = visible.filter(function(i) { return !(i && i.kind === 'question' && i.status === 'answered'); });
      var recentCount = visible.filter(inboxRecent).length;
      var expanded = !!state.inbox.answeredExpanded || !!search;
      var title = answeredQuestions.length ? '已回应 ' + answeredQuestions.length + ' 条' : '已回应';
      if (recentCount && !expanded) title += ' · 最近 ' + recentCount + ' 条';
      var html = '<section class="card memory-section inbox-archive-section" style="padding:14px 16px;margin-bottom:14px;background:#ffffff;">';
      html += '<button type="button" class="inbox-subhead inbox-subhead-toggle" data-action="toggle-inbox-archive" aria-expanded="' + (expanded ? 'true' : 'false') + '">';
      html += '<span class="inbox-subhead-marker" aria-hidden="true">✅</span>' + esc(title) + '<span class="inbox-subhead-note">只读归档</span>';
      html += '<span class="inbox-subhead-caret">' + (expanded ? '▾' : '▸') + '</span>';
      html += '</button>';
      if (expanded) {
        if (answeredQuestions.length) {
          html += '<div class="inbox-card-list">';
          answeredQuestions.forEach(function(it) { html += renderInboxArchiveCard(it); });
          html += '</div>';
        }
        if (known.length) {
          html += '<div class="inbox-subhead"><span class="inbox-subhead-marker" aria-hidden="true">✓</span>已知悉 (' + known.length + ')<span class="inbox-subhead-note">briefing / 已消解</span></div>';
          html += '<div class="inbox-card-list">';
          known.forEach(function(it) { html += renderInboxArchiveCard(it); });
          html += '</div>';
        }
      }
      html += '</section>';
      return html;
    }
    // STEP-C3 收件箱动作。每个动作改后端状态后,从 state.inbox.items 本地剔除该项 +
    // 重渲染(乐观更新),避免全量 loadActions 抖动;失败用 flashHint 提示。
    function removeInboxItemLocal(id) {
      state.inbox.items = (state.inbox.items || []).filter(function(i) { return i && i.id !== id; });
      state.inbox.awaitingItems = (state.inbox.awaitingItems || []).filter(function(i) { return i && i.id !== id; });
      if (state.inbox.replyingId === id) state.inbox.replyingId = null;
    }
    function findInboxItem(id) {
      return inboxAwaiting().filter(function(i) { return i && i.id === id; })[0] || null;
    }
    function archiveInboxItemLocal(id, status, answer) {
      var item = findInboxItem(id);
      removeInboxItemLocal(id);
      if (!item) return;
      var archived = Object.assign({}, item, {
        status: status,
        answer: answer || item.answer || '',
        updatedAt: new Date().toISOString(),
      });
      if (status === 'answered') {
        archived.answeredAt = archived.updatedAt;
        state.inbox.answeredItems = [archived].concat(state.inbox.answeredItems || []);
      } else {
        archived.dismissedAt = archived.updatedAt;
        state.inbox.dismissedItems = [archived].concat(state.inbox.dismissedItems || []);
      }
    }
    // 防重入:动作进行中标记 pendingById[id],按钮渲染为 disabled,
    // 慢网下连点不会重复提交(尤其转待处理的 create 会重复建待办)。
    function isInboxPending(id) {
      return !!(state.inbox.pendingById && state.inbox.pendingById[id]);
    }
    function setInboxPending(id, on) {
      if (!state.inbox.pendingById) state.inbox.pendingById = {};
      if (on) state.inbox.pendingById[id] = true;
      else delete state.inbox.pendingById[id];
    }
    function openInboxReply(id) {
      state.inbox.replyingId = (state.inbox.replyingId === id) ? null : id;
      renderActions();
      if (state.inbox.replyingId === id) {
        var input = document.getElementById('inbox-reply-input-' + id);
        if (input && typeof input.focus === 'function') input.focus();
      }
    }
    function cancelInboxReply() {
      state.inbox.replyingId = null;
      renderActions();
    }
    async function submitInboxReply(id) {
      if (isInboxPending(id)) return;
      var input = document.getElementById('inbox-reply-input-' + id);
      var answer = input ? String(input.value || '').trim() : '';
      if (!answer) { flashHint('回应内容不能为空'); if (input && input.focus) input.focus(); return; }
      setInboxPending(id, true);
      renderActions();
      try {
        var res = await apiPost('inbox/answer', { id: id, answer: answer });
        if (!res || res.success !== true) { flashHint('回应未送达,请确认本地 worker 在运行'); return; }
        archiveInboxItemLocal(id, 'answered', answer);
        flashHint('已回应,Agent 会看到');
      } finally {
        setInboxPending(id, false);
        renderActions();
      }
    }
    async function ackInboxItem(id) {
      if (isInboxPending(id)) return;
      setInboxPending(id, true);
      renderActions();
      try {
        // 空 answer = 已读/ack(briefing 或无需回的 question)。
        var res = await apiPost('inbox/answer', { id: id });
        if (!res || res.success !== true) { flashHint('操作未送达,请确认本地 worker 在运行'); return; }
        archiveInboxItemLocal(id, 'answered', '');
        flashHint('已标记知道了');
      } finally {
        setInboxPending(id, false);
        renderActions();
      }
    }
    async function convertInboxToTodo(id) {
      if (isInboxPending(id)) return;
      // 转待处理:先建 action(标题取 body),成功后再 dismiss inbox 项;
      // 串行 + 失败回滚提示,避免「dismiss 了却没建 action」的丢条目。
      var item = findInboxItem(id);
      if (!item) return;
      setInboxPending(id, true);
      renderActions();
      try {
        var title = String(item.body || '').trim().slice(0, 120) || '(来自收件箱)';
        var created = await apiPost('actions', { title: title, createdBy: 'inbox', project: item.project });
        if (!created || created.success !== true) { flashHint('转待处理失败:未能创建待办'); return; }
        var dismissed = await apiPost('inbox/dismiss', { id: id });
        if (!dismissed || dismissed.success !== true) {
          flashHint('已建待办,但收件箱项未消解,请手动「知道了」');
          state.actions.loaded = false;
          loadActions({ generate: false });
          return;
        }
        archiveInboxItemLocal(id, 'dismissed', '');
        state.actions.loaded = false;
        loadActions({ generate: false });
        flashHint('已转入待处理');
      } finally {
        setInboxPending(id, false);
        renderActions();
      }
    }

    // STEP-C4 Done 折叠区:只读现有 action.status==='done' 且当天 updatedAt 的项,
    // 默认折叠(§3.2)。不新增抽取器、不动后端,纯前端筛 state.actions.items。
    function isUpdatedToday(ts) {
      if (!ts) return false;
      var d = new Date(ts);
      if (isNaN(d.getTime())) return false;
      var now = new Date();
      return d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    }
    function renderDoneTodaySection(doneItems, frontierIds, cardRenderer) {
      var today = (doneItems || []).filter(function(a) { return isUpdatedToday(a.updatedAt); });
      if (!today.length) return '';
      var expanded = !!state.actions.doneExpanded;
      var html = '<section class="action-group done-today-section">';
      html += '<button type="button" class="action-group-head done-today-head" data-action="toggle-done-today" aria-expanded="' + (expanded ? 'true' : 'false') + '">';
      html += '<div class="action-group-title">' + esc(t('act.metric.done')) + ' <span class="done-today-sub">' + today.length + ' ' + esc(t('act.itemsUnit')) + '</span></div>';
      html += '<span class="done-today-caret">' + (expanded ? '▾' : '▸') + '</span>';
      html += '</button>';
      if (expanded && typeof cardRenderer === 'function') {
        html += '<div class="action-card-list">';
        today.forEach(function(a) {
          html += cardRenderer(a, frontierIds.has(a.id));
        });
        html += '</div>';
      }
      html += '</section>';
      return html;
    }

    function renderActions() {
      var el = document.getElementById('view-actions');
      var items = (state.actions.items || []).filter(isActionRenderable).slice();
      state.actions.reviewItems = [];
      var search = state.actions.search.toLowerCase();
      var statusFilter = state.actions.statusFilter === 'all' ? '' : state.actions.statusFilter;
      if (['attention', 'awaiting', 'review', 'pending', 'blocked', 'active'].indexOf(statusFilter) >= 0) statusFilter = 'todo';
      var defaultView = !statusFilter && !search;
      var FOCUS_DAYS = 3;
      var STALE_DAYS = 10;
      var todoFilterActive = statusFilter === 'todo';
      var frontierIds = new Set((state.actions.frontier || []).map(function(a) { return a.id; }));

      if (search) {
        items = items.filter(function(a) {
          var chain = (a && a.metadata && a.metadata.todoChain) || {};
          return (a.title + ' ' + (a.description || '') + ' ' + (a.tags || []).join(' ') + ' ' + (a.project || '') + ' ' +
            (chain.completionSummary || '') + ' ' + (chain.latestStatus || '') + ' ' + (chain.nextStep || '')).toLowerCase().indexOf(search) >= 0;
        });
      }
      var metricItems = items.slice();
      if (statusFilter) {
        items = items.filter(function(a) {
          return statusFilter === 'todo'
            ? (a.status === 'pending' || a.status === 'blocked' || a.status === 'active')
            : a.status === statusFilter;
        });
      }
      function actionAttentionKey(a, isFrontier) {
        if (a.status === 'done' || a.status === 'cancelled') return '';
        if (isFrontier) return 'next';
        if (a.status === 'blocked') return 'needsWork';
        if (a.priority === 'high' || Number(a.priority) >= 8) return 'noteworthy';
        return '';
      }
      function actionDescriptionText(text) {
        var s = String(text || '').trim();
        if (!s) return '';
        s = todoDisplayText(s);
        if (I18N_LANG !== 'zh') return s;
        var map = [
          [/^Execute launch promotion for GitHub, Xiaohongshu, V2EX, Reddit, X, and other target communities\..*$/i, '继续推进 GitHub、小红书、V2EX、Reddit 和 X 等渠道的发布推广。'],
          [/^Execute launch promotion for (.+)$/i, '继续推进 $1 的发布推广。'],
          [/^Create a Notion-style continuous-motion 30s README demo[:：]?\s*(.+)$/i, '制作 30 秒 README 演示，展示从输入到结果预览的完整路径。'],
          [/^Use huashu-design video workflow to produce a short README\/social demo showing how the study abroad applications skill works[:：]?\s*(.+)$/i, '制作一段适合 README 和社媒使用的短演示，说明留学申请 Skill 的使用过程。'],
          [/^Use huashu-design video workflow to produce a short README\/social demo showing how the study abroad applications skill works\.?$/i, '制作一段适合 README 和社媒使用的短演示，说明留学申请 Skill 的使用过程。'],
          [/^Use huashu-design video workflow to produce a short README\/social demo showing how (.+?) works[:：]?\s*(.+)$/i, '制作一段适合 README 和社媒使用的短演示，说明 $1 的使用过程。'],
          [/^Use huashu-design video workflow to produce a short README\/social demo showing how (.+?) works\.?$/i, '制作一段适合 README 和社媒使用的短演示，说明 $1 的使用过程。'],
          [/^来源：(.+)$/i, '来自 $1'],
          [/^来自本地审计日志$/i, '来自本地操作记录']
        ];
        for (var i = 0; i < map.length; i++) {
          if (map[i][0].test(s)) return s.replace(map[i][0], map[i][1]);
        }
        return s;
      }
      function actionChainStatusText(a) {
        var chain = (a && a.metadata && a.metadata.todoChain) || null;
        if (!chain || typeof chain !== 'object') return '';
        var summary = String(chain.completionSummary || chain.latestStatus || chain.nextStep || '').trim();
        if (!summary) return '';
        summary = todoDisplayText(summary);
        var state = String(chain.completionState || '').trim();
        var prefix = state === 'completed' ? '✓ ' : (state === 'interrupted' ? '⏸ ' : '→ ');
        return prefix + summary;
      }
      function todoDisplayText(text) {
        return String(text || '')
          .replace(/Needs attention|Needs your reply|Needs confirmation|Needs follow-up|In progress|Follow up|To confirm|Reply queue|Reply/gi, 'Todo')
          .replace(/需处理|需要你回应|需要确认|需要跟进|进行中|待跟进|待确认|待回应|待回复队列|回应/g, 'Todo');
      }
      function actionSourceText(a) {
        var parts = [];
        if (a.project) parts.push(projectDisplayName(a.project));
        if (a.source) parts.push(a.source);
        return parts.join(' · ');
      }
      function actionVisibleTags(tags) {
        var all = Array.isArray(tags) ? tags.filter(Boolean).map(String) : [];
        var visible = [];
        function add(tag) {
          if (tag && visible.indexOf(tag) < 0) visible.push(tag);
        }
        all.filter(function(tag) {
          return tag === 'todo-extracted' || tag === 'todo-recheck' || /^time:[a-z_]+$/i.test(tag) || /^type:[a-z_]+$/i.test(tag);
        }).forEach(add);
        all.forEach(function(tag) {
          if (visible.length < 5) add(tag);
        });
        return visible.slice(0, 5);
      }
      function actionTitleText(text) {
        var s = String(text || t('act.untitled')).trim();
        s = todoDisplayText(s);
        if (I18N_LANG !== 'zh') return s;
        var map = [
          [/^Create README 30s demo GIF and backup MP4 for taught-master-applications-skill$/i, '制作留学申请 Skill 的 README 演示视频'],
          [/^Create README 30s demo GIF and backup MP4 for (.+)$/i, '制作 $1 的 README 演示视频'],
          [/^Create 30-second demo GIF\/video for taught-master-applications-skill$/i, '制作留学申请 Skill 的 30 秒演示视频'],
          [/^Promote\s+(.+?)\s+across target platforms$/i, '推广 $1'],
          [/^Build\s+(.+)$/i, '制作 $1'],
          [/^Create\s+(.+)$/i, '创建 $1'],
          [/^Execute\s+(.+)$/i, '执行 $1'],
          [/^Review\s+(.+)$/i, '复盘 $1'],
          [/^Check\s+(.+)$/i, '检查 $1']
        ];
        for (var i = 0; i < map.length; i++) {
          if (map[i][0].test(s)) return s.replace(map[i][0], map[i][1]);
        }
        return s;
      }
      function priorityLabel(value) {
        if (value === 'high' || Number(value) >= 8) return t('act.prio.high');
        if (value === 'normal' || Number(value) >= 5) return t('act.prio.normal');
        return t('act.prio.low');
      }
      function priorityClass(value) {
        if (value === 'high' || Number(value) >= 8) return 'high';
        if (value === 'normal' || Number(value) >= 5) return 'normal';
        return 'low';
      }
      function compactActionTitle(text) {
        var s = String(text || t('act.untitled')).replace(/^(TODO|FIXME)\s*[:：-]\s*/i, '').trim();
        var headingMatch = s.match(/#{1,6}\s*([^#\n]+?)(?=\s+#{1,6}\s|$)/);
        if (headingMatch && !/^(Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation)\b/i.test(headingMatch[1].trim())) {
          s = headingMatch[1].trim();
        }
        s = s
          .replace(/#{1,6}\s*(Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation)\b[\s\S]*$/i, '')
          .replace(/#{1,6}\s*/g, '')
          .replace(/\b(Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation)\b[\s\S]*$/i, '')
          .replace(/\s+/g, ' ')
          .trim();
        var first = s.split(/[。！？\n]/u)[0] || s;
        return truncate(actionTitleText(first.replace(/[。！？；;,.，]+$/u, '').trim() || t('act.untitled')), 72);
      }
      function stripMarkdownPlanText(text) {
        return String(text || '')
          .replace(/\s+(#{1,6}\s+)/g, '\n$1')
          .split(/\n+/)
          .filter(function(line) {
            var trimmed = line.trim();
            if (!trimmed) return false;
            if (/^#{1,6}\s/.test(trimmed)) return false;
            if (/^\s*[-*]\s+/.test(line)) return false;
            if (/^(Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation)\b/i.test(trimmed)) return false;
            if (/^(执行步骤|验证命令|停止条件|修改范围)[:：]?/u.test(trimmed)) return false;
            return true;
          })
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      function actionMetricCards(counts) {
        var todoCount = counts.pending + counts.blocked + counts.active;
        var metrics = [
          { label: t('act.metric.todo'), value: todoCount, filter: 'todo', primary: todoCount > 0 },
          { label: t('act.metric.done'), value: counts.done, filter: 'done', primary: false }
        ];
        var html = '<div class="action-overview">';
        metrics.forEach(function(m) {
          var current = state.actions.statusFilter || '';
          if (['attention', 'awaiting', 'review', 'pending', 'blocked', 'active'].indexOf(current) >= 0) current = 'todo';
          var active = current === m.filter;
          html += '<button class="action-overview-card' + (m.primary ? ' primary' : '') + (active ? ' active' : '') + '" data-action="filter-actions-status" data-status="' + esc(m.filter) + '" type="button"><div class="action-overview-label">' + esc(m.label) + '</div><div class="action-overview-value">' + m.value + '</div></button>';
        });
        html += '</div>';
        return html;
      }
      function actionNeedsRecheck(a) {
        var tags = Array.isArray(a && a.tags) ? a.tags : [];
        return tags.indexOf('todo-recheck') >= 0;
      }
      function normalizeActionTimestamp(value) {
        var raw = String(value || '').trim();
        if (!raw) return '';
        var m = raw.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/);
        return m ? m[0] : raw;
      }
      function actionTimestamp(a) {
        var extraction = (a && a.metadata && a.metadata.todoExtraction) || {};
        if (actionNeedsRecheck(a) && extraction.latestSourceCheckpoint) {
          return normalizeActionTimestamp(extraction.latestSourceCheckpoint);
        }
        return normalizeActionTimestamp(extraction.sourceCheckpoint || (a && (a.createdAt || a.updatedAt)) || '');
      }
      function actionAgeDays(a) {
        var ts = actionTimestamp(a);
        if (!ts) return 0;
        var ms = new Date(ts).getTime();
        if (!isFinite(ms)) return 0;
        return Math.max(0, (Date.now() - ms) / 86400000);
      }
      function isOpenAction(a) {
        return a && (a.status === 'active' || a.status === 'blocked' || a.status === 'pending');
      }
      function isNoisyChainOpenAction(a) {
        var chain = (a && a.metadata && a.metadata.todoChain) || null;
        if (!isOpenAction(a) || !chain) return false;
        var statusText = String(chain.completionSummary || '') + ' ' + String(chain.latestStatus || '');
        var text = statusText + ' ' + String(a.description || '');
        var statusHasNextStep = /(下一步|仍需|还需|需要继续|需要|待处理|待确认|待跟进|blocked|阻塞|失败|卡住|error|failed)/i.test(statusText);
        if (chain.completionState === 'completed') return true;
        if (/<collaboration_mode>|#\s*Plan Mode\b|#\s*Agent Mode\b/i.test(text)) return true;
        if (/已(?:完成|提交并推送|创建|通过|合并|上传|重启|新建)|服务已重启|正常|无需后续|no action needed|completed/i.test(statusText) && !statusHasNextStep) return true;
        return false;
      }
      function isLegacyGeneratedOpenAction(a) {
        return isOpenAction(a) && a.createdBy === 'todo-extract' && !(a.metadata && a.metadata.todoChain);
      }
      function splitDefaultOpenItems(list) {
        var split = { focus: [], earlier: [], older: [], legacy: [] };
        (list || []).forEach(function(a) {
          if (!isOpenAction(a)) return;
          if (isLegacyGeneratedOpenAction(a) || isNoisyChainOpenAction(a)) {
            split.legacy.push(a);
            return;
          }
          var age = actionAgeDays(a);
          if (age <= FOCUS_DAYS || (actionNeedsRecheck(a) && age <= STALE_DAYS)) split.focus.push(a);
          else if (age > STALE_DAYS) split.older.push(a);
          else split.earlier.push(a);
        });
        return split;
      }
      function renderActionFilters() {
        var html = '<div class="actions-filter-row">';
        html += '<input id="actions-search" class="search-input" type="text" placeholder="' + esc(t('act.searchPlaceholder')) + '" value="' + esc(state.actions.search) + '" style="flex:1;min-width:200px" />';
        html += actionMetricCards(statusCounts);
        var extractTitle = state.actions.extractMessage || t('act.extract.title');
        var extractLabel = t('act.extract.run');
        if (state.actions.extractInFlight) extractLabel = t('act.extract.running');
        else if (state.actions.extractStatus === 'done') extractLabel = state.actions.extractPartial ? t('act.extract.partial') : (state.actions.extractFallback ? t('act.extract.rules') : t('act.extract.done'));
        else if (state.actions.extractStatus === 'error') extractLabel = t('act.extract.error');
        html += '<button class="btn btn-primary' + (state.actions.extractInFlight ? ' btn-working' : '') + '" data-action="extract-actions" type="button" title="' + esc(extractTitle) + '" style="margin-left:auto;"' + (state.actions.extractInFlight ? ' disabled aria-busy="true"' : '') + '>' + esc(extractLabel) + '</button>';
        var cleanupLabel = t('act.cleanup.run');
        if (state.actions.cleanupInFlight) cleanupLabel = t('act.cleanup.running');
        else if (state.actions.cleanupStatus === 'done') cleanupLabel = t('act.cleanup.done');
        else if (state.actions.cleanupStatus === 'error') cleanupLabel = t('act.cleanup.error');
        html += '<button class="btn' + (state.actions.cleanupInFlight ? ' btn-working' : '') + '" data-action="update-cards" type="button" title="' + esc(state.actions.cleanupMessage || t('act.cleanup.title')) + '"' + (state.actions.cleanupInFlight ? ' disabled aria-busy="true"' : '') + '>' + esc(cleanupLabel) + '</button>';
        html += '<button class="btn' + (state.actions.stale ? ' btn-soft-alert' : '') + '" data-action="refresh-actions" type="button">' + (state.actions.stale ? t('act.refresh') : t('act.refresh')) + '</button>';
        html += '</div>';
        return html;
      }
      function renderActionCard(a, isFrontier) {
        var html = '<article class="action-item-card action-approved-card">';
        html += '<div class="action-priority-rail ' + priorityClass(a.priority) + '"></div>';
        html += '<div class="action-candidate-main">';
        html += '<div class="action-item-title">' + esc(compactActionTitle(a.title)) + '</div>';
        var actionDesc = actionChainStatusText(a) || actionDescriptionText(a.description);
        if (actionDesc) html += '<div class="action-item-desc">' + esc(truncate(actionDesc, 120)) + '</div>';
        if (actionNeedsRecheck(a)) html += '<div class="action-recheck-note">' + esc(t('act.recheck')) + '</div>';
        // STEP-16 calm card: source + relative time are hidden at rest and fade in
        // on hover; priority shows on the rail, status via the group. No badges /
        // status icon / classification tags.
        var metaParts = [];
        var sourceText = actionSourceText(a);
        var sourceTs = actionTimestamp(a);
        if (sourceText) metaParts.push(t('act.from') + ' ' + esc(sourceText));
        if (sourceTs) metaParts.push(esc(relativeTime(sourceTs)));
        if (metaParts.length) html += '<div class="action-item-submeta"' + (sourceTs ? ' title="' + esc(absoluteHour(sourceTs)) + '"' : '') + '>' + metaParts.join(' · ') + '</div>';
        html += '</div>';
        html += '<div class="action-item-actions">';
        html += '<div class="action-secondary">';
        var jumpObsId = Array.isArray(a.sourceObservationIds) ? a.sourceObservationIds.find(function(id) { return typeof id === 'string' && id.length > 0; }) : '';
        var refreshing = !!(state.actions.cardRefreshInFlight && state.actions.cardRefreshInFlight[a.id]);
        if (jumpObsId) html += '<button class="btn-ghost-sm action-source-link" type="button" data-action="jump-to-evidence" data-obs-id="' + esc(jumpObsId) + '">' + esc(t('act.viewSource')) + '</button>';
        html += '<button class="btn-ghost-sm action-refresh-link' + (refreshing ? ' btn-working' : '') + '" data-action="refresh-action-card" data-action-id="' + esc(a.id || '') + '" type="button"' + (refreshing ? ' disabled aria-busy="true"' : '') + '>' + esc(refreshing ? t('act.cardRefresh.running') : t('act.cardRefresh.run')) + '</button>';
        if (a.status !== 'cancelled') html += '<button class="btn-ghost-sm action-archive-link" data-action="action-status" data-action-id="' + esc(a.id || '') + '" data-status="cancelled" type="button">' + esc(t('act.status.archive')) + '</button>';
        html += '</div>';
        if (a.status !== 'done') html += '<button class="btn-primary-sm" data-action="action-status" data-action-id="' + esc(a.id || '') + '" data-status="done" type="button">' + esc(t('act.status.complete')) + '</button>';
        html += '</div>';
        html += '</article>';
        return html;
      }
      function renderActionGroup(status, group) {
        if (!group.length) return '';
        var html = '<section class="action-group">';
        var title = status === 'todo' ? t('act.metric.todo') : (status === 'done' ? t('act.metric.done') : statusLabel(status));
        html += '<div class="action-group-head"><div class="action-group-title">' + esc(title) + '</div><div class="lesson-count-pill">' + group.length + ' ' + t('act.itemsUnit') + '</div></div>';
        html += '<div class="action-card-list">';
        group.forEach(function(a) {
          html += renderActionCard(a, frontierIds.has(a.id));
        });
        html += '</div></section>';
        return html;
      }
      function renderTodoGroup(group) {
        var cards = Array.isArray(group) ? group : [];
        var total = cards.length;
        if (!total) return '';
        var html = '<section class="action-group unified-todo-section">';
        html += '<div class="action-group-head"><div class="action-group-title">' + esc(t('act.metric.todo')) + '</div><div class="lesson-count-pill">' + total + ' ' + t('act.itemsUnit') + '</div></div>';
        html += '<div class="action-card-list">';
        cards.forEach(function(a) {
          html += renderActionCard(a, frontierIds.has(a.id));
        });
        html += '</div></section>';
        return html;
      }
      function renderFoldedOpenSection(group, title, lead, stateKey, actionName) {
        if (!group.length) return '';
        var expanded = !!state.actions[stateKey];
        var html = '<section class="action-group action-folded-section">';
        html += '<button type="button" class="action-folded-head" data-action="' + esc(actionName) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">';
        html += '<div><div class="action-group-title">' + esc(title) + '</div><div class="action-folded-lead">' + esc(lead) + '</div></div>';
        html += '<div class="action-folded-meta"><span class="lesson-count-pill">' + group.length + ' ' + t('act.itemsUnit') + '</span><span class="done-today-caret">' + (expanded ? '▾' : '▸') + '</span></div>';
        html += '</button>';
        if (expanded) {
          html += '<div class="action-card-list">';
          group.forEach(function(a) {
            html += renderActionCard(a, frontierIds.has(a.id));
          });
          html += '</div>';
        }
        html += '</section>';
        return html;
      }
      var statusCounts = { active: 0, blocked: 0, pending: 0, done: 0, cancelled: 0 };
      metricItems.forEach(function(a) { if (statusCounts[a.status] !== undefined) statusCounts[a.status] += 1; });

      var html = renderActionFilters();

      if (items.length === 0) {
        html += '<div class="empty-state">' +
          '<div class="empty-icon">&#9745;</div>' +
          '<div class="empty-title">' + t('act.empty.title') + '</div>' +
          '<div class="empty-lead">' + t('act.empty.lead') + '</div>' +
          '</div>';
      } else {
        items = items.slice().sort(function(a, b) {
          var order = { active: 1, blocked: 2, pending: 3, done: 4, cancelled: 5 };
          return (order[a.status] || 9) - (order[b.status] || 9) || (Number(b.priority) || 0) - (Number(a.priority) || 0);
        });
        // STEP-C4:无筛选的默认视图里,done 不混在分组流中,改由底部 Done
        // 折叠区单独承载、且只显当天完成的(§3.2/§3.3)。点了 Done 筛选 chip
        // (statusFilter==='done')时则照常全列,不走折叠区。
        // STEP-12:cancelled(归档/被更新丢弃/被合并)也不进默认活动视图——否则
        // 合并/丢弃后卡片仍以「已取消」分组留在原处,看着像「没生效」。
        if (defaultView || (todoFilterActive && !search)) {
          var defaultSplit = splitDefaultOpenItems(items);
          html += renderTodoGroup(defaultSplit.focus);
          html += renderFoldedOpenSection(defaultSplit.earlier, t('act.section.earlier'), t('act.section.earlierLead'), 'earlierOpenExpanded', 'toggle-earlier-open');
          html += renderFoldedOpenSection(defaultSplit.older, t('act.section.older'), t('act.section.olderLead'), 'olderBacklogExpanded', 'toggle-older-backlog');
          html += renderFoldedOpenSection(defaultSplit.legacy, t('act.section.legacy'), t('act.section.legacyLead'), 'legacyBacklogExpanded', 'toggle-legacy-backlog');
          if (defaultView) html += renderDoneTodaySection(items.filter(function(a) { return a.status === 'done'; }), frontierIds, renderActionCard);
        } else {
          if (statusFilter !== 'done') {
            html += renderTodoGroup(items.filter(function(a) { return a.status === 'pending' || a.status === 'blocked' || a.status === 'active'; }));
          }
          if (!todoFilterActive) {
            html += renderActionGroup('done', items.filter(function(a) { return a.status === 'done'; }));
          }
        }
      }

      var __focus = captureSearchFocus(['actions-search']);
      el.innerHTML = html;
      var __as = document.getElementById('actions-search');
      if (__as) bindImeSafeSearch(__as, 200, function(v){ state.actions.search = v; renderActions(); });
      restoreSearchFocus(__focus);
    }
