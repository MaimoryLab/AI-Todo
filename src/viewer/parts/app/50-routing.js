    function normalizeTab(tab) {
      var normalized = String(tab || '').replace(/^#/, '').toLowerCase();
      // 专家模式下,被隐藏视图放行;否则按 TAB_REDIRECTS 折回主三栏。
      if (expertModeEnabled() && EXPERT_TABS.some(function(t) { return t.id === normalized; })) {
        return normalized;
      }
      if (TAB_REDIRECTS[normalized]) return TAB_REDIRECTS[normalized];
      return TAB_IDS.indexOf(normalized) >= 0 ? normalized : 'dashboard';
    }

    function tabFromRoute() {
      try {
        return normalizeTab(decodeURIComponent(window.location.hash.slice(1)));
      } catch (_) {
        return 'dashboard';
      }
    }

    function updateTabRoute(tab, replace) {
      var target = '#' + tab;
      if (window.location.hash === target) return;
      if (replace) {
        history.replaceState(null, '', target);
      } else {
        history.pushState(null, '', target);
      }
    }

    function switchTab(tab, opts) {
      opts = opts || {};
      tab = normalizeTab(tab);
      if (state.activeTab === 'replay' && tab !== 'replay' && typeof stopReplayTimer === 'function') {
        stopReplayTimer();
      }
      if (!opts.skipRoute) {
        updateTabRoute(tab, !!opts.replaceRoute);
      }
      state.activeTab = tab;
      document.querySelectorAll('.tab-bar button').forEach(function(b) {
        var isActive = b.dataset.tab === tab;
        b.classList.toggle('active', isActive);
        if (isActive) {
          b.setAttribute('aria-current', 'page');
        } else {
          b.removeAttribute('aria-current');
        }
      });
      document.querySelectorAll('.view').forEach(function(v) {
        v.classList.toggle('active', v.id === 'view-' + tab);
      });
      if (state.flagsConfig) renderFlagBanners(state.flagsConfig);
      loadTab(tab);
    }

    async function loadTab(tab) {
      switch(tab) {
        case 'dashboard': if (!state.dashboard.loaded) await loadDashboard(); break;
        case 'graph': if (!state.graph.loaded) await loadGraph(); break;
        case 'memories': if (!state.memories.loaded) await loadMemories(); break;
        case 'timeline': if (!state.timeline.loaded) await loadTimeline(); break;
        case 'sessions': if (!state.sessions.loaded) await loadSessions(); break;
        case 'lessons': if (!state.lessons.loaded) await loadLessons(); break;
        case 'actions': if (!state.actions.loaded) await loadActions(); break;
        case 'audit': if (!state.audit.loaded) await loadAudit(); break;
        case 'activity': if (!state.activity.loaded) await loadActivity(); break;
        case 'profile': if (!state.profile.loaded) await loadProfile(); break;
        case 'replay': if (!state.replay.loaded) await loadReplay(); break;
      }
    }

