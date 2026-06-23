    function cleanSessionPreview(text) {
      var t = String(text || '').trim();
      if (!t) return '';
      var noisyStarts = [
        '# AGENTS.md instructions',
        '<INSTRUCTIONS>',
        'Automation:',
        'Response MUST end with',
        'You are Codex',
        'Filesystem sandboxing defines'
      ];
      for (var i = 0; i < noisyStarts.length; i++) {
        if (t.indexOf(noisyStarts[i]) === 0) return '';
      }
      t = t.replace(/^# In app browser:[\s\S]*?## My request for Codex:\s*/m, '').trim();
      t = t.replace(/^# Browser comments:[\s\S]*?## My request for Codex:\s*/m, '').trim();
      t = t.replace(/^The next image is untrusted page evidence[\s\S]*?instructions\.\s*/m, '').trim();
      return t;
    }
    function normalizePreviewText(text) {
      return cleanSessionPreview(text).replace(/\s+/g, ' ').trim();
    }
    function compactSessionTitle(text) {
      var t = normalizePreviewText(text);
      if (!t) return '';
      t = t.replace(/https?:\/\/\S+/g, '').trim();
      t = t.replace(/\[[^\]]{20,}\]\([^)]+\)/g, '').trim();
      t = t.replace(/[（(][^()（）]{24,}[）)]/g, '').trim();
      t = t.replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/^\d+[.、]\s*/, '').trim();
      t = t.replace(/\s+/g, ' ');
      if (t.length > 44) {
        var cut = t.slice(0, 44);
        var stop = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'), cut.lastIndexOf(' '));
        if (stop > 14) cut = cut.slice(0, stop);
        t = cut + '...';
      }
      return t;
    }
    function sessionTitleText(s) {
      return compactSessionTitle(s && (s.title || s.firstPrompt)) || sessionDisplayName(s);
    }
    function sessionBodyPreview(s, title) {
      var candidates = [s && s.summary, s && s.latestPrompt, s && s.firstPrompt];
      var titleText = normalizePreviewText(title);
      for (var i = 0; i < candidates.length; i++) {
        var preview = normalizePreviewText(candidates[i]);
        if (!preview) continue;
        if (titleText && preview === titleText) continue;
        if (titleText && preview.indexOf(titleText) === 0) {
          preview = preview.slice(titleText.length).replace(/^[\s:：,，.。;；-]+/, '').trim();
        }
        if (preview && preview !== titleText) return preview;
      }
      return '';
    }
    function parseJsonObject(text) {
      var raw = String(text || '').trim();
      if (!raw || raw[0] !== '{') return null;
      try { return JSON.parse(raw); } catch (e) { return null; }
    }
	    function splitCommandNarrative(text) {
	      var raw = String(text || '').trim();
	      if (!raw) return { command: '', output: '' };
	      var pipeIndex = raw.indexOf(' | ');
	      var left = pipeIndex >= 0 ? raw.slice(0, pipeIndex).trim() : raw;
	      var right = pipeIndex >= 0 ? raw.slice(pipeIndex + 3).trim() : '';
	      var obj = parseJsonObject(left);
	      return { command: obj && obj.command ? String(obj.command) : '', output: right };
	    }
	    function extractCommandText(o) {
	      var rawNarrative = String(o && o.narrative || '').trim();
	      var rawSubtitle = String(o && o.subtitle || '').trim();
	      var first = rawNarrative.indexOf(' | ') >= 0 ? splitCommandNarrative(rawNarrative) : splitCommandNarrative(rawSubtitle);
	      if (first.command || first.output) return first;
	      var second = splitCommandNarrative(rawNarrative);
	      if (second.command || second.output) return second;
	      var ti = o && o.toolInput;
	      if (ti && typeof ti === 'object' && ti.command) return { command: String(ti.command), output: String(o && o.toolOutput || '') };
	      return { command: '', output: '' };
	    }
    function normalizedToolTraceName(value) {
      return String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
    }
    function isJsonLikeText(text) {
      var trimmed = String(text || '').trim();
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
      try {
        JSON.parse(trimmed);
        return true;
      } catch (e) {
        return /^[{\[]/.test(trimmed);
      }
    }
    function looksToolTraceDisplayText(text) {
      var trimmed = String(text || '').trim();
      if (!trimmed) return false;
      var lower = trimmed.toLowerCase();
      return isJsonLikeText(trimmed) || /"plan"\s*:|"command"\s*:|toolinput|tooloutput|function_id/.test(lower);
    }
    function commandHumanSummary(command) {
      var c = String(command || '').trim();
      if (!c) return t('obs.summary.localOperation');
      if (c.indexOf('ensure-agentmemory-live.mjs') >= 0 && c.indexOf('--restart') >= 0) return t('obs.summary.restartService');
      if (c.indexOf('ensure-agentmemory-live.mjs') >= 0) return t('obs.summary.startService');
      if (/^open\s+['"]?https?:\/\/127\.0\.0\.1:3114/.test(c)) return t('obs.summary.openPreview');
      if (c.indexOf('agentmemory/livez') >= 0 || c.indexOf('/health') >= 0) return t('obs.summary.checkService');
      if (c.indexOf('sessionBodyPreview') >= 0 || c.indexOf('observationDisplay') >= 0) return t('obs.summary.verifyPageFix');
      if (c.indexOf('bugfix-log') >= 0 && /sed|cat|ls/.test(c)) return t('obs.summary.viewFixLog');
      if (/command -v npx/.test(c)) return t('obs.summary.checkBrowserAutomation');
      if (/^(ps|lsof|netstat)\b/.test(c) || c.indexOf(' ps ') >= 0 || c.indexOf('lsof ') >= 0) return t('obs.summary.checkProcess');
      if (/^mkdir\b|^mv\b|^cp\b|^node <<|cleanup|重复旧版本|_待确认清理/.test(c)) return t('obs.summary.organizeLocalFiles');
      if (/^curl\b/.test(c)) return t('obs.summary.readLocalServiceData');
      if (/^sed\b|^rg\b|^grep\b|^find\b|^ls\b|^nl\b/.test(c)) return t('obs.summary.viewLocalFiles');
      if (/^(npm|pnpm|bun|yarn)\b/.test(c)) return t('obs.summary.runProjectScript');
      if (/^(git)\b/.test(c)) return t('obs.summary.checkCodeVersion');
      return t('obs.summary.runLocalCommand');
    }
    function commandOutputSummary(output, command) {
      var out = String(output || '').trim();
      var c = String(command || '');
      if (!out) return t('obs.output.noText');
      if (out.indexOf('"ok": true') >= 0 || out.indexOf('"status":"ok"') >= 0 || out.indexOf('"status": "ok"') >= 0) return t('obs.output.serviceOk');
      if (out.indexOf('npx-missing') >= 0) return t('obs.output.npxMissing');
      if (out.indexOf('npx-ok') >= 0) return t('obs.output.npxOk');
      if (out.indexOf('sessionBodyPreview') >= 0 || out.indexOf('observationDisplay') >= 0) return t('obs.output.pageFixOk');
      if (out.indexOf('error') >= 0 || out.indexOf('failed') >= 0 || out.indexOf('Error:') >= 0) return t('obs.output.error');
      if (/^curl\b/.test(c)) return t('obs.output.readService');
      if (/^sed\b|^rg\b|^grep\b|^find\b|^ls\b|^nl\b/.test(c)) return t('obs.output.viewFiles');
      return t('obs.output.done');
    }
	    function observationDisplay(o) {
	      var baseTitle = normalizePreviewText(o && (o.title || o.toolName || (o.hookType ? o.hookType.replace(/_/g, ' ') : 'Observation')));
	      var rawSubtitle = normalizePreviewText(o && o.subtitle);
	      var rawNarrative = normalizePreviewText(o && o.narrative);
	      var commandInfo = extractCommandText(o);
	      var type = o && (o.type || o.hookType || '');
	      var toolName = normalizedToolTraceName(o && (o.toolName || o.title || o.hookType));
	      var title = baseTitle || 'Observation';
	      var subtitle = rawSubtitle;
	      var body = rawNarrative;
	      if (title === 'prompt_submit') title = t('obs.display.promptSubmit');
	      if (title === 'agent_message') title = t('obs.display.agentMessage');
	      if (toolName === 'update_plan') {
	        title = t('obs.display.updatePlan');
	        subtitle = '';
	        body = t('obs.display.updatePlanBody');
	      } else if (toolName === 'apply_patch') {
	        title = t('obs.display.applyPatch');
	        subtitle = '';
	        body = t('obs.display.applyPatchBody');
	      } else if ((type === 'command_run' || toolName === 'bash' || toolName === 'exec_command') && commandInfo.command) {
	        title = commandHumanSummary(commandInfo.command);
	        subtitle = '';
	        body = commandOutputSummary(commandInfo.output, commandInfo.command);
      } else if (rawSubtitle && rawNarrative && rawNarrative.indexOf(rawSubtitle) === 0) {
        body = rawNarrative.slice(rawSubtitle.length).replace(/^[\s|:：,，.。;；-]+/, '').trim();
      }
	      if (looksToolTraceDisplayText(subtitle)) subtitle = '';
	      if (looksToolTraceDisplayText(body)) body = t('obs.display.toolTrace');
	      body = sessionBodyPreview({ summary: body, latestPrompt: rawNarrative, firstPrompt: rawSubtitle }, title);
	      return { title: title, subtitle: subtitle, body: body };
	    }
	    function looksRawSystemText(text) {
	      var t = String(text || '').trim();
	      return t.indexOf('{"command"') >= 0 || t.indexOf('\\\"command\\\"') >= 0 || /^Bash($|[:：])/.test(t) || /^prompt_submit$/.test(t) || /^agent_message$/.test(t);
	    }
	    function cleanEpisodeText(text, fallback) {
	      var t = normalizePreviewText(text);
	      if (!t || looksRawSystemText(t)) return fallback || '';
	      return t;
	    }
	    function episodeActionText(o) {
	      var type = observationType(o);
	      var display = observationDisplay(o);
	      var title = cleanEpisodeText(display.title, typeDisplayLabel(type));
	      var body = cleanEpisodeText(display.body, '');
	      if (body && body !== title) return title + '：' + truncate(body, 64);
	      return title;
	    }
	    function typeDisplayLabel(type) {
	      return t('episode.type.' + (type || 'other'), String(type || t('episode.type.other')).replace(/_/g, ' '));
	    }
	    function episodeKindLabel(kind) {
	      return t('episode.kind.' + (kind || 'work'), t('episode.kind.work'));
	    }
	    function observationType(o) {
	      var toolMap = { Read: 'file_read', Write: 'file_write', Edit: 'file_edit', Bash: 'command_run', Grep: 'search', Glob: 'search', WebFetch: 'web_fetch', WebSearch: 'web_fetch', AskUserQuestion: 'conversation', Task: 'subagent' };
	      return (o && (o.type || toolMap[o.toolName] || (o.hookType ? o.hookType.replace(/_/g, ' ') : 'other'))) || 'other';
	    }
	    function episodeTimeKey(o) {
	      var sid = o && (o._sessionId || o.sessionId);
	      if (sid) return 'session:' + sid;
	      try {
	        var d = new Date(o.timestamp);
	        if (!Number.isNaN(d.getTime())) return 'hour:' + d.toISOString().slice(0, 13);
	      } catch(e) {}
	      return 'misc';
	    }
	    function episodeFallbackTitle(first, projectName) {
	      var name = first && (first._sessionName || first.sessionName);
	      if (name && name !== 'Codex 会话') return name;
	      var d = first && first.timestamp ? formatTime(first.timestamp) : '';
	      return (projectName ? projectName + ' · ' : '') + (d || t('episode.workSegment'));
	    }
	    function classifyEpisode(counts, title, body, importance) {
	      var text = String((title || '') + ' ' + (body || '')).toLowerCase();
	      if ((importance || 0) >= 8 || counts.decision || counts.error) return 'important';
	      if (/修|bug|error|错误|异常|排查|fix|fail|undefined|json|bash/.test(text)) return 'bugfix';
	      if (/解释|研究|github|项目|repo|资料|分析|搜索|tencent|memory/.test(text) || counts.web_fetch || counts.search) return 'research';
	      if (/用户提出需求|需求|继续|优化|启动/.test(text) || counts.conversation) return 'user_need';
	      if (counts.file_write || counts.file_edit || counts.file_read) return 'file_work';
	      return 'work';
	    }
	    function filterTimelineEpisodes(episodes) {
	      var filter = state.timeline.episodeFilter || 'all';
	      if (filter === 'all') return episodes;
	      return episodes.filter(function(ep) {
	        if (filter === 'important') return ep.kind === 'important' || ep.kind === 'user_need' || ep.kind === 'bugfix';
	        return ep.kind === filter;
	      });
	    }
	    function buildTimelineEpisodes(observations) {
	      var project = (state.timeline.sessions || []).find(function(s) { return sessionProjectKey(s) === state.timeline.projectKey; });
	      var projectName = project ? projectDisplayName(project) : '';
	      var buckets = {};
	      (observations || []).forEach(function(o) {
	        var key = episodeTimeKey(o);
	        if (!buckets[key]) buckets[key] = [];
	        buckets[key].push(o);
	      });
	      return Object.keys(buckets).map(function(key) {
	        var items = buckets[key].slice().sort(function(a, b) {
	          return String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
	        });
	        var first = items[0] || {};
	        var last = items[items.length - 1] || first;
	        var counts = {};
	        var actions = [];
	        var title = '';
	        var bodyCandidate = '';
	        items.forEach(function(o) {
	          var type = observationType(o);
	          counts[type] = (counts[type] || 0) + 1;
	          var display = observationDisplay(o);
	          var cleanTitle = cleanEpisodeText(display.title, '');
	          var cleanBody = cleanEpisodeText(display.body, '');
	          if (!title && cleanTitle && cleanTitle !== 'Observation') title = cleanTitle;
	          if (!bodyCandidate && cleanBody) bodyCandidate = cleanBody;
	          var action = episodeActionText(o);
	          if (actions.indexOf(action) < 0) actions.push(action);
	        });
	        var typeText = Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a]; }).slice(0, 4).map(function(t) {
	          return typeDisplayLabel(t) + ' ' + counts[t];
	        }).join('，');
		        var readableTitle = title || episodeFallbackTitle(first, projectName);
		        var readableBody = bodyCandidate || (t('episode.bodyPrefix') + typeText + t('episode.bodySuffix'));
		        var maxImportance = items.reduce(function(max, o) { return Math.max(max, typeof o.importance === 'number' ? o.importance : 5); }, 0);
		        var kind = classifyEpisode(counts, readableTitle, readableBody, maxImportance);
		        return {
		          key: key,
		          title: readableTitle,
		          body: readableBody,
		          actions: actions.slice(0, 6),
		          count: items.length,
		          typeText: typeText || t('episode.record') + ' ' + items.length,
		          start: first.timestamp,
		          end: last.timestamp,
		          importance: maxImportance,
		          kind: kind
		        };
	      }).sort(function(a, b) {
	        return String(b.end || '').localeCompare(String(a.end || ''));
	      });
	    }
    function memoryTypeLabel(t) {
      var map = {
        fact: '事实',
        preference: '偏好',
        profile: '身份档案',
        architecture: '架构',
        workflow: '流程',
        pattern: '模式',
        bug: '问题',
        goal: '目标',
        history: '经历',
        project: '项目',
        principle: '原则',
        lifestyle: '生活'
      };
      return map[t] || t || '未分类';
    }
    function memoryAreaToType(area) {
      var map = {
        profile: 'profile',
        preference: 'preference',
        project: 'project',
        principle: 'pattern',
        history: 'history'
      };
      return map[area] || 'fact';
    }
    function memoryTypeToArea(type, mem) {
      var category = memoryCategory(mem || { type: type });
      if (category === '身份档案') return 'profile';
      if (category === '偏好') return 'preference';
      if (category === '项目与目标') return 'project';
      if (category === '判断框架') return 'principle';
      if (category === '经历') return 'history';
      return type === 'project' ? 'project' : type === 'preference' ? 'preference' : type === 'pattern' || type === 'workflow' ? 'principle' : 'profile';
    }
    function shortDateTime(ts) {
      if (!ts) return '-';
      try {
        var d = new Date(ts);
        return d.getFullYear() + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + String(d.getDate()).padStart(2, '0') +
          ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      } catch {
        return ts;
      }
    }
    function inferAgentFromSession(s) {
      var direct = s.agentId || s.agent || s.agentName || '';
      if (direct) return String(direct);
      var pid = String(s.project || s.cwd || s.id || '').toLowerCase();
      if (pid.indexOf('demo') >= 0) return t('project.demo');
      if (pid.indexOf('codex') >= 0) return 'Codex';
      if (pid.indexOf('claude') >= 0) return 'Claude';
      if (pid.indexOf('cursor') >= 0) return 'Cursor';
      if (pid.indexOf('openclaw') >= 0) return 'OpenClaw';
      return t('source.local');
    }
    function inferSessionSource(s) {
      var direct = s.agentId || s.agent || s.agentName || '';
      if (direct) return { name: String(direct), kind: 'agent', note: t('source.agentMarked') };
      var tags = Array.isArray(s.tags) ? s.tags.join(' ').toLowerCase() : '';
      var pid = String(s.project || s.cwd || s.id || '').toLowerCase();
      if (pid.indexOf('demo') >= 0) return { name: t('project.demo'), kind: 'demo', note: t('source.demoNote') };
      if (tags.indexOf('jsonl-import') >= 0) return { name: t('source.importedClaude'), kind: 'imported', note: t('source.importedClaudeNote') };
      if (pid.indexOf('codex') >= 0) return { name: 'Codex', kind: 'agent', note: t('source.pathInferred') };
      if (pid.indexOf('claude') >= 0) return { name: 'Claude', kind: 'agent', note: t('source.pathInferred') };
      if (pid.indexOf('cursor') >= 0) return { name: 'Cursor', kind: 'agent', note: t('source.pathInferred') };
      if (pid.indexOf('openclaw') >= 0) return { name: 'OpenClaw', kind: 'agent', note: t('source.pathInferred') };
      return { name: t('source.local'), kind: 'local', note: t('source.unknownAgentNote') };
    }
    function agentAvatarSpec(name) {
      var n = String(name || '').toLowerCase();
      if (n.indexOf('codex') >= 0) return { label: 'Codex', cls: 'codex', image: '/agent-avatars/codex.png' };
      if (n.indexOf('claude') >= 0) return { label: 'Claude', cls: 'claude', image: '/agent-avatars/claude.png' };
      if (n.indexOf('hermes') >= 0) return { label: 'Hermes', cls: 'hermes', image: '/agent-avatars/hermes.png' };
      if (n.indexOf('openclaw') >= 0) return { label: 'OpenClaw', cls: 'openclaw', image: '/agent-avatars/openclaw.png' };
      if (n.indexOf('cursor') >= 0) return { label: 'Cursor', cls: 'cursor' };
      if (n.indexOf('演示') >= 0 || n.indexOf('demo') >= 0) return { label: I18N_LANG === 'zh' ? '演' : 'D', cls: 'unknown' };
      if (n.indexOf('导入') >= 0 || n.indexOf('import') >= 0) return { label: I18N_LANG === 'zh' ? '导' : 'I', cls: 'claude', image: '/agent-avatars/claude.png' };
      if (n.indexOf('本地记录') >= 0 || n.indexOf('local record') >= 0 || n.indexOf('未标记') >= 0 || n.indexOf('unknown') >= 0) return { label: I18N_LANG === 'zh' ? '本' : 'L', cls: 'unknown' };
      return { label: String(name || '?').replace(/\s+/g, '').slice(0, 2).toUpperCase(), cls: 'unknown' };
    }
    function renderAgentAvatar(avatar) {
      var cls = 'agent-avatar ' + esc(avatar.cls || 'unknown') + (avatar.image ? ' has-image' : '');
      if (avatar.image) {
        return '<span class="' + cls + '" data-label="' + esc(avatar.label || '?') + '"><img src="' + esc(avatar.image) + '" alt="' + esc(avatar.label || 'Agent') + ' ' + esc(t('agent.avatarAlt')) + '" loading="lazy" /></span>';
      }
      return '<span class="' + cls + '" data-label="' + esc(avatar.label || '?') + '">' + esc(avatar.label || '?') + '</span>';
    }
    function isDemoSession(s) {
      var raw = String((s && (s.id || s.project || s.cwd || s.title || s.summary)) || '').toLowerCase();
      return raw.indexOf('demo_') >= 0 || raw.indexOf('/tmp/agentmemory-demo') >= 0 || raw.indexOf('agentmemory-demo') >= 0;
    }
    function sessionId(s) {
      return s && s.id !== undefined && s.id !== null ? String(s.id) : '';
    }
    function isValidSession(s) {
      return !!sessionId(s);
    }
    function shortSessionId(s, n) {
      var id = sessionId(s);
      return id ? id.slice(0, n || 8) : '';
    }
    function sessionDisplayName(s) {
      var project = s && s.project ? String(s.project).split('/').pop() : '';
      if (project) return project;
      return shortSessionId(s, 8) || t('dash.unnamedSession');
    }
    function sessionLabel(s) {
      var id = shortSessionId(s, 8);
      var name = sessionDisplayName(s);
      return id ? name + ' (' + id + ')' : name + ' (' + t('ses.noRecordId') + ')';
    }
    function sessionProjectKey(s) {
      var raw = (s && (s.cwd || s.project)) ? String(s.cwd || s.project) : t('project.uncategorized');
      if (raw.indexOf('/tmp/agentmemory-demo') >= 0) return t('project.demo');
      if (raw.indexOf('/Users/szn') === 0) {
        var parts = raw.split('/').filter(Boolean);
        if (parts.length >= 3) return parts.slice(0, 3).join('/');
      }
      return raw.replace(/\/$/, '') || t('project.uncategorized');
    }
    function projectDisplayName(key) {
      var k = String(key || t('project.uncategorized'));
      if (k === 'all') return t('project.all');
      if (k === 'browser') return t('project.browser');
      if (k === '未归类' || k === 'Uncategorized') return t('project.uncategorized');
      if (k === '演示数据' || k === 'Demo data') return t('project.demo');
      var parts = k.split('/').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : k;
    }
    function arrayFromCsv(value) {
      if (Array.isArray(value)) return value.map(function(v) { return String(v || '').trim(); }).filter(Boolean);
      return String(value || '').split(/[,，\s]+/).map(function(v) { return v.trim(); }).filter(Boolean);
    }
    function reviewPayload(item) {
      return (item && item.payload && typeof item.payload === 'object') ? item.payload : {};
    }
    function reviewProject(item) {
      var payload = reviewPayload(item);
      if (payload.projectScope === 'all' || payload.project === 'all') return 'all';
      if (payload.project) return payload.project;
      if (item && item.kind === 'action') return '';
      return (item && item.page && item.page.host) || 'browser';
    }
    function reviewTags(item) {
      var payload = reviewPayload(item);
      return arrayFromCsv(payload.tags).slice(0, 6);
    }
    function isMarkdownPlanText(text) {
      var raw = String(text || '');
      var hasPlanHeading = /^#{1,3}\s+.*(?:计划|Plan)\s*$/im.test(raw);
      var sectionMatches = raw.match(/^#{1,3}\s+(?:Summary|Key Changes|Test Plan|Assumptions|Public API|Implementation|执行步骤|验证命令)\b/img) || [];
      var compact = raw.replace(/\s+/g, ' ');
      var compactPlanSections = [
        /#{1,3}\s+Summary\b/i,
        /#{1,3}\s+Key Changes\b/i,
        /#{1,3}\s+Test Plan\b/i,
        /#{1,3}\s+Assumptions\b/i,
        /#{1,3}\s+Implementation\b/i,
        /#{1,3}\s+执行步骤\b/i,
        /#{1,3}\s+验证命令\b/i
      ].filter(function(pattern) { return pattern.test(compact); }).length;
      var compactPlan = /#{1,3}\s+[^#]{0,160}(?:计划|Plan)/i.test(compact) &&
        (compactPlanSections >= 2 || /#{1,3}\s+Summary\b/i.test(compact));
      return (hasPlanHeading && sectionMatches.length >= 2) || compactPlan;
    }
    function isReviewTextPolluted(text) {
      var trimmed = String(text || '').trim();
      if (!trimmed) return false;
      var lower = trimmed.toLowerCase();
      if (isJsonLikeText(trimmed)) return true;
      if (isMarkdownPlanText(trimmed)) return true;
      if (/please implement this plan/i.test(trimmed)) return true;
      if (/"plan"\s*:/.test(trimmed) && /"status"\s*:/.test(trimmed) && /"step"\s*:/.test(trimmed)) return true;
      if (/"command"\s*:|toolinput|tooloutput|function_id/.test(lower)) return true;
      if (/"(?:cmd|workdir|yield_time_ms|max_output_tokens)"\s*:/.test(lower)) return true;
      if (/\b(tooluseid|tooluse|call_[a-z0-9]+|chunk id|wall time|process exited)\b/i.test(trimmed)) return true;
      if (/^(?:json|state|limit)\s+[\w.-]+/i.test(trimmed)) return true;
      if (/\b(?:namewithowner|headrefname|baserefname|databaseid)\b/i.test(lower)) return true;
      if (/^\s*(?:gh|git|npm|pnpm|yarn|python3?|node|curl)\s+[^\n]*(?:--json|--limit|--workdir|--max-output|--yield-time|status|show|list|run|test|install|build)\b/i.test(trimmed)) return true;
      if (/审查结果\s*\[[Pp]\d+\]/.test(trimmed) && /(?:src|test)\/[^\s]+(?:\s*\(line\s+\d+\))?/.test(trimmed)) return true;
      if (/^src\/[^\s]+/m.test(trimmed) && /\bnpm\s+(test|run|install|build)\b/i.test(trimmed)) return true;
      if (/^\s*(npm|pnpm|yarn)\s+(test|run|install|build)\b/im.test(trimmed)) return true;
      return false;
    }
    function isReviewItemDisplayable(item) {
      if (!item) return false;
      return !isReviewTextPolluted(item.title) && !isReviewTextPolluted(item.content);
    }
    function isActionReviewRenderable(item) {
      if (!item) return false;
      return item.kind === 'action' && isReviewItemDisplayable(item);
    }
    function actionTags(action) {
      return Array.isArray(action && action.tags) ? action.tags.map(String) : [];
    }
    function isGeneratedAction(action) {
      var tags = actionTags(action);
      return (action && action.createdBy === 'todo-extract') ||
        tags.indexOf('todo-extracted') >= 0 ||
        tags.indexOf('action-candidate') >= 0 ||
        !!(action && action.metadata && action.metadata.todoExtraction);
    }
    function isActionRenderable(action) {
      if (!action) return false;
      if (!isGeneratedAction(action)) return true;
      return !isReviewTextPolluted(action.title) && !isReviewTextPolluted(action.description);
    }
    function reviewActionPriority(item) {
      var payload = reviewPayload(item);
      var candidate = payload.actionCandidate && typeof payload.actionCandidate === 'object' ? payload.actionCandidate : {};
      var value = candidate.priority || payload.priority || item.priority || 5;
      var parsed = parseInt(value, 10);
      if (!Number.isFinite(parsed)) parsed = 5;
      return Math.max(1, Math.min(10, parsed));
    }
    function reviewSourceLabel(item) {
      var payload = reviewPayload(item);
      return payload.sourceLabel || payload.provider || (item && item.page && (item.page.typeLabel || item.page.host)) || '浏览器';
    }
    function browserSessionObservations(item) {
      var page = (item && item.page) || {};
      var conversation = (item && item.conversation) || {};
      var turns = Array.isArray(conversation.turns) ? conversation.turns : [];
      var createdAt = (item && (item.createdAt || item.updatedAt)) || new Date().toISOString();
      var observations = [];
      if (page.title || page.url) {
        observations.push({
          id: (item.id || 'browser') + '_page',
          sessionId: 'browser_' + (item.id || ''),
          timestamp: createdAt,
          type: 'web_fetch',
          title: page.title || '浏览器页面',
          subtitle: page.host || page.typeLabel || '浏览器',
          narrative: [page.title, page.url].filter(Boolean).join('\n'),
          facts: [],
          concepts: ['browser'],
          files: [],
          importance: 0.5
        });
      }
      turns.forEach(function(turn, index) {
        var role = turn && turn.role === 'assistant' ? 'AI' : turn && turn.role === 'user' ? '用户' : '对话';
        var text = String((turn && turn.text) || '').trim();
        if (!text) return;
        observations.push({
          id: (item.id || 'browser') + '_turn_' + index,
          sessionId: 'browser_' + (item.id || ''),
          timestamp: createdAt,
          type: 'conversation',
          title: role,
          subtitle: page.title || page.host || '浏览器对话',
          narrative: text,
          facts: [],
          concepts: ['browser', role],
          files: [],
          importance: role === '用户' ? 0.8 : 0.6
        });
      });
      if (item && item.content) {
        observations.push({
          id: (item.id || 'browser') + '_review',
          sessionId: 'browser_' + (item.id || ''),
          timestamp: item.updatedAt || createdAt,
          type: item.kind === 'lesson' ? 'decision' : 'discovery',
          title: item.kind === 'lesson' ? '经验候选' : '同步会话',
          subtitle: item.status === 'approved' ? '已保存' : item.status === 'dismissed' ? '已忽略' : '待审阅',
          narrative: item.content,
          facts: [],
          concepts: ['browser', item.kind === 'lesson' ? 'lesson' : 'session'],
          files: [],
          importance: 0.7
        });
      }
      return observations;
    }
    function browserReviewSessions(items) {
      return (items || []).filter(function(item) {
        var payload = reviewPayload(item);
        return item && item.source === 'browser-extension' && !payload.browserSessionId && item.page && (item.page.type === 'ai-chat' || item.conversation || item.page.url);
      }).map(function(item) {
        var page = item.page || {};
        var payload = reviewPayload(item);
        var provider = (item.conversation && item.conversation.provider) || payload.provider || page.host || '浏览器';
        var obs = browserSessionObservations(item);
        return {
          id: 'browser_' + item.id,
          project: provider || '浏览器',
          cwd: 'browser/' + (page.host || provider || 'web'),
          source: 'browser-extension',
          agentId: provider || '浏览器',
          startedAt: item.createdAt || item.updatedAt || '',
          updatedAt: item.updatedAt || item.createdAt || '',
          endedAt: item.reviewedAt || item.updatedAt || item.createdAt || '',
          status: item.status === 'pending' ? 'active' : 'completed',
          observationCount: obs.length,
          firstPrompt: page.title || item.title || '浏览器对话',
          summary: item.content || '',
          tags: ['browser', page.type || '', item.kind || ''].filter(Boolean),
          embeddedObservations: obs,
          browserPage: page
        };
      });
    }
    function groupSessionsByProject(items) {
      var groups = {};
      (items || []).forEach(function(s) {
        var key = sessionProjectKey(s);
        if (!groups[key]) groups[key] = { key: key, name: projectDisplayName(key), sessions: [], count: 0, latest: '', observations: 0, sources: {}, hasMissingId: false };
        groups[key].sessions.push(s);
        if (!sessionId(s)) groups[key].hasMissingId = true;
        groups[key].count += 1;
        groups[key].observations += s.observationCount || 0;
        var rt = sessionRecordTime(s);
        if (rt > groups[key].latest) groups[key].latest = rt;
        var src = inferSessionSource(s).name || '未标记来源';
        groups[key].sources[src] = (groups[key].sources[src] || 0) + 1;
      });
      return Object.keys(groups).map(function(k) {
        groups[k].sessions.sort(function(a, b) { return (sessionRecordTime(b) || '').localeCompare(sessionRecordTime(a) || ''); });
        return groups[k];
      }).sort(function(a, b) { return (b.latest || '').localeCompare(a.latest || ''); });
    }
    function sessionSourceKey(s) {
      var source = inferSessionSource(s);
      return source.kind + ':' + source.name;
    }
    function sessionSourceGroups(items) {
      var groups = {
        all: { key: 'all', name: '全部会话', count: 0, latest: '', observations: 0, kind: 'all' }
      };
      (items || []).forEach(function(s) {
        var source = inferSessionSource(s);
        var key = sessionSourceKey(s);
        if (!groups[key]) groups[key] = { key: key, name: source.name || '未标记来源', count: 0, latest: '', observations: 0, kind: source.kind || 'source' };
        groups.all.count += 1;
        groups[key].count += 1;
        groups.all.observations += s.observationCount || 0;
        groups[key].observations += s.observationCount || 0;
        var rt = sessionRecordTime(s);
        if (rt > groups.all.latest) groups.all.latest = rt;
        if (rt > groups[key].latest) groups[key].latest = rt;
      });
      return Object.keys(groups).map(function(k) { return groups[k]; }).sort(function(a, b) {
        if (a.key === 'all') return -1;
        if (b.key === 'all') return 1;
        return (b.latest || '').localeCompare(a.latest || '');
      });
    }
    function sessionRecordTime(s) {
      return (s && (s.updatedAt || s.endedAt || s.startedAt)) || '';
    }
    function sessionStatusLabel(status) {
      var map = { active: '历史会话', completed: '历史会话', archived: '历史会话', failed: '历史会话' };
      return map[status] || '历史会话';
    }
    function sessionSourceSummary(s, obsCount) {
      var source = String((s && s.source) || '').indexOf('browser') >= 0 ? '浏览器对话' : String((s && s.source) || '').indexOf('local-') === 0 ? '本地 Agent 会话' : '工作台会话';
      return [
        { label: '来源', value: source },
        { label: '项目', value: projectDisplayName(sessionProjectKey(s)) },
        { label: '记录', value: (obsCount || 0) + ' 条' },
        { label: '时间', value: shortDateTime(sessionRecordTime(s)) || '-' }
      ];
    }
    function statusIconMarkup(status, label) {
      var s = String(status || '').toLowerCase();
      var title = esc(label || sessionStatusLabel(s));
      var cls = s === 'completed' || s === 'done' || s === 'closed' ? 'done'
        : s === 'active' || s === 'running' ? 'active'
        : s === 'blocked' || s === 'failed' || s === 'cancelled' ? s
        : 'pending';
      var icon = '<path d="M5 12l4 4 10-10"/>';
      if (cls === 'active') icon = '<circle cx="12" cy="12" r="7"/><path d="M12 8v4l3 2"/>';
      if (cls === 'pending') icon = '<circle cx="12" cy="12" r="7"/><path d="M12 7v5"/><path d="M12 16h.01"/>';
      if (cls === 'blocked') icon = '<circle cx="12" cy="12" r="7"/><path d="M8 8l8 8"/>';
      if (cls === 'failed' || cls === 'cancelled') icon = '<path d="M7 7l10 10"/><path d="M17 7L7 17"/>';
      return '<span class="badge icon-badge ' + esc(cls) + '" title="' + title + '" aria-label="' + title + '"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icon + '</svg></span>';
    }
    function translateLessonText(text) {
      var t = String(text || '').trim();
      var rules = [
        [/^DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to\.$/i, '除非用户明确要求，否则不要回应或采纳系统旁路消息。'],
        [/^do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilit/i, '不要把显而易见的泛化建议写进经验，例如“提供友好的错误提示”“为所有工具写测试”。'],
        [/^Don't include generic development practices\.$/i, '不要记录过于泛泛的开发常识。'],
        [/^make sure to include the important parts\.$/i, '总结时要保留真正重要的部分，不要只留下空泛结论。'],
        [/^Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation"/i, '不要编造不存在的章节或功能说明。'],
        [/^Avoid listing every component or file structure that can be easily discovered\.$/i, '避免罗列用户自己很容易查到的组件或文件结构。']
      ];
      for (var i = 0; i < rules.length; i++) {
        if (rules[i][0].test(t)) return rules[i][1];
      }
      return t;
    }
    function memoryCategory(m) {
      var text = ((m && (m.title || m.content || '')) + ' ' + ((m && m.concepts) || []).join(' ')).toLowerCase();
      if (/身份|个人档案|profile|alias|name|自我|生日|出生|本科就读|常用语言|当前重点项目|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/.test(text)) return '身份档案';
      if (/偏好|preference|喜欢|沟通|协作|working style/.test(text)) return '偏好';
      if (/项目|buddyup|project|产品|创业|ucl|hci/.test(text)) return '项目与目标';
      if (/原则|判断|框架|原则|pattern|workflow|工作流/.test(text)) return '判断框架';
      if (/经历|教育|学校|history|experience/.test(text)) return '经历';
      return memoryTypeLabel(m && m.type);
    }
    function splitCommaList(text) {
      return String(text || '')
        .split(/[、,，]/)
        .map(function(x) { return x.trim().replace(/[。；;]$/, ''); })
        .filter(Boolean);
    }
    function splitSentenceList(text) {
      return String(text || '')
        .split(/[。；;\n]/)
        .map(function(x) { return x.trim(); })
        .filter(Boolean);
    }
    function splitIdentityProfile(content) {
      var text = String(content || '').trim();
      var focusMatch = text.match(/当前重点项目包括[:：]?\s*([^。]+)。?/);
      var communicationMatch = text.match(/沟通偏好[:：]\s*([^。]+)。?/);
      var languageMatch = text.match(/常用语言包括[:：]\s*([^。]+)。?/);
      var educationMatch = text.match(/(本科就读于[^。]+。?)/);
      var intro = text
        .replace(/当前重点项目包括[:：]?\s*[^。]+。?/g, '')
        .replace(/沟通偏好[:：]\s*[^。]+。?/g, '')
        .replace(/常用语言包括[:：]\s*[^。]+。?/g, '')
        .replace(/本科就读于[^。]+。?/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        intro: intro || text,
        education: splitSentenceList(educationMatch && educationMatch[1]),
        focus: splitCommaList(focusMatch && focusMatch[1]),
        communication: splitCommaList(communicationMatch && communicationMatch[1]),
        language: splitCommaList(languageMatch && languageMatch[1])
      };
    }
    function memoryStrength(m) {
      var rawStrength = (m && m.strength) || 0;
      var strength = Math.round(rawStrength <= 1 ? rawStrength * 100 : rawStrength * 10);
      if (strength > 100) strength = 100;
      if (strength < 0) strength = 0;
      return strength;
    }
    function memorySourceKind(m) {
      var concepts = (m && Array.isArray(m.concepts) ? m.concepts : []).join(' ').toLowerCase();
      var project = String((m && m.project) || '').toLowerCase();
      var text = String((m && (m.title || m.content)) || '').toLowerCase();
      if (project === 'browser' || concepts.indexOf('browser-context') >= 0 || text.indexOf('网页记忆线索') >= 0 || text.indexOf('浏览器候选记忆') >= 0) return 'browser';
      if (m && m.sessionIds && m.sessionIds.length) return 'session';
      return 'manual';
    }
    function browserSourceFromMemory(m) {
      var concepts = m && Array.isArray(m.concepts) ? m.concepts : [];
      var source = '';
      concepts.forEach(function(c) {
        var s = String(c || '');
        if (s.indexOf('browser-source:') === 0 && !source) source = s.slice('browser-source:'.length);
      });
      if (source) return source;
      var host = '';
      concepts.forEach(function(c) {
        var s = String(c || '');
        if (s.indexOf('browser-host:') === 0 && !host) host = s.slice('browser-host:'.length);
      });
      return host;
    }
    function browserSourceLabel(source) {
      var labels = { chatgpt: 'ChatGPT', claude: 'Claude', gemini: 'Gemini', perplexity: 'Perplexity', grok: 'Grok', deepseek: 'DeepSeek', github: 'GitHub', feishu: '飞书', notion: 'Notion' };
      if (!source) return '浏览器';
      return labels[source] || source.replace(/^www\./, '');
    }
    function memorySourceLabel(m) {
      var kind = memorySourceKind(m);
      if (kind === 'browser') return browserSourceLabel(browserSourceFromMemory(m));
      if (kind === 'session') return '会话';
      return '手动';
    }
    function renderMemoryCard(card) {
      var mem = card.memory || {};
      var cls = card.kind || 'default';
      var html = '<article class="memory-display-card ' + esc(cls) + '">';
      html += '<div class="memory-card-top">';
      html += '<div class="memory-card-title">' + esc(card.title || '未命名记忆') + '</div>';
      html += '<span class="badge ' + (TYPE_BADGES[mem.type] || 'badge-muted') + '">' + esc(card.label || memoryTypeLabel(mem.type)) + '</span>';
      html += '</div>';
      if (card.items && card.items.length) {
        html += '<ul class="memory-card-list">';
        card.items.forEach(function(item) { html += '<li>' + esc(item) + '</li>'; });
        html += '</ul>';
      } else {
        html += '<div class="memory-card-body">' + esc(card.body || '暂无内容') + '</div>';
      }
      if (mem.concepts && mem.concepts.length > 0) {
        html += '<div class="tag-list">';
        mem.concepts.slice(0, 4).forEach(function(c) { html += '<span class="tag">' + esc(c) + '</span>'; });
        html += '</div>';
      }
      html += '<div class="memory-card-footer">';
      html += '<span class="mem-meta-pill icon-badge pending" title="记忆条目" aria-label="记忆条目"><svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 19.5A2.5 2.5 0 0 1 7.5 17H20"/><path d="M7.5 2H20v20H7.5A2.5 2.5 0 0 1 5 19.5v-17A2.5 2.5 0 0 1 7.5 2z"/></svg></span>';
      html += '<span class="mem-meta-pill" title="来源">' + esc(memorySourceLabel(mem)) + '</span>';
      html += '<div class="memory-card-actions">';
      html += '<button class="btn" style="font-size:10px;padding:3px 8px;" data-action="edit-memory" data-memory-id="' + esc(mem.id || '') + '">编辑</button>';
      html += '<button class="btn btn-danger" style="font-size:10px;padding:3px 8px;" data-action="delete-memory" data-memory-id="' + esc(mem.id || '') + '" data-memory-title="' + esc(card.title || mem.title || '') + '">删除</button>';
      html += '</div></div>';
      html += '</article>';
      return html;
    }
    function memoryDisplayCards(m) {
      var content = (m && (m.content || m.title)) || '';
      if (memoryCategory(m) === '身份档案') {
        var data = splitIdentityProfile(content);
        var cards = [];
        if (data.intro) cards.push({ memory: m, kind: 'identity', label: '身份', title: '基本信息', body: data.intro });
        if (data.education && data.education.length) cards.push({ memory: m, kind: 'history', label: '经历', title: '教育经历', items: data.education });
        if (data.focus && data.focus.length) cards.push({ memory: m, kind: 'project', label: '项目', title: '当前重点', items: data.focus });
        if (data.communication && data.communication.length) cards.push({ memory: m, kind: 'preference', label: '偏好', title: '沟通偏好', items: data.communication });
        if (data.language && data.language.length) cards.push({ memory: m, kind: 'identity', label: '语言', title: '常用表达', items: data.language });
        return cards.length ? cards : [{ memory: m, kind: 'identity', label: memoryTypeLabel(m && m.type), title: (m && m.title) || '身份档案', body: content }];
      }
      var title = ((m && m.title) || '').trim();
      var body = ((m && m.content) || '').trim();
      var sameTitle = title && body && body.indexOf(title) === 0;
      return [{
        memory: m,
        kind: 'default',
        label: memoryTypeLabel(m && m.type),
        title: sameTitle ? truncate(body, 72) : truncate(title || body, 72),
        body: sameTitle ? body.slice(title.length).trim() || body : body
      }];
    }
    function renderIdentityProfileCard(mem) {
      if (!mem) return '';
      var data = splitIdentityProfile(mem.content || mem.title || '');
      var headline = '未命名身份';
      var birth = '';
      var intro = data.intro || '';
      var nameMatch = intro.match(/^([^，。]+?)(?:，|。)/);
      if (nameMatch) headline = nameMatch[1].trim();
      var birthMatch = intro.match(/(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}\s*生?)/);
      if (birthMatch) birth = birthMatch[1].replace(/年|月/g, '-').replace(/日/g, '').replace(/--/g, '-');
      var titleLine = intro.replace(headline, '').replace(/^，/, '').trim();
      if (birth) titleLine = titleLine.replace(birthMatch && birthMatch[0], '').replace(/^，/, '').trim();
      var html = '<section class="card" style="margin-bottom:12px;padding:14px 16px;">';
      html += '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap;">';
      html += '<div style="min-width:220px;flex:1;">';
      html += '<div class="card-title" style="border:0;margin:0;padding:0;">身份档案</div>';
      html += '<div style="font-family:Lora,Georgia,serif;font-size:22px;color:var(--ink);margin-top:8px;line-height:1.25;">' + esc(headline) + '</div>';
      html += '<div style="font-size:13px;color:var(--ink-muted);line-height:1.55;margin-top:7px;max-width:780px;">' + esc(titleLine || intro) + '</div>';
      html += '</div>';
      html += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">';
      if (birth) html += '<span class="mem-meta-pill">生日 ' + esc(birth) + '</span>';
      html += '<span class="badge ' + (TYPE_BADGES[mem.type] || 'badge-muted') + '">' + esc(memoryTypeLabel(mem.type)) + '</span>';
      html += '<button class="btn" style="font-size:11px;padding:4px 10px;" data-action="edit-memory" data-memory-id="' + esc(mem.id || '') + '">编辑</button>';
      html += '</div></div>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin-top:12px;">';
      var sections = [
        ['当前重点', data.focus],
        ['沟通偏好', data.communication],
        ['常用语言', data.language]
      ];
      sections.forEach(function(section) {
        var label = section[0];
        var list = section[1] || [];
        html += '<div style="padding:12px;border:1px solid var(--border-light);background:var(--bg-subtle);border-radius:6px;min-height:92px;">';
        html += '<div style="font-size:12px;color:var(--ink-muted);font-weight:700;margin-bottom:8px;">' + esc(label) + '</div>';
        if (list.length) {
          html += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
          list.forEach(function(item) { html += '<span class="tag" style="font-size:11px;">' + esc(item) + '</span>'; });
          html += '</div>';
        } else {
          html += '<div style="font-size:12px;color:var(--ink-faint);line-height:1.5;">暂无结构化内容</div>';
        }
        html += '</div>';
      });
      html += '</div>';
      html += '</section>';
      return html;
    }
    function renderIdentityProfileGroup(cards) {
      cards = cards || [];
      if (!cards.length) return '';
      var primary = (cards[0] && cards[0].memory) || {};
      var titleCard = cards.find(function(c) { return c.title === '基本信息'; }) || cards[0];
      var headline = titleCard && titleCard.body ? titleCard.body.split(/[，。]/)[0] : '身份档案';
      var html = '<article class="memory-display-card identity" style="min-height:0;padding:26px !important;">';
      html += '<div style="display:grid;grid-template-columns:minmax(0,1.3fr) auto;gap:22px;align-items:start;">';
      html += '<div style="min-width:0;">';
      html += '<div class="memory-card-title" style="font-size:24px !important;">' + esc(headline || '身份档案') + '</div>';
      if (titleCard && titleCard.body) {
        html += '<div class="memory-card-body" style="margin-top:8px;max-width:760px;">' + esc(truncate(titleCard.body, 150)) + '</div>';
      }
      html += '</div>';
      html += '<div class="memory-card-actions" style="justify-content:flex-end;">';
      html += '<button class="btn" data-action="edit-memory" data-memory-id="' + esc(primary.id || '') + '" data-memory-mode="profile">编辑档案</button>';
      html += '<button class="btn btn-danger" data-action="delete-memory" data-memory-id="' + esc(primary.id || '') + '" data-memory-title="' + esc(primary.title || '身份档案') + '">删除</button>';
      html += '</div></div>';
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:0;margin-top:20px;border-top:1px solid var(--border);border-left:1px solid var(--border);">';
      cards.forEach(function(card) {
        if (card === titleCard) return;
        html += '<div style="border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:transparent;padding:16px;min-height:150px;">';
        html += '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;">';
        html += '<div style="font-family:var(--font-ui);font-size:14px;font-weight:650;color:var(--ink);">' + esc(card.title || '信息') + '</div>';
        html += '<span style="font-size:12px;color:var(--ink-muted);">' + esc(card.label || '') + '</span>';
        html += '</div>';
        if (card.items && card.items.length) {
          html += '<ul class="memory-card-list">';
          card.items.forEach(function(item) { html += '<li>' + esc(item) + '</li>'; });
          html += '</ul>';
        } else {
          html += '<div class="memory-card-body">' + esc(card.body || '暂无内容') + '</div>';
        }
        html += '</div>';
      });
      html += '</div>';
      html += '</article>';
      return html;
    }
    function buildAgentMemoryPrompt(mem) {
      var data = splitIdentityProfile((mem && (mem.content || mem.title)) || '');
      var lines = [];
      lines.push('请根据这份用户记忆来优化协作方式：');
      if (data.intro) lines.push('- 用户画像：' + data.intro);
      if (data.focus && data.focus.length) lines.push('- 当前重点：' + data.focus.join('；'));
      if (data.communication && data.communication.length) lines.push('- 沟通偏好：' + data.communication.join('；'));
      if (data.language && data.language.length) lines.push('- 常用表达/风格：' + data.language.join('；'));
      if (data.education && data.education.length) lines.push('- 经历背景：' + data.education.join('；'));
      lines.push('- 协作原则：少暴露用户难以理解的内部概念，把功能解释成清晰的产品流程；能用图标表达的小标签优先用图标；界面和建议都要服务真实使用，而不是只展示系统记录。');
      return lines.join('\n');
    }
    function openAgentPrompt(id) {
      var mem = (state.memories.items || []).find(function(m) { return m.id === id; }) || (state.memories.items || []).find(function(m) { return memoryCategory(m) === '身份档案'; });
      if (!mem) return;
      var prompt = buildAgentMemoryPrompt(mem);
      var modal = document.getElementById('modal');
      var overlay = document.getElementById('modal-overlay');
      modal.innerHTML =
        '<h3>协作提示</h3>' +
        '<p>这些记忆会自动进入 Agent 的理解范围；这里仅保留可复制的提示文本。</p>' +
        '<div class="memory-add-form">' +
        '<label>协作提示<textarea id="agent-memory-prompt" rows="10">' + esc(prompt) + '</textarea></label>' +
        '<div id="agent-prompt-status" class="memory-form-error"></div>' +
        '</div>' +
        '<div class="modal-actions"><button class="btn" data-action="close-modal">关闭</button><button class="btn btn-primary" data-action="copy-agent-prompt">复制提示</button></div>';
      overlay.classList.add('open');
      setTimeout(function() {
        var input = document.getElementById('agent-memory-prompt');
        if (input) input.focus();
      }, 0);
    }
    async function copyAgentPrompt() {
      var text = (document.getElementById('agent-memory-prompt') || {}).value || '';
      var status = document.getElementById('agent-prompt-status');
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          var ta = document.getElementById('agent-memory-prompt');
          if (ta) { ta.select(); document.execCommand('copy'); }
        }
        if (status) {
          status.style.display = 'block';
          status.style.color = 'var(--green)';
          status.textContent = '已复制。';
        }
      } catch (err) {
        if (status) {
          status.style.display = 'block';
          status.style.color = 'var(--red)';
          status.textContent = '复制失败，可以手动选中这段提示。';
        }
      }
    }
    async function copyTextToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text || '');
        return;
      }
      var ta = document.createElement('textarea');
      ta.value = text || '';
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    function debounce(fn, ms) {
      var t;
      return function() {
        var args = arguments, ctx = this;
        clearTimeout(t);
        t = setTimeout(function() { fn.apply(ctx, args); }, ms);
      };
    }

    // IME_SAFE_SEARCH_V2
    function bindImeSafeSearch(input, ms, onSearch) {
      var composing = false;
      var justCommitted = false;
      var run = debounce(function(value) { onSearch(value); }, ms);
      input.addEventListener('compositionstart', function() { composing = true; });
      input.addEventListener('compositionend', function() {
        composing = false;
        justCommitted = true;
        onSearch(input.value);
        setTimeout(function() { justCommitted = false; }, 0);
      });
      input.addEventListener('input', function(e) {
        if (composing || e.isComposing) return;
        if (justCommitted) return;
        run(input.value);
      });
    }
    function captureSearchFocus(ids) {
      var a = document.activeElement;
      if (!a || ids.indexOf(a.id) < 0) return null;
      return { id: a.id, start: a.selectionStart, end: a.selectionEnd };
    }
    function restoreSearchFocus(focus) {
      if (!focus) return;
      var el = document.getElementById(focus.id);
      if (!el) return;
      el.focus();
      if (typeof el.setSelectionRange === 'function') {
        try { el.setSelectionRange(focus.start, focus.end); } catch (e) {}
      }
    }

