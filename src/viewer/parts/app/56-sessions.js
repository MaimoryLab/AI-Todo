    async function loadSessions(options) {
      options = options || {};
      var reason = options.reason || 'manual';
      var showLoading = options.showLoading !== false;
      var requestSeq = (state.sessions.requestSeq || 0) + 1;
      state.sessions.requestSeq = requestSeq;
      var el = document.getElementById('view-sessions');
      if (showLoading || !state.sessions.loaded) el.innerHTML = '<div class="loading">加载会话中...</div>';
      var results = await Promise.all([
        settledData('工作台会话', { sessions: [] }, function() { return apiGet('sessions'); }),
        settledData('本地会话', [], function() { return loadLocalCodexSessions(120); }),
        settledData('浏览器对话', { items: [] }, function() { return apiGet('review?limit=200'); })
      ]);
      if (state.sessions.requestSeq !== requestSeq) return;
      state.sessions.warnings = results.filter(function(r) { return r.failed; }).map(function(r) { return r.label; });
      var browserSessions = browserReviewSessions((results[2].data && results[2].data.items) || []);
      state.sessions.items = mergeSessions(((results[0].data && results[0].data.sessions) || []).concat(browserSessions), results[1].data || []).filter(function(s) { return !isDemoSession(s); });
      pruneSessionHighlightCache(state.sessions.items);
      pruneSessionDetailCache(state.sessions.items);
      if (reason === 'manual') state.sessions.stale = false;
      state.sessions.loaded = true;
      renderSessions();
    }

    function renderSessions() {
      var el = document.getElementById('view-sessions');
      var items = state.sessions.items.slice().sort(function(a, b) {
        return (sessionRecordTime(b) || '').localeCompare(sessionRecordTime(a) || '');
      });

      var html = '<div class="session-list">';
      html += renderDataWarnings(state.sessions.warnings, 'refresh-sessions');
      html += '<div id="sessions-stale-notice">' + sessionStaleNoticeMarkup() + '</div>';
      if (items.length === 0) {
        html += '<div class="empty-state"><div class="empty-icon">&#128466;</div><p>' + (state.sessions.warnings && state.sessions.warnings.length ? t('ses.emptyNeedRetry') : t('ses.empty')) + '</p>';
        if (state.sessions.warnings && state.sessions.warnings.length) html += '<div style="margin-top:10px;"><button class="btn btn-primary" data-action="refresh-sessions">' + t('ses.retry') + '</button></div>';
        html += '</div>';
      } else {
        var groupMode = state.sessions.groupMode === 'source' ? 'source' : 'folder';
        state.sessions.groupMode = groupMode;
        var projectGroups = groupSessionsByProject(items);
        var sourceGroups = sessionSourceGroups(items);
        var folderGroups = [{
          key: 'all',
          name: t('ses.allSessions'),
          sessions: items,
          count: items.length,
          latest: projectGroups[0] ? projectGroups[0].latest : '',
          observations: items.reduce(function(sum, s) { return sum + (s.observationCount || 0); }, 0),
          sources: {},
          hasMissingId: false
        }].concat(projectGroups);
        var groups = groupMode === 'source' ? sourceGroups.map(function(g) {
          return {
            key: g.key,
            name: g.name,
            count: g.count,
            latest: g.latest,
            observations: g.observations,
            sessions: g.key === 'all' ? items : items.filter(function(s) { return sessionSourceKey(s) === g.key; })
          };
        }) : folderGroups;
        var activeGroupKey = groupMode === 'source' ? (state.sessions.sourceKey || 'all') : (state.sessions.folderKey || 'all');
        if (!groups.some(function(g) { return g.key === activeGroupKey; })) activeGroupKey = 'all';
        if (groupMode === 'source') state.sessions.sourceKey = activeGroupKey;
        else state.sessions.folderKey = activeGroupKey;
        var activeGroup = groups.find(function(g) { return g.key === activeGroupKey; }) || groups[0];
        var visibleItems = activeGroup.sessions || [];
        var totalObs = items.reduce(function(sum, s) { return sum + (s.observationCount || 0); }, 0);
        html += '<div class="session-hero">';
        html += '<div><div class="session-hero-title">' + t('ses.heroTitle') + '</div><div class="session-hero-note">' + t('ses.heroNote') + '</div></div>';
        html += '<div class="session-hero-meta">' + items.length + ' ' + t('ses.unitSessions') + ' · ' + projectGroups.length + ' ' + t('ses.unitFolders') + ' · ' + (sourceGroups.length - 1) + ' ' + t('ses.unitSources') + ' · ' + totalObs + ' ' + t('ses.unitRecords') + '</div>';
        html += '</div>';
        html += '<div id="session-detail"></div>';

        html += '<section class="session-section">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px;">';
        html += '<span class="mode-switch" aria-label="' + esc(t('ses.groupModeAria')) + '">';
        html += '<button type="button" class="' + (groupMode === 'folder' ? 'active' : '') + '" data-action="session-group-mode" data-mode="folder">' + t('ses.byFolder') + '</button>';
        html += '<button type="button" class="' + (groupMode === 'source' ? 'active' : '') + '" data-action="session-group-mode" data-mode="source">' + t('ses.bySource') + '</button>';
        html += '</span>';
        html += '<button class="btn" data-action="refresh-sessions">' + t('act.refresh') + '</button>';
        html += '</div>';
        html += '<div class="session-inbox">';
        html += '<aside class="session-source-rail" aria-label="' + esc(t('ses.groupAria')) + '">';
        html += '<div class="session-source-label">' + (groupMode === 'source' ? t('ses.source') : t('ses.folder')) + '</div>';
        groups.forEach(function(g) {
          var latest = g.sessions && g.sessions[0];
          var preview = latest ? sessionBodyPreview(latest, sessionTitleText(latest)) : '';
          html += '<button type="button" class="session-source-chip' + (g.key === activeGroupKey ? ' active' : '') + '" data-action="select-session-group" data-group-key="' + esc(g.key) + '" title="' + esc(g.key) + '">';
          html += '<span class="session-source-name">' + esc(g.name) + '</span><span class="session-source-count">' + g.count + '</span>';
          if (preview) html += '<span class="folder-hover-preview">' + esc(truncate(preview, 150)) + '</span>';
          html += '</button>';
        });
        html += '</aside>';
        html += '<div class="session-inbox-main">';
        html += '<div class="session-inbox-head"><div><div class="session-inbox-title">' + esc(activeGroup ? activeGroup.name : t('ses.allSessions')) + '</div><div class="session-inbox-note">' + visibleItems.length + ' ' + t('ses.unitSessions') + ' · ' + ((activeGroup && activeGroup.observations) || 0) + ' ' + t('ses.unitRecords') + '</div></div></div>';
        if (!visibleItems.length) {
          html += '<div class="session-empty-filter">' + (groupMode === 'source' ? t('ses.emptySource') : t('ses.emptyFolder')) + '</div>';
        } else {
          visibleItems.forEach(function(s) {
            var id = sessionId(s);
            var title = sessionTitleText(s);
            var preview = sessionBodyPreview(s, title) || t('ses.noPreview');
            var source = inferSessionSource(s);
            var avatarLabel = (source.name || t('ses.avatarFallback')).replace(/\s+/g, '').slice(0, 2);
            var selected = id && state.sessions.selectedId === id;
            html += '<button type="button" class="session-row' + (selected ? ' selected' : '') + '" data-action="select-session" data-session-id="' + esc(id || '') + '">';
            html += '<span class="session-row-avatar" aria-hidden="true">' + esc(avatarLabel || t('ses.avatarFallback')) + '</span>';
            html += '<div>';
            html += '<div class="session-row-title">' + esc(title || t('dash.unnamedSession')) + '</div>';
            html += '<div class="session-row-preview">' + esc(preview) + '</div>';
            html += '<div class="session-row-meta"><span>' + esc(source.name || t('ses.localRecord')) + '</span><span>' + esc(projectDisplayName(sessionProjectKey(s))) + '</span></div>';
            html += '</div>';
            html += '<div class="session-row-side"><span>' + esc(shortDateTime(sessionRecordTime(s))) + '</span><span class="session-row-count">' + (s.observationCount || 0) + ' ' + t('ses.recordsUnit') + '</span></div>';
            html += '</button>';
          });
        }
        html += '</div></div>';
        html += '</section>';
      }
      html += '</div>';
      el.innerHTML = html;

      if (state.sessions.selectedId) renderSessionDetail();
    }

    function selectSession(id) {
      state.sessions.selectedId = id;
      renderSessions();
      setTimeout(function() {
        var panel = document.getElementById('session-detail');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 80);
    }

    var SESSION_HIGHLIGHT_LABELS = {
      goal: '用户',
      agent_output: 'Agent',
      tool: '工具',
      mcp: 'MCP',
      command: '命令',
      failure: '失败',
      validation: '验证',
      file: '文件',
      artifact: '产物',
      skill: 'Skill',
      todo: '待办',
      follow_up: '后续'
    };

    function sessionHighlightCacheKey(s) {
      if (!s) return '';
      return [
        sessionId(s),
        s.status || '',
        s.observationCount || 0,
        s.updatedAt || '',
        s.endedAt || '',
        s.startedAt || ''
      ].join('|');
    }

    function pruneSessionHighlightCache(items) {
      var keep = {};
      (items || []).forEach(function(s) {
        var id = sessionId(s);
        if (id) keep[id] = sessionHighlightCacheKey(s);
      });
      Object.keys(state.sessions.highlightsById || {}).forEach(function(id) {
        if (!keep[id] || state.sessions.highlightsById[id].cacheKey !== keep[id]) {
          delete state.sessions.highlightsById[id];
        }
      });
    }

    function pruneSessionDetailCache(items) {
      var keep = {};
      (items || []).forEach(function(s) {
        var id = sessionId(s);
        if (id) keep[id] = sessionHighlightCacheKey(s);
      });
      Object.keys(state.sessions.detailCacheById || {}).forEach(function(id) {
        if (!keep[id] || state.sessions.detailCacheById[id].cacheKey !== keep[id]) {
          delete state.sessions.detailCacheById[id];
        }
      });
    }

    function sessionDetailSections(id) {
      if (!state.sessions.detailSectionsById) state.sessions.detailSectionsById = {};
      if (!state.sessions.detailSectionsById[id]) {
        state.sessions.detailSectionsById[id] = { highlights: true, process: false };
      }
      return state.sessions.detailSectionsById[id];
    }

    function renderSessionSectionTitle(sessionIdValue, section, title, expanded) {
      return '<div class="card-title" style="display:flex;justify-content:space-between;align-items:center;gap:10px;">' +
        '<span>' + esc(title) + '</span>' +
        '<button type="button" class="btn" style="padding:4px 8px;font-size:11px;" data-action="toggle-session-detail-section" data-session-id="' + esc(sessionIdValue) + '" data-section="' + esc(section) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '">' + (expanded ? '收起' : '展开') + '</button>' +
      '</div>';
    }

    function toggleSessionDetailSection(id, section) {
      if (!id || (section !== 'highlights' && section !== 'process')) return;
      var sections = sessionDetailSections(id);
      sections[section] = !sections[section];
      renderSessionDetail({ useCacheOnly: true });
    }

    async function getSessionHighlights(id, sessionRecord) {
      if (!id) return { ok: false, highlights: [] };
      var cacheKey = sessionHighlightCacheKey(sessionRecord);
      var cached = state.sessions.highlightsById[id];
      if (cached && cached.cacheKey === cacheKey) return cached;
      var result = await apiGet('session/highlights?sessionId=' + encodeURIComponent(id) + '&maxItems=12');
      var view = result && result.success === true && Array.isArray(result.highlights)
        ? { ok: true, highlights: result.highlights, cacheKey: cacheKey }
        : { ok: false, highlights: [], cacheKey: cacheKey };
      state.sessions.highlightsById[id] = view;
      return view;
    }

    function sessionDialogueHighlights(view) {
      return (Array.isArray(view && view.highlights) ? view.highlights : []).filter(function(item) {
        return item && (item.category === 'goal' || item.category === 'agent_output');
      });
    }

    function renderSessionHighlights(sessionIdValue, view, expanded) {
      var html = '<div class="card" style="margin-bottom:12px;" data-section="highlights">';
      html += renderSessionSectionTitle(sessionIdValue, 'highlights', '会话重点', expanded);
      if (!expanded) return html + '</div>';
      if (!view || view.ok === false) {
        html += '<div style="font-size:13px;color:var(--ink-faint);margin-top:8px;">会话重点暂不可用</div></div>';
        return html;
      }
      var highlights = sessionDialogueHighlights(view);
      if (highlights.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);margin-top:8px;">暂无会话重点</div></div>';
        return html;
      }
      var compactHighlights = highlights.length > 4;
      html += '<div class="session-highlights-list' + (compactHighlights ? ' compact' : '') + '" style="display:grid;gap:10px;margin-top:10px;">';
      highlights.forEach(function(item) {
        var label = SESSION_HIGHLIGHT_LABELS[item.category] || item.category || '重点';
        html += '<div style="display:grid;grid-template-columns:82px 1fr;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-light);">';
        html += '<div><span class="badge badge-muted" style="font-size:10px;padding:3px 8px;">' + esc(label) + '</span></div>';
        html += '<div style="min-width:0;">';
        html += '<div style="font-size:14px;color:var(--ink);font-weight:600;line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere;">' + esc(item.title || label) + '</div>';
        if (item.summary) html += '<div class="md-body" style="font-size:13px;color:var(--ink-muted);line-height:1.45;margin-top:3px;overflow-wrap:anywhere;">' + renderMarkdownSafe(item.summary) + '</div>';
        html += '</div></div>';
      });
      html += '</div>';
      if (compactHighlights) {
        html += '<div style="margin-top:8px;font-size:12px;color:var(--ink-faint);">仅展示前几条重点；需要完整内容时使用完整对话过程。</div>';
      }
      html += '</div>';
      return html;
    }

    function isSessionPreviewExpanded(id) {
      return !!(state.sessions.previewExpandedById && state.sessions.previewExpandedById[id]);
    }

    function toggleSessionPreview(id) {
      if (!id) return;
      if (!state.sessions.previewExpandedById) state.sessions.previewExpandedById = {};
      state.sessions.previewExpandedById[id] = !state.sessions.previewExpandedById[id];
      renderSessionDetail({ useCacheOnly: true });
    }

    async function renderSessionDetail(options) {
      options = options || {};
      var panel = document.getElementById('session-detail');
      if (!panel) return;
      var s = state.sessions.items.find(function(x) { return sessionId(x) === state.sessions.selectedId; });
      var id = sessionId(s);
      if (!s || !id) { panel.innerHTML = ''; return; }

      var cacheKey = sessionHighlightCacheKey(s);
      var cachedDetail = state.sessions.detailCacheById && state.sessions.detailCacheById[id];
      var hasFreshCache = cachedDetail && cachedDetail.cacheKey === cacheKey;
      var obs;
      var highlightsView;
      if (hasFreshCache) {
        obs = cachedDetail.observations || [];
        highlightsView = cachedDetail.highlightsView || { ok: false, highlights: [], cacheKey: cacheKey };
      } else if (options.useCacheOnly) {
        return;
      } else {
        var detailRequestSeq = (state.sessions.detailRequestSeq || 0) + 1;
        state.sessions.detailRequestSeq = detailRequestSeq;
        if (!panel.innerHTML) panel.innerHTML = '<div class="detail-panel"><h3>加载会话详情中…</h3></div>';
        obs = [];
        if (!Array.isArray(s.embeddedObservations) || String(s.id || '').indexOf('browser_sync_') >= 0 || !s.id) {
          obs = Array.isArray(s.embeddedObservations) ? s.embeddedObservations : [];
        }
        if (!obs.length && id) {
          var obsRes = await apiGet('observations?sessionId=' + encodeURIComponent(id));
          obs = (obsRes && obsRes.observations) || [];
        }
        if ((!obs || obs.length === 0) && Array.isArray(s.embeddedObservations)) {
          obs = s.embeddedObservations;
        }
        if ((!obs || obs.length === 0) && String(s.source || '').indexOf('local-') === 0) {
          var localRes = await apiGet('local-agent-session-events?sessionId=' + encodeURIComponent(id));
          obs = (localRes && localRes.observations) || obs || [];
        }
        highlightsView = await getSessionHighlights(id, s);
        if (state.sessions.detailRequestSeq !== detailRequestSeq || state.sessions.selectedId !== id) return;
        state.sessions.detailCacheById[id] = {
          cacheKey: cacheKey,
          observations: obs || [],
          highlightsView: highlightsView,
        };
      }

      var typeCounts = {};
      var toolCounts = {};
      var fileSet = new Set();
      var firstPromptFromObs = '';
      obs.forEach(function(o) {
        var t = o.type || o.hookType || 'other';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
        var tool = o.title || o.toolName;
        if (tool && t !== 'conversation') toolCounts[tool] = (toolCounts[tool] || 0) + 1;
        (o.files || []).forEach(function(f) { fileSet.add(f); });
        if (!firstPromptFromObs && (o.userPrompt || (o.type === 'conversation' && o.narrative))) {
          firstPromptFromObs = o.userPrompt || o.narrative || '';
        }
      });

      var durationMs = s.endedAt ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime() : 0;
      var durationLabel = durationMs > 0 ? (durationMs < 60000 ? (durationMs / 1000).toFixed(1) + 's' : (durationMs / 60000).toFixed(1) + 'm') : '-';

      var detailTitle = sessionTitleText(s);
      var preview = sessionBodyPreview({ summary: s.summary, latestPrompt: firstPromptFromObs, firstPrompt: s.firstPrompt }, detailTitle) || firstPromptFromObs || s.summary || s.firstPrompt || '';
      var detailSections = sessionDetailSections(id);

      var html = '<div class="detail-panel" id="session-detail-top">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;">';
      html += '<div><h3 style="margin:0;">会话时间线</h3><div style="font-size:12px;color:var(--ink-muted);margin-top:4px;">' + esc(projectDisplayName(sessionProjectKey(s))) + ' · ' + esc(shortDateTime(sessionRecordTime(s))) + '</div></div>';
      html += statusIconMarkup(s.status, sessionStatusLabel(s.status));
      html += '</div>';

      if (preview) {
        var previewExpanded = isSessionPreviewExpanded(id);
        var previewIsLong = String(preview).length > 260;
        html += '<div class="session-detail-preview' + (!previewExpanded && previewIsLong ? ' compact' : '') + '">' + esc(preview) + '</div>';
        if (previewIsLong) {
          html += '<button type="button" class="btn" style="padding:4px 8px;font-size:11px;margin:-4px 0 12px;" data-action="toggle-session-preview" data-session-id="' + esc(id) + '">' + (previewExpanded ? '收起摘要' : '展开摘要') + '</button>';
        }
      }

      html += '<div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px;margin-bottom:14px;">';
      html += '<div class="card" style="padding:10px;"><div style="font-size:10px;letter-spacing:0.08em;color:var(--ink-muted);">记录</div><div style="font-size:20px;font-weight:600;">' + obs.length + '</div></div>';
      html += '<div class="card" style="padding:10px;"><div style="font-size:10px;letter-spacing:0.08em;color:var(--ink-muted);">操作类型</div><div style="font-size:20px;font-weight:600;">' + Object.keys(typeCounts).length + '</div></div>';
      html += '<div class="card" style="padding:10px;"><div style="font-size:10px;letter-spacing:0.08em;color:var(--ink-muted);">文件</div><div style="font-size:20px;font-weight:600;">' + fileSet.size + '</div></div>';
      html += '<div class="card" style="padding:10px;"><div style="font-size:10px;letter-spacing:0.08em;color:var(--ink-muted);">时长</div><div style="font-size:20px;font-weight:600;">' + esc(durationLabel) + '</div></div>';
      html += '</div>';

      html += renderSessionHighlights(id, highlightsView, detailSections.highlights !== false);

      var timelineObs = obs.slice().sort(function(a, b) { return (a.timestamp || '').localeCompare(b.timestamp || ''); });
      var processExpanded = detailSections.process === true;
      var isLongTimeline = timelineObs.length > 80;
      html += '<div class="card" style="margin-bottom:12px;" data-section="process">';
      html += renderSessionSectionTitle(id, 'process', '完整对话过程 · ' + timelineObs.length + ' 条', processExpanded);
      if (processExpanded && isLongTimeline) {
        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:8px;"><div style="font-size:12px;color:var(--ink-muted);">记录很多，可以先跳到底部看最近进展。</div><button class="btn" data-action="session-jump" data-target="bottom">跳到底部</button></div>';
      }
      if (processExpanded && timelineObs.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);margin-top:8px;">这段会话还没有可展示的过程记录。</div>';
      } else if (processExpanded) {
        html += '<div style="display:grid;gap:8px;margin-top:10px;">';
        timelineObs.forEach(function(o) {
          var display = observationDisplay(o);
          var type = o.type || o.hookType || 'other';
          html += '<div' + (o && o.id ? ' id="obs-anchor-' + esc(o.id) + '"' : '') + ' style="display:grid;grid-template-columns:72px 1fr;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-light);">';
          html += '<div style="font-size:12px;color:var(--ink-faint);font-family:var(--font-ui);">' + esc(shortTime(o.timestamp)) + '</div>';
          html += '<div><div style="font-size:14px;color:var(--ink);font-weight:600;line-height:1.35;white-space:pre-wrap;">' + esc(display.title || observationTypeLabel(type)) + '</div>';
          if (display.body) html += '<div class="md-body" style="font-size:13px;color:var(--ink-muted);line-height:1.45;margin-top:3px;overflow-wrap:anywhere;">' + renderMarkdownSafe(display.body) + '</div>';
          html += '</div></div>';
        });
        html += '</div>';
        if (isLongTimeline) html += '<div id="session-detail-bottom" style="display:flex;justify-content:flex-end;margin-top:10px;"><button class="btn" data-action="session-jump" data-target="top">回到顶部</button></div>';
      }
      html += '</div>';

      var topTools = Object.keys(toolCounts).sort(function(a, b) { return toolCounts[b] - toolCounts[a]; }).slice(0, 10);
      if (topTools.length > 0) {
        var maxC = toolCounts[topTools[0]] || 1;
        html += '<div class="card" style="margin-bottom:12px;"><div class="card-title">工具使用</div>';
        html += '<div class="bar-chart" style="margin-top:8px;">';
        topTools.forEach(function(t) {
          var pct = Math.round((toolCounts[t] / maxC) * 100);
          html += '<div class="bar-row"><span class="bar-label" style="font-family:var(--font-mono);">' + esc(t) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:var(--accent);"></div></div><span class="bar-value">' + toolCounts[t] + '</span></div>';
        });
        html += '</div></div>';
      }

      var typeKeys = Object.keys(typeCounts).sort(function(a, b) { return typeCounts[b] - typeCounts[a]; });
      if (typeKeys.length > 0) {
        html += '<div class="card" style="margin-bottom:12px;"><div class="card-title">记录类型</div>';
        html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">';
        typeKeys.forEach(function(t) {
          html += '<span class="badge badge-muted">' + esc(typeDisplayLabel(t)) + ' · ' + typeCounts[t] + '</span>';
        });
        html += '</div></div>';
      }

      if (fileSet.size > 0) {
        var filesArr = Array.from(fileSet).slice(0, 30);
        html += '<div class="card" style="margin-bottom:12px;"><div class="card-title">文件</div>';
        html += '<div style="font-size:12px;font-family:var(--font-mono);line-height:1.6;margin-top:8px;">';
        filesArr.forEach(function(f) { html += '<div>&#8226; ' + esc(f) + '</div>'; });
        if (fileSet.size > 30) html += '<div style="color:var(--ink-faint);">+' + (fileSet.size - 30) + ' more</div>';
        html += '</div></div>';
      }

      var detailId = sessionId(s);
      html += '<div class="card" style="margin-bottom:12px;"><div class="card-title">记录来源</div>';
      html += '<div class="memory-card-grid" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:10px;">';
      sessionSourceSummary(s, obs.length).forEach(function(item) {
        html += '<div class="action-overview-card" style="padding:10px;"><div class="action-overview-label">' + esc(item.label) + '</div><div style="font-size:13px;color:var(--ink);line-height:1.35;margin-top:4px;overflow-wrap:anywhere;">' + esc(item.value || '-') + '</div></div>';
      });
      html += '</div>';
      html += '<details style="margin-top:10px;font-size:12px;color:var(--ink-muted);"><summary style="cursor:pointer;">查看技术细节</summary>';
      html += '<div style="font-family:var(--font-mono);margin-top:8px;line-height:1.7;">';
      html += '<div><span style="color:var(--ink-muted);">id:</span> ' + esc(detailId || '无记录 ID') + '</div>';
      html += '<div><span style="color:var(--ink-muted);">path:</span> ' + esc(s.cwd || '-') + '</div>';
      html += '<div><span style="color:var(--ink-muted);">started:</span> ' + esc(formatTime(s.startedAt)) + '</div>';
      if (s.endedAt) html += '<div><span style="color:var(--ink-muted);">ended:</span> ' + esc(formatTime(s.endedAt)) + '</div>';
      if (s.model) html += '<div><span style="color:var(--ink-muted);">model:</span> ' + esc(s.model) + '</div>';
      if (s.tags && s.tags.length) html += '<div><span style="color:var(--ink-muted);">tags:</span> ' + s.tags.map(esc).join(', ') + '</div>';
      html += '</div></details></div>';

      html += '<div style="display:flex;gap:8px;">';
      if (detailId) {
        html += '<button class="btn btn-primary" data-action="summarize-session" data-session-id="' + esc(detailId) + '">生成摘要</button>';
      } else {
        html += '<button class="btn btn-primary" disabled>暂不能整理</button>';
      }
      html += '</div></div>';
      panel.innerHTML = html;
      applyPendingHighlight();
    }

    async function endSession(id) {
      await apiPost('session/end', { sessionId: id });
      state.sessions.loaded = false;
      loadSessions({ showLoading: true, reason: 'manual' });
    }

    async function summarizeSession(id, btn) {
      if (!btn) return;
      btn.textContent = '生成中...';
      btn.disabled = true;
      try {
        var result = await apiPost('summarize', { sessionId: id });
        state.lessons.loaded = false;
        if (result && result.success) {
          btn.textContent = result.fallback ? '已生成本地摘要' : '已生成摘要';
          btn.title = result.fallback ? '没有可用模型时，已用本地规则从会话记录生成摘要。' : '';
        } else {
          btn.textContent = summarizeErrorLabel(result && (result.reason || result.error));
          btn.title = summarizeErrorHint(result && (result.reason || result.error));
        }
      } catch (err) {
        btn.textContent = '摘要服务未响应';
        btn.title = '本地工作台没有连上摘要接口，请确认 AI Todo worker 正在运行。';
      }
      setTimeout(function() { btn.textContent = '生成摘要'; btn.disabled = false; }, 2600);
    }

    function summarizeErrorLabel(error) {
      if (error === 'no_observations') return '暂无可摘要内容';
      if (error === 'session_not_found') return '会话不存在';
      if (error === 'no_provider') return '缺少模型配置';
      return '生成失败';
    }

    function summarizeErrorHint(error) {
      if (error === 'no_observations') return '这段会话还没有可整理的记录。';
      if (error === 'session_not_found') return '本地数据里没有找到这段会话。';
      if (error === 'no_provider') return '未配置模型时会使用本地规则摘要；如果仍失败，请检查本地 worker 日志。';
      return String(error || '摘要生成失败，请稍后重试。');
    }

    function skillDraftSlug(text) {
      var base = String(text || 'skill').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
      return (base || 'memory-skill').slice(0, 48);
    }
    function skillDraftTitle(groupKey) {
      var name = projectDisplayName(groupKey || '通用经验');
      return name === '通用经验' ? '可复用工作流 Skill' : name + ' 工作流 Skill';
    }
    function buildSkillDraft(groupKey, lessons) {
      var list = (lessons || []).slice().sort(function(a, b) { return (b.confidence || 0) - (a.confidence || 0); }).slice(0, 8);
      var title = skillDraftTitle(groupKey);
      var slug = skillDraftSlug(groupKey || title);
      var tags = [];
      list.forEach(function(l) { (l.tags || []).forEach(function(t) { if (tags.indexOf(t) < 0) tags.push(t); }); });
      var lines = [];
      lines.push('# ' + title);
      lines.push('');
      lines.push('## When to use');
      lines.push('Use this skill when the user is working on ' + projectDisplayName(groupKey || 'a reusable workflow') + ' and needs the agent to apply the repeated lessons below.');
      lines.push('');
      lines.push('## Core lessons');
      if (!list.length) lines.push('- Add confirmed lessons here before installing this skill.');
      list.forEach(function(l) { lines.push('- ' + translateLessonText(l.content)); });
      lines.push('');
      lines.push('## Operating guidance');
      lines.push('- Preserve the user-visible product intent before changing implementation details.');
      lines.push('- Prefer reviewable drafts over automatic writes when the output changes durable memory or local skills.');
      lines.push('- Keep examples, docs, and product UI aligned after every meaningful change.');
      if (tags.length) {
        lines.push('');
        lines.push('## Tags');
        lines.push(tags.slice(0, 10).map(function(t) { return '`' + t + '`'; }).join(' '));
      }
      lines.push('');
      lines.push('## Suggested install path');
      lines.push('`~/.codex/skills/' + slug + '/SKILL.md`');
      return lines.join('\n');
    }
    function openSkillDraft(groupKey) {
      var lessons = (state.lessons.items || []).filter(function(l) {
        var key = l.project || (l.tags && l.tags[0]) || '通用经验';
        return key === groupKey;
      });
      var draft = buildSkillDraft(groupKey, lessons);
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      modal.innerHTML =
        '<h3>Skill 草稿</h3>' +
        '<p>这是从已确认经验生成的草稿，不会自动写入本地 Skill。确认适合长期复用后，再复制到对应 Skill 目录。</p>' +
        '<pre id="skill-draft-preview" class="skill-draft-preview">' + esc(draft) + '</pre>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">关闭</button><button class="btn btn-primary" data-action="copy-skill-draft">复制草稿</button></div>';
      overlay.classList.add('open');
    }

    function openAddLesson() {
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      var projectOptions = '<option value="">全部项目</option>';
      (state.lessons.projects || []).forEach(function(projectKey) {
        projectOptions += '<option value="' + esc(projectKey) + '">' + esc(projectDisplayName(projectKey)) + '</option>';
      });
      modal.innerHTML =
        '<h3>创建经验</h3>' +
        '<p>写下一条以后可以复用、也可能沉淀进本地 Skill 的做法。</p>' +
        '<div class="memory-add-form">' +
        '<label>经验<textarea id="add-lesson-content" rows="6" placeholder="例如：会话页应该像工作档案，而不是聊天记录列表。"></textarea></label>' +
        '<label>适用场景<textarea id="add-lesson-context" rows="3" placeholder="例如：设计记忆产品、会话回放、面向非技术用户的界面时。"></textarea></label>' +
        '<div class="memory-add-grid">' +
        '<label>标签<input id="add-lesson-tags" placeholder="ui, skill, memory-product"></label>' +
        '<label>项目<select id="add-lesson-project">' + projectOptions + '</select><span style="display:block;margin-top:6px;font-size:12px;color:var(--ink-muted);">选择全部项目时，这条经验会作为通用经验保存。</span></label>' +
        '</div>' +
        '<div id="add-lesson-error" class="memory-form-error"></div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">取消</button><button class="btn btn-primary" data-action="save-new-lesson">保存</button></div>';
      overlay.classList.add('open');
      setTimeout(function() {
        var input = document.getElementById('add-lesson-content');
        if (input) input.focus();
      }, 0);
    }

    async function saveNewLesson() {
      var err = document.getElementById('add-lesson-error');
      var content = (document.getElementById('add-lesson-content') || {}).value || '';
      var context = (document.getElementById('add-lesson-context') || {}).value || '';
      var tags = (document.getElementById('add-lesson-tags') || {}).value || '';
      var project = (document.getElementById('add-lesson-project') || {}).value || '';
      if (!content.trim()) {
        if (err) {
          err.style.display = 'block';
          err.textContent = '先写一条经验再保存。';
        }
        return;
      }
      var result = await apiPost('lessons', {
        content: content.trim(),
        context: context.trim(),
        tags: tags.split(',').map(function(t) { return t.trim(); }).filter(Boolean),
        project: project.trim() || undefined,
        confidence: 0.85
      });
      if (!result || result.error) {
        if (err) {
          err.style.display = 'block';
          err.textContent = (result && result.error) || '保存失败，请稍后再试。';
        }
        return;
      }
      closeModal();
      state.lessons.loaded = false;
      await loadLessons();
    }

    async function openSkillDetail(path) {
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      modal.innerHTML = '<h3>Skill 详情</h3><p>正在读取本地 SKILL.md...</p><div class="modal-actions"><button class="btn" data-action="close-modal">关闭</button></div>';
      overlay.classList.add('open');
      var detail = await apiGet('local-skill-detail?path=' + encodeURIComponent(path || ''));
      if (!detail || detail.error) {
        modal.innerHTML = '<h3>Skill 详情</h3><p>' + esc((detail && detail.error) || '读取失败') + '</p><div class="modal-actions"><button class="btn" data-action="close-modal">关闭</button></div>';
        return;
      }
      var html = '<h3>' + esc(detail.name || 'Skill') + '</h3>';
      if (detail.description) html += '<p>' + esc(detail.description) + '</p>';
      html += '<div class="card" style="margin:12px 0;padding:12px;">';
      html += '<div style="font-size:12px;line-height:1.7;color:var(--ink-muted);">';
      html += '<div><strong style="color:var(--ink);">来源文件</strong><br><span style="font-family:var(--font-mono);overflow-wrap:anywhere;">' + esc(detail.path || '') + '</span></div>';
      html += '<div style="margin-top:8px;"><strong style="color:var(--ink);">最近修改</strong><br>' + esc(formatTime(detail.updatedAt)) + '</div>';
      if (detail.argumentHint) html += '<div style="margin-top:8px;"><strong style="color:var(--ink);">参数提示</strong><br>' + esc(detail.argumentHint) + '</div>';
      html += '</div></div>';
      if (detail.headings && detail.headings.length) {
        html += '<div class="card" style="margin:12px 0;padding:12px;"><div class="card-title">结构</div><div class="tag-list">';
        detail.headings.forEach(function(h) { html += '<span class="tag">' + esc(h) + '</span>'; });
        html += '</div></div>';
      }
      html += '<div class="card" style="margin:12px 0;padding:12px;max-height:320px;overflow:auto;">';
      html += '<div class="card-title">内容预览</div>';
      html += '<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px;line-height:1.55;color:var(--ink-secondary);margin:10px 0 0;">' + esc(detail.preview || '暂无内容') + '</pre>';
      html += '</div>';
      html += '<div class="modal-actions"><button class="btn" data-action="copy-skill-path" data-skill-path="' + esc(detail.path || path || '') + '">复制路径</button><button class="btn btn-primary" data-action="close-modal">关闭</button></div>';
      modal.innerHTML = html;
    }

