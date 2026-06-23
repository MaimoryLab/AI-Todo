    async function loadLessons() {
      var el = document.getElementById('view-lessons');
      el.innerHTML = '<div class="loading">正在加载经验...</div>';
      var results = await Promise.all([apiGet('lessons?minConfidence=0.5'), apiGet('sessions')]);
      var explicitLessons = (results[0] && results[0].lessons) || [];
      var sessions = (results[1] && results[1].sessions) || [];
      var projects = {};
      sessions.forEach(function(s) {
        var key = sessionProjectKey(s);
        if (key) projects[key] = true;
      });
      state.lessons.items = explicitLessons;
      state.lessons.projects = Object.keys(projects).sort(function(a, b) { return projectDisplayName(a).localeCompare(projectDisplayName(b)); });
      state.lessons.mode = explicitLessons.length ? 'explicit' : 'empty';
      state.lessons.loaded = true;
      renderLessons();
    }

    function renderLessons() {
      var el = document.getElementById('view-lessons');
      var items = state.lessons.items;
      var search = state.lessons.search.toLowerCase();

      if (search) {
        items = items.filter(function(l) {
          return (l.content + ' ' + l.context + ' ' + (l.tags || []).join(' ')).toLowerCase().indexOf(search) >= 0;
        });
      }

      var groups = {};
      items.forEach(function(l) {
        var tags = (l.tags || []).filter(Boolean);
        var key = tags[0] || l.project || '通用工作方式';
        if (!groups[key]) groups[key] = [];
        groups[key].push(l);
      });
      var groupKeys = Object.keys(groups).sort(function(a, b) { return groups[b].length - groups[a].length; });

      var skillQuery = String(state.lessons.skillSearch || '').trim().toLowerCase();
      var skillRootFilter = state.lessons.skillRootFilter || 'all';
      function skillMatches(skill) {
        var rootOk = skillRootFilter === 'all' || String(skill.root || '') === skillRootFilter;
        if (!rootOk) return false;
        if (!skillQuery) return true;
        return String(skill.name || '').toLowerCase().indexOf(skillQuery) >= 0 || String(skill.path || '').toLowerCase().indexOf(skillQuery) >= 0 || String(skill.root || '').toLowerCase().indexOf(skillQuery) >= 0;
      }
      function skillRootMeta(root) {
        var known = {
          Codex: { title: 'Codex 环境', sub: '这个 agent 会加载' },
          Agents: { title: '共享目录', sub: '多个 agent 可复用' },
          Plugin: { title: '插件提供', sub: '随插件一起安装' }
        };
        return known[root] || { title: root || '其他来源', sub: '自定义 agent / skill 目录' };
      }
      var rootOrder = { Codex: 1, Agents: 2, Plugin: 99 };
      var allSkillRoots = Array.from(new Set((LOCAL_SKILLS || []).map(function(skill) { return skill.root || '其他'; }))).sort(function(a, b) {
        return (rootOrder[a] || 50) - (rootOrder[b] || 50) || a.localeCompare(b);
      });
      var visibleSkills = (LOCAL_SKILLS || []).filter(skillMatches);
      var skillGroups = {};
      visibleSkills.forEach(function(skill) {
        if (!skillGroups[skill.root]) skillGroups[skill.root] = [];
        skillGroups[skill.root].push(skill);
      });
      var skillRoots = Object.keys(skillGroups).sort(function(a, b) {
        return (rootOrder[a] || 50) - (rootOrder[b] || 50) || a.localeCompare(b);
      });

      var html = '<div class="lesson-workshop">';
      html += '<div class="lesson-workshop-head">';
      html += '<div><div class="lesson-workshop-title">本地 Skill 管理台</div>';
      html += '<div class="lesson-workshop-sub">先看已经安装的能力，再决定哪些经验值得沉淀进去。</div></div>';
      html += '<div class="lesson-head-actions"><div class="lesson-count-pill">' + (LOCAL_SKILLS || []).length + ' 个 Skill</div>';
      html += '<button class="btn btn-primary add-lesson-btn" data-action="open-add-lesson" aria-label="创建经验">';
      html += '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
      html += '创建经验</button></div>';
      html += '</div>';

      html += '<div class="skill-console-summary">';
      html += '<div class="skill-console-stat"><span class="skill-console-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"></path><path d="M8 9h8M8 13h5"></path></svg></span><div><div class="skill-console-stat-value">' + (LOCAL_SKILLS || []).length + '</div><div class="skill-console-stat-label">已安装 Skill</div></div></div>';
      html += '<div class="skill-console-stat"><span class="skill-console-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18"></path><path d="M6 7v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"></path><path d="M9 4h6"></path></svg></span><div><div class="skill-console-stat-value">' + allSkillRoots.length + '</div><div class="skill-console-stat-label">来源目录</div></div></div>';
      html += '<div class="skill-console-stat"><span class="skill-console-stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"></path><path d="M10 22h4"></path><path d="M8.5 14a6 6 0 1 1 7 0c-.8.6-1.2 1.3-1.4 2h-4.2c-.2-.7-.6-1.4-1.4-2Z"></path></svg></span><div><div class="skill-console-stat-value">' + items.length + '</div><div class="skill-console-stat-label">待沉淀经验</div></div></div>';
      html += '</div>';

      html += '<div class="skill-filter-row">';
      html += '<button class="skill-filter-btn' + (skillRootFilter === 'all' ? ' active' : '') + '" data-action="filter-skill-root" data-root="all"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>全部</button>';
      allSkillRoots.forEach(function(root) {
        var meta = skillRootMeta(root);
        html += '<button class="skill-filter-btn' + (skillRootFilter === root ? ' active' : '') + '" data-action="filter-skill-root" data-root="' + esc(root) + '"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18"></path><path d="M5 7v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7"></path><path d="M9 4h6"></path></svg>' + esc(meta.title) + '</button>';
      });
      html += '</div>';

      html += '<div style="display:flex;gap:8px;align-items:center;">';
      html += '<input id="skills-search" class="search-input" type="text" placeholder="搜索 Skill 名称或路径..." value="' + esc(state.lessons.skillSearch) + '" style="flex:1" />';
      html += '</div>';

      html += '<div class="local-skill-grid">';
      if (skillRoots.length === 0) {
        html += '<div class="empty-state"><div class="empty-title">没有匹配的 Skill</div></div>';
      }
      skillRoots.forEach(function(root) {
        var list = (skillGroups[root] || []).slice();
        var meta = skillRootMeta(root);
        html += '<article class="local-skill-card">';
        html += '<div class="local-skill-head"><div><div class="local-skill-title">' + esc(meta.title) + '</div><div class="local-skill-sub">' + esc(meta.sub) + '</div></div><div class="skill-draft-count">' + list.length + '</div></div>';
        html += '<div class="local-skill-list">';
        list.forEach(function(skill) {
          html += '<div class="local-skill-row">';
          html += '<div style="min-width:0;"><div class="local-skill-name">' + esc(skill.name) + '</div><div class="local-skill-path" title="' + esc(skill.path) + '">' + esc(skill.path) + '</div></div>';
          html += '<div class="local-skill-row-actions"><button class="icon-btn" data-action="open-skill-detail" data-skill-path="' + esc(skill.path) + '" title="查看详情" aria-label="查看详情"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="3"></circle></svg></button><button class="icon-btn" data-action="copy-skill-path" data-skill-path="' + esc(skill.path) + '" title="复制路径" aria-label="复制路径"><svg viewBox="0 0 24 24" fill="none" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button></div>';
          html += '</div>';
        });
        html += '</div></article>';
      });
      html += '</div>';

      html += '<div class="lesson-section-head"><div><div class="lesson-workshop-title" style="font-size:16px;">可沉淀经验</div><div class="lesson-workshop-sub">这些是从工作里提炼出的规则，可以继续合并进某个本地 Skill。</div></div><div class="lesson-count-pill">' + items.length + ' 条经验</div></div>';

      html += '<div style="display:flex;gap:8px;align-items:center;">';
      html += '<input id="lessons-search" class="search-input" type="text" placeholder="搜索经验..." value="' + esc(state.lessons.search) + '" style="flex:1" />';
      html += '</div>';

      if (items.length === 0) {
        html += '<div class="empty-state">' +
          '<div class="empty-icon">&#128161;</div>' +
          '<div class="empty-title">还没有可沉淀的经验</div>' +
          '<div class="empty-lead">当某条做法被确认有复用价值，它会先进入这里，再决定是否写进某个本地 Skill。</div>' +
          '</div>';
      } else {
        html += '<div class="skill-draft-grid">';
        groupKeys.forEach(function(key) {
          var group = groups[key].slice().sort(function(a, b) { return (b.confidence || 0) - (a.confidence || 0); });
          html += '<article class="skill-draft-card">';
          html += '<div class="skill-draft-head"><div class="skill-draft-title">' + esc(key) + '</div><div class="skill-draft-count">' + group.length + ' 条</div></div>';
          html += '<ul class="skill-lesson-list">';
          group.slice(0, 4).forEach(function(l) {
            var lessonContent = translateLessonText(l.content);
            html += '<li>' + esc(truncate(lessonContent, 120)) + '</li>';
          });
          if (group.length > 4) html += '<li>还有 ' + (group.length - 4) + ' 条相近经验</li>';
          html += '</ul>';
          html += '<div class="skill-draft-actions"><button class="btn" data-action="open-skill-draft" data-skill-draft-key="' + esc(key) + '">生成草稿</button></div>';
          html += '</article>';
        });
        html += '</div>';
      }
      html += '</div>';

      var __focus = captureSearchFocus(['skills-search', 'lessons-search']);
      el.innerHTML = html;
      var __ss = document.getElementById('skills-search');
      if (__ss) bindImeSafeSearch(__ss, 200, function(v){ state.lessons.skillSearch = v; renderLessons(); });
      var __ls = document.getElementById('lessons-search');
      if (__ls) bindImeSafeSearch(__ls, 200, function(v){ state.lessons.search = v; renderLessons(); });
      restoreSearchFocus(__focus);
    }

