import { ChevronDown, FolderOpen, MessageSquareText, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { isAgentContextText, isTurnAbortedText } from "../../../agent-context.js";
import { sourceLabel, textFor, type Locale } from "../i18n.js";
import { cn } from "../lib/utils.js";
import type { ObservationRecord, SessionRecord, SourceSummary } from "../types.js";
import type { SourceFilter } from "../view-model.js";
import { ObservationText } from "./observation-text.js";
import { Badge, Button, Card, Input, SectionTitle, SegmentedFilter } from "./ui.js";
import { sessionProjectLabel, sourceCount, SourceIcon } from "./source-labels.js";

const OBSERVATION_PREVIEW_LIMIT = 12;

export function SourcesWorkspace({ sessions, sourceSummaries, sourceFilter, sessionOffset, observationsBySession, selectedSessionId, highlightedObservationId, locale, onFilter, onLoadMore, onSelect }: {
  sessions: SessionRecord[];
  sourceSummaries: SourceSummary[];
  sourceFilter: SourceFilter;
  sessionOffset: number;
  observationsBySession: Record<string, ObservationRecord[]>;
  selectedSessionId: string;
  highlightedObservationId: string;
  locale: Locale;
  onFilter: (filter: SourceFilter) => void;
  onLoadMore: () => void;
  onSelect: (sessionId: string) => void;
}) {
  const text = textFor(locale);
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [showAllMessages, setShowAllMessages] = useState(false);
  const autoExpandedGroupKeyRef = useRef("");
  const selected = sessions.find((session) => session.id === selectedSessionId) ?? (selectedSessionId ? undefined : sessions[0]);
  const observations = selected ? observationsBySession[selected.id] ?? [] : [];
  const visibleObservations = showAllMessages ? observations : observations.slice(0, OBSERVATION_PREVIEW_LIMIT);
  const totalSessions = sourceFilter === "all"
    ? sourceSummaries.reduce((sum, source) => sum + source.sessions, 0)
    : sourceSummaries.find((source) => source.source === sourceFilter)?.sessions ?? 0;
  const filters: SourceFilter[] = ["all", "codex", "claude-code", "browser"];
  const projectOptions = useMemo(() => sessionProjectOptions(sessions, locale), [sessions, locale]);
  const selectedProject = projectFilter === "all" ? undefined : projectOptions.find((project) => project.key === projectFilter);
  const projectMenuOptions = useMemo(() => filterProjects(projectOptions, projectQuery), [projectOptions, projectQuery]);
  const filteredSessions = sessions.filter((session) => matchesSessionQuery(session, query, locale) && matchesSessionProject(session, projectFilter, locale));
  const groups = sessionGroups(filteredSessions, locale);

  useEffect(() => {
    setShowAllMessages(false);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!highlightedObservationId || !observations.some((observation) => observation.id === highlightedObservationId)) return;
    if (!visibleObservations.some((observation) => observation.id === highlightedObservationId)) setShowAllMessages(true);
  }, [highlightedObservationId, observations, visibleObservations]);

  useEffect(() => {
    if (!selected) return;
    const autoExpandKey = `${selected.id}:${highlightedObservationId}`;
    if (autoExpandedGroupKeyRef.current === autoExpandKey) return;
    const group = groups.find((item) => item.sessions.some((session) => session.id === selected.id));
    if (!group) return;
    autoExpandedGroupKeyRef.current = autoExpandKey;
    setExpandedGroups((current) => current[group.key] ? current : { ...current, [group.key]: true });
  }, [selected?.id, highlightedObservationId, groups]);

  useEffect(() => {
    if (projectFilter !== "all" && !projectOptions.some((project) => project.key === projectFilter)) setProjectFilter("all");
  }, [projectFilter, projectOptions]);

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
      <Card className="min-w-0 overflow-hidden">
        <div className="border-b border-[var(--app-border)] bg-[var(--app-surface)] p-3">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-[var(--app-subtle)]" aria-hidden="true" />
            <SectionTitle>{text.sources}</SectionTitle>
          </div>
          <label className="relative mt-3 block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--app-subtle)]" aria-hidden="true" />
            <Input aria-label={text.searchSources} placeholder={text.searchSources} value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" />
          </label>
          <div className="mt-3 grid gap-2">
            <SegmentedFilter aria-label={text.sourceFilter}>
              {filters.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  className={cn(
                    "inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition active:translate-y-px",
                    sourceFilter === filter ? "bg-[var(--app-ink)] text-white" : "text-[var(--app-muted)] hover:bg-[var(--app-surface)] hover:text-[var(--app-ink)]"
                  )}
                  onClick={() => onFilter(filter)}
                >
                  {filter === "all" ? text.all : sourceLabel(filter, locale)}
                  <span>{sourceCount(sourceSummaries, filter)}</span>
                </button>
              ))}
            </SegmentedFilter>
            <div className="relative min-w-0" onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setProjectMenuOpen(false);
            }}>
              <button
                type="button"
                className={cn(
                  "inline-flex min-h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-white px-3 text-left text-sm font-medium transition active:translate-y-px",
                  projectMenuOpen ? "border-[var(--app-accent)] text-[var(--app-accent)]" : "border-[var(--app-border)] text-[var(--app-muted)] hover:text-[var(--app-ink)]"
                )}
                aria-haspopup="menu"
                aria-expanded={projectMenuOpen}
                aria-label={text.projectFilter}
                title={selectedProject?.label ?? text.allProjects}
                onClick={() => {
                  setProjectMenuOpen((open) => !open);
                  setProjectQuery("");
                }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setProjectMenuOpen(false);
                }}
              >
                <span className="min-w-0 truncate">{text.projectPrefix(selectedProject?.label ?? text.allProjects)}</span>
                <span className="inline-flex shrink-0 items-center gap-2">
                  <Badge className="bg-white">{selectedProject?.sessions.length ?? sessions.length}</Badge>
                  <ChevronDown className={cn("h-4 w-4 text-[var(--app-subtle)] transition", projectMenuOpen && "rotate-180")} aria-hidden="true" />
                </span>
              </button>
              {projectMenuOpen && (
                <div className="absolute right-0 z-20 mt-2 w-full min-w-[18rem] rounded-lg border border-[var(--app-border)] bg-white p-2 shadow-lg" role="menu">
                  <Input aria-label={text.searchProjects} placeholder={text.searchProjects} value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} />
                  <div className="app-scroll mt-2 max-h-72 overflow-y-auto">
                    <ProjectMenuItem label={text.allProjects} count={sessions.length} active={projectFilter === "all"} onClick={() => {
                      setProjectFilter("all");
                      setProjectMenuOpen(false);
                    }} />
                    {projectMenuOptions.map((project) => (
                      <ProjectMenuItem key={project.key} label={project.label} count={project.sessions.length} summary={sessionSourceSummary(project.sessions, locale)} active={projectFilter === project.key} onClick={() => {
                        setProjectFilter(project.key);
                        setProjectMenuOpen(false);
                      }} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="app-scroll max-h-[34rem] space-y-2 overflow-y-auto p-3 xl:max-h-[calc(100vh-220px)]">
          {sessions.length === 0 && <div className="rounded-md bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-muted)]">{text.connectSource}</div>}
          {sessions.length > 0 && groups.length === 0 && <div className="rounded-md bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-muted)]">{text.noSessionsMatch}</div>}
          {groups.map((group) => {
            const expanded = expandedGroups[group.key] ?? false;
            const visibleSessions = expanded ? group.sessions : [];
            return (
              <section key={group.key} className="overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-surface)]">
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? text.collapseProject(group.label) : text.expandProject(group.label)}
                  className="flex w-full items-center justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-surface-muted)] px-3 py-2 text-left transition hover:bg-white"
                  onClick={() => setExpandedGroups((current) => ({ ...current, [group.key]: !expanded }))}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <FolderOpen className="h-4 w-4 shrink-0 text-[var(--app-subtle)]" aria-hidden="true" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-[var(--app-ink)]">{group.label}</span>
                      <span className="block text-xs text-[var(--app-subtle)]">{text.sessionCount(group.sessions.length)}</span>
                    </span>
                  </span>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[var(--app-border)] bg-white">
                    <ChevronDown className={cn("h-4 w-4 text-[var(--app-subtle)] transition", expanded && "rotate-180")} aria-hidden="true" />
                  </span>
                </button>
                <div className="divide-y divide-[var(--app-border)]">
                  {visibleSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={cn(
                        "w-full p-3 text-left transition",
                        selected?.id === session.id ? "bg-[var(--app-surface-selected)] shadow-[inset_3px_0_0_var(--app-accent)]" : "bg-[var(--app-surface)] hover:bg-[var(--app-surface-muted)]"
                      )}
                      onClick={() => {
                        setShowAllMessages(false);
                        onSelect(session.id);
                      }}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium text-[var(--app-ink)]">
                        <SourceIcon source={session.source} />
                        <span className="truncate">{sourceLabel(session.source, locale)}</span>
                        <span className="min-w-0 truncate text-[var(--app-subtle)]">· {sessionProjectLabel(session, locale)}</span>
                      </div>
                      <div className="mt-1 line-clamp-2 text-sm leading-5 text-[var(--app-muted)]">{session.preview || text.temporarySession}</div>
                      <div className="mt-2 text-xs text-[var(--app-subtle)]">{text.messageCount(session.observationCount)}</div>
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
          {sessionOffset < totalSessions && (
            <Button variant="secondary" className="w-full" onClick={onLoadMore}>
              {text.loadMore}
            </Button>
          )}
        </div>
      </Card>
      <Card className="min-w-0 overflow-hidden">
        {selected ? (
          <>
            <div className="flex items-start justify-between gap-3 border-b border-[var(--app-border)] bg-[var(--app-surface)] p-4">
              <div className="min-w-0">
                <SectionTitle>{sourceLabel(selected.source, locale)} · {sessionProjectLabel(selected, locale)}</SectionTitle>
                <h2 className="mt-1 line-clamp-2 text-lg font-semibold leading-6 tracking-normal text-[var(--app-ink)]">{selected.preview || text.temporarySession}</h2>
              </div>
              <Badge>{text.messageCount(selected.observationCount)}</Badge>
            </div>
            <div className="app-scroll max-h-[42rem] space-y-3 overflow-y-auto bg-[var(--app-surface-muted)] p-3 xl:max-h-[calc(100vh-220px)]">
              {observations.length === 0 && <div className="rounded-md bg-white p-4 text-sm text-[var(--app-muted)]">{text.selectSource}</div>}
              {visibleObservations.map((observation) => (
                <article
                  id={`obs-${observation.id}`}
                  key={observation.id}
                  className={cn("source-message rounded-md border p-3", sourceMessageTone(observation), highlightedObservationId === observation.id && "border-amber-300 bg-amber-50 shadow-[inset_3px_0_0_var(--app-amber)]")}
                >
                  <div className="mb-2 flex flex-col gap-1 text-xs text-[var(--app-subtle)] sm:flex-row sm:items-center sm:justify-between">
                    <span className="font-semibold capitalize text-[var(--app-muted)]">{sourceRoleLabel(observation, locale)}</span>
                    <time dateTime={observation.createdAt}>{new Date(observation.createdAt).toLocaleString()}</time>
                  </div>
                  <ObservationText observation={observation} />
                </article>
              ))}
              {!showAllMessages && observations.length > visibleObservations.length && (
                <Button variant="secondary" className="w-full" onClick={() => setShowAllMessages(true)}>
                  <MessageSquareText className="h-4 w-4" aria-hidden="true" />
                  {text.showAllMessages}
                </Button>
              )}
            </div>
          </>
        ) : (
          <div className="m-3 rounded-md bg-[var(--app-surface-muted)] p-4 text-sm text-[var(--app-muted)]">{text.noSourceSessions}</div>
        )}
      </Card>
    </div>
  );
}

function sessionGroups(sessions: SessionRecord[], locale: Locale): Array<{ key: string; label: string; sessions: SessionRecord[] }> {
  const groups = new Map<string, { key: string; label: string; sessions: SessionRecord[] }>();
  for (const session of sessions) {
    const label = sessionProjectLabel(session, locale);
    const key = sessionProjectKey(session, locale);
    const group = groups.get(key) ?? { key, label, sessions: [] };
    group.sessions.push(session);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function sessionProjectOptions(sessions: SessionRecord[], locale: Locale): Array<{ key: string; label: string; sessions: SessionRecord[] }> {
  return sessionGroups(sessions, locale).sort((first, second) => latestSessionTime(second.sessions) - latestSessionTime(first.sessions));
}

function ProjectMenuItem({ active, label, count, summary, onClick }: {
  active: boolean;
  label: string;
  count: number;
  summary?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn("flex w-full min-w-0 items-center justify-between gap-3 rounded-md px-3 py-2 text-left transition", active ? "bg-[var(--app-surface-selected)] text-[var(--app-accent)]" : "text-[var(--app-ink)] hover:bg-[var(--app-surface-muted)]")}
      onClick={onClick}
      title={label}
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{label}</span>
        {summary && <span className="block truncate text-xs text-[var(--app-subtle)]">{summary}</span>}
      </span>
      <Badge className="bg-white">{count}</Badge>
    </button>
  );
}

function filterProjects<T extends { label: string }>(projects: T[], query: string): T[] {
  const term = query.trim().toLowerCase();
  if (!term) return projects;
  return projects.filter((project) => project.label.toLowerCase().includes(term));
}

function matchesSessionProject(session: SessionRecord, projectFilter: string, locale: Locale): boolean {
  return projectFilter === "all" || sessionProjectKey(session, locale) === projectFilter;
}

function sessionProjectKey(session: SessionRecord, locale: Locale): string {
  return `${session.source}:${session.projectPath || sessionProjectLabel(session, locale)}`;
}

function sessionSourceSummary(sessions: SessionRecord[], locale: Locale): string {
  const sources = [...new Set(sessions.map((session) => session.source))];
  return sources.map((source) => sourceLabel(source, locale)).join(" / ");
}

function latestSessionTime(sessions: SessionRecord[]): number {
  return Math.max(...sessions.map((session) => Date.parse(session.updatedAt)));
}

function matchesSessionQuery(session: SessionRecord, query: string, locale: Locale): boolean {
  const term = query.trim().toLowerCase();
  if (!term) return true;
  return [sourceLabel(session.source, locale), sessionProjectLabel(session, locale), session.preview, session.path]
    .some((value) => value.toLowerCase().includes(term));
}

function sourceMessageTone(observation: ObservationRecord): string {
  if (isTurnAborted(observation)) return "mx-auto max-w-xl border-[var(--app-border)] bg-[var(--app-surface-muted)] opacity-80";
  if (isAgentContext(observation)) return "border-[var(--app-border)] bg-[var(--app-surface-muted)] opacity-80";
  if (observation.role === "user") return "ml-auto border-[var(--app-border-strong)] bg-white shadow-[inset_3px_0_0_var(--app-accent)]";
  if (observation.role === "assistant") return "border-[var(--app-border)] bg-white";
  return "border-[var(--app-border)] bg-white";
}

function sourceRoleLabel(observation: ObservationRecord, locale: Locale): string {
  const text = textFor(locale);
  if (isTurnAborted(observation)) return text.turnInterrupted;
  if (isAgentContext(observation)) return text.agentContext;
  return observation.role === "unknown" ? text.message : observation.role;
}

function isAgentContext(observation: ObservationRecord): boolean {
  return isAgentContextText(observation.text);
}

function isTurnAborted(observation: ObservationRecord): boolean {
  return isTurnAbortedText(observation.text);
}
