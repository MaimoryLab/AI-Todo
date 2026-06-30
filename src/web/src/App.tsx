import {
  Archive,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Code2,
  Eye,
  FolderKanban,
  Globe2,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Settings,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import { useEffect, useState, type ChangeEvent } from "react";
import { api, userFacingError } from "./api/client.js";
import { Badge, Button, Card, IconButton, Input, SectionTitle } from "./components/ui.js";
import { cn } from "./lib/utils.js";
import type { ObservationRecord, OrganizeResult, PublicAppConfig, SessionRecord, SourceKind, SourceSummary, StartupScanStatus, TodoCard } from "./types.js";

type View = "todos" | "sources" | "settings";
type SourceFilter = SourceKind | "all";

const SESSION_PAGE_SIZE = 50;
const OPEN_GROUP_PREVIEW_LIMIT = 6;

const sourceLabels: Record<SourceKind, string> = {
  codex: "Codex",
  "claude-code": "Claude",
  browser: "Browser"
};

export function App() {
  const [view, setView] = useState<View>("todos");
  const [todos, setTodos] = useState<TodoCard[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [sourceSummaries, setSourceSummaries] = useState<SourceSummary[]>([]);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [sessionOffset, setSessionOffset] = useState(0);
  const [observationsBySession, setObservationsBySession] = useState<Record<string, ObservationRecord[]>>({});
  const [settings, setSettings] = useState<PublicAppConfig | null>(null);
  const [startup, setStartup] = useState<StartupScanStatus | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("");
  const [highlightedObservationId, setHighlightedObservationId] = useState<string>("");
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

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
    setStatus("Organizing recent sessions...");
    try {
      const result = await api<OrganizeResult>("/todos/organize", { method: "POST", body: {} });
      await refresh();
      const warningText = result.warnings.length ? ` ${result.warnings.map(userFacingError).join(" ")}` : "";
      setStatus(`Organized ${result.created} new and ${result.updated} updated cards.${warningText}`);
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
      setStatus("No source is linked to this card yet.");
      return;
    }
    const session = await ensureSessionLoaded(todo.origin.sessionId);
    if (!session) {
      setView("sources");
      setStatus("The linked source session is no longer available.");
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

  const openTodos = todos.filter((todo) => todo.status === "todo");
  const closedTodos = todos.filter((todo) => todo.status !== "todo");

  return (
    <main className="min-h-screen bg-neutral-100 text-neutral-950">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-neutral-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium text-neutral-500">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              AI Todo
            </div>
            <h1 className="text-2xl font-semibold tracking-normal">Action inbox</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <IconButton label="Refresh" onClick={() => void refresh()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <Button onClick={() => void organize()} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Sparkles className="h-4 w-4" aria-hidden="true" />}
              Organize
            </Button>
          </div>
        </header>

        <nav className="sticky top-0 z-10 -mx-4 flex gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-100/95 px-4 py-3 backdrop-blur sm:mx-0 sm:px-0" aria-label="Primary">
          <NavButton active={view === "todos"} onClick={() => setView("todos")} icon={<CircleDot className="h-4 w-4" />}>To-Do</NavButton>
          <NavButton active={view === "sources"} onClick={() => setView("sources")} icon={<FolderKanban className="h-4 w-4" />}>Sources</NavButton>
          <NavButton active={view === "settings"} onClick={() => setView("settings")} icon={<Settings className="h-4 w-4" />}>Settings</NavButton>
        </nav>

        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_320px]">
          <section className="min-w-0">
            {view === "todos" && (
              <TodoWorkspace
                openTodos={openTodos}
                closedTodos={closedTodos}
                onComplete={(id) => void updateTodo(id, "done")}
                onIgnore={(id) => void updateTodo(id, "ignored")}
                onSources={(todo) => void openTodoSources(todo)}
                onOrganize={() => void organize()}
                busy={busy}
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
                onSaved={async () => {
                  await refresh();
                  setStatus("Settings saved.");
                }}
              />
            )}
          </section>
          <aside className="min-w-0 space-y-4">
            <Card className="p-4">
              <SectionTitle>Status</SectionTitle>
              <p className="mt-2 text-sm text-neutral-700">{status}</p>
            </Card>
            <Card className="p-4">
              <SectionTitle>Review</SectionTitle>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
                <Metric label="Open" value={openTodos.length} />
                <Metric label="Done" value={todos.filter((todo) => todo.status === "done").length} />
                <Metric label="Sources" value={sessions.length} />
              </dl>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}

function NavButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      className={cn(
        "inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md px-3 text-sm font-medium text-neutral-600",
        active ? "bg-white text-neutral-950 shadow-sm ring-1 ring-neutral-200" : "hover:bg-white/70"
      )}
      onClick={onClick}
      type="button"
    >
      {icon}
      {children}
    </button>
  );
}

function TodoWorkspace(props: {
  openTodos: TodoCard[];
  closedTodos: TodoCard[];
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
  onOrganize: () => void;
  busy: boolean;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const [expandedOpenGroups, setExpandedOpenGroups] = useState<Record<string, boolean>>({});
  if (props.openTodos.length === 0 && props.closedTodos.length === 0) {
    return (
      <Card className="flex min-h-80 flex-col items-center justify-center p-6 text-center">
        <Sparkles className="h-10 w-10 text-neutral-400" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-semibold">No cards yet</h2>
        <p className="mt-1 max-w-md text-sm text-neutral-600">Organize recent sessions into a focused action inbox.</p>
        <Button className="mt-4" onClick={props.onOrganize} disabled={props.busy}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Organize
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <SectionTitle>To-Do</SectionTitle>
          <h2 className="text-xl font-semibold tracking-normal">Open loops first</h2>
        </div>
        <Badge>{props.openTodos.length} open</Badge>
      </div>
      {todoGroups(props.openTodos).map((group) => {
        const expanded = expandedOpenGroups[group.key] ?? false;
        const visibleTodos = expanded ? group.todos : group.todos.slice(0, OPEN_GROUP_PREVIEW_LIMIT);
        const hiddenCount = group.todos.length - visibleTodos.length;
        return (
        <section key={group.key} className="space-y-2">
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 text-left"
            aria-expanded={expanded}
            onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: !expanded }))}
          >
            <h3 className="text-sm font-semibold text-neutral-700">{group.label}</h3>
            <span className="inline-flex items-center gap-2">
              <Badge>{group.todos.length}</Badge>
              <ChevronDown className={cn("h-4 w-4 text-neutral-500 transition", expanded && "rotate-180")} aria-hidden="true" />
            </span>
          </button>
          <div className="space-y-3">
            {visibleTodos.map((todo) => (
              <TodoItem key={todo.id} todo={todo} onComplete={props.onComplete} onIgnore={props.onIgnore} onSources={props.onSources} compactStatus />
            ))}
            {hiddenCount > 0 && (
              <Button variant="secondary" className="w-full" onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: true }))}>
                Show {hiddenCount} more
              </Button>
            )}
          </div>
        </section>
        );
      })}
      {props.closedTodos.length > 0 && (
        <section className="rounded-lg border border-neutral-200 bg-white p-3">
          <button className="flex w-full items-center justify-between gap-3 text-left text-sm font-semibold text-neutral-700" type="button" onClick={() => setShowClosed(!showClosed)}>
            Completed / ignored
            <span className="inline-flex items-center gap-2 text-xs font-medium text-neutral-500">
              {props.closedTodos.length}
              <ChevronDown className={cn("h-4 w-4 transition", showClosed && "rotate-180")} aria-hidden="true" />
            </span>
          </button>
          {showClosed && (
            <div className="mt-3 space-y-3">
              {props.closedTodos.map((todo) => (
                <TodoItem key={todo.id} todo={todo} onComplete={props.onComplete} onIgnore={props.onIgnore} onSources={props.onSources} muted />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function todoGroups(todos: TodoCard[]): Array<{ key: string; label: string; todos: TodoCard[] }> {
  const groups = [
    { key: "blocked", label: "Blocked", todos: [] as TodoCard[] },
    { key: "in_progress", label: "In progress", todos: [] as TodoCard[] },
    { key: "needs_review", label: "Needs review", todos: [] as TodoCard[] }
  ];
  for (const todo of todos) {
    const state = todo.metadata.completionState?.toLowerCase().replace(/\s+/g, "_");
    const target = groups.find((group) => group.key === state) ?? groups[2];
    target.todos.push(todo);
  }
  return groups.filter((group) => group.todos.length > 0);
}

function TodoItem({ todo, muted, compactStatus, onComplete, onIgnore, onSources }: {
  todo: TodoCard;
  muted?: boolean;
  compactStatus?: boolean;
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
}) {
  return (
    <Card className={cn("p-4", muted && "opacity-70")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          {!compactStatus && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={todo.status === "todo" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : ""}>{todo.status === "todo" ? "Open" : todo.status === "done" ? "Done" : "Ignored"}</Badge>
              {todo.metadata.completionState && <Badge>{todo.metadata.completionState}</Badge>}
            </div>
          )}
          <h3 className="break-words text-lg font-semibold tracking-normal">{todo.title}</h3>
          <p className="break-words text-sm leading-6 text-neutral-700">{todo.description}</p>
          {todo.metadata.completionSummary && (
            <p className="break-words text-sm text-neutral-500">
              <span className="font-medium text-neutral-600">Agent:</span> {todo.metadata.completionSummary}
            </p>
          )}
          <button className="flex max-w-full items-start gap-2 text-left text-sm text-neutral-500 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-70" type="button" title={originLabel(todo)} disabled={!todo.origin} onClick={() => onSources(todo)}>
            <SourceIcon source={todo.origin?.source} />
            <span className="min-w-0">
              <span className="block truncate font-medium text-neutral-600">{originProjectLabel(todo)}</span>
              <span className="block truncate text-xs text-neutral-500">{originSessionLabel(todo)}</span>
            </span>
          </button>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button variant="secondary" onClick={() => onComplete(todo.id)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Complete
          </Button>
          <Button variant="secondary" onClick={() => onSources(todo)}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            Sources
          </Button>
          <IconButton label="Ignore" onClick={() => onIgnore(todo.id)}>
            <Archive className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </Card>
  );
}

function SourcesWorkspace({ sessions, sourceSummaries, sourceFilter, sessionOffset, observationsBySession, selectedSessionId, highlightedObservationId, onFilter, onLoadMore, onSelect }: {
  sessions: SessionRecord[];
  sourceSummaries: SourceSummary[];
  sourceFilter: SourceFilter;
  sessionOffset: number;
  observationsBySession: Record<string, ObservationRecord[]>;
  selectedSessionId: string;
  highlightedObservationId: string;
  onFilter: (filter: SourceFilter) => void;
  onLoadMore: () => void;
  onSelect: (sessionId: string) => void;
}) {
  const selected = sessions.find((session) => session.id === selectedSessionId) ?? (selectedSessionId ? undefined : sessions[0]);
  const observations = selected ? observationsBySession[selected.id] ?? [] : [];
  const totalSessions = sourceFilter === "all"
    ? sourceSummaries.reduce((sum, source) => sum + source.sessions, 0)
    : sourceSummaries.find((source) => source.source === sourceFilter)?.sessions ?? 0;
  const filters: SourceFilter[] = ["all", "codex", "claude-code", "browser"];
  return (
    <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
      <Card className="min-w-0 p-3">
        <div className="mb-3 space-y-3 px-1">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-neutral-400" aria-hidden="true" />
            <SectionTitle>Sources</SectionTitle>
          </div>
          <div className="flex gap-1 overflow-x-auto" aria-label="Source filter">
            {filters.map((filter) => (
              <button
                key={filter}
                type="button"
                className={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                  sourceFilter === filter ? "bg-neutral-950 text-white" : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200"
                )}
                onClick={() => onFilter(filter)}
              >
                {filter === "all" ? "All" : sourceLabels[filter]}
                <span>{sourceCount(sourceSummaries, filter)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[calc(100vh-220px)] space-y-2 overflow-y-auto pr-1">
          {sessions.length === 0 && <div className="rounded-md bg-neutral-50 p-4 text-sm text-neutral-600">Connect or scan a source to review sessions.</div>}
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={cn(
                "w-full rounded-md border p-3 text-left transition",
                selected?.id === session.id ? "border-neutral-900 bg-neutral-50" : "border-neutral-200 bg-white hover:bg-neutral-50"
              )}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <SourceIcon source={session.source} />
                <span className="truncate">{sourceLabels[session.source]}</span>
              </div>
              <div className="mt-1 truncate text-sm text-neutral-600">{session.preview || "Temporary session"}</div>
              <div className="mt-2 text-xs text-neutral-400">{session.observationCount} messages</div>
            </button>
          ))}
          {sessionOffset < totalSessions && (
            <Button variant="secondary" className="w-full" onClick={onLoadMore}>
              Load more
            </Button>
          )}
        </div>
      </Card>
      <Card className="min-w-0 p-4">
        {selected ? (
          <>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <SectionTitle>{sourceLabels[selected.source]}</SectionTitle>
                <h2 className="truncate text-xl font-semibold tracking-normal">{selected.preview || "Temporary session"}</h2>
              </div>
              <Badge>{selected.observationCount} messages</Badge>
            </div>
            <div className="max-h-[calc(100vh-220px)] space-y-3 overflow-y-auto pr-1">
              {observations.length === 0 && <div className="rounded-md bg-neutral-50 p-4 text-sm text-neutral-600">Select a source to load its conversation.</div>}
              {observations.map((observation) => (
                <article
                  id={`obs-${observation.id}`}
                  key={observation.id}
                  className={cn(
                    "rounded-md border border-neutral-200 bg-white p-3",
                    highlightedObservationId === observation.id && "border-amber-300 bg-amber-50"
                  )}
                >
                  <div className="mb-2 flex items-center justify-between gap-2 text-xs text-neutral-500">
                    <span className="capitalize">{observation.role === "unknown" ? "Message" : observation.role}</span>
                    <time>{new Date(observation.createdAt).toLocaleString()}</time>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm leading-6 text-neutral-800">{observation.text}</p>
                </article>
              ))}
            </div>
          </>
        ) : (
          <div className="rounded-md bg-neutral-50 p-4 text-sm text-neutral-600">No source sessions yet.</div>
        )}
      </Card>
    </div>
  );
}

function SettingsWorkspace({ settings, startup, onSaved }: { settings: PublicAppConfig; startup: StartupScanStatus | null; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState(settings);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      const saved = await api<PublicAppConfig>("/settings", {
        method: "PUT",
        body: {
          sources: form.sources,
          llm: {
            enabled: form.llm.enabled,
            provider: "openai",
            model: form.llm.model,
            endpoint: form.llm.endpoint,
            thinkingDepth: form.llm.thinkingDepth,
            timeoutMs: form.llm.timeoutMs,
            ...(clearKey ? { apiKey: "" } : apiKey ? { apiKey } : {})
          },
          organize: form.organize
        }
      });
      setForm(saved);
      await onSaved();
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionTitle>Settings</SectionTitle>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Codex source">
            <Input value={form.sources.codex.path ?? ""} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, sources: { ...form.sources, codex: { path: event.target.value } } })} />
          </Field>
          <Field label="Claude source">
            <Input value={form.sources["claude-code"].path ?? ""} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, sources: { ...form.sources, "claude-code": { path: event.target.value } } })} />
          </Field>
          <Field label="Model">
            <Input value={form.llm.model} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, llm: { ...form.llm, model: event.target.value } })} />
          </Field>
          <Field label="Endpoint">
            <Input value={form.llm.endpoint} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, llm: { ...form.llm, endpoint: event.target.value } })} />
          </Field>
          <Field label="Look-back days">
            <Input type="number" min={1} value={form.organize.sinceDays} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, organize: { ...form.organize, sinceDays: Number(event.target.value) } })} />
          </Field>
          <Field label="Max sessions">
            <Input type="number" min={1} max={200} value={form.organize.maxSessions} onChange={(event: ChangeEvent<HTMLInputElement>) => setForm({ ...form, organize: { ...form.organize, maxSessions: Number(event.target.value) } })} />
          </Field>
          <Field label="API key">
            <Input type="password" placeholder={settings.llm.apiKeyConfigured ? `Configured ${settings.llm.apiKeyMasked}` : "Paste API key"} value={apiKey} onChange={(event: ChangeEvent<HTMLInputElement>) => setApiKey(event.target.value)} />
          </Field>
          <label className="flex items-center gap-2 self-end text-sm text-neutral-700">
            <input type="checkbox" checked={clearKey} onChange={(event) => setClearKey(event.target.checked)} />
            Clear saved API key
          </label>
        </div>
        <Button className="mt-4" onClick={() => void save()} disabled={saving}>
          <Save className="h-4 w-4" aria-hidden="true" />
          Save Settings
        </Button>
        {saveError && <p className="mt-3 text-sm text-red-700">{saveError}</p>}
      </Card>
      <details className="rounded-lg border border-neutral-200 bg-white p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium">
          Diagnostics
          <ChevronDown className="h-4 w-4" aria-hidden="true" />
        </summary>
        <div className="mt-3 space-y-2 text-sm text-neutral-600">
          <p>Startup scan: {startup?.status ?? "idle"}</p>
          <p>Extraction: {settings.llm.apiKeyConfigured ? "Configured" : "Needs setup"}</p>
          {startup?.warnings.map((warning: string) => <p key={warning}>{userFacingError(warning)}</p>)}
        </div>
      </details>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-sm font-medium text-neutral-700">
      {label}
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-neutral-50 p-3">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

function SourceIcon({ source }: { source?: SourceKind }) {
  const className = "h-4 w-4 shrink-0 text-neutral-500";
  if (source === "codex") return <TerminalSquare className={className} aria-hidden="true" />;
  if (source === "claude-code") return <Bot className={className} aria-hidden="true" />;
  if (source === "browser") return <Globe2 className={className} aria-hidden="true" />;
  return <Code2 className={className} aria-hidden="true" />;
}

function originLabel(todo: TodoCard): string {
  if (!todo.origin) return "Source not linked";
  const project = todo.origin.projectTitle || sourceLabels[todo.origin.source];
  const session = todo.origin.sessionTitle || "Temporary session";
  return `${sourceLabels[todo.origin.source]} · ${project} › ${session}`;
}

function originProjectLabel(todo: TodoCard): string {
  if (!todo.origin) return "Source not linked";
  const project = todo.origin.projectTitle || sourceLabels[todo.origin.source];
  return `${sourceLabels[todo.origin.source]} · ${project}`;
}

function originSessionLabel(todo: TodoCard): string {
  return todo.origin?.sessionTitle || "Temporary session";
}

function sourceCount(sources: SourceSummary[], filter: SourceFilter): number {
  if (filter === "all") return sources.reduce((sum, source) => sum + source.sessions, 0);
  return sources.find((source) => source.source === filter)?.sessions ?? 0;
}

function mergeSessions(first: SessionRecord[], second: SessionRecord[]): SessionRecord[] {
  const seen = new Set<string>();
  return [...first, ...second].filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}
