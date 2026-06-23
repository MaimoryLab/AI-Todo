    async function loadReplay() {
      var el = document.getElementById('view-replay');
      el.innerHTML = '<div class="loading">加载会话列表中…</div>';
      var res = await apiGet('replay/sessions');
      state.replay.sessions = (res && res.sessions) || [];
      state.replay.loaded = true;
      renderReplay();
    }

    async function refreshReplaySessions() {
      state.replay.loaded = false;
      await loadReplay();
    }

    function renderReplay() {
      var el = document.getElementById('view-replay');
      var sessions = state.replay.sessions || [];
      var options = '<option value="">— pick a session —</option>' + sessions.map(function(s) {
        var id = sessionId(s);
        var label = sessionDisplayName(s) + ' · ' + (shortSessionId(s, 8) || '无记录 ID') + ' · ' + (s.observationCount || 0) + ' obs';
        return '<option value="' + esc(id) + '"' + (id && id === state.replay.selectedId ? ' selected' : '') + (id ? '' : ' disabled') + '>' + esc(label) + '</option>';
      }).join('');

      var tl = state.replay.timeline;
      var hasTl = tl && tl.events && tl.events.length > 0;
      var cursorEvent = hasTl ? tl.events[Math.min(state.replay.cursor, tl.events.length - 1)] : null;
      var progress = hasTl && tl.totalDurationMs > 0 ? Math.min(100, (state.replay.offsetAt / tl.totalDurationMs) * 100) : 0;

      el.innerHTML =
        '<div class="toolbar">' +
          '<select id="replay-session-select">' + options + '</select>' +
          '<button data-action="replay-refresh">刷新</button>' +
          '<span class="sep"></span>' +
          '<input type="text" id="replay-import-path" placeholder="~/.claude/projects 或 file.jsonl" style="width:280px">' +
          '<button data-action="replay-import">导入 JSONL</button>' +
        '</div>' +
        (hasTl
          ? '<div class="replay-controls">' +
              '<button data-action="replay-step" data-dir="-1" title="上一步 (←)">◀</button>' +
              '<button data-action="replay-toggle-play" title="播放/暂停 (空格)">' + (state.replay.playing ? '❚❚ 暂停' : '▶ 播放') + '</button>' +
              '<button data-action="replay-step" data-dir="1" title="下一步 (→)">▶</button>' +
              '<button data-action="replay-reset" title="重置">⟲</button>' +
              '<span class="sep"></span>' +
              '<span>速度</span>' +
              ['0.5', '1', '2', '4'].map(function(sp) {
                var active = Math.abs(state.replay.speed - parseFloat(sp)) < 0.01;
                return '<button data-action="replay-speed" data-speed="' + sp + '"' + (active ? ' class="active"' : '') + '>' + sp + '×</button>';
              }).join('') +
              '<span class="sep"></span>' +
              '<span>' + (state.replay.cursor + 1) + ' / ' + tl.eventCount + '</span>' +
            '</div>' +
            '<div class="replay-progress"><div class="replay-progress-bar" style="width:' + progress.toFixed(1) + '%"></div></div>' +
            '<div class="replay-grid">' +
              '<div class="replay-list" id="replay-list">' +
                tl.events.map(function(ev, i) {
                  var active = i === state.replay.cursor ? ' replay-event-active' : '';
                  return '<div class="replay-event replay-event-' + esc(ev.kind) + active + '" data-replay-idx="' + i + '">' +
                    '<span class="replay-event-kind">' + esc(ev.kind) + '</span>' +
                    '<span class="replay-event-label">' + esc(ev.label) + '</span>' +
                    '<span class="replay-event-time">' + (ev.offsetMs / 1000).toFixed(1) + 's</span>' +
                  '</div>';
                }).join('') +
              '</div>' +
              '<div class="replay-detail">' + renderReplayDetail(cursorEvent) + '</div>' +
            '</div>'
          : '<div class="empty">请选择一个会话进行回放，或从 ~/.claude/projects 导入 Claude Code 的 JSONL 记录。</div>');

      var sel = document.getElementById('replay-session-select');
      if (sel) sel.addEventListener('change', function() { selectReplaySession(sel.value); });
    }

    function renderReplayDetail(ev) {
      if (!ev) return '<div class="empty">尚未选择事件。</div>';
      var blocks = [];
      blocks.push('<div class="replay-detail-header"><b>' + esc(ev.label) + '</b> <span class="muted">' + esc(ev.kind) + '</span></div>');
      if (ev.ts) blocks.push('<div class="muted">' + esc(formatTime(ev.ts)) + '</div>');
      if (ev.body) {
        blocks.push('<pre class="replay-body">' + esc(ev.body) + '</pre>');
      }
      if (ev.toolName) {
        blocks.push('<div class="replay-tool"><b>工具：</b> ' + esc(ev.toolName) + '</div>');
      }
      if (ev.toolInput !== undefined && ev.toolInput !== null) {
        var inp = typeof ev.toolInput === 'string' ? ev.toolInput : JSON.stringify(ev.toolInput, null, 2);
        blocks.push('<div class="replay-tool-block"><b>输入</b><pre>' + esc(truncate(inp, 4000)) + '</pre></div>');
      }
      if (ev.toolOutput !== undefined && ev.toolOutput !== null) {
        var out = typeof ev.toolOutput === 'string' ? ev.toolOutput : JSON.stringify(ev.toolOutput, null, 2);
        blocks.push('<div class="replay-tool-block"><b>输出</b><pre>' + esc(truncate(out, 4000)) + '</pre></div>');
      }
      return blocks.join('');
    }

    async function selectReplaySession(sessionId) {
      stopReplayTimer();
      state.replay.selectedId = sessionId;
      state.replay.timeline = null;
      state.replay.cursor = 0;
      state.replay.offsetAt = 0;
      state.replay.playing = false;
      if (!sessionId) { renderReplay(); return; }
      var el = document.getElementById('view-replay');
      el.innerHTML = '<div class="loading">加载回放中…</div>';
      var res = await apiGet('replay/load?sessionId=' + encodeURIComponent(sessionId));
      if (res && res.success && res.timeline) {
        state.replay.timeline = res.timeline;
      } else {
        state.replay.timeline = { events: [], eventCount: 0, totalDurationMs: 0 };
      }
      renderReplay();
    }

    function toggleReplayPlay() {
      if (!state.replay.timeline || state.replay.timeline.eventCount === 0) return;
      if (state.replay.playing) {
        stopReplayTimer();
      } else {
        startReplayTimer();
      }
      renderReplay();
    }

    function startReplayTimer() {
      state.replay.playing = true;
      state.replay.startAt = Date.now();
      var baseOffset = state.replay.offsetAt;
      if (state.replay.timer) clearInterval(state.replay.timer);
      state.replay.timer = setInterval(function() {
        if (!state.replay.timeline) return;
        var elapsed = (Date.now() - state.replay.startAt) * state.replay.speed;
        state.replay.offsetAt = baseOffset + elapsed;
        var events = state.replay.timeline.events;
        var newCursor = state.replay.cursor;
        for (var i = newCursor; i < events.length; i++) {
          if (events[i].offsetMs <= state.replay.offsetAt) newCursor = i;
          else break;
        }
        var changed = newCursor !== state.replay.cursor;
        state.replay.cursor = newCursor;
        if (state.replay.offsetAt >= state.replay.timeline.totalDurationMs) {
          state.replay.offsetAt = state.replay.timeline.totalDurationMs;
          stopReplayTimer();
          renderReplay();
          return;
        }
        if (changed) renderReplay();
      }, 100);
    }

    function stopReplayTimer() {
      state.replay.playing = false;
      if (state.replay.timer) {
        clearInterval(state.replay.timer);
        state.replay.timer = null;
      }
    }

    function stepReplay(dir) {
      if (!state.replay.timeline) return;
      stopReplayTimer();
      var next = state.replay.cursor + dir;
      if (next < 0) next = 0;
      if (next >= state.replay.timeline.eventCount) next = state.replay.timeline.eventCount - 1;
      state.replay.cursor = next;
      state.replay.offsetAt = state.replay.timeline.events[next].offsetMs;
      renderReplay();
    }

    function setReplaySpeed(sp) {
      if (!sp || sp <= 0) return;
      var wasPlaying = state.replay.playing;
      stopReplayTimer();
      state.replay.speed = sp;
      if (wasPlaying) startReplayTimer();
      renderReplay();
    }

    function resetReplay() {
      stopReplayTimer();
      state.replay.cursor = 0;
      state.replay.offsetAt = 0;
      renderReplay();
    }

    async function runReplayImport() {
      var input = document.getElementById('replay-import-path');
      var pathVal = input ? input.value.trim() : '';
      var body = {};
      if (pathVal) body.path = pathVal;
      var el = document.getElementById('view-replay');
      var prior = el.innerHTML;
      el.innerHTML = '<div class="loading">Importing JSONL…</div>';
      var res = await apiPost('replay/import-jsonl', body);
      if (!res || res.success === false) {
        el.innerHTML = prior;
        alert((res && res.error) || '导入失败');
        return;
      }
      alert('已导入 ' + (res.imported || 0) + ' 个文件，生成 ' + (res.observations || 0) + ' 条观察记录');
      await refreshReplaySessions();
    }

