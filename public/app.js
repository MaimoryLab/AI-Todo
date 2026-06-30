const state = {
  sources: [],
  sessions: [],
  todos: [],
  startupScan: { status: "idle", sources: [], warnings: [] },
  observationsBySession: {},
  selectedSessionId: null,
  highlightedObservationId: null,
  settings: null,
  settingsOpen: false
};

const $ = (selector) => document.querySelector(selector);

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

$("#organize").addEventListener("click", organize);
$("#settings-gear").addEventListener("click", toggleSettings);
$("#settings-panel").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target.dataset.action === "close-settings") closeSettings();
});

await refresh();

async function refresh() {
  try {
    const [sources, sessions, todos, settings, startupScan] = await Promise.all([
      api("/sources"),
      api("/sessions"),
      api("/todos"),
      api("/settings"),
      api("/startup/scan")
    ]);
    Object.assign(state, { sources, sessions, todos, settings, startupScan });
    if (!state.selectedSessionId || !sessions.some((session) => session.id === state.selectedSessionId)) {
      state.selectedSessionId = sessions[0]?.id ?? null;
    }
    if (state.selectedSessionId) await ensureSessionObservations(state.selectedSessionId);
    render();
    setStatus(startupStatusText(startupScan));
  } catch (error) {
    setStatus(error.message);
  }
}

function render() {
  renderStartupScan();
  renderSources();
  renderEvidenceBrowser();
  renderTodos();
  renderSettingsPanel();
}

function renderStartupScan() {
  const scan = state.startupScan ?? { status: "idle", sources: [], warnings: [] };
  const details = (scan.sources ?? []).map((source) => {
    const result = source.result;
    if (!result) return `${source.source}: ${source.warning ?? "not indexed"}`;
    return `${source.source}: ${result.scanned} scanned, ${result.skipped} skipped`;
  }).join(" / ");
  $("#startup-scan").innerHTML = `
    <article class="session-hero indexing-${escapeAttr(scan.status)}">
      <div>
        <div class="label">Local Index</div>
        <div class="title">${escapeHtml(startupStatusText(scan))}</div>
        <div class="meta">${escapeHtml(details || "Waiting for local startup scan.")}</div>
      </div>
      <span class="badge ${scan.status === "failed" ? "ignored" : "done"}">${escapeHtml(scan.status)}</span>
    </article>
  `;
}

function renderSources() {
  const latestSession = state.sessions[0];
  const totalCheckpoints = state.sources.reduce((sum, source) => sum + Number(source.checkpoints || 0), 0);
  const openTodos = state.todos.filter((todo) => todo.status === "todo").length;
  $("#source-grid").innerHTML = [
    { label: "Sessions", value: state.sessions.length, sub: latestSession ? `recent ${formatDate(latestSession.updatedAt)}` : "no local records" },
    { label: "Open Todos", value: openTodos, sub: `${state.todos.length} total cards` },
    { label: "Checkpoints", value: totalCheckpoints, sub: "mtime + size incremental scan" },
    ...state.sources.map((source) => ({
      label: source.source,
      value: source.sessions,
      sub: `${source.checkpoints} checkpoints`
    }))
  ].map((source) => `
    <article class="stat stat-card">
      <div class="label">${escapeHtml(source.label)}</div>
      <div class="value">${escapeHtml(String(source.value))}</div>
      <div class="sub">${escapeHtml(source.sub)}</div>
    </article>
  `).join("");
}

function renderEvidenceBrowser() {
  const selected = state.sessions.find((session) => session.id === state.selectedSessionId) ?? state.sessions[0];
  const totalObservations = state.sessions.reduce((sum, session) => sum + Number(session.observationCount || 0), 0);
  if (!selected) {
    $("#evidence-browser").innerHTML = `<div class="empty">No clean sessions indexed yet.</div>`;
    return;
  }
  $("#evidence-browser").innerHTML = `
    <article class="session-hero">
      <div>
        <div class="label">Evidence Browser</div>
        <div class="title">Clean conversation archive</div>
        <div class="meta">${state.sessions.length} visible sessions / ${totalObservations} cleaned observations</div>
      </div>
      <span class="badge">${escapeHtml(sessionSourceName(selected.source))}</span>
    </article>
    <section class="session-inbox">
      <aside class="session-source-rail" aria-label="Clean sessions">
        <div class="session-source-label">Sessions</div>
        ${state.sessions.map((session) => `
          <button class="session-source-chip ${session.id === selected.id ? "active" : ""}" type="button" data-session="${escapeAttr(session.id)}">
            <span class="session-source-name">${escapeHtml(sessionTitle(session))}</span>
            <span class="session-source-count">${session.observationCount ?? observationCount(session)}</span>
            <span class="folder-hover-preview">${escapeHtml(sessionPreview(session))}</span>
          </button>
        `).join("")}
      </aside>
      <div class="session-inbox-main">
        <div class="session-inbox-head">
          <div>
            <div class="label">${escapeHtml(selected.source)}</div>
            <div class="title">${escapeHtml(sessionTitle(selected))}</div>
          </div>
          <span class="badge">${selected.observationCount ?? observationCount(selected)} records</span>
        </div>
        ${renderSessionObservationTrail(selected)}
      </div>
    </section>
  `;
  document.querySelectorAll("[data-session]").forEach((button) => {
    button.addEventListener("click", () => selectSession(button.dataset.session));
  });
  if (state.highlightedObservationId) requestAnimationFrame(() => applyObservationHighlight(state.highlightedObservationId));
}

function renderSessionObservationTrail(session) {
  const observations = cleanSessionObservations(session.id);
  if (observations.length === 0) return `<div class="empty">No visible transcript for this session.</div>`;
  return observations.map((observation) => `
    <article id="obs-anchor-${escapeAttr(observation.id)}" class="session-row observation-card conversation-${escapeAttr(observation.role)} ${observation.id === state.highlightedObservationId ? "obs-jump-highlight" : ""}">
      <span class="session-row-avatar ${escapeAttr(observation.role)}" aria-hidden="true">${observation.role === "user" ? "U" : "AI"}</span>
      <div>
        <div class="row-head">
          <div class="title">${observation.role === "user" ? "User" : "Agent reply"}</div>
          <div class="meta">${formatDate(observation.createdAt)}</div>
        </div>
        <div class="desc conversation-text">${escapeHtml(observation.text)}</div>
      </div>
    </article>
  `).join("");
}

async function selectSession(sessionId) {
  if (!sessionId) return;
  state.selectedSessionId = sessionId;
  state.highlightedObservationId = null;
  await ensureSessionObservations(sessionId);
  renderEvidenceBrowser();
}

function renderTodos() {
  $("#todo-list").innerHTML = state.todos.length ? `
    <section class="action-group">
      <div class="action-card-list">
        ${state.todos.map((todo) => `
          <article class="row todo-card action-item-card action-candidate-card">
            <div class="priority-rail action-priority-rail ${escapeHtml(todo.status)}"></div>
            <div class="todo-main">
              <div class="todo-title">${escapeHtml(todo.title)}</div>
              <div class="todo-desc">${escapeHtml(todo.description)}</div>
              <div class="todo-meta">
                <span class="badge ${todo.status}">${todo.status}</span>
                <span class="badge">${todo.evidenceIds.length} evidence</span>
                <span class="meta">${formatDate(todo.updatedAt)}</span>
              </div>
            </div>
            <div class="todo-actions">
              <button class="evidence-link" type="button" data-evidence="${escapeHtml(todo.id)}">Evidence</button>
              <span class="action-secondary">
                <button class="btn-primary-sm" type="button" data-status="done" data-id="${escapeHtml(todo.id)}">Done</button>
                <button class="btn-ghost-sm" type="button" data-status="ignored" data-id="${escapeHtml(todo.id)}">Ignore</button>
              </span>
            </div>
          </article>
        `).join("")}
      </div>
    </section>
  ` : `<div class="empty">No todos yet. Local sessions are indexed automatically, then Organize creates cards.</div>`;

  document.querySelectorAll("[data-status]").forEach((button) => {
    button.addEventListener("click", () => updateTodo(button.dataset.id, button.dataset.status));
  });
  document.querySelectorAll("[data-evidence]").forEach((button) => {
    button.addEventListener("click", () => jumpToTodoEvidence(button.dataset.evidence));
  });
}

function renderSettingsPanel() {
  const settings = state.settings;
  const llm = settings?.llm ?? {};
  const organize = settings?.organize ?? {};
  const apiKeyLabel = llm.apiKeyConfigured ? `Configured ${llm.apiKeyMasked}` : "Missing";
  $("#settings-panel").classList.toggle("open", state.settingsOpen);
  $("#settings-panel").setAttribute("aria-hidden", String(!state.settingsOpen));
  $("#settings-gear").setAttribute("aria-expanded", String(state.settingsOpen));
  $("#settings-panel").innerHTML = `
    <div class="settings-head">
      <div>
        <div class="settings-title">Settings</div>
        <div class="settings-sub">Local paths and LLM extraction defaults.</div>
      </div>
      <button class="ghost" type="button" data-action="close-settings" aria-label="Close settings">Close</button>
    </div>
    <form id="settings-form" class="settings-form">
      <section class="settings-section">
        <div class="settings-section-title">Sources</div>
        <div class="settings-grid">
          <label>
            Codex home or source path
            <input id="codex-path" name="codex" autocomplete="off" value="${escapeAttr(settings?.sources?.codex?.path ?? "")}">
          </label>
          <label>
            Claude Code source path
            <input id="claude-path" name="claude" autocomplete="off" value="${escapeAttr(settings?.sources?.["claude-code"]?.path ?? "")}">
          </label>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">LLM Extraction</div>
        <div class="settings-grid">
          <label class="check-row">
            <input id="llm-enabled" type="checkbox" ${llm.enabled === false ? "" : "checked"}>
            Enable LLM card generation
          </label>
          <label>
            Provider
            <select id="llm-provider">
              <option value="openai" selected>openai</option>
            </select>
          </label>
          <label>
            Model
            <input id="llm-model" autocomplete="off" value="${escapeAttr(llm.model ?? "deepseek/deepseek-v4-flash")}">
          </label>
          <label>
            Endpoint
            <input id="llm-endpoint" autocomplete="off" value="${escapeAttr(llm.endpoint ?? "https://api.novita.ai/openai/v1")}">
          </label>
          <label>
            Thinking depth
            <select id="llm-thinking">
              ${["low", "medium", "high"].map((depth) => `<option value="${depth}" ${depth === (llm.thinkingDepth ?? "medium") ? "selected" : ""}>${depth}</option>`).join("")}
            </select>
          </label>
          <label>
            Timeout ms
            <input id="llm-timeout" type="number" min="1000" max="600000" step="1000" value="${escapeAttr(llm.timeoutMs ?? 120000)}">
          </label>
          <label>
            API key
            <input id="llm-api-key" type="password" autocomplete="off" placeholder="Leave blank to keep current key">
          </label>
          <label class="check-row">
            <input id="llm-clear-key" type="checkbox">
            Clear saved API key
          </label>
          <div class="settings-note">API key: ${escapeHtml(apiKeyLabel)}</div>
        </div>
      </section>
      <section class="settings-section">
        <div class="settings-section-title">Organize Scope</div>
        <div class="settings-grid">
          <label>
            Look-back days
            <input id="organize-since-days" type="number" min="1" max="3650" step="1" value="${escapeAttr(organize.sinceDays ?? 7)}">
          </label>
          <label>
            Max interactions per session
            <input id="organize-max-interactions" type="number" min="1" max="500" step="1" value="${escapeAttr(organize.maxInteractionsPerSession ?? 10)}">
          </label>
          <label>
            Max sessions
            <input id="organize-max-sessions" type="number" min="1" max="200" step="1" value="${escapeAttr(organize.maxSessions ?? 16)}">
          </label>
          <label>
            Max observations per session
            <input id="organize-max-observations" type="number" min="1" max="1000" step="1" value="${escapeAttr(organize.maxObservationsPerSession ?? 40)}">
          </label>
        </div>
      </section>
      <button type="submit" class="primary">Save Settings</button>
    </form>
  `;
  $("#settings-form")?.addEventListener("submit", saveSettings);
}

async function organize() {
  const button = $("#organize");
  const originalLabel = button.textContent;
  button.disabled = true;
  button.classList.add("is-busy");
  button.setAttribute("aria-busy", "true");
  button.textContent = "Organizing...";
  const estimate = organizeEstimateText();
  setStatus(`Organizing recent sessions. ${estimate}`);
  try {
    const result = await api("/todos/organize", { method: "POST", body: {} });
    showOrganizeResult(result);
    await refresh();
  } catch (error) {
    setStatus(error.message);
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
    button.removeAttribute("aria-busy");
    button.textContent = originalLabel || "Organize";
  }
}

function organizeEstimateText() {
  const organize = state.settings?.organize ?? {};
  const maxSessions = Number(organize.maxSessions ?? 16);
  const maxInteractions = Number(organize.maxInteractionsPerSession ?? 10);
  const estimatedSeconds = Math.max(20, Math.min(180, Math.ceil(maxSessions * Math.max(2, maxInteractions / 5))));
  const range = estimatedSeconds < 60
    ? `${estimatedSeconds}-${estimatedSeconds + 20} seconds`
    : `${Math.ceil(estimatedSeconds / 60)}-${Math.ceil((estimatedSeconds + 60) / 60)} minutes`;
  return `This may take about ${range}; only the newest ${maxSessions} sessions are processed in this run.`;
}

async function updateTodo(id, status) {
  await api(`/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
  await refresh();
}

async function jumpToTodoEvidence(id) {
  const evidence = await api(`/todos/${encodeURIComponent(id)}/evidence`);
  if (evidence.length === 0) {
    $("#evidence-browser").innerHTML = `<div class="empty">No evidence for this todo.</div>`;
    showView("evidence");
    return;
  }

  const targetObservationId = evidence[0].observationId;
  const resolved = await resolveObservationSession(targetObservationId);
  if (!resolved) {
    state.highlightedObservationId = targetObservationId;
    renderEvidenceBrowser();
    showView("evidence");
    setStatus("Evidence source session was not found in the clean session index.");
    return;
  }

  state.selectedSessionId = resolved.session.id;
  state.highlightedObservationId = targetObservationId;
  state.observationsBySession[resolved.session.id] = resolved.observations;
  renderEvidenceBrowser();
  showView("evidence");
  requestAnimationFrame(() => applyObservationHighlight(targetObservationId));
}

async function resolveObservationSession(observationId) {
  for (const session of state.sessions) {
    const observations = await api(`/sessions/${encodeURIComponent(session.id)}/observations`);
    if (observations.some((observation) => observation.id === observationId)) {
      return { session, observations };
    }
  }
  return null;
}

function applyObservationHighlight(observationId) {
  const element = document.getElementById(`obs-anchor-${observationId}`);
  if (!element) return;
  element.scrollIntoView({ block: "center", behavior: "smooth" });
  element.classList.remove("obs-jump-highlight");
  void element.offsetWidth;
  element.classList.add("obs-jump-highlight");
  setTimeout(() => element.classList.remove("obs-jump-highlight"), 2400);
}

async function saveSettings(event) {
  event.preventDefault();
  const submitter = event.submitter instanceof HTMLButtonElement ? event.submitter : $("#settings-form button[type='submit']");
  if (submitter) submitter.disabled = true;
  setStatus("Saving settings...");
  const apiKey = $("#llm-api-key").value.trim();
  const clearKey = $("#llm-clear-key").checked;
  const llm = {
    enabled: $("#llm-enabled").checked,
    provider: "openai",
    model: $("#llm-model").value.trim(),
    endpoint: $("#llm-endpoint").value.trim(),
    thinkingDepth: $("#llm-thinking").value,
    timeoutMs: Number($("#llm-timeout").value)
  };
  if (clearKey) llm.apiKey = "";
  if (!clearKey && apiKey) llm.apiKey = apiKey;

  try {
    await api("/settings", {
      method: "PUT",
      body: {
        sources: {
          codex: pathValue("#codex-path"),
          "claude-code": pathValue("#claude-path")
        },
        llm,
        organize: {
          sinceDays: Number($("#organize-since-days").value),
          maxInteractionsPerSession: Number($("#organize-max-interactions").value),
          maxSessions: Number($("#organize-max-sessions").value),
          maxObservationsPerSession: Number($("#organize-max-observations").value)
        }
      }
    });
    await refresh();
    state.settingsOpen = true;
    renderSettingsPanel();
    setStatus("Settings saved.");
  } catch (error) {
    setStatus(`Settings save failed: ${error.message}`);
  } finally {
    if (submitter) submitter.disabled = false;
  }
}

function pathValue(selector) {
  const path = $(selector).value.trim();
  return path ? { path } : {};
}

function toggleSettings() {
  state.settingsOpen = !state.settingsOpen;
  renderSettingsPanel();
}

function closeSettings() {
  state.settingsOpen = false;
  renderSettingsPanel();
}

function showOrganizeResult(result) {
  const dialog = $("#organize-dialog");
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const sources = Array.isArray(result.sources) ? result.sources : [];
  $("#organize-dialog-summary").textContent = `${result.engine.toUpperCase()} engine / ${result.scanned} observations / ${result.durationMs}ms`;
  $("#organize-result").innerHTML = `
    <section class="organize-status-row">
      <span class="badge ${warnings.length ? "ignored" : "done"}">${escapeHtml(organizeStatusLabel(result, warnings))}</span>
      <span class="organize-meta">${escapeHtml(result.engine)} engine</span>
      <span class="organize-meta">${result.durationMs}ms</span>
    </section>
    <section class="organize-summary-grid" aria-label="Organize summary">
      ${[
        ["Scanned", result.scanned],
        ["Created", result.created],
        ["Updated", result.updated],
        ["Completed", result.completed],
        ["Ignored", result.ignored]
      ].map(([label, value]) => `
        <article class="organize-stat">
          <div class="label">${label}</div>
          <div class="value">${escapeHtml(String(value))}</div>
        </article>
      `).join("")}
    </section>
    <section class="organize-body-grid">
      <article class="organize-section">
        <div class="organize-section-head">
          <div class="label">Sources Scanned</div>
          <div class="sub">${sources.length} sources</div>
        </div>
        ${renderOrganizeSources(sources)}
      </article>
      <article class="organize-section ${warnings.length ? "has-warnings" : ""}">
        <div class="organize-section-head">
          <div class="label">Warnings</div>
          <div class="sub">${warnings.length || "none"}</div>
        </div>
        ${renderOrganizeWarnings(warnings, result.details)}
      </article>
    </section>
    <footer class="organize-footer">
      <button type="button" class="primary" data-dialog-action="todos">View Todos</button>
      <button type="button" class="ghost" data-dialog-action="settings">Review Settings</button>
      <button type="button" class="ghost" data-dialog-action="close">Close</button>
    </footer>
  `;
  $("#organize-result").querySelectorAll("[data-dialog-action]").forEach((button) => {
    button.addEventListener("click", () => handleOrganizeDialogAction(button.dataset.dialogAction));
  });
  dialog.showModal();
}

function organizeStatusLabel(result, warnings) {
  if (warnings.length > 0) return "Warnings";
  if (result.created > 0) return `Created ${result.created}`;
  if (result.updated > 0) return `Updated ${result.updated}`;
  return "No changes";
}

function renderOrganizeSources(sources) {
  if (sources.length === 0) return `<div class="empty organize-empty">No source observations were scanned.</div>`;
  const total = Math.max(1, sources.reduce((sum, source) => sum + Number(source.scanned || 0), 0));
  return `
    <div class="organize-source-list">
      ${sources.map((source) => {
        const scanned = Number(source.scanned || 0);
        const percent = Math.max(3, Math.round((scanned / total) * 100));
        return `
          <div class="organize-source-row">
            <span class="session-row-avatar" aria-hidden="true">${escapeHtml(sourceInitials(source.source))}</span>
            <div>
              <div class="row-head">
                <div class="title">${escapeHtml(sessionSourceName(source.source))}</div>
                <div class="meta">${scanned} scanned</div>
              </div>
              <div class="organize-source-bar"><span style="width:${percent}%"></span></div>
            </div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderOrganizeWarnings(warnings, details) {
  if (!warnings.length) return `<div class="organize-ok">No warnings.</div>`;
  const batchFailures = Array.isArray(details?.batchFailures) ? details.batchFailures : [];
  const truncations = Array.isArray(details?.truncations) ? details.truncations : [];
  const scope = details?.scope;
  return `
    <ul class="organize-warning-list">
      ${warnings.map((warning) => `<li>${escapeHtml(warningLabel(warning))}</li>`).join("")}
    </ul>
    ${scope ? `<div class="settings-note">整理范围：扫描 ${escapeHtml(String(scope.sessionsScanned ?? 0))} 个会话，跳过 ${escapeHtml(String(scope.sessionsDropped ?? 0))} 个会话、${escapeHtml(String(scope.observationsDropped ?? 0))} 条记录。</div>` : ""}
    ${truncations.length ? `<div class="settings-note">已压缩 ${truncations.length} 条较长会话片段后再发送给 LLM。</div>` : ""}
    ${batchFailures.length ? `
      <ul class="organize-warning-list">
        ${batchFailures.slice(0, 4).map((failure) => `
          <li>${escapeHtml(sessionSourceName(failure.source))} / ${escapeHtml(shortId(failure.sessionId))}: ${escapeHtml(batchFailureReasonLabel(failure.reason))}</li>
        `).join("")}
      </ul>
    ` : ""}
  `;
}

function warningLabel(warning) {
  return {
    llm_config_missing: "LLM is not configured; no cards were generated.",
    llm_timeout: "部分会话的 LLM 抽取超时。",
    llm_provider_failed: "部分会话的 LLM 调用失败。",
    llm_output_invalid: "The LLM returned output that could not be used.",
    llm_no_valid_candidates: "No actionable todos were found.",
    llm_input_truncated: "部分长会话内容已压缩后再发送给 LLM。",
    llm_batch_failed: "部分批次失败，其余批次已继续处理。",
    organize_scope_truncated: "本次只整理最近一部分会话。",
    organize_failed: "Organize failed before cards could be created."
  }[warning] ?? warning;
}

function batchFailureReasonLabel(reason) {
  return {
    network_error: "网络请求失败",
    http_400: "provider 拒绝请求",
    http_401: "API key 无效或未授权",
    http_403: "API key 无权限",
    http_404: "模型或接口不存在",
    http_429: "provider 限流",
    http_500: "provider 服务错误",
    http_502: "provider 网关错误",
    http_503: "provider 暂不可用",
    http_504: "provider 调用超时",
    unknown_provider_error: "未知 provider 错误",
    timeout: "调用超时",
    invalid_json: "模型返回了非 JSON",
    invalid_schema: "模型返回结构不符合要求"
  }[reason] ?? reason;
}

function shortId(value) {
  const text = String(value || "");
  return text.length > 18 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function handleOrganizeDialogAction(action) {
  const dialog = $("#organize-dialog");
  if (action === "todos") {
    dialog.close();
    showView("todos");
    $("#organize").focus();
    return;
  }
  if (action === "settings") {
    dialog.close();
    state.settingsOpen = true;
    renderSettingsPanel();
    $("#settings-gear").focus();
    return;
  }
  dialog.close();
  $("#organize").focus();
}

function showView(id) {
  document.querySelectorAll(".tabs button").forEach((button) => {
    const active = button.dataset.view === id;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".view").forEach((view) => {
    view.classList.toggle("active", view.id === id);
  });
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      method: options.method ?? "GET",
      headers: { "content-type": "application/json" },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch {
    throw new Error("Local AI-Todo server is not reachable. Restart with ai-todo open.");
  }
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

async function ensureSessionObservations(sessionId) {
  if (!sessionId || state.observationsBySession[sessionId]) return;
  try {
    state.observationsBySession[sessionId] = await api(`/sessions/${encodeURIComponent(sessionId)}/observations`);
  } catch {
    state.observationsBySession[sessionId] = [];
  }
}

function setStatus(message) {
  $("#status").textContent = message;
}

function startupStatusText(scan) {
  if (!scan || scan.status === "idle") return "Ready";
  if (scan.status === "indexing") return "Indexing local sessions...";
  if (scan.status === "failed") return "Indexing finished with warnings";
  return "Ready";
}

function sessionSourceGroups() {
  const groups = new Map();
  for (const session of state.sessions) {
    const group = groups.get(session.source) ?? { name: session.source, count: 0, preview: "" };
    group.count++;
    if (!group.preview) group.preview = sessionPreview(session);
    groups.set(session.source, group);
  }
  return Array.from(groups.values());
}

function observationCount(session) {
  return (state.observationsBySession[session.id] ?? []).length;
}

function cleanSessionObservations(sessionId) {
  return (state.observationsBySession[sessionId] ?? []).filter((observation) => observation.role === "user" || observation.role === "assistant");
}

function sessionPreview(session) {
  if (session.preview) return session.preview;
  const observation = (state.observationsBySession[session.id] ?? []).find((item) => item.role === "user" || item.role === "assistant");
  return observation?.text ?? "No visible transcript preview yet.";
}

function sessionTitle(session) {
  const preview = sessionPreview(session);
  return truncate(preview || session.source, 84);
}

function sessionSourceName(source) {
  if (source === "claude-code") return "Claude";
  if (source === "codex") return "Codex";
  return "Browser";
}

function sourceInitials(source) {
  return sessionSourceName(source).slice(0, 2).toUpperCase();
}

function shortPath(path) {
  const parts = String(path || "").split("/");
  return parts.slice(-3).join("/") || path;
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function formatDate(value) {
  return new Date(value).toLocaleString();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value);
}
