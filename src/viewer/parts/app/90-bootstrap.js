    document.addEventListener('keydown', function(e) {
      if (state.activeTab !== 'replay') return;
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA')) return;
      if (e.key === ' ') { e.preventDefault(); toggleReplayPlay(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); stepReplay(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); stepReplay(1); }
    });

    // 总览页下拉刷新（顶部向下滑动触发）
    var dashPullStartY = null;
    var dashPullStartTop = false;
    var dashPullTriggered = false;
    var dashPullCooldownAt = 0;
    document.addEventListener('touchstart', function(e) {
      if (state.activeTab !== 'dashboard') return;
      if (!e.touches || e.touches.length !== 1) return;
      var scTop = (window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0);
      dashPullStartTop = scTop <= 2;
      dashPullStartY = e.touches[0].clientY;
      dashPullTriggered = false;
    }, { passive: true });
    document.addEventListener('touchmove', function(e) {
      if (state.activeTab !== 'dashboard') return;
      if (!dashPullStartTop || dashPullStartY === null || dashPullTriggered) return;
      if (!e.touches || e.touches.length !== 1) return;
      var dy = e.touches[0].clientY - dashPullStartY;
      if (dy < 72) return;
      var now = Date.now();
      if (now - dashPullCooldownAt < 1200) return;
      dashPullTriggered = true;
      dashPullCooldownAt = now;
      refreshDashboard();
    }, { passive: true });
    document.addEventListener('touchend', function() {
      dashPullStartY = null;
      dashPullStartTop = false;
      dashPullTriggered = false;
    }, { passive: true });

    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible') {
        refreshActiveTab('visibility');
      }
    });

    renderExpertTabs();
    switchTab(tabFromRoute(), { replaceRoute: true });
    connectWs();
    startDashboardAutoRefresh();
