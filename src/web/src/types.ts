export type SourceKind = "codex" | "claude-code" | "browser";
export type TodoStatus = "todo" | "done" | "ignored";

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

export interface TodoCard {
  id: string;
  title: string;
  description: string;
  status: TodoStatus;
  metadata: TodoMetadata;
  origin?: TodoOrigin;
  evidenceIds: string[];
  updatedAt: string;
}

export interface SessionRecord {
  id: string;
  source: SourceKind;
  path: string;
  updatedAt: string;
  observationCount: number;
  preview: string;
}

export interface SourceSummary {
  source: SourceKind;
  sessions: number;
  checkpoints: number;
}

export interface ObservationRecord {
  id: string;
  sessionId: string;
  source: SourceKind;
  role: string;
  text: string;
  createdAt: string;
}

export interface PublicAppConfig {
  sources: {
    codex: { path?: string };
    "claude-code": { path?: string };
  };
  llm: {
    enabled: boolean;
    provider: "openai";
    model: string;
    endpoint: string;
    thinkingDepth: "low" | "medium" | "high";
    timeoutMs: number;
    apiKeyConfigured: boolean;
    apiKeyMasked: string;
  };
  organize: {
    sinceDays: number;
    maxInteractionsPerSession: number;
    maxSessions: number;
    maxObservationsPerSession: number;
  };
}

export interface OrganizeResult {
  created: number;
  updated: number;
  warnings: string[];
  durationMs: number;
}

export interface StartupScanStatus {
  status: "idle" | "indexing" | "ready" | "failed";
  discovery: Array<{
    source: Extract<SourceKind, "codex" | "claude-code">;
    status: "configured" | "discovered" | "missing";
    path?: string;
  }>;
  warnings: string[];
}
