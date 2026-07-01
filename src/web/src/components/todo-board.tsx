import { Archive, CheckCircle2, ChevronDown, Eye, FileText, Inbox, Search, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { sourceLabel, textFor, type Locale } from "../i18n.js";
import { cn } from "../lib/utils.js";
import type { SourceKind, TodoCard, TodoEvidence, TodoEvidenceContext } from "../types.js";
import { MarkdownText } from "./observation-text.js";
import { Badge, Button, Card, Input, SectionTitle } from "./ui.js";
import { originLabel, originProjectLabel, SourceIcon } from "./source-labels.js";

const OPEN_GROUP_PREVIEW_LIMIT = 6;
const OPEN_GROUP_INITIAL_LIMIT = 3;
const DEFAULT_EXPANDED_GROUP_LIMIT = 2;
const PROJECT_CHIP_LIMIT = 4;
type TodoSourceFilter = "all" | SourceKind;
type SourceTarget = Pick<TodoEvidence, "sessionId" | "observationId">;
type GroupMode = "collapsed" | "preview" | "full";

export function TodoBoard(props: {
  openTodos: TodoCard[];
  closedTodos: TodoCard[];
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard, target?: SourceTarget) => void;
  evidenceByTodo: Record<string, TodoEvidence[]>;
  evidenceErrorsByTodo: Record<string, string>;
  onSelectTodo: (todo: TodoCard) => void;
  onOrganize: () => void;
  busy: boolean;
  locale: Locale;
}) {
  const text = textFor(props.locale);
  const [showClosed, setShowClosed] = useState(false);
  const [groupModes, setGroupModes] = useState<Record<string, GroupMode>>({});
  const [selectedTodoId, setSelectedTodoId] = useState("");
  const [sourceFilter, setSourceFilter] = useState<TodoSourceFilter>("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const projectOptions = useMemo(() => projectTodoGroups(props.openTodos, props.locale), [props.openTodos, props.locale]);
  const projectChipOptions = useMemo(() => visibleProjectChips(projectOptions, projectFilter), [projectOptions, projectFilter]);
  const moreProjectOptions = useMemo(() => projectOptions.filter((project) => !projectChipOptions.some((visible) => visible.key === project.key)), [projectOptions, projectChipOptions]);
  const visibleOpenTodos = useMemo(() => props.openTodos.filter((todo) => matchesTodo(todo, sourceFilter, projectFilter, query)), [props.openTodos, sourceFilter, projectFilter, query]);
  const visibleOpenGroups = useMemo(
    () => projectTodoGroups(visibleOpenTodos, props.locale).map((group) => ({ ...group, chains: projectTaskChains(group.todos) })),
    [visibleOpenTodos, props.locale]
  );
  const orderedVisibleOpenTodos = useMemo(() => visibleOpenGroups.flatMap((group) => group.chains.map((chain) => chain.todo)), [visibleOpenGroups]);
  const selectedTodo = orderedVisibleOpenTodos.find((todo) => todo.id === selectedTodoId) ?? orderedVisibleOpenTodos[0];

  useEffect(() => {
    if (projectFilter !== "all" && !projectOptions.some((project) => project.key === projectFilter)) setProjectFilter("all");
  }, [projectFilter, projectOptions]);

  useEffect(() => {
    if (moreProjectOptions.length === 0 && projectMenuOpen) setProjectMenuOpen(false);
  }, [moreProjectOptions.length, projectMenuOpen]);

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
            <div className="space-y-3">
              <label className="relative block min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-subtle)]" aria-hidden="true" />
                <Input aria-label={text.searchCards} placeholder={text.searchCards} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
              </label>
              <div className="grid gap-2 xl:grid-cols-[auto_minmax(0,1fr)] xl:items-center">
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
                <div className="flex min-w-0 items-center gap-2 overflow-x-auto app-scroll" aria-label={text.projectFilter}>
                  <ProjectChip active={projectFilter === "all"} label={text.allProjects} count={props.openTodos.length} onClick={() => setProjectFilter("all")} />
                  {projectChipOptions.map((project) => (
                    <ProjectChip key={project.key} active={projectFilter === project.key} label={project.label} count={project.todos.length} onClick={() => setProjectFilter(project.key)} />
                  ))}
                  {moreProjectOptions.length > 0 && (
                    <div className="relative shrink-0" onBlur={(event) => {
                      if (!event.currentTarget.contains(event.relatedTarget)) setProjectMenuOpen(false);
                    }}>
                      <button
                        type="button"
                        className={cn(
                          "inline-flex min-h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium transition active:translate-y-px",
                          projectMenuOpen ? "border-[var(--app-accent)] bg-white text-[var(--app-accent)]" : "border-[var(--app-border)] bg-white text-[var(--app-muted)] hover:text-[var(--app-ink)]"
                        )}
                        aria-haspopup="menu"
                        aria-expanded={projectMenuOpen}
                        onClick={() => setProjectMenuOpen((open) => !open)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setProjectMenuOpen(false);
                        }}
                      >
                        {text.moreProjects}
                        <Badge className="bg-white">{moreProjectOptions.length}</Badge>
                        <ChevronDown className={cn("h-4 w-4 text-[var(--app-subtle)] transition", projectMenuOpen && "rotate-180")} aria-hidden="true" />
                      </button>
                      {projectMenuOpen && (
                        <div className="absolute left-0 z-20 mt-2 max-h-72 w-72 overflow-y-auto rounded-lg border border-[var(--app-border)] bg-white p-1 shadow-lg" role="menu">
                          {moreProjectOptions.map((project) => (
                            <button
                              key={project.key}
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm text-[var(--app-ink)] hover:bg-[var(--app-surface-muted)]"
                              onClick={() => {
                                setProjectFilter(project.key);
                                setProjectMenuOpen(false);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Escape") setProjectMenuOpen(false);
                              }}
                            >
                              <span className="min-w-0 truncate">{project.label}</span>
                              <Badge className="bg-white">{project.todos.length}</Badge>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </Card>

          {visibleOpenTodos.length === 0 && <Card className="p-6 text-sm text-[var(--app-muted)]">{text.noCardsMatch}</Card>}
          {visibleOpenGroups.map((group) => {
            const mode = groupModes[group.key] ?? defaultGroupMode(group, visibleOpenGroups, projectFilter, sourceFilter, query);
            const visibleChains = mode === "full"
              ? group.chains.slice(0, OPEN_GROUP_PREVIEW_LIMIT)
              : mode === "preview"
                ? group.chains.slice(0, OPEN_GROUP_INITIAL_LIMIT)
                : [];
            const hiddenCount = group.chains.length - visibleChains.length;
            return (
              <section key={group.key} className="space-y-2">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-lg px-1 py-2 text-left transition hover:bg-white/60"
                  aria-expanded={mode !== "collapsed"}
                  onClick={() => setGroupModes((current) => ({ ...current, [group.key]: mode === "collapsed" ? "preview" : "collapsed" }))}
                >
                  <span className="min-w-0">
                    <h2 className="text-sm font-semibold text-[var(--app-muted)]">{group.label}</h2>
                    <span className="block truncate text-xs text-[var(--app-subtle)]">{projectSourceSummary(group.todos, props.locale)}</span>
                  </span>
                  <span className="inline-flex items-center gap-2">
                    <Badge>{group.todos.length}</Badge>
                    <ChevronDown className={cn("h-4 w-4 text-[var(--app-subtle)] transition", mode !== "collapsed" && "rotate-180")} aria-hidden="true" />
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
                  {hiddenCount > 0 && mode !== "collapsed" && (
                    <Button variant="secondary" className="w-full" onClick={() => setGroupModes((current) => ({ ...current, [group.key]: "full" }))}>
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
    const key = todoProjectKey(todo);
    const label = todo.origin?.projectTitle || text.unknownProject;
    const group = groups.get(key) ?? { key, label, todos: [] };
    group.todos.push(todo);
    groups.set(key, group);
  }
  return [...groups.values()].sort((first, second) => latestTodoTime(second.todos) - latestTodoTime(first.todos));
}

function visibleProjectChips<T extends { key: string }>(projects: T[], selectedKey: string): T[] {
  const visible = projects.slice(0, PROJECT_CHIP_LIMIT);
  if (selectedKey === "all" || visible.some((project) => project.key === selectedKey)) return visible;
  const selected = projects.find((project) => project.key === selectedKey);
  return selected ? [selected, ...visible.slice(0, PROJECT_CHIP_LIMIT - 1)] : visible;
}

function defaultGroupMode(
  group: { key: string },
  groups: Array<{ key: string }>,
  projectFilter: string,
  sourceFilter: TodoSourceFilter,
  query: string
): GroupMode {
  if (projectFilter !== "all" || sourceFilter !== "all" || query.trim()) return "preview";
  return groups.findIndex((item) => item.key === group.key) < DEFAULT_EXPANDED_GROUP_LIMIT ? "preview" : "collapsed";
}

function ProjectChip({ active, label, count, onClick }: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex min-h-10 max-w-52 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium transition active:translate-y-px",
        active ? "border-[var(--app-accent)] bg-white text-[var(--app-accent)]" : "border-[var(--app-border)] bg-white text-[var(--app-muted)] hover:text-[var(--app-ink)]"
      )}
      aria-pressed={active}
      onClick={onClick}
      title={label}
    >
      <span className="min-w-0 truncate">{label}</span>
      <Badge className="bg-white">{count}</Badge>
    </button>
  );
}

function todoProjectKey(todo: TodoCard): string {
  return `project:${todo.origin?.projectPath || todo.origin?.projectTitle || "unknown"}`;
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
  onSources: (todo: TodoCard, target?: SourceTarget) => void;
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
  onSources: (todo: TodoCard, target?: SourceTarget) => void;
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
  onSources: (todo: TodoCard, target?: SourceTarget) => void;
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
                {confidence && <Badge className={confidence.tone}>{text.confidenceLabel(confidence.value)}</Badge>}
                <span className="text-xs text-[var(--app-subtle)]">{formatRelativeTime(todoEventTime(todo), locale)}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="space-y-5 p-5">
          <section>
            <h3 className="text-sm font-semibold text-[var(--app-ink)]">{text.contextEvidence}</h3>
            <div className="mt-3 space-y-3">
              {evidenceError && <EvidenceMessage>{evidenceError}</EvidenceMessage>}
              {!evidenceError && !evidence && <EvidenceMessage>{text.loadingEvidence}</EvidenceMessage>}
              {!evidenceError && evidence?.length === 0 && <EvidenceMessage>{text.noEvidence}</EvidenceMessage>}
              {!evidenceError && evidence?.slice(0, 2).map((item) => (
                <EvidenceItem key={item.id} item={item} todo={todo} locale={locale} onSources={onSources} />
              ))}
            </div>
          </section>
          {(!evidence || evidence.length === 0 || evidenceError) && (
            <Button className="w-full" onClick={() => onSources(todo)} aria-label={text.openTodoSources(todo.title)}>
              <Eye className="h-4 w-4" aria-hidden="true" />
              {text.openSources}
            </Button>
          )}
        </div>
      </Card>
    </aside>
  );
}

function EvidenceMessage({ children }: { children: string }) {
  return <div className="rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-muted)]">{children}</div>;
}

function EvidenceItem({ item, todo, locale, onSources }: {
  item: TodoEvidence;
  todo: TodoCard;
  locale: Locale;
  onSources: (todo: TodoCard, target?: SourceTarget) => void;
}) {
  const text = textFor(locale);
  const rows = evidenceRows(item);
  return (
    <details className="group rounded-lg border border-[var(--app-border)] bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-muted)]">
      <summary className="cursor-pointer list-none">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge className="bg-white">
            <SourceIcon source={item.source ?? todo.origin?.source} />
            {item.source ? sourceLabel(item.source, locale) : text.sourceUnavailable}
          </Badge>
          <Badge className="bg-white">{roleLabel(item.role, locale)}</Badge>
          <time className="text-xs text-[var(--app-subtle)]" dateTime={item.createdAt ?? todoEventTime(todo)} title={new Date(item.createdAt ?? todoEventTime(todo)).toLocaleString()}>
            {formatRelativeTime(item.createdAt ?? todoEventTime(todo), locale)}
          </time>
          <ChevronDown className="ml-auto h-4 w-4 text-[var(--app-subtle)] transition group-open:rotate-180" aria-hidden="true" />
        </div>
        <div className="mt-2 min-w-0 break-words text-xs font-medium text-[var(--app-ink)]">
          {item.projectTitle || todo.origin?.projectTitle || text.unknownProject}
        </div>
        <div className="mt-1 min-w-0 break-words text-xs text-[var(--app-subtle)]">
          {item.sessionTitle || todo.origin?.sessionTitle || text.temporarySession}
        </div>
        <p className="mt-2 line-clamp-3 min-w-0 break-words leading-6">{evidencePreview(item.text)}</p>
      </summary>
      <div className="mt-4 max-h-96 space-y-3 overflow-y-auto pr-1 app-scroll">
        {rows.map((row) => (
          <EvidenceContextRow key={row.observationId} row={row} locale={locale} active={row.observationId === item.observationId} />
        ))}
      </div>
      <Button className="mt-3 w-full" variant="secondary" size="sm" onClick={() => onSources(todo, item)} aria-label={text.openTodoSources(todo.title)}>
        <Eye className="h-4 w-4" aria-hidden="true" />
        {text.openEvidenceSource}
      </Button>
    </details>
  );
}

function EvidenceContextRow({ row, locale, active }: {
  row: TodoEvidenceContext;
  locale: Locale;
  active: boolean;
}) {
  const createdAt = row.createdAt || new Date(0).toISOString();
  return (
    <article className={cn("rounded-md border bg-white p-3", active ? "border-[var(--app-border-strong)]" : "border-[var(--app-border)]")}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge className="bg-[var(--app-surface-muted)]">{roleLabel(row.role, locale)}</Badge>
        {row.createdAt && (
          <time className="text-xs text-[var(--app-subtle)]" dateTime={row.createdAt} title={new Date(row.createdAt).toLocaleString()}>
            {formatRelativeTime(createdAt, locale)}
          </time>
        )}
      </div>
      <MarkdownText text={row.text} markdown={row.role === "assistant" || row.role === "user"} />
    </article>
  );
}

function evidenceRows(item: TodoEvidence): TodoEvidenceContext[] {
  if (item.context?.length) return item.context;
  return [{
    observationId: item.observationId,
    role: item.role,
    createdAt: item.createdAt,
    text: item.text
  }];
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

function matchesTodo(todo: TodoCard, sourceFilter: TodoSourceFilter, projectFilter: string, query: string): boolean {
  if (sourceFilter !== "all" && todo.origin?.source !== sourceFilter) return false;
  if (projectFilter !== "all" && todoProjectKey(todo) !== projectFilter) return false;
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

function evidencePreview(text: string): string {
  const value = text.trim();
  return value.length > 220 ? `${value.slice(0, 220)}...` : value;
}

function roleLabel(role: string | undefined, locale: Locale): string {
  if (locale === "zh-CN") {
    if (role === "user") return "用户";
    if (role === "assistant") return "助手";
    if (role === "system") return "系统";
  }
  return role || "source";
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
