import { Archive, CheckCircle2, ChevronDown, Eye, Sparkles } from "lucide-react";
import { useState } from "react";
import { sourceLabel, textFor, type Locale } from "../i18n.js";
import { cn } from "../lib/utils.js";
import type { TodoCard } from "../types.js";
import { Badge, Button, Card, IconButton, SectionTitle } from "./ui.js";
import { originLabel, originProjectLabel, SourceIcon } from "./source-labels.js";

const OPEN_GROUP_PREVIEW_LIMIT = 6;

export function TodoBoard(props: {
  openTodos: TodoCard[];
  closedTodos: TodoCard[];
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
  onOrganize: () => void;
  busy: boolean;
  locale: Locale;
}) {
  const text = textFor(props.locale);
  const [showClosed, setShowClosed] = useState(false);
  const [expandedOpenGroups, setExpandedOpenGroups] = useState<Record<string, boolean>>({});
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
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <SectionTitle>{text.todos}</SectionTitle>
          <h2 className="text-xl font-semibold tracking-normal text-[var(--app-ink)]">{text.openLoopsTitle}</h2>
          <p className="mt-1 max-w-3xl text-sm text-[var(--app-muted)]">{text.openLoopsDescription}</p>
        </div>
        <Badge className="self-start border-blue-200 bg-blue-50 text-blue-700">{text.openCount(props.openTodos.length)}</Badge>
      </div>
      {projectTodoGroups(props.openTodos, props.locale).map((group) => {
        const expanded = expandedOpenGroups[group.key] ?? false;
        const sortedTodos = sortTodosByEventTime(group.todos);
        const visibleTodos = expanded ? sortedTodos : sortedTodos.slice(0, OPEN_GROUP_PREVIEW_LIMIT);
        const hiddenCount = group.todos.length - visibleTodos.length;
        return (
          <section key={group.key} className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)]">
            <button
              type="button"
              className={cn("flex w-full items-center justify-between gap-3 border-b border-[var(--app-border)] px-3 py-2 text-left transition hover:bg-white", group.headerClass)}
              aria-expanded={expanded}
              onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: !expanded }))}
            >
              <span className="min-w-0">
                <h3 className="text-sm font-semibold text-[var(--app-ink)]">{group.label}</h3>
                <span className="block truncate text-xs text-[var(--app-muted)]">{projectSourceSummary(group.todos, props.locale)}</span>
              </span>
              <span className="inline-flex items-center gap-2">
                <Badge className={group.badgeClass}>{group.todos.length}</Badge>
                <ChevronDown className={cn("h-4 w-4 text-[var(--app-subtle)] transition", expanded && "rotate-180")} aria-hidden="true" />
              </span>
            </button>
            <div className="divide-y divide-[var(--app-border)]">
              {visibleTodos.map((todo) => (
                <TodoItem key={todo.id} todo={todo} locale={props.locale} onComplete={props.onComplete} onIgnore={props.onIgnore} onSources={props.onSources} compactStatus />
              ))}
              {hiddenCount > 0 && (
                <div className="p-3">
                  <Button variant="secondary" className="w-full" onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: true }))}>
                    {text.showMore(hiddenCount)}
                  </Button>
                </div>
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
            <div className="divide-y divide-[var(--app-border)] border-t border-[var(--app-border)]">
              {sortTodosByEventTime(props.closedTodos).map((todo) => (
                <TodoItem key={todo.id} todo={todo} locale={props.locale} onComplete={props.onComplete} onIgnore={props.onIgnore} onSources={props.onSources} muted />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function projectTodoGroups(todos: TodoCard[], locale: Locale): Array<{ key: string; label: string; badgeClass: string; headerClass: string; todos: TodoCard[] }> {
  const text = textFor(locale);
  const groups = new Map<string, { key: string; label: string; badgeClass: string; headerClass: string; todos: TodoCard[] }>();
  for (const todo of todos) {
    const key = `project:${todo.origin?.projectPath || todo.origin?.projectTitle || "unknown"}`;
    const label = todo.origin?.projectTitle || text.unknownProject;
    const group = groups.get(key) ?? { key, label, badgeClass: "border-blue-200 bg-blue-50 text-blue-700", headerClass: "bg-slate-50", todos: [] };
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

function latestTodoTime(todos: TodoCard[]): number {
  return Math.max(...todos.map((todo) => Date.parse(todoEventTime(todo))));
}

function TodoItem({ todo, muted, compactStatus, locale, onComplete, onIgnore, onSources }: {
  todo: TodoCard;
  muted?: boolean;
  compactStatus?: boolean;
  locale: Locale;
  onComplete: (id: string) => void;
  onIgnore: (id: string) => void;
  onSources: (todo: TodoCard) => void;
}) {
  const text = textFor(locale);
  const eventTime = todoEventTime(todo);
  const eventTitle = new Date(eventTime).toLocaleString();
  return (
    <Card className={cn("relative overflow-hidden rounded-none border-0 p-4 shadow-none", muted && "opacity-70")}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {!compactStatus && <Badge className={todo.status === "todo" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-green-200 bg-green-50 text-green-700"}>{todo.status === "todo" ? text.open : todo.status === "done" ? text.done : text.ignored}</Badge>}
            {todo.metadata.completionState && <Badge>{todo.metadata.completionState}</Badge>}
          </div>
          <h3 className="break-words text-base font-semibold leading-6 tracking-normal text-[var(--app-ink)] sm:text-lg">{todo.title}</h3>
          <p className="todo-description break-words text-sm leading-6 text-[var(--app-muted)]">{todo.description}</p>
          <div className="todo-meta-row">
            <button aria-label={text.openSourceSession(todo.title)} className="inline-flex min-w-0 items-center gap-1.5 rounded-md text-left text-xs font-medium text-[var(--app-muted)] transition hover:text-[var(--app-ink)] disabled:cursor-not-allowed disabled:opacity-70" type="button" title={originLabel(todo, locale)} disabled={!todo.origin} onClick={() => onSources(todo)}>
              <SourceIcon source={todo.origin?.source} />
              <span className="truncate">{originProjectLabel(todo, locale)}</span>
            </button>
            <time className="shrink-0 text-xs text-[var(--app-subtle)]" dateTime={eventTime} title={eventTitle}>{formatRelativeTime(todoEventTime(todo), locale)}</time>
          </div>
          {todo.metadata.completionSummary && (
            <details className="rounded-md bg-[var(--app-surface-muted)] px-3 py-2 text-sm text-[var(--app-muted)]">
              <summary className="cursor-pointer font-medium text-[var(--app-ink)]">{text.agentProgress}</summary>
              <p className="mt-1 break-words leading-6">{todo.metadata.completionSummary}</p>
            </details>
          )}
        </div>
        <div className="grid shrink-0 grid-cols-[1fr_1fr_auto] gap-2 lg:min-w-[17rem]">
          <Button aria-label={text.completeTodo(todo.title)} variant="secondary" size="sm" onClick={() => onComplete(todo.id)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {text.complete}
          </Button>
          <Button aria-label={text.openTodoSources(todo.title)} variant="secondary" size="sm" onClick={() => onSources(todo)}>
            <Eye className="h-4 w-4" aria-hidden="true" />
            {text.sources}
          </Button>
          <IconButton label={text.ignoreTodo(todo.title)} onClick={() => onIgnore(todo.id)}>
            <Archive className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>
    </Card>
  );
}

function sortTodosByEventTime(todos: TodoCard[]): TodoCard[] {
  return [...todos].sort((first, second) => Date.parse(todoEventTime(second)) - Date.parse(todoEventTime(first)));
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
