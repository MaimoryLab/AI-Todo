export const CLI_COMMANDS = [
  "ai-todo",
  "ai-todo scan",
  "ai-todo organize",
  "ai-todo list",
  "ai-todo done <id>",
  "ai-todo ignore <id>",
  "ai-todo open",
  "ai-todo doctor",
  "ai-todo connect codex",
  "ai-todo mcp"
] as const;

export const HTTP_ROUTES = [
  "GET /healthz",
  "GET /sources",
  "POST /sources/scan",
  "GET /sessions",
  "GET /sessions/:id/observations",
  "POST /browser/sessions",
  "POST /todos/organize",
  "GET /todos",
  "PATCH /todos/:id",
  "GET /todos/:id/evidence",
  "POST /todos/:id/refresh",
  "GET /organize-runs/:id",
  "GET /startup/scan",
  "GET /settings",
  "PUT /settings"
] as const;

export const MCP_TOOLS = [
  "todo_scan",
  "todo_organize",
  "todo_list",
  "todo_update",
  "todo_open"
] as const;

export type TodoStatus = "todo" | "done" | "ignored";
export type SourceKind = "codex" | "claude-code" | "browser";
export type OrganizeEngine = "llm";

export interface SessionRecord {
  id: string;
  source: SourceKind;
  path: string;
  projectPath?: string;
  updatedAt: string;
  observationCount: number;
  preview: string;
}

export interface ObservationRecord {
  id: string;
  sessionId: string;
  source: SourceKind;
  role: string;
  text: string;
  createdAt: string;
}

export interface TodoCard {
  id: string;
  title: string;
  description: string;
  status: TodoStatus;
  metadata: TodoMetadata;
  origin?: TodoOrigin;
  chain?: TaskChainView;
  evidenceIds: string[];
  updatedAt: string;
}

export interface TaskChainView {
  id: string;
  sessionId: string;
  projectPath?: string;
  projectTitle?: string;
  source: SourceKind;
  title: string;
  summary: string;
  status: string;
  currentNode: ChainNodeSummary;
  completedNodeCount: number;
  completedNodes: ChainNodeSummary[];
}

export interface ChainNodeSummary {
  id: string;
  title: string;
  summary: string;
  owner: "agent" | "user";
  status: "completed" | "superseded" | "blocked" | "current";
  nextStep?: string;
  observationId?: string;
  createdAt?: string;
}

export interface TodoOrigin {
  source: SourceKind;
  projectTitle?: string;
  projectPath?: string;
  sessionId: string;
  sessionTitle?: string;
  sessionTemporary?: boolean;
  observationId: string;
  eventCreatedAt?: string;
}

export interface TodoMetadata {
  completionState?: string;
  completionSummary?: string;
  nextStep?: string;
  sourceObservationId?: string;
}

export interface OrganizeResult {
  runId: string;
  scanned: number;
  sources: Array<{ source: SourceKind; scanned: number }>;
  created: number;
  updated: number;
  completed: number;
  ignored: number;
  engine: OrganizeEngine;
  warnings: string[];
  details?: {
    scope?: {
      sessionsScanned: number;
      sessionsDropped: number;
      observationsDropped: number;
    };
    truncations?: Array<{
      sessionId: string;
      source: SourceKind;
      role: string;
      originalChars: number;
      keptChars: number;
    }>;
    batchFailures?: Array<{
      sessionId: string;
      source: SourceKind;
      warning: string;
      reason: string;
      retryable: boolean;
    }>;
  };
  durationMs: number;
}
