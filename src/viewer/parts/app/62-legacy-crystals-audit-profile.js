    async function loadCrystals() {
      var el = document.getElementById('view-crystals');
      el.innerHTML = '<div class="loading">正在加载结晶...</div>';
      var results = await Promise.all([apiGet('crystals'), apiGet('lessons')]);
      state.crystals.items = (results[0] && results[0].crystals) || [];
      var lessonMap = {};
      var lessons = (results[1] && results[1].lessons) || [];
      lessons.forEach(function(l) { if (l && l.id) lessonMap[l.id] = l; });
      state.crystals.lessonMap = lessonMap;
      state.crystals.loaded = true;
      renderCrystals();
    }

    function renderCrystals() {
      var el = document.getElementById('view-crystals');
      var items = state.crystals.items;
      var search = state.crystals.search.toLowerCase();
      var lessonMap = state.crystals.lessonMap || {};

      if (search) {
        items = items.filter(function(c) {
          var lessonText = (c.lessons || [])
            .map(function(lid) {
              var l = lessonMap[lid];
              return l && typeof l.content === 'string' ? l.content : lid;
            })
            .join(' ');
          var filesText = (c.filesAffected || []).join(' ');
          var haystack = [
            c.narrative || '',
            (c.keyOutcomes || []).join(' '),
            lessonText,
            filesText,
            c.project || '',
          ].join(' ').toLowerCase();
          return haystack.indexOf(search) >= 0;
        });
      }

      var html = '<div class="crystal-intro">';
      html += '<div><div class="crystal-intro-title">工作沉淀</div>';
      html += '<div class="crystal-intro-copy">这里保留已经整理过的工作结果：做了什么、留下了哪些文件、能复用什么经验。</div></div>';
      html += '<div class="crystal-count-pill">' + items.length + ' 条</div>';
      html += '</div>';

      html += '<div style="display:flex;gap:8px;margin-bottom:12px;">';
      html += '<input id="crystals-search" class="search-input" type="text" placeholder="搜索结晶..." value="' + esc(state.crystals.search) + '" style="flex:1" />';
      html += '</div>';

      if (items.length === 0) {
        html += '<div class="empty-state">' +
          '<div class="empty-icon">&#128142;</div>' +
          '<div class="empty-title">还没有结晶</div>' +
          '<div class="empty-lead">结晶是一次完整工作的压缩摘要，用来保留关键结论、涉及文件和可复用经验。当前还没有生成结晶，但会话和记忆已经可以先使用。</div>' +
          '<pre class="empty-cmd">导入历史会话后，可以把重要会话整理成结晶；后续我会优先把这里做成一键整理。</pre>' +
          '<div><a class="empty-link" href="https://github.com/MaimoryLab/agentmemory-lab#crystals" target="_blank" rel="noopener">结晶说明</a></div>' +
          '</div>';
      } else {
        html += '<div class="crystal-list">';
        items.forEach(function(c) {
          html += '<article class="crystal-card">';
          html += '<div class="crystal-card-head">';
          html += '<div class="crystal-card-title">' + esc(truncate(c.narrative || '未命名工作', 180)) + '</div>';
          html += '<div class="crystal-card-time">' + esc(shortDateTime(c.createdAt)) + '</div>';
          html += '</div>';

          var pillRow = [];
          if (c.project) pillRow.push('<span class="badge badge-muted">' + esc(projectDisplayName(c.project)) + '</span>');
          if (c.filesAffected && c.filesAffected.length) pillRow.push('<span class="badge badge-blue">' + c.filesAffected.length + ' 个文件</span>');
          if (c.lessons && c.lessons.length) pillRow.push('<span class="badge badge-green">' + c.lessons.length + ' 条经验</span>');
          if (pillRow.length) html += '<div class="crystal-meta-row">' + pillRow.join('') + '</div>';

          if (c.filesAffected && c.filesAffected.length > 0) {
            html += '<div class="crystal-section"><div class="crystal-section-label">涉及文件</div>';
            html += '<div class="crystal-soft-list">';
            c.filesAffected.slice(0, 4).forEach(function(f) {
              html += '<div>' + esc(f) + '</div>';
            });
            if (c.filesAffected.length > 4) html += '<div>还有 ' + (c.filesAffected.length - 4) + ' 个文件</div>';
            html += '</div></div>';
          }

          if (c.lessons && c.lessons.length > 0) {
            html += '<div class="crystal-section"><div class="crystal-section-label">可复用经验</div>';
            html += '<div class="crystal-soft-list">';
            c.lessons.slice(0, 3).forEach(function(lid) {
              var content = lessonMap[lid] ? lessonMap[lid].content : lid;
              html += '<div>' + esc(content) + '</div>';
            });
            if (c.lessons.length > 3) html += '<div>还有 ' + (c.lessons.length - 3) + ' 条经验</div>';
            html += '</div></div>';
          }

          html += '</article>';
        });
        html += '</div>';
      }

      var __focus = captureSearchFocus(['crystals-search']);
      el.innerHTML = html;
      var __cs = document.getElementById('crystals-search');
      if (__cs) bindImeSafeSearch(__cs, 200, function(v){ state.crystals.search = v; renderCrystals(); });
      restoreSearchFocus(__focus);
    }

    async function loadAudit() {
      var el = document.getElementById('view-audit');
      el.innerHTML = '<div class="loading">加载审计日志中...</div>';
      var result = await apiGet('audit?limit=100');
      state.audit.entries = (result && result.entries) || [];
      state.audit.loaded = true;
      renderAudit();
    }

    function renderAudit() {
      var el = document.getElementById('view-audit');
      var entries = state.audit.entries;
      var opFilter = state.audit.opFilter;

      var ops = {};
      entries.forEach(function(e) { ops[e.operation] = true; });
      var opList = Object.keys(ops).sort();

      var filtered = opFilter ? entries.filter(function(e) { return e.operation === opFilter; }) : entries;

      var html = '<div class="toolbar">';
      html += '<select id="audit-op-filter"><option value="">全部操作</option>';
      opList.forEach(function(op) {
        html += '<option value="' + esc(op) + '"' + (opFilter === op ? ' selected' : '') + '>' + esc(op) + '</option>';
      });
      html += '</select>';
      html += '<button class="btn" data-action="refresh-audit" style="margin-left:8px;">刷新日志</button>';
      html += '</div>';

      html += '<div class="card">';
      if (filtered.length === 0) {
        if (entries.length === 0) {
          html += '<div class="empty-state"><div class="empty-icon">&#128220;</div><p>暂无审计记录</p><p style="font-size:12px;color:var(--ink-faint);font-style:italic;">当发生删除、演化、合并等治理操作后，这里会出现记录。</p><div style="margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap;"><button class="btn btn-primary" data-dashboard-jump="activity">去活动</button><button class="btn" data-dashboard-jump="sessions">去会话</button></div></div>';
        } else {
          html += '<div class="empty-state"><div class="empty-icon">&#128269;</div><p>当前筛选下无结果</p><div style="margin-top:10px;"><button class="btn" data-action="clear-audit-filter">清空筛选</button></div></div>';
        }
      } else {
        filtered.forEach(function(a, idx) {
          var badgeClass = OP_BADGES[a.operation] || 'badge-muted';
          html += '<div class="audit-entry">';
          html += '<div class="audit-head">';
          html += '<span class="badge ' + badgeClass + '">' + esc(a.operation) + '</span>';
          html += '<span style="font-size:12px;color:var(--ink-muted);font-family:var(--font-mono);">' + esc(a.functionId || '') + '</span>';
          html += '<span style="font-size:10px;color:var(--ink-faint);margin-left:auto;font-family:var(--font-mono);">' + esc(formatTime(a.timestamp)) + '</span>';
          html += '<button class="btn" style="font-size:9px;padding:1px 6px;margin-left:8px;" data-action="toggle-audit" data-audit-index="' + idx + '" aria-label="展开详情">&#9660;</button>';
          html += '</div>';
          if (a.targetIds && a.targetIds.length) {
            html += '<div style="font-size:10px;color:var(--ink-faint);font-family:var(--font-mono);">' + a.targetIds.length + ' 个目标: ' + esc(a.targetIds.slice(0, 3).join(', ')) + (a.targetIds.length > 3 ? '...' : '') + '</div>';
          }
          html += '<div class="audit-detail" id="audit-detail-' + idx + '"><pre>' + esc(JSON.stringify(a.details || {}, null, 2)) + '</pre></div>';
          html += '</div>';
        });
      }
      html += '</div>';

      el.innerHTML = html;

      document.getElementById('audit-op-filter').addEventListener('change', function() {
        state.audit.opFilter = this.value;
        renderAudit();
      });
    }

    function toggleAuditDetail(idx) {
      var el = document.getElementById('audit-detail-' + idx);
      if (el) el.classList.toggle('open');
    }

    async function loadProfile() {
      var el = document.getElementById('view-profile');
      el.innerHTML = '<div class="loading">加载画像中...</div>';
      var sessResult = await apiGet('sessions');
      var sessions = (sessResult && sessResult.sessions) || [];

      var projects = {};
      sessions.forEach(function(s) { if (s.project) projects[s.project] = true; });
      state.profile.projects = Object.keys(projects).sort();
      state.profile.loaded = true;

      if (state.profile.projects.length > 0 && !state.profile.selectedProject) {
        state.profile.selectedProject = state.profile.projects[0];
      }

      renderProfileToolbar();
      if (state.profile.selectedProject) await loadProfileData();
    }

    function renderProfileToolbar() {
      var el = document.getElementById('view-profile');
      var html = '<div class="toolbar">';
      html += '<select id="profile-project">';
      if (state.profile.projects.length === 0) {
        html += '<option value="">暂无项目</option>';
      } else {
        state.profile.projects.forEach(function(p) {
          html += '<option value="' + esc(p) + '"' + (state.profile.selectedProject === p ? ' selected' : '') + '>' + esc(p) + '</option>';
        });
      }
      html += '</select></div>';
      html += '<div id="profile-content"></div>';
      el.innerHTML = html;

      document.getElementById('profile-project').addEventListener('change', function() {
        state.profile.selectedProject = this.value;
        loadProfileData();
      });
    }

    async function loadProfileData() {
      var content = document.getElementById('profile-content');
      if (!content || !state.profile.selectedProject) return;
      content.innerHTML = '<div class="loading">加载画像数据中...</div>';
      var result = await apiGet('profile?project=' + encodeURIComponent(state.profile.selectedProject));
      state.profile.data = (result && result.profile) ? result.profile : result;
      renderProfile();
    }

    function renderProfile() {
      var content = document.getElementById('profile-content');
      if (!content) return;
      var p = state.profile.data;

      if (!p) {
        content.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128203;</div><p>该项目暂无画像数据</p></div>';
        return;
      }

      var html = '<div class="two-col">';

      html += '<div class="card"><div class="card-title">高频概念</div>';
      var concepts = p.topConcepts || [];
      if (concepts.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">No concepts yet</div>';
      } else {
        var maxC = Math.max.apply(null, concepts.map(function(c) { return c.frequency; })) || 1;
        html += '<div class="bar-chart">';
        concepts.slice(0, 10).forEach(function(c) {
          var pct = Math.round((c.frequency / maxC) * 100);
          html += '<div class="bar-row"><span class="bar-label">' + esc(c.concept) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:var(--yellow);"></div></div><span class="bar-value">' + c.frequency + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';

      html += '<div class="card"><div class="card-title">高频文件</div>';
      var files = p.topFiles || [];
      if (files.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">No files yet</div>';
      } else {
        var maxF = Math.max.apply(null, files.map(function(f) { return f.frequency; })) || 1;
        html += '<div class="bar-chart">';
        files.slice(0, 10).forEach(function(f) {
          var pct = Math.round((f.frequency / maxF) * 100);
          html += '<div class="bar-row"><span class="bar-label">' + esc(f.file.split('/').pop()) + '</span><div class="bar-track"><div class="bar-fill" style="width:' + pct + '%;background:var(--green);"></div></div><span class="bar-value">' + f.frequency + '</span></div>';
        });
        html += '</div>';
      }
      html += '</div>';

      html += '</div>';

      html += '<div class="card" style="margin-top:16px;"><div class="card-title">约定</div>';
      var conventions = p.conventions || [];
      if (conventions.length === 0) {
        html += '<div style="font-size:13px;color:var(--ink-faint);font-style:italic;">No conventions detected yet</div>';
      } else {
        html += '<ul style="padding-left:16px;">';
        conventions.forEach(function(c) { html += '<li style="font-size:13px;color:var(--ink-muted);margin-bottom:4px;">' + esc(c) + '</li>'; });
        html += '</ul>';
      }
      html += '</div>';

      if (p.summary) {
        html += '<div class="card" style="margin-top:16px;"><div class="card-title">项目摘要</div>';
        html += '<p style="font-size:13px;color:var(--ink-muted);line-height:1.7;">' + esc(p.summary) + '</p></div>';
      }

      var stats = '<div class="card" style="margin-top:16px;"><div class="card-title">项目统计</div>';
      stats += '<div class="detail-row"><div class="dl">Sessions</div><div class="dv" style="font-family:var(--font-mono);">' + (p.sessionCount || 0) + '</div></div>';
      stats += '<div class="detail-row"><div class="dl">Total Obs</div><div class="dv" style="font-family:var(--font-mono);">' + (p.totalObservations || 0) + '</div></div>';
      stats += '<div class="detail-row"><div class="dl">Updated</div><div class="dv" style="font-family:var(--font-mono);font-size:12px;">' + esc(formatTime(p.updatedAt)) + '</div></div>';
      stats += '</div>';

      content.innerHTML = html + stats;
    }

    var wsReconnectTimer = null;
    var wsRetries = 0;
    var WS_MAX_RETRIES = 4;
    var directFailed = false;
    var directFailures = 0;
    var DIRECT_FAILURE_THRESHOLD = 2;
    var pollTimer = null;
    var POLL_INTERVAL_MS = 10000;

    function setWsStatus(text, cls) {
      var el = document.getElementById('ws-status');
      if (!el) return;
      el.textContent = text;
      el.className = 'ws-status ' + cls;
    }

    var WS_REPROBE_EVERY_TICKS = 6;

    function startPolling() {
      if (pollTimer) return;
      setWsStatus('polling · ' + (POLL_INTERVAL_MS / 1000) + 's', 'disconnected');
      var tick = 0;
      pollTimer = setInterval(function() {
        tick++;
        refreshActiveTab('poll');
        if (tick % WS_REPROBE_EVERY_TICKS === 0) {
          var ws = state.ws;
          if (!ws || ws.readyState !== WebSocket.OPEN) {
            wsRetries = 0;
            directFailures = 0;
            directFailed = false;
            connectWs();
          }
        }
      }, POLL_INTERVAL_MS);
    }

    function stopPolling() {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = null;
    }

    var WS_CONNECT_TIMEOUT_MS = 5000;

