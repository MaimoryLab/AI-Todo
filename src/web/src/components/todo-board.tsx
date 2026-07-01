import { Archive, CheckCircle2, ChevronDown, Eye, FileText, Inbox, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { sourceLabel, textFor, type Locale } from "../i18n.js";
import { cn } from "../lib/utils.js";
import type { SourceKind, TodoCard, TodoEvidence } from "../types.js";
import { Badge, Button, Card, Input, SectionTitle } from "./ui.js";
import { originLabel, originProjectLabel, SourceIcon } from "./source-labels.js";

const OPEN_GROUP_PREVIEW_LIMIT = 6;
type TodoSourceFilter = "all" | SourceKind;

export function TodoBoard(props: {
  openTodos: TodoCard[];
  closedTodos: TodoCard[];
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
  evidenceByTodo: Record<string, TodoEvidence[]>;
  evidenceErrorsByTodo: Record<string, string>;
  onSelectTodo: (todo: TodoCard) => void;
  onOrganize: () => void;
  busy: boolean;
  locale: Locale;
}) {
  const text = textFor(props.locale);
  const [showClosed, setShowClosed] = useState(false);
  const [expandedOpenGroups, setExpandedOpenGroups] = useState<Record<string, boolean>>({});
  const [selectedTodoId, setSelectedTodoId] = useState("");
  const [sourceFilter, setSourceFilter] = useState<TodoSourceFilter>("all");
  const [query, setQuery] = useState("");
  const visibleOpenTodos = useMemo(() => props.openTodos.filter((todo) => matchesTodo(todo, sourceFilter, query)), [props.openTodos, sourceFilter, query]);
  const visibleOpenGroups = useMemo(
    () => projectTodoGroups(visibleOpenTodos, props.locale).map((group) => ({ ...group, chains: projectTaskChains(group.todos) })),
    [visibleOpenTodos, props.locale]
  );
  const orderedVisibleOpenTodos = useMemo(() => visibleOpenGroups.flatMap((group) => group.chains.map((chain) => chain.todo)), [visibleOpenGroups]);
  const selectedTodo = orderedVisibleOpenTodos.find((todo) => todo.id === selectedTodoId) ?? orderedVisibleOpenTodos[0];

  useEffect(() => {
    if (!selectedTodo) return;
    if (selectedTodo.id !== selectedTodoId) setSelectedTodoId(selectedTodo.id);
  }, [selectedTodo?.id, selectedTodoId]);

  useEffect(() => {
    if (selectedTodoId && selectedTodo?.id === selectedTodoId) props.onSelectTodo(selectedTodo);
  }, [selectedTodoId, selectedTodo?.id]);

  if (props.openTodos.length === 0 && props.closedTodos.length === 0) {
    return (
      <Card className="flex min-h-80 flex-col items-center justify-center p-6 text-center">
        <Sparkles className="h-10 w-10 text-[var(--app-subtle)]" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-semibold text-[var(--app-ink)]">{text.noCards}</h2>
        <p className="mt-1 max-w-md text-sm text-[var(--app-muted)]">{text.noCardsDescription}</p>
        <Button aria-label={text.organizeEmpty} title={text.organizeEmpty} className="mt-4" onClick={props.onOrganize} disabled={props.busy}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {text.organize}
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.46fr)]">
        <div className="min-w-0">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <Inbox className="h-8 w-8 text-[var(--app-ink)]" aria-hidden="true" />
                <h1 className="text-3xl font-semibold tracking-normal text-[var(--app-ink)]">{text.actionInbox}</h1>
              </div>
              <p className="mt-2 max-w-2xl text-sm text-[var(--app-muted)]">{text.appSubtitle}</p>
            </div>
            <div className="grid grid-cols-3 gap-3 sm:min-w-[540px]">
              <MetricCard label={text.open} value={props.openTodos.length} tone="blue" />
              <MetricCard label={text.needsReview} value={visibleOpenTodos.length} tone="amber" />
              <MetricCard label={text.sources} value={countLinkedSources(props.openTodos)} tone="green" />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.46fr)] xl:items-start">
        <div className="min-w-0 space-y-3">
          <Card className="p-3">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 gap-2 overflow-x-auto app-scroll" aria-label={text.sourceFilter}>
                {(["all", "codex", "claude-code", "browser"] as const).map((filter) => (
                  <button
                    key={filter}
                    type="button"
                    className={cn(
                      "inline-flex min-h-10 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium transition active:translate-y-px",
                      sourceFilter === filter ? "border-[var(--app-accent)] bg-white text-[var(--app-accent)]" : "border-[var(--app-border)] bg-white text-[var(--app-muted)] hover:text-[var(--app-ink)]"
                    )}
                    aria-pressed={sourceFilter === filter}
                    onClick={() => setSourceFilter(filter)}
                  >
                    {filter !== "all" && <SourceIcon source={filter} />}
                    {filter === "all" ? text.all : sourceLabel(filter, props.locale)}
                  </button>
                ))}
              </div>
              <label className="relative block min-w-0 lg:w-[32rem]">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-subtle)]" aria-hidden="true" />
                <Input aria-label={text.searchCards} placeholder={text.searchCards} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
              </label>
            </div>
          </Card>

          {visibleOpenTodos.length === 0 && <Card className="p-6 text-sm text-[var(--app-muted)]">{text.noCardsMatch}</Card>}
          {visibleOpenGroups.map((group) => {
            const expanded = expandedOpenGroups[group.key] ?? false;
            const visibleChains = expanded ? group.chains : group.chains.slice(0, OPEN_GROUP_PREVIEW_LIMIT);
            const hiddenCount = group.chains.length - visibleChains.length;
            return (
              <section key={group.key} className="space-y-2">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-2 text-left transition hover:bg-white/60"
                  aria-expanded={expanded}
                  onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: !expanded }))}
                >
                  <span className="min-w-0">
                    <h2 className="text-sm font-semibold text-[var(--app-muted)]">{group.label}</h2>
                    <span className="block truncate text-xs text-[var(--app-subtle)]">{projectSourceSummary(group.todos, props.locale)}</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <Badge>{group.todos.length}</Badge>
                    <ChevronDown className={cn("h-4 w-4 text-[var(--app-subtle)] transition", expanded && "rotate-180")} aria-hidden="true" />
                  </span>
                </button>
                <div className="space-y-2">
                  {visibleChains.map((chain) => (
                    <TaskChainContainer
                      key={chain.key}
                      todo={chain.todo}
                      locale={props.locale}
                      selected={selectedTodo?.id === chain.todo.id}
                      onSelect={() => setSelectedTodoId(chain.todo.id)}
                      onComplete={props.onComplete}
                      onIgnore={props.onIgnore}
                      onSources={props.onSources}
                    />
                  ))}
                  {hiddenCount > 0 && (
                    <Button variant="secondary" className="w-full" onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: true }))}>
                      {text.showMore(hiddenCount)}
                    </Button>
                  )}
                </div>
              </section>
            );
          })}
          {props.closedTodos.length > 0 && (
            <section className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)]">
              <button className="flex w-full items-center justify-between gap-3 bg-[var(--app-surface-muted)] px-3 py-2 text-left text-sm font-semibold text-[var(--app-muted)] transition hover:bg-white" type="button" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
                {text.completedIgnored}
                <span className="inline-flex items-center gap-2 text-xs font-medium text-[var(--app-subtle)]">
                  {props.closedTodos.length}
                  <ChevronDown className={cn("h-4 w-4 transition", showClosed && "rotate-180")} aria-hidden="true" />
                </span>
              </button>
              {showClosed && (
                <div className="space-y-2 border-t border-[var(--app-border)] bg-[var(--app-bg)] p-2">
                  {sortTodosByEventTime(props.closedTodos).map((todo) => (
                    <TodoItem key={todo.id} todo={todo} locale={props.locale} onComplete={props.onComplete} onIgnore={props.onIgnore} onSources={props.onSources} muted />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        <TodoInspector
          todo={selectedTodo}
          evidence={selectedTodo ? props.evidenceByTodo[selectedTodo.id] : undefined}
          evidenceError={selectedTodo ? props.evidenceErrorsByTodo[selectedTodo.id] : ""}
          locale={props.locale}
          onSources={props.onSources}
        />
      </div>
    </div>
  );
}

function projectTodoGroups(todos: TodoCard[], locale: Locale): Array<{ key: string; label: string; todos: TodoCard[] }> {
  const text = textFor(locale);
  const groups = new Map<string, { key: string; label: string; todos: TodoCard[] }>();
  for (const todo of todos) {
    const key = `project:${todo.origin?.projectPath || todo.origin?.projectTitle || "unknown"}`;
    const label = todo.origin?.projectTitle || text.unknownProject;
    const group = groups.get(key) ?? { key, label, todos: [] };
    group.todos.push(todo);
    groups.set(key, group);
  }
  return [...groups.values()].sort((first, second) => latestTodoTime(second.todos) - latestTodoTime(first.todos));
}

function projectSourceSummary(todos: TodoCard[], locale: Locale): string {
  const sources = [...new Set(todos.map((todo) => todo.origin?.source).filter((source): source is NonNullable<TodoCard["origin"]>["source"] => Boolean(source)))];
  const sourceText = sources.map((source) => sourceLabel(source, locale)).join(" / ") || textFor(locale).sourceUnavailable;
  return `${sourceText} · ${textFor(locale).openCount(todos.length)}`;
}

function projectTaskChains(todos: TodoCard[]): Array<{ key: string; todo: TodoCard }> {
  return sortTodosByEventTime(todos).map((todo) => ({
    key: todo.chain?.id ? `${todo.chain.id}:${todo.id}` : todo.id,
    todo
  }));
}

function latestTodoTime(todos: TodoCard[]): number {
  return Math.max(...todos.map((todo) => Date.parse(todoEventTime(todo))));
}

function TaskChainContainer({ todo, locale, selected, onSelect, onComplete, onIgnore, onSources }: {
  todo: TodoCard;
  locale: Locale;
  selected: boolean;
  onSelect: () => void;
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
}) {
  const text = textFor(locale);
  const completedNodes = todo.chain?.completedNodes ?? [];
  return (
    <section className={cn("overflow-hidden rounded-lg border bg-white transition", selected ? "border-[var(--app-accent)] bg-[var(--app-surface-selected)] shadow-[inset_4px_0_0_var(--app-accent)]" : "border-[var(--app-border)] hover:border-[var(--app-border-strong)]")}>
      <TodoItem todo={todo} locale={locale} onComplete={onComplete} onIgnore={onIgnore} onSources={onSources} onSelect={onSelect} compactStatus selected={selected} />
      {completedNodes.length > 0 && (
        <details className="border-t border-[var(--app-border)] px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium text-[var(--app-ink)]">{text.completedChainSteps(todo.chain?.completedNodeCount ?? completedNodes.length)}</summary>
          <ol className="mt-3 space-y-3">
            {completedNodes.map((node) => (
              <li key={node.id} className="border-l-2 border-slate-300 pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-[var(--app-ink)]">{node.title}</span>
                  <Badge>{node.owner}</Badge>
                </div>
                {node.summary && <p className="mt-1 break-words leading-6 text-[var(--app-muted)]">{node.summary}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function TodoItem({ todo, muted, compactStatus, selected, locale, onSelect, onComplete, onIgnore, onSources }: {
  todo: TodoCard;
  muted?: boolean;
  compactStatus?: boolean;
  selected?: boolean;
  locale: Locale;
  onSelect?: () => void;
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
}) {
  const text = textFor(locale);
  const eventTime = todoEventTime(todo);
  const eventTitle = new Date(eventTime).toLocaleString();
  const progress = todoProgress(todo);
  const confidence = todoConfidence(todo);
  return (
    <Card className={cn("relative overflow-hidden border-0 p-4 shadow-none", selected && "bg-transparent", muted && "opacity-70")}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_12rem] lg:items-center">
        <button type="button" className="grid min-w-0 grid-cols-[2.75rem_minmax(0,1fr)] gap-3 text-left disabled:cursor-default" disabled={!onSelect} onClick={onSelect}>
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-blue-50 text-[var(--app-accent)]">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {!compactStatus && <Badge className={todo.status === "todo" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-green-200 bg-green-50 text-green-700"}>{todo.status === "todo" ? text.open : todo.status === "done" ? text.done : text.ignored}</Badge>}
            {confidence && <Badge className={confidence.tone}>{text.confidenceLabel(confidence.value)}</Badge>}
            {warningBadge(todo, locale)}
          </div>
          <h3 className="break-words text-base font-semibold leading-6 tracking-normal text-[var(--app-ink)] sm:text-lg">{todo.title}</h3>
          <p className="todo-description break-words text-sm leading-6 text-[var(--app-muted)]">{todo.description}</p>
          <div className="todo-meta-row">
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md text-left text-xs font-medium text-[var(--app-muted)]" title={originLabel(todo, locale)}>
              <SourceIcon source={todo.origin?.source} />
              <span className="truncate">{originProjectLabel(todo, locale)}</span>
            </span>
            <time className="shrink-0 text-xs text-[var(--app-subtle)]" dateTime={eventTime} title={eventTitle}>{formatRelativeTime(todoEventTime(todo), locale)}</time>
            {progress && (
              <span className="inline-flex items-center gap-2 text-xs text-[var(--app-muted)]">
                {text.agent}: {progress.label}
                <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[var(--app-border)]">
                  <span className="block h-full rounded-full bg-[var(--app-accent)]" style={{ width: `${progress.percent}%` }} />
                </span>
              </span>
            )}
          </div>
          {todo.metadata.completionSummary && (
            <details className="rounded-md bg-[var(--app-surface-muted)] px-3 py-2 text-sm text-[var(--app-muted)]">
              <summary className="cursor-pointer font-medium text-[var(--app-ink)]">{text.agentProgress}</summary>
              <p className="mt-1 break-words leading-6">{todo.metadata.completionSummary}</p>
            </details>
          )}
        </div>
        </button>
        <div className="grid shrink-0 gap-2">
          <Button aria-label={text.completeTodo(todo.title)} variant="secondary" size="sm" onClick={() => onComplete(todo.id)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {text.complete}
          </Button>
          <Button aria-label={text.openTodoSources(todo.title)} variant="secondary" size="sm" onClick={() => onSources(todo)}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            {text.sources}
          </Button>
          <Button aria-label={text.ignoreTodo(todo.title)} variant="secondary" size="sm" onClick={() => onIgnore(todo.id)}>
            <Archive className="h-4 w-4" aria-hidden="true" />
            {text.ignore}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function sortTodosByEventTime(todos: TodoCard[]): TodoCard[] {
  return [...todos].sort((first, second) => Date.parse(todoEventTime(second)) - Date.parse(todoEventTime(first)));
}

function TodoInspector({ todo, evidence, evidenceError, locale, onSources }: {
  todo: TodoCard | undefined;
  evidence: TodoEvidence[] | undefined;
  evidenceError?: string;
  locale: Locale;
  onSources: (todo: TodoCard) => void;
}) {
  const text = textFor(locale);
  if (!todo) {
    return (
      <Card className="sticky top-24 p-5">
        <SectionTitle>{text.sources}</SectionTitle>
        <p className="mt-3 text-sm text-[var(--app-muted)]">{text.selectTodoCard}</p>
      </Card>
    );
  }
  const confidence = todoConfidence(todo);
  return (
    <aside className="sticky top-24 min-w-0">
      <Card className="overflow-hidden">
        <div className="space-y-3 border-b border-[var(--app-border)] p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-blue-50 text-[var(--app-accent)]">
              <FileText className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="break-words text-lg font-semibold leading-6 text-[var(--app-ink)]">{todo.title}</h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge>
                  <SourceIcon source={todo.origin?.source} />
                  {todo.origin?.source ? sourceLabel(todo.origin.source, locale) : text.sourceUnavailable}
                </Badge>
                <span className="text-xs text-[var(--app-subtle)]">{formatRelativeTime(todoEventTime(todo), locale)}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-5 p-5">
          <section>
            <h3 className="text-sm font-semibold text-[var(--app-ink)]">{text.evidence}</h3>
            <div className="mt-3 space-y-3">
              {evidenceError && <EvidenceMessage>{evidenceError}</EvidenceMessage>}
              {!evidenceError && !evidence && <EvidenceMessage>{text.loadingEvidence}</EvidenceMessage>}
              {!evidenceError && evidence?.length === 0 && <EvidenceMessage>{text.noEvidence}</EvidenceMessage>}
              {!evidenceError && evidence?.slice(0, 2).map((item) => (
                <blockquote key={item.id} className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm leading-6 text-[var(--app-muted)]">
                  <span className="text-xl leading-none text-[var(--app-subtle)]">“</span>
                  {item.text}
                </blockquote>
              ))}
            </div>
          </section>
          <section>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--app-ink)]">
              <Archive className="h-4 w-4 text-[var(--app-subtle)]" aria-hidden="true" />
              {text.attachments}
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {todo.evidenceIds.slice(0, 3).map((id, index) => (
                <Badge key={id} className="bg-white">
                  <FileText className="h-3.5 w-3.5" aria-hidden="true" />
                  {text.evidenceFile(index + 1)}
                </Badge>
              ))}
              {todo.evidenceIds.length === 0 && <span className="text-sm text-[var(--app-subtle)]">{text.sourceUnavailable}</span>}
            </div>
          </section>
          <section className="grid gap-3 sm:grid-cols-2">
            {confidence && (
              <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-3">
                <div className="text-xs text-[var(--app-subtle)]">{text.confidence}</div>
                <div className="mt-1 text-lg font-semibold text-[var(--app-ink)]">{confidence.value}%</div>
              </div>
            )}
            <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-3">
              <div className="text-xs text-[var(--app-subtle)]">{text.source}</div>
              <div className="mt-1 truncate text-sm font-semibold text-[var(--app-ink)]">{todo.origin?.sessionTitle || text.temporarySession}</div>
            </div>
          </section>
          <Button className="w-full" onClick={() => onSources(todo)} aria-label={text.openTodoSources(todo.title)}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            {text.openSources}
          </Button>
        </div>
      </Card>
    </aside>
  );
}

function EvidenceMessage({ children }: { children: string }) {
  return <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-muted)]">{children}</div>;
}

function MetricCard({ label, value, tone }: { label: string; value: number; tone: "blue" | "amber" | "green" }) {
  const toneClass = tone === "blue" ? "text-[var(--app-accent)]" : tone === "amber" ? "text-[var(--app-amber)]" : "text-[var(--app-green)]";
  return (
    <div className="rounded-lg border border-[var(--app-border)] bg-white px-4 py-3">
      <div className="text-sm text-[var(--app-subtle)]">{label}</div>
      <div className={cn("mt-1 text-2xl font-semibold leading-none", toneClass)}>{value}</div>
    </div>
  );
}

function matchesTodo(todo: TodoCard, sourceFilter: TodoSourceFilter, query: string): boolean {
  if (sourceFilter !== "all" && todo.origin?.source !== sourceFilter) return false;
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [todo.title, todo.description, todo.metadata.completionSummary, todo.chain?.title, todo.chain?.summary, todo.origin?.projectTitle]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalized));
}

function countLinkedSources(todos: TodoCard[]): number {
  return new Set(todos.map((todo) => todo.origin?.sessionId).filter(Boolean)).size;
}

function todoProgress(todo: TodoCard): { label: string; percent: number } | null {
  if (!todo.chain) return null;
  const total = todo.chain.completedNodeCount + 1;
  const percent = Math.min(100, Math.round((todo.chain.completedNodeCount / total) * 100));
  return { label: `${todo.chain.completedNodeCount}/${total}`, percent };
}

function todoConfidence(todo: TodoCard): { value: number; tone: string } | null {
  const raw = todo.metadata.completionState?.match(/(\d{1,3})(?:%|\/100)?/u)?.[1];
  const value = raw ? Math.min(100, Number(raw)) : Math.max(45, Math.min(92, 60 + todo.evidenceIds.length * 9));
  const tone = value < 55 ? "border-amber-200 bg-amber-50 text-amber-700" : "border-green-200 bg-green-50 text-green-700";
  return { value, tone };
}

function warningBadge(todo: TodoCard, locale: Locale) {
  const text = textFor(locale);
  if (!todo.origin) return <Badge className="border-amber-200 bg-amber-50 text-amber-700">{text.missingSource}</Badge>;
  const confidence = todoConfidence(todo);
  if (confidence && confidence.value < 55) return <Badge className="border-amber-200 bg-amber-50 text-amber-700">{text.lowConfidence}</Badge>;
  return null;
}

function todoEventTime(todo: TodoCard): string {
  return todo.origin?.eventCreatedAt ?? todo.updatedAt;
}

function formatRelativeTime(value: string, locale: Locale): string {
  const text = textFor(locale);
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return text.happenedNow;
  const elapsedMinutes = Math.floor(elapsedMs / 60_000);
  if (elapsedMinutes < 60) return text.happenedAgo(text.timeMinute(elapsedMinutes));
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return text.happenedAgo(text.timeHour(elapsedHours));
  return text.happenedAgo(text.timeDay(Math.floor(elapsedHours / 24)));
}
