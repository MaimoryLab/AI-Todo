import { CheckSquare2, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import type { textFor } from "../i18n.js";
import { cn } from "../lib/utils.js";
import type { View } from "../view-model.js";
import { Button, IconButton } from "./ui.js";

type AppText = ReturnType<typeof textFor>;

export function AppShell({ text, view, status, busy, onView, onRefresh, onOrganize, children }: {
  text: AppText;
  view: View;
  status: string;
  busy: boolean;
  onView: (view: View) => void;
  onRefresh: () => void;
  onOrganize: () => void;
  children: React.ReactNode;
}) {
  return (
    <main className="min-h-screen bg-[var(--app-bg)] text-[var(--app-ink)]">
      <div className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col px-4 pb-4 sm:px-6 lg:px-8">
        <header className="sticky top-0 z-20 -mx-4 flex flex-col gap-3 border-b border-[var(--app-line)] bg-[var(--app-bg)]/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 xl:flex-row xl:items-center xl:justify-between">
          <div className="flex min-w-0 flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-xl font-semibold text-[var(--app-ink)]">
              <CheckSquare2 className="h-6 w-6" aria-hidden="true" />
              {text.appName}
            </div>
            <nav className="flex gap-1 overflow-x-auto app-scroll" aria-label={text.primaryNav}>
              <NavButton label={text.openView(text.todos)} active={view === "todos"} onClick={() => onView("todos")}>{text.todos}</NavButton>
              <NavButton label={text.openView(text.sources)} active={view === "sources"} onClick={() => onView("sources")}>{text.sources}</NavButton>
              <NavButton label={text.openView(text.settings)} active={view === "settings"} onClick={() => onView("settings")}>{text.settings}</NavButton>
            </nav>
          </div>
          <div className="flex flex-wrap items-center justify-start gap-2 xl:justify-end">
            <span aria-live="polite" className="max-w-full truncate text-sm text-[var(--app-muted)] sm:max-w-[22rem]" title={status}>
              {status}
            </span>
            <IconButton label={text.refresh} onClick={onRefresh}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </IconButton>
            <Button aria-label={text.organizeAll} title={text.organizeAll} onClick={onOrganize} disabled={busy} variant="secondary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <FolderOpen className="h-4 w-4" aria-hidden="true" />}
              {text.organize}
            </Button>
          </div>
        </header>
        <section className="mt-6 min-w-0">{children}</section>
      </div>
    </main>
  );
}

function NavButton({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button
      aria-label={label}
      className={cn(
        "inline-flex min-h-10 shrink-0 items-center border-b-2 px-3 text-sm font-medium text-[var(--app-muted)] transition active:translate-y-px",
        active ? "border-[var(--app-accent)] text-[var(--app-accent)]" : "border-transparent hover:text-[var(--app-ink)]"
      )}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}
