    function formatTime(ts) {
      if (!ts) return '';
      try { return new Date(ts).toLocaleString(); } catch { return ts; }
    }
    function shortTime(ts) {
      if (!ts) return '';
      try { return new Date(ts).toLocaleTimeString(); } catch { return ts; }
    }
    // Absolute time down to the hour only (year-month-day hour, no minutes/seconds).
    function absoluteHour(ts) {
      try {
        var d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        var p = function(n) { return (n < 10 ? '0' : '') + n; };
        var base = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours());
        return I18N_LANG === 'zh' ? base + '时' : base + ':00';
      } catch { return ''; }
    }
    // Relative time without minute/second granularity; falls back to absoluteHour
    // for anything older than ~30 days.
    function relativeTime(ts) {
      if (!ts) return '';
      try {
        var diff = Date.now() - new Date(ts).getTime();
        if (!isFinite(diff)) return absoluteHour(ts);
        if (diff < 0) diff = 0;
        var hour = 3600000, day = 86400000, zh = I18N_LANG === 'zh';
        if (diff < hour) return zh ? '刚刚' : 'just now';
        if (diff < day) { var h = Math.floor(diff / hour); return zh ? h + '小时前' : h + 'h ago'; }
        if (diff < 30 * day) { var dd = Math.floor(diff / day); return zh ? dd + '天前' : dd + 'd ago'; }
        return absoluteHour(ts);
      } catch { return absoluteHour(ts); }
    }
    function truncate(s, n) {
      if (!s) return '';
      return s.length > n ? s.slice(0, n) + '...' : s;
    }
