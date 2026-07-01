import { basename, dirname } from "node:path";
import type { ChainNodeSummary, OrganizeResult, SourceKind, TaskChainView, TodoCard, TodoMetadata, TodoOrigin } from "../contracts.js";
import type { Database } from "../db/index.js";
import { stableId } from "../extract/rules.js";

export interface TodoEvidence {
  id: string;
  observationId: string;
  text: string;
}

export interface TodoEnhancer {
  enhance(candidate: { title: string; description: string; mergeKey: string; evidenceText: string }): Promise<{ title?: string; description?: string } | null>;
}

export type LlmOrganizeWarning =
  | "llm_config_missing"
  | "llm_timeout"
  | "llm_provider_failed"
  | "llm_output_invalid"
  | "llm_no_valid_candidates"
  | "llm_input_truncated"
  | "llm_batch_failed"
  | "organize_scope_truncated"
  | "organize_failed";

export interface LlmTodoCandidate {
  title: string;
  description: string;
  metadata?: TodoMetadata;
  confidence: number;
  sourceObservationId: string;
  quote: string;
  dedupeKey: string;
}

export interface LlmTaskChainNode {
  title: string;
  summary?: string;
  description?: string;
  owner?: "agent" | "user";
  status?: "completed" | "superseded" | "blocked" | "current";
  nextStep?: string;
  observationId?: string;
  createdAt?: string;
}

export interface LlmTaskChain {
  chainId?: string;
  title: string;
  summary?: string;
  status?: string;
  completedNodes?: LlmTaskChainNode[];
  currentNode?: LlmTodoCandidate & {
    owner?: "agent" | "user";
    nextStep?: string;
  };
}

export type LlmExtractResult =
  | { ok: true; todos?: LlmTodoCandidate[]; taskChains?: LlmTaskChain[] }
  | { ok: false; warning: LlmOrganizeWarning; reason?: string; retryable?: boolean };

export interface OrganizeOptions {
  enhancer?: TodoEnhancer["enhance"];
  llmExtractor?: (observations: ObservationForOrganize[]) => Promise<LlmExtractResult>;
  scope?: {
    sinceDays: number;
    maxInteractionsPerSession: number;
    maxSessions?: number;
    maxObservationsPerSession?: number;
  };
  limits?: Partial<OrganizeLimits>;
}

export interface ObservationForOrganize {
  id: string;
  sessionId: string;
  source: SourceKind;
  role: string;
  text: string;
  createdAt: string;
}

type WriteResult = { created: number; updated: number; engine: "llm" };
type OrganizeDetails = NonNullable<OrganizeResult["details"]>;

export interface OrganizeLimits {
  maxUserBlocks: number;
  maxTotalTextChars: number;
  maxBlockTextChars: number;
  llmBatchSize: number;
  llmConcurrency: number;
  maxObservationTextChars: number;
  maxSessionPayloadChars: number;
  maxBatchPayloadChars: number;
}

export const DEFAULT_ORGANIZE_LIMITS: OrganizeLimits = {
  maxUserBlocks: 120,
  maxTotalTextChars: 80000,
  maxBlockTextChars: 4000,
  llmBatchSize: 20,
  llmConcurrency: 2,
  maxObservationTextChars: 3000,
  maxSessionPayloadChars: 24000,
  maxBatchPayloadChars: 32000
};

export async function organizeTodos(db: Database, options: OrganizeOptions = {}): Promise<OrganizeResult> {
  const started = Date.now();
  const runId = stableId("organize", new Date(started).toISOString(), Math.random().toString(36));
  const warnings = new Set<string>();
  const details: OrganizeDetails = {};
  const limits = { ...DEFAULT_ORGANIZE_LIMITS, ...options.limits };
  const observations = planScopedObservations(loadScopedObservations(db, options.scope), options.scope, limits, warnings, details);
  const sourceCounts = new Map<SourceKind, number>();
  for (const observation of observations) {
    sourceCounts.set(observation.source, (sourceCounts.get(observation.source) ?? 0) + 1);
  }
  const writeResult: WriteResult = options.llmExtractor
    ? await writeBatchedLlmTodos(db, observations, options, limits, warnings, details)
    : noLlmResult(warnings, "llm_config_missing");

  const result: OrganizeResult = {
    runId,
    scanned: observations.length,
    sources: Array.from(sourceCounts, ([source, scanned]) => ({ source, scanned })),
    created: writeResult.created,
    updated: writeResult.updated,
    completed: 0,
    ignored: 0,
    engine: writeResult.engine,
    warnings: Array.from(warnings),
    durationMs: Date.now() - started
  };
  if (hasOrganizeDetails(details)) result.details = details;

  db.prepare(
    "INSERT INTO organize_runs (id, result_json, created_at) VALUES (?, ?, ?)"
  ).run(runId, JSON.stringify(result), new Date().toISOString());
  return result;
}

function loadScopedObservations(db: Database, scope: OrganizeOptions["scope"]): ObservationForOrganize[] {
  const params: string[] = [];
  let where = "";
  if (scope) {
    where = "WHERE datetime(created_at) >= datetime(?)";
    params.push(new Date(Date.now() - scope.sinceDays * 24 * 60 * 60 * 1000).toISOString());
  }
  return db.prepare(
    `SELECT id, session_id as sessionId, source, role, text, created_at as createdAt
     FROM observations
     ${where}
     ORDER BY created_at, id`
  ).all(...params) as unknown as ObservationForOrganize[];
}

export function scopeObservations(
  observations: ObservationForOrganize[],
  scope: OrganizeOptions["scope"]
): ObservationForOrganize[] {
  if (!scope) return observations;
  const cutoffMs = Date.now() - scope.sinceDays * 24 * 60 * 60 * 1000;
  const recent = observations.filter((observation) => Date.parse(observation.createdAt) >= cutoffMs);
  const grouped = new Map<string, ObservationForOrganize[]>();
  for (const observation of recent) {
    const group = grouped.get(observation.sessionId) ?? [];
    group.push(observation);
    grouped.set(observation.sessionId, group);
  }
  const scoped: ObservationForOrganize[] = [];
  for (const group of grouped.values()) {
    scoped.push(...takeRecentInteractions(group, scope.maxInteractionsPerSession));
  }
  return scoped.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function takeRecentInteractions(observations: ObservationForOrganize[], maxInteractions: number): ObservationForOrganize[] {
  const boundaries = observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => observation.role === "user")
    .map(({ index }) => index);
  if (boundaries.length <= maxInteractions) return observations;
  const cutoff = boundaries[boundaries.length - maxInteractions];
  return observations.slice(cutoff);
}

function planScopedObservations(
  observations: ObservationForOrganize[],
  scope: OrganizeOptions["scope"],
  limits: OrganizeLimits,
  warnings: Set<string>,
  details: OrganizeDetails
): ObservationForOrganize[] {
  const scoped = scopeObservationsBySession(observations, scope, limits, warnings, details);
  return applyPayloadBudget(scoped, limits, warnings, details);
}

function scopeObservationsBySession(
  observations: ObservationForOrganize[],
  scope: OrganizeOptions["scope"],
  limits: OrganizeLimits,
  warnings: Set<string>,
  details: OrganizeDetails
): ObservationForOrganize[] {
  const base = scope ? observations.filter((observation) => {
    const cutoffMs = Date.now() - scope.sinceDays * 24 * 60 * 60 * 1000;
    return Date.parse(observation.createdAt) >= cutoffMs;
  }) : observations;
  const sessions = new Map<string, ObservationForOrganize[]>();
  for (const observation of base) {
    const group = sessions.get(observation.sessionId) ?? [];
    group.push(observation);
    sessions.set(observation.sessionId, group);
  }
  const maxSessions = scope?.maxSessions ?? Number.POSITIVE_INFINITY;
  const maxObservationsPerSession = scope?.maxObservationsPerSession ?? Number.POSITIVE_INFINITY;
  const rankedSessions = Array.from(sessions.values())
    .map((group) => group.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
    .sort((a, b) => latestTimestamp(b).localeCompare(latestTimestamp(a)));
  const selected = rankedSessions.slice(0, maxSessions);
  const sessionsDropped = Math.max(0, rankedSessions.length - selected.length);
  let observationsDropped = rankedSessions.slice(maxSessions).reduce((sum, group) => sum + group.length, 0);
  const scoped: ObservationForOrganize[] = [];
  for (const group of selected) {
    const interactionScoped = scope ? takeRecentInteractions(group, scope.maxInteractionsPerSession) : group;
    const observationScoped = interactionScoped.slice(Math.max(0, interactionScoped.length - maxObservationsPerSession));
    observationsDropped += Math.max(0, group.length - interactionScoped.length) + Math.max(0, interactionScoped.length - observationScoped.length);
    scoped.push(...observationScoped);
  }
  if (sessionsDropped > 0 || observationsDropped > 0) {
    warnings.add("organize_scope_truncated");
    details.scope = {
      sessionsScanned: selected.length,
      sessionsDropped,
      observationsDropped
    };
  }
  return scoped.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function latestTimestamp(observations: ObservationForOrganize[]): string {
  return observations.reduce((latest, observation) => observation.createdAt > latest ? observation.createdAt : latest, "");
}

function applyPayloadBudget(
  observations: ObservationForOrganize[],
  limits: OrganizeLimits,
  warnings: Set<string>,
  details: OrganizeDetails
): ObservationForOrganize[] {
  let totalText = 0;
  let userBlocks = 0;
  const sessionText = new Map<string, number>();
  const limited: ObservationForOrganize[] = [];
  for (const observation of observations) {
    if (observation.role === "user" && userBlocks >= limits.maxUserBlocks) {
      warnings.add("organize_scope_truncated");
      continue;
    }
    const maxTextChars = observation.role === "user"
      ? Math.min(limits.maxBlockTextChars, limits.maxObservationTextChars)
      : limits.maxObservationTextChars;
    let text = observation.text.length > maxTextChars
      ? observation.text.slice(0, maxTextChars)
      : observation.text;
    if (text.length !== observation.text.length) {
      addTruncationDetail(details, observation, observation.text.length, text.length);
      warnings.add("llm_input_truncated");
    }
    const sessionUsed = sessionText.get(observation.sessionId) ?? 0;
    if (sessionUsed + text.length > limits.maxSessionPayloadChars) {
      const available = Math.max(0, limits.maxSessionPayloadChars - sessionUsed);
      if (available === 0) {
        warnings.add("organize_scope_truncated");
        continue;
      }
      text = text.slice(0, available);
      addTruncationDetail(details, observation, observation.text.length, text.length);
      warnings.add("llm_input_truncated");
    }
    if (totalText + text.length > limits.maxTotalTextChars) {
      warnings.add("organize_scope_truncated");
      continue;
    }
    totalText += text.length;
    sessionText.set(observation.sessionId, sessionUsed + text.length);
    if (observation.role === "user") userBlocks++;
    limited.push(text === observation.text ? observation : { ...observation, text });
  }
  return limited;
}

function addTruncationDetail(
  details: OrganizeDetails,
  observation: ObservationForOrganize,
  originalChars: number,
  keptChars: number
): void {
  details.truncations ??= [];
  details.truncations.push({
    sessionId: observation.sessionId,
    source: observation.source,
    role: observation.role,
    originalChars,
    keptChars
  });
}

function hasOrganizeDetails(details: OrganizeDetails): boolean {
  return !!details.scope || !!details.truncations?.length || !!details.batchFailures?.length;
}

function writeExtractedLlmTodos(
  db: Database,
  observations: ObservationForOrganize[],
  extracted: LlmExtractResult,
  warnings: Set<string>,
  details: OrganizeDetails
): WriteResult {
  if (!extracted.ok) {
    warnings.add(extracted.warning);
    addBatchFailureDetail(details, observations, extracted);
    return noLlmResult(warnings);
  }
  const byId = new Map(observations.map((observation) => [observation.id, observation]));
  const chainCandidates = taskChainCandidates(extracted.taskChains ?? [], byId);
  const candidates = dedupeLlmCandidates<ChainCandidate>(
    [...(extracted.todos ?? []).map((candidate): ChainCandidate => ({ candidate })), ...chainCandidates]
      .filter((item) => validLlmCandidate(item.candidate, byId)),
    existingActiveTodos(db)
  );
  if (candidates.length === 0) {
    warnings.add("llm_no_valid_candidates");
    return noLlmResult(warnings);
  }

  let created = 0;
  let updated = 0;
  for (const item of candidates) {
    const candidate = item.candidate;
    const observation = byId.get(candidate.sourceObservationId);
    if (!observation) continue;
    const todoId = stableId(candidate.dedupeKey);
    const now = new Date().toISOString();
    const metadata = normalizeTodoMetadata(candidate.metadata, candidate.sourceObservationId);
    const metadataJson = JSON.stringify(metadata);
    const chainNodeId = item.chain ? writeTaskChain(db, item.chain, candidate, observation, now) : undefined;
    const existing = db.prepare("SELECT id FROM todos WHERE id = ?").get(todoId);
    if (existing) {
      if (chainNodeId) {
        db.prepare(
          "UPDATE todos SET title = ?, description = ?, chain_node_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?"
        ).run(candidate.title.trim(), candidate.description.trim(), chainNodeId, metadataJson, now, todoId);
      } else {
        db.prepare(
          "UPDATE todos SET title = ?, description = ?, metadata_json = ?, updated_at = ? WHERE id = ?"
        ).run(candidate.title.trim(), candidate.description.trim(), metadataJson, now, todoId);
      }
      updated++;
    } else {
      db.prepare(
        "INSERT INTO todos (id, title, description, status, chain_node_id, metadata_json, updated_at) VALUES (?, ?, ?, 'todo', ?, ?, ?)"
      ).run(todoId, candidate.title.trim(), candidate.description.trim(), chainNodeId ?? null, metadataJson, now);
      created++;
    }
    db.prepare(
      "INSERT OR REPLACE INTO evidence (id, todo_id, observation_id, text) VALUES (?, ?, ?, ?)"
    ).run(stableId(todoId, observation.id), todoId, observation.id, candidate.quote.trim());
  }
  return { created, updated, engine: "llm" };
}

interface ChainCandidate {
  candidate: LlmTodoCandidate;
  chain?: LlmTaskChain;
}

function taskChainCandidates(chains: LlmTaskChain[], observations: Map<string, ObservationForOrganize>): ChainCandidate[] {
  return chains
    .filter((chain) => chain.currentNode && chain.status !== "completed")
    .map((chain) => ({ candidate: chain.currentNode!, chain }))
    .filter((item) => observations.has(item.candidate.sourceObservationId));
}

function writeTaskChain(
  db: Database,
  chain: LlmTaskChain,
  candidate: LlmTodoCandidate,
  observation: ObservationForOrganize,
  now: string
): string {
  const session = db.prepare("SELECT project_path as projectPath, path FROM sessions WHERE id = ?").get(observation.sessionId) as { projectPath?: string; path?: string } | undefined;
  const chainId = stableId(chain.chainId || observation.sessionId, candidate.dedupeKey);
  const completedNodes = chain.completedNodes ?? [];
  const currentNodeId = stableId(chainId, "current", candidate.dedupeKey);
  db.prepare(
    `INSERT OR REPLACE INTO task_chains
      (id, session_id, source, project_path, title, summary, status, current_node_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM task_chains WHERE id = ?), ?), ?)`
  ).run(
    chainId,
    observation.sessionId,
    observation.source,
    session?.projectPath || session?.path || null,
    cleanMetadataText(chain.title, 160) || candidate.title.trim(),
    cleanMetadataText(chain.summary, 500),
    cleanMetadataText(chain.status, 80) || candidate.metadata?.completionState || "in_progress",
    currentNodeId,
    chainId,
    now,
    now
  );
  db.prepare("DELETE FROM task_chain_nodes WHERE chain_id = ?").run(chainId);
  completedNodes.forEach((node, index) => {
    const nodeId = stableId(chainId, "completed", String(index), node.title);
    db.prepare(
      `INSERT INTO task_chain_nodes
        (id, chain_id, observation_id, position, title, summary, owner, status, next_step, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      nodeId,
      chainId,
      cleanMetadataText(node.observationId) || null,
      index,
      cleanMetadataText(node.title, 160),
      cleanMetadataText(node.summary, 500),
      node.owner === "user" ? "user" : "agent",
      node.status === "blocked" || node.status === "superseded" ? node.status : "completed",
      cleanMetadataText(node.nextStep, 240) || null,
      cleanMetadataText(node.createdAt) || now
    );
  });
  db.prepare(
    `INSERT INTO task_chain_nodes
      (id, chain_id, observation_id, position, title, summary, owner, status, next_step, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'current', ?, ?)`
  ).run(
    currentNodeId,
    chainId,
    candidate.sourceObservationId,
    completedNodes.length,
    candidate.title.trim(),
    candidate.description.trim(),
    chain.currentNode?.owner === "user" ? "user" : "agent",
    cleanMetadataText(chain.currentNode?.nextStep ?? candidate.metadata?.nextStep, 240) || null,
    now
  );
  return currentNodeId;
}

async function writeBatchedLlmTodos(
  db: Database,
  observations: ObservationForOrganize[],
  options: OrganizeOptions,
  limits: OrganizeLimits,
  warnings: Set<string>,
  details: OrganizeDetails
): Promise<WriteResult> {
  const extractor = options.llmExtractor;
  if (!extractor) return noLlmResult(warnings, "llm_config_missing");
  const batches = chunkObservationsBySession(observations, limits.llmBatchSize, limits.maxBatchPayloadChars)
    .filter((batch) => batch.some((observation) => observation.role === "user"));
  let totalCreated = 0;
  let totalUpdated = 0;
  const concurrency = Math.max(1, Math.floor(limits.llmConcurrency));

  for (let index = 0; index < batches.length; index += concurrency) {
    const extracted = await Promise.all(batches.slice(index, index + concurrency).map(async (batch) => ({
      batch,
      result: await extractor(batch)
    })));
    for (const item of extracted) {
      const warningsBefore = new Set(warnings);
      const result = writeExtractedLlmTodos(db, item.batch, item.result, warnings, details);
      if (hasBatchFailureWarning(warnings, warningsBefore)) warnings.add("llm_batch_failed");
      totalCreated += result.created;
      totalUpdated += result.updated;
    }
  }

  if (batches.length === 0) warnings.add("llm_no_valid_candidates");
  return { created: totalCreated, updated: totalUpdated, engine: "llm" };
}

function addBatchFailureDetail(
  details: OrganizeDetails,
  observations: ObservationForOrganize[],
  failure: Extract<LlmExtractResult, { ok: false }>
): void {
  const first = observations.find((observation) => observation.role === "user") ?? observations[0];
  if (!first) return;
  details.batchFailures ??= [];
  details.batchFailures.push({
    sessionId: first.sessionId,
    source: first.source,
    warning: failure.warning,
    reason: failure.reason ?? failure.warning,
    retryable: failure.retryable ?? isRetryableWarning(failure.warning)
  });
}

function isRetryableWarning(warning: LlmOrganizeWarning): boolean {
  return warning === "llm_timeout" ||
    warning === "llm_provider_failed" ||
    warning === "llm_output_invalid";
}

function hasBatchFailureWarning(warnings: Set<string>, before: Set<string>): boolean {
  for (const warning of warnings) {
    if (before.has(warning)) continue;
    if (
      warning === "llm_timeout" ||
      warning === "llm_provider_failed" ||
      warning === "llm_output_invalid"
    ) return true;
  }
  return false;
}

function noLlmResult(warnings: Set<string>, warning?: LlmOrganizeWarning): WriteResult {
  if (warning) warnings.add(warning);
  return { created: 0, updated: 0, engine: "llm" };
}

function chunkObservationsBySession(
  observations: ObservationForOrganize[],
  batchSize: number,
  maxBatchPayloadChars: number
): ObservationForOrganize[][] {
  const sessions = new Map<string, ObservationForOrganize[]>();
  for (const observation of observations) {
    const group = sessions.get(observation.sessionId) ?? [];
    group.push(observation);
    sessions.set(observation.sessionId, group);
  }
  const chunks: ObservationForOrganize[][] = [];
  for (const group of sessions.values()) {
    chunks.push(...chunkObservations(group, batchSize, maxBatchPayloadChars));
  }
  return chunks;
}

function chunkObservations(
  observations: ObservationForOrganize[],
  batchSize: number,
  maxBatchPayloadChars: number
): ObservationForOrganize[][] {
  const chunks: ObservationForOrganize[][] = [];
  let chunk: ObservationForOrganize[] = [];
  let users = 0;
  let chars = 0;
  for (const observation of observations) {
    const isUser = observation.role === "user";
    const wouldExceedUserLimit = isUser && users >= batchSize && chunk.length > 0;
    const wouldExceedPayloadLimit = chars > 0 &&
      chars + observation.text.length > maxBatchPayloadChars &&
      chunk.some((item) => item.role === "user");
    if (wouldExceedUserLimit || wouldExceedPayloadLimit) {
      chunks.push(chunk);
      chunk = [];
      users = 0;
      chars = 0;
    }
    chunk.push(observation);
    chars += observation.text.length;
    if (isUser) users++;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

function validLlmCandidate(candidate: LlmTodoCandidate, observations: Map<string, ObservationForOrganize>): boolean {
  const observation = observations.get(candidate.sourceObservationId);
  return !!observation &&
    typeof candidate.title === "string" &&
    !!candidate.title.trim() &&
    typeof candidate.description === "string" &&
    !!candidate.description.trim() &&
    typeof candidate.quote === "string" &&
    !!candidate.quote.trim() &&
    observation.text.includes(candidate.quote.trim()) &&
    typeof candidate.dedupeKey === "string" &&
    !!candidate.dedupeKey.trim() &&
    typeof candidate.confidence === "number" &&
    Number.isFinite(candidate.confidence) &&
    candidate.confidence >= 0.75 &&
    candidatePassesQualityGate(candidate);
}

function candidatePassesQualityGate(candidate: LlmTodoCandidate): boolean {
  const title = normalizeTodoText(candidate.title);
  const description = normalizeTodoText(candidate.description);
  const quote = normalizeTodoText(candidate.quote);
  const combined = `${title} ${description} ${quote}`;
  return !looksIncompleteTitle(title) &&
    !isCompletedOrStatusOnly(combined) &&
    !isToolPolluted(combined) &&
    !isPureProcessChore(combined) &&
    !hasLongTechnicalIdentifier(title);
}

function dedupeLlmCandidates<T extends { candidate: LlmTodoCandidate }>(candidates: T[], existingTodos: ExistingTodoForDedupe[]): T[] {
  const accepted: T[] = [];
  const keys = new Set(existingTodos.map((todo) => candidateIdentityKey(todo)));
  for (const item of candidates) {
    const candidate = item.candidate;
    const todoId = stableId(candidate.dedupeKey);
    const key = candidateIdentityKey(candidate);
    if (existingTodos.some((todo) => todo.id !== todoId && nearDuplicateTodo(todo, candidate))) continue;
    if (accepted.some((acceptedItem) => nearDuplicateTodo(acceptedItem.candidate, candidate))) continue;
    keys.add(key);
    accepted.push(item);
  }
  return accepted;
}

interface ExistingTodoForDedupe {
  id: string;
  title: string;
  description: string;
}

function existingActiveTodos(db: Database): ExistingTodoForDedupe[] {
  return db.prepare("SELECT id, title, description FROM todos WHERE status = 'todo'").all() as unknown as ExistingTodoForDedupe[];
}

function candidateIdentityKey(candidate: Pick<LlmTodoCandidate, "title" | "description">): string {
  return `${normalizeTodoKey(candidate.title)}|${normalizeTodoKey(candidate.description)}`;
}

function nearDuplicateTodo(left: Pick<LlmTodoCandidate, "title" | "description">, right: Pick<LlmTodoCandidate, "title" | "description">): boolean {
  const leftTitle = normalizeTodoKey(left.title);
  const rightTitle = normalizeTodoKey(right.title);
  if (!leftTitle || !rightTitle) return false;
  if (leftTitle === rightTitle) return true;
  if (leftTitle.includes(rightTitle) || rightTitle.includes(leftTitle)) return true;
  return tokenSimilarity(leftTitle, rightTitle) >= 0.72;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = todoTokens(left);
  const rightTokens = todoTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap++;
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function todoTokens(value: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of value.matchAll(/[a-z0-9]+|[\u4e00-\u9fff]/giu)) {
    const token = match[0].toLowerCase();
    if (token && token !== "并" && token !== "和" && token !== "与") tokens.add(token);
  }
  return tokens;
}

function normalizeTodoText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTodoKey(value: string): string {
  return normalizeTodoText(value)
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:()[\]{}"'`“”‘’\s-]/g, "");
}

function looksIncompleteTitle(title: string): boolean {
  if (Array.from(title).length < 3) return true;
  if (!/[A-Za-z\u4e00-\u9fff]/u.test(title)) return true;
  if (/(?:返回|status|code|状态码)\s*\d{1,2}$/i.test(title)) return true;
  if (/[、,，]\s*\/[A-Za-z]{1,4}$/u.test(title)) return true;
  if (/\bhttps?:\/\/\S*[:/]$/i.test(title)) return true;
  if (/^(?:准备|开始|继续|接下来|现在我会)\s*[^\n。！？]{0,80}(?:到|为|把|对|向|在|从|将)$/u.test(title)) return true;
  return false;
}

function isCompletedOrStatusOnly(value: string): boolean {
  const text = normalizeTodoText(value);
  if (/(?:已完成|已通过|已经完成|完成了|都能显示|服务可用|健康检查已完成|worktree clean|working tree clean|process exited 0|no changes)/i.test(text)) return true;
  return /^(?:确认|检查|状态确认|健康检查|服务可用|review settings|status check)[\s\S]{0,80}$/i.test(text);
}

function isToolPolluted(value: string): boolean {
  return /\b(?:Bash|Shell|exec_command|apply_patch|toolUseId|function_call|function_call_output|process exited|Chunk ID|Wall time|yield_time_ms|max_output_tokens)\b/i.test(value) ||
    /"(?:cmd|command|workdir|yield_time_ms|max_output_tokens)"\s*:/i.test(value);
}

function isPureProcessChore(value: string): boolean {
  const text = normalizeTodoText(value);
  if (!/(?:做最后一次状态确认|最后一次状态确认|启动后做健康检查|做健康检查|确认工作区干净|确认当前分支|确认 PR 链接|重启后再测一次|重启 Codex desktop app 后再测一次)/i.test(text)) {
    return false;
  }
  return !/(?:修复|修正|补充|实现|调整|排查|定位|创建|更新|推送|提交|fix|add|update|create|implement|resolve)/i.test(text);
}

function hasLongTechnicalIdentifier(title: string): boolean {
  return /(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]{24,}|https?:\/\/|\/(?:Users|tmp|var|private|Volumes)\/)/i.test(title);
}

export function listTodos(db: Database): TodoCard[] {
  return db.prepare(
    `SELECT
      todos.id,
      todos.title,
      todos.description,
      todos.status,
      todos.chain_node_id as chainNodeId,
      todos.metadata_json as metadataJson,
      todos.updated_at as updatedAt,
      MIN(evidence.observation_id) as evidenceObservationId,
      COALESCE(json_group_array(evidence.id) FILTER (WHERE evidence.id IS NOT NULL), '[]') as evidenceIds
    FROM todos
    LEFT JOIN evidence ON evidence.todo_id = todos.id
    GROUP BY todos.id
    ORDER BY todos.updated_at DESC`
  ).all().map((row) => {
    const record = row as Record<string, unknown>;
    const metadata = parseTodoMetadata(record.metadataJson);
    const sourceObservationId = metadata.sourceObservationId || String(record.evidenceObservationId || "");
    return {
      id: String(record.id),
      title: String(record.title),
      description: String(record.description),
      status: record.status as TodoCard["status"],
      metadata,
      origin: todoOrigin(db, sourceObservationId),
      chain: todoChain(db, String(record.chainNodeId || "")),
      updatedAt: String(record.updatedAt),
      evidenceIds: JSON.parse(String(record.evidenceIds))
    };
  });
}

function todoChain(db: Database, chainNodeId: string): TaskChainView | undefined {
  if (!chainNodeId) return undefined;
  const row = db.prepare(
    `SELECT
      task_chains.id,
      task_chains.session_id as sessionId,
      task_chains.source,
      task_chains.project_path as projectPath,
      task_chains.title,
      task_chains.summary,
      task_chains.status,
      current_node.id as currentNodeId,
      current_node.observation_id as currentObservationId,
      current_node.title as currentTitle,
      current_node.summary as currentSummary,
      current_node.owner as currentOwner,
      current_node.status as currentStatus,
      current_node.next_step as currentNextStep,
      current_node.created_at as currentCreatedAt
    FROM task_chain_nodes current_node
    JOIN task_chains ON task_chains.id = current_node.chain_id
    WHERE current_node.id = ?`
  ).get(chainNodeId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const projectPath = cleanMetadataText(row.projectPath);
  const completedNodes = db.prepare(
    `SELECT id, observation_id as observationId, title, summary, owner, status, next_step as nextStep, created_at as createdAt
     FROM task_chain_nodes
     WHERE chain_id = ? AND status != 'current'
     ORDER BY position, created_at, id`
  ).all(String(row.id)).map((node) => chainNodeSummary(node as Record<string, unknown>));
  const currentNode = chainNodeSummary({
    id: row.currentNodeId,
    observationId: row.currentObservationId,
    title: row.currentTitle,
    summary: row.currentSummary,
    owner: row.currentOwner,
    status: row.currentStatus,
    nextStep: row.currentNextStep,
    createdAt: row.currentCreatedAt
  });
  return {
    id: String(row.id),
    sessionId: String(row.sessionId),
    source: row.source as SourceKind,
    projectPath: projectPath || undefined,
    projectTitle: projectPath ? projectTitleFromPath(projectPath) : undefined,
    title: String(row.title),
    summary: String(row.summary),
    status: String(row.status),
    currentNode,
    completedNodeCount: completedNodes.length,
    completedNodes
  };
}

function chainNodeSummary(row: Record<string, unknown>): ChainNodeSummary {
  const owner = row.owner === "user" ? "user" : "agent";
  const status = row.status === "completed" || row.status === "superseded" || row.status === "blocked" ? row.status : "current";
  return {
    id: String(row.id),
    title: String(row.title),
    summary: String(row.summary),
    owner,
    status,
    nextStep: cleanMetadataText(row.nextStep, 240) || undefined,
    observationId: cleanMetadataText(row.observationId) || undefined,
    createdAt: cleanMetadataText(row.createdAt) || undefined
  };
}

function todoOrigin(db: Database, observationId: string | undefined): TodoOrigin | undefined {
  if (!observationId) return undefined;
  const row = db.prepare(
    `SELECT
      observations.id as observationId,
      observations.session_id as sessionId,
      observations.source as source,
      observations.text as observationText,
      observations.created_at as eventCreatedAt,
      COALESCE(sessions.project_path, sessions.path) as projectPath,
      COALESCE((
        SELECT preview.text
        FROM observations preview
        WHERE preview.session_id = observations.session_id
          AND preview.role IN ('user', 'assistant')
        ORDER BY preview.created_at, preview.id
        LIMIT 1
      ), '') as sessionPreview
    FROM observations
    JOIN sessions ON sessions.id = observations.session_id
    WHERE observations.id = ?`
  ).get(observationId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const projectPath = String(row.projectPath);
  const sessionTitle = truncateOriginText(String(row.sessionPreview) || String(row.observationText));
  return {
    source: row.source as SourceKind,
    projectTitle: projectTitleFromPath(projectPath),
    projectPath,
    sessionId: String(row.sessionId),
    sessionTitle: sessionTitle || "Temporary session",
    sessionTemporary: true,
    observationId: String(row.observationId),
    eventCreatedAt: String(row.eventCreatedAt)
  };
}

function projectTitleFromPath(path: string): string | undefined {
  const fileParent = path.endsWith(".jsonl") ? dirname(path) : path;
  const title = basename(fileParent).trim();
  if (!title || title === ".") return undefined;
  return readableProjectTitle(title);
}

function readableProjectTitle(title: string): string | undefined {
  const marker = "AI-TodoProject";
  const markerIndex = title.indexOf(marker);
  if (markerIndex >= 0) {
    const suffix = title.slice(markerIndex + marker.length).replace(/^-+/u, "");
    return suffix || marker;
  }
  const cleaned = title.replace(/^-+|-+$/gu, "");
  if (!cleaned || /^\d+$/u.test(cleaned) || /^(Users|tmp|var|private|Volumes)(?:[-_]|$)/u.test(cleaned)) {
    return undefined;
  }
  return title;
}

function truncateOriginText(value: string): string {
  return Array.from(normalizeTodoText(value)).slice(0, 84).join("");
}

function normalizeTodoMetadata(metadata: TodoMetadata | undefined, sourceObservationId: string): TodoMetadata {
  return {
    ...cleanTodoMetadata(metadata),
    sourceObservationId
  };
}

function parseTodoMetadata(value: unknown): TodoMetadata {
  try {
    const parsed = JSON.parse(String(value ?? "{}")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return cleanTodoMetadata(parsed as TodoMetadata);
  } catch {
    return {};
  }
}

function cleanTodoMetadata(metadata: TodoMetadata | undefined): TodoMetadata {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const cleaned: TodoMetadata = {};
  const completionState = cleanMetadataText(metadata.completionState);
  const completionSummary = cleanMetadataText(metadata.completionSummary, 240);
  const nextStep = cleanMetadataText(metadata.nextStep, 240);
  const sourceObservationId = cleanMetadataText(metadata.sourceObservationId);
  if (completionState) cleaned.completionState = completionState;
  if (completionSummary) cleaned.completionSummary = completionSummary;
  if (nextStep) cleaned.nextStep = nextStep;
  if (sourceObservationId) cleaned.sourceObservationId = sourceObservationId;
  return cleaned;
}

function cleanMetadataText(value: unknown, maxLength = 120): string {
  if (typeof value !== "string") return "";
  const text = normalizeTodoText(value);
  return Array.from(text).slice(0, maxLength).join("");
}

export function updateTodoStatus(db: Database, id: string, status: "done" | "ignored"): boolean {
  const result = db.prepare(
    "UPDATE todos SET status = ?, updated_at = ? WHERE id = ?"
  ).run(status, new Date().toISOString(), id);
  return result.changes > 0;
}

export function listTodoEvidence(db: Database, todoId: string): TodoEvidence[] | null {
  const todo = db.prepare("SELECT id FROM todos WHERE id = ?").get(todoId);
  if (!todo) return null;
  return db.prepare(
    `SELECT
      evidence.id,
      evidence.observation_id as observationId,
      observations.text as text
    FROM evidence
    JOIN observations ON observations.id = evidence.observation_id
    WHERE evidence.todo_id = ?
    ORDER BY evidence.id`
  ).all(todoId).map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: String(record.id),
      observationId: String(record.observationId),
      text: String(record.text)
    };
  });
}

export function getOrganizeRun(db: Database, id: string): OrganizeResult | null {
  const row = db.prepare(
    "SELECT result_json as resultJson FROM organize_runs WHERE id = ?"
  ).get(id) as { resultJson: string } | undefined;
  return row ? JSON.parse(row.resultJson) as OrganizeResult : null;
}
