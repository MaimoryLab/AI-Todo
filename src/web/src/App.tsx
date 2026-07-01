import { useEffect, useState } from "react";
import { api, localizedUserFacingError } from "./api/client.js";
import { AppShell } from "./components/app-shell.js";
import { SettingsWorkspace } from "./components/settings-workspace.js";
import { SourcesWorkspace } from "./components/sources-workspace.js";
import { TodoBoard } from "./components/todo-board.js";
import { readLocale, textFor, writeLocale, type Locale } from "./i18n.js";
import type { ObservationRecord, OrganizeResult, PublicAppConfig, SessionRecord, SourceSummary, StartupScanStatus, TodoCard, TodoEvidence } from "./types.js";
import type { SourceFilter, View } from "./view-model.js";

const SESSION_PAGE_SIZE = 50;

export function App() {
  const [view, setView] = useState<View>("todos");
  const [todos, setTodos] = useState<TodoCard[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [locale, setLocale] = useState<Locale>(() => readLocale());
  const [sourceSummaries, setSourceSummaries] = useState<SourceSummary[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sessionOffset, setSessionOffset] = useState(0);
  const [observationsBySession, setObservationsBySession] = useState<Record<string, ObservationRecord[]>>({});
  const [evidenceByTodo, setEvidenceByTodo] = useState<Record<string, TodoEvidence[]>>({});
  const [settings, setSettings] = useState<PublicAppConfig | null>(null);
  const [startup, setStartup] = useState<StartupScanStatus | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [highlightedObservationId, setHighlightedObservationId] = useState<string>("");
  const [status, setStatus] = useState<string>(() => textFor(readLocale()).ready);
  const [busy, setBusy] = useState(false);
  const [startupNoticeShown, setStartupNoticeShown] = useState(false);
  const text = textFor(locale);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    writeLocale(locale);
  }, [locale]);

  useEffect(() => {
    void loadSessions(sourceFilter, 0);
  }, [sourceFilter]);

  useEffect(() => {
    if (!selectedSessionId && sessions[0]) setSelectedSessionId(sessions[0].id);
  }, [selectedSessionId, sessions]);

  useEffect(() => {
    if (view !== "sources" || !highlightedObservationId || !observationsBySession[selectedSessionId]) return;
    requestAnimationFrame(() => document.getElementById(`obs-${highlightedObservationId}`)?.scrollIntoView({ block: "center" }));
  }, [view, selectedSessionId, highlightedObservationId, observationsBySession]);

  useEffect(() => {
    if (!startup) return;
    if (startup.status === "indexing") {
      const timer = window.setTimeout(() => void refresh(), 500);
      return () => window.clearTimeout(timer);
    }
    const message = startupStatusMessage(startup, locale);
    if (message && !startupNoticeShown) {
      setStatus(message);
      setStartupNoticeShown(true);
    }
  }, [locale, startup, startupNoticeShown]);

  async function refresh() {
    const [nextTodos, nextSources, nextSettings, nextStartup] = await Promise.all([
      api<TodoCard[]>("/todos"),
      api<SourceSummary[]>("/sources"),
      api<PublicAppConfig>("/settings"),
      api<StartupScanStatus>("/startup/scan")
    ]);
    setTodos(nextTodos);
    setSourceSummaries(nextSources);
    setSettings(nextSettings);
    setStartup(nextStartup);
    await loadSessions(sourceFilter, 0);
  }

  async function loadSessions(filter: SourceFilter, offset: number) {
    const query = new URLSearchParams({
      limit: String(SESSION_PAGE_SIZE),
      offset: String(offset)
    });
    if (filter !== "all") query.set("source", filter);
    const nextSessions = await api<SessionRecord[]>(`/sessions?${query.toString()}`);
    setSessions((current) => offset === 0 ? nextSessions : mergeSessions(current, nextSessions));
    setSessionOffset(offset + nextSessions.length);
    if (offset === 0) {
      setSelectedSessionId(nextSessions[0]?.id ?? "");
      setHighlightedObservationId("");
    }
  }

  async function organize() {
    setBusy(true);
    setStatus(text.organizing);
    try {
      const result = await api<OrganizeResult>("/todos/organize", { method: "POST", body: {} });
      await refresh();
      setStatus(organizeStatus(result, locale));
    } catch (error) {
      setStatus((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function updateTodo(id: string, status: "done" | "ignored") {
    await api<TodoCard>(`/todos/${encodeURIComponent(id)}`, { method: "PATCH", body: { status } });
    await refresh();
  }

  async function openTodoSources(todo: TodoCard) {
    if (!todo.origin) {
      setView("sources");
      setStatus(text.noLinkedSource);
      return;
    }
    const session = await ensureSessionLoaded(todo.origin.sessionId);
    if (!session) {
      setView("sources");
      setStatus(text.linkedSourceMissing);
      return;
    }
    setSelectedSessionId(todo.origin.sessionId);
    setHighlightedObservationId(todo.origin.observationId);
    await loadObservations(todo.origin.sessionId);
    setView("sources");
  }

  async function ensureSessionLoaded(sessionId: string): Promise<SessionRecord | null> {
    const existing = sessions.find((session) => session.id === sessionId);
    if (existing) return existing;
    const [session] = await api<SessionRecord[]>(`/sessions?sessionId=${encodeURIComponent(sessionId)}`);
    if (!session) return null;
    setSessions((current) => mergeSessions([session], current));
    return session;
  }

  async function loadObservations(sessionId: string) {
    if (observationsBySession[sessionId]) return;
    const observations = await api<ObservationRecord[]>(`/sessions/${encodeURIComponent(sessionId)}/observations`);
    setObservationsBySession((current) => ({ ...current, [sessionId]: observations }));
  }

  async function loadTodoEvidence(todoId: string) {
    if (evidenceByTodo[todoId]) return;
    try {
      const evidence = await api<TodoEvidence[]>(`/todos/${encodeURIComponent(todoId)}/evidence`);
      setEvidenceByTodo((current) => ({ ...current, [todoId]: evidence }));
    } catch (error) {
      setStatus((error as Error).message);
    }
  }

  const openTodos = todos.filter((todo) => todo.status === "todo");
  const closedTodos = todos.filter((todo) => todo.status !== "todo");

  return (
    <AppShell
      text={text}
      view={view}
      status={status}
      busy={busy}
      onView={setView}
      onRefresh={() => void refresh()}
      onOrganize={() => void organize()}
    >
      {view === "todos" && (
        <TodoBoard
          openTodos={openTodos}
          closedTodos={closedTodos}
          onComplete={(id) => void updateTodo(id, "done")}
          onIgnore={(id) => void updateTodo(id, "ignored")}
          onSources={(todo) => void openTodoSources(todo)}
          evidenceByTodo={evidenceByTodo}
          onSelectTodo={(todo) => void loadTodoEvidence(todo.id)}
          onOrganize={() => void organize()}
          busy={busy}
          locale={locale}
        />
      )}
      {view === "sources" && (
        <SourcesWorkspace
          sessions={sessions}
          sourceSummaries={sourceSummaries}
          sourceFilter={sourceFilter}
          sessionOffset={sessionOffset}
          observationsBySession={observationsBySession}
          selectedSessionId={selectedSessionId}
          highlightedObservationId={highlightedObservationId}
          locale={locale}
          onFilter={(filter) => setSourceFilter(filter)}
          onLoadMore={() => void loadSessions(sourceFilter, sessionOffset)}
          onSelect={(sessionId) => {
            setSelectedSessionId(sessionId);
            void loadObservations(sessionId);
          }}
        />
      )}
      {view === "settings" && settings && (
        <SettingsWorkspace
          settings={settings}
          startup={startup}
          locale={locale}
          onLocale={(nextLocale) => {
            setLocale(nextLocale);
            setStatus(textFor(nextLocale).ready);
          }}
          onSaved={async (message) => {
            await refresh();
            setStatus(message ?? textFor(locale).settingsSaved);
          }}
        />
      )}
    </AppShell>
  );
}

function organizeStatus(result: OrganizeResult, locale: Locale): string {
  const text = textFor(locale);
  const summary = text.organized(result.created, result.updated);
  if (result.warnings.length === 0) return summary;
  const warnings = result.warnings.map((warning) => localizedUserFacingError(warning, locale)).join(" ");
  if (result.created + result.updated > 0) return `${summary} ${text.reviewSessions}${warnings}`;
  return `${summary} ${warnings}`;
}

function startupStatusMessage(startup: StartupScanStatus | null, locale: Locale): string {
  if (!startup?.warnings.length) return "";
  return `${textFor(locale).sourceScanFailed}${startup.warnings.map((warning) => localizedUserFacingError(warning, locale)).join(" ")}`;
}

function mergeSessions(first: SessionRecord[], second: SessionRecord[]): SessionRecord[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}
