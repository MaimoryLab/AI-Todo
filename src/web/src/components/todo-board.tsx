import { Archive, CheckCircle2, ChevronDown, Eye, Sparkles } from "lucide-react";
import { useState } from "react";
import { textFor, type Locale } from "../i18n.js";
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
        <Sparkles className="h-10 w-10 text-neutral-400" aria-hidden="true" />
        <h2 className="mt-3 text-lg font-semibold">{text.noCards}</h2>
        <p className="mt-1 max-w-md text-sm text-neutral-600">{text.noCardsDescription}</p>
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
        <div>
          <SectionTitle>{text.todos}</SectionTitle>
          <h2 className="text-xl font-semibold tracking-normal">{text.openLoopsTitle}</h2>
          <p className="mt-1 text-sm text-neutral-600">{text.openLoopsDescription}</p>
        </div>
        <Badge className="self-start border-blue-200 bg-blue-50 text-blue-700">{text.openCount(props.openTodos.length)}</Badge>
      </div>
      {todoGroups(props.openTodos, props.locale).map((group) => {
        const expanded = expandedOpenGroups[group.key] ?? false;
        const sortedTodos = sortTodosByEventTime(group.todos);
        const visibleTodos = expanded ? sortedTodos : sortedTodos.slice(0, OPEN_GROUP_PREVIEW_LIMIT);
        const hiddenCount = group.todos.length - visibleTodos.length;
        return (
          <section key={group.key} className="overflow-hidden rounded-lg border border-neutral-200 bg-white">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-3 border-b border-neutral-100 bg-neutral-50/70 px-3 py-2 text-left"
              aria-expanded={expanded}
              onClick={() => setExpandedOpenGroups((current) => ({ ...current, [group.key]: !expanded }))}
            >
              <span className="min-w-0">
                <h3 className="text-sm font-semibold text-neutral-800">{group.label}</h3>
                <span className="block truncate text-xs text-neutral-500">{group.description}</span>
              </span>
              <span className="inline-flex items-center gap-2">
                <Badge className={group.badgeClass}>{group.todos.length}</Badge>
                <ChevronDown className={cn("h-4 w-4 text-neutral-500 transition", expanded && "rotate-180")} aria-hidden="true" />
              </span>
            </button>
            <div className="divide-y divide-neutral-100">
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
        <section className="rounded-lg border border-neutral-200 bg-white p-3">
          <button className="flex w-full items-center justify-between gap-3 text-left text-sm font-semibold text-neutral-700" type="button" aria-expanded={showClosed} onClick={() => setShowClosed(!showClosed)}>
            {text.completedIgnored}
            <span className="inline-flex items-center gap-2 text-xs font-medium text-neutral-500">
              {props.closedTodos.length}
              <ChevronDown className={cn("h-4 w-4 transition", showClosed && "rotate-180")} aria-hidden="true" />
            </span>
          </button>
          {showClosed && (
            <div className="mt-3 space-y-3">
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

function todoGroups(todos: TodoCard[], locale: Locale): Array<{ key: string; label: string; description: string; badgeClass: string; todos: TodoCard[] }> {
  const text = textFor(locale);
  const groups = [
    { key: "blocked", label: text.blocked, description: text.blockedDescription, badgeClass: "border-red-200 bg-red-50 text-red-700", todos: [] as TodoCard[] },
    { key: "in_progress", label: text.inProgress, description: text.inProgressDescription, badgeClass: "border-blue-200 bg-blue-50 text-blue-700", todos: [] as TodoCard[] },
    { key: "needs_review", label: text.needsReview, description: text.needsReviewDescription, badgeClass: "border-amber-200 bg-amber-50 text-amber-700", todos: [] as TodoCard[] }
  ];
  for (const todo of todos) {
    const state = todo.metadata.completionState?.toLowerCase().replace(/\s+/g, "_");
    const target = groups.find((group) => group.key === state) ?? groups[2];
    target.todos.push(todo);
  }
  return groups.filter((group) => group.todos.length > 0);
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
    <Card className={cn("relative overflow-hidden rounded-none border-0 border-b border-neutral-100 p-4 shadow-none last:border-b-0", muted && "opacity-70")}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          {!compactStatus && (
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={todo.status === "todo" ? "border-blue-200 bg-blue-50 text-blue-700" : "border-green-200 bg-green-50 text-green-700"}>{todo.status === "todo" ? text.open : todo.status === "done" ? text.done : text.ignored}</Badge>
              {todo.metadata.completionState && <Badge>{todo.metadata.completionState}</Badge>}
            </div>
          )}
          <h3 className="break-words text-lg font-semibold tracking-normal">{todo.title}</h3>
          <p className="todo-description break-words text-sm leading-6 text-neutral-700">{todo.description}</p>
          <div className="todo-meta-row">
            <button aria-label={text.openSourceSession(todo.title)} className="inline-flex min-w-0 items-center gap-1.5 rounded-md text-left text-xs font-medium text-neutral-600 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-70" type="button" title={originLabel(todo, locale)} disabled={!todo.origin} onClick={() => onSources(todo)}>
              <SourceIcon source={todo.origin?.source} />
              <span className="truncate">{originProjectLabel(todo, locale)}</span>
            </button>
            <time className="shrink-0 text-xs text-neutral-500" dateTime={eventTime} title={eventTitle}>{formatRelativeTime(todoEventTime(todo), locale)}</time>
          </div>
          {todo.metadata.completionSummary && (
            <details className="text-sm text-neutral-500">
              <summary className="cursor-pointer font-medium text-neutral-600">{text.agentProgress}</summary>
              <p className="mt-1 break-words">{todo.metadata.completionSummary}</p>
            </details>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 sm:justify-end">
          <Button aria-label={text.completeTodo(todo.title)} variant="secondary" onClick={() => onComplete(todo.id)}>
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            {text.complete}
          </Button>
          <Button aria-label={text.openTodoSources(todo.title)} variant="secondary" onClick={() => onSources(todo)}>
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
