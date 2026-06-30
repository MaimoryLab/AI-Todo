import type { AppConfig, AppSecrets } from "../config.js";
import type { LlmExtractResult, LlmTodoCandidate, ObservationForOrganize } from "../todos/service.js";

const TODO_EXTRACTION_PROMPT = `
You extract actionable AI-Todo cards from cleaned user/assistant transcripts.

Return only JSON:
{"todos":[{"title":"...","description":"...","confidence":0.9,"sourceObservationId":"...","quote":"...","dedupeKey":"..."}]}

Rules:
- Use taskChains as the primary unit. Anchor title to the original user intent and description to the latest assistant state, blocker, or next step.
- Create todos only for unresolved, actionable work: next actions, follow-ups, failed validation, blockers, or work still in progress.
- Reject completed results, status reports, confirmations, health checks, shell/tool logs, command payloads, and process chores.
- Titles must read like mature todo app cards: short verb + object + outcome. Do not use transcript fragments.
- Put long branch names, paths, URLs, commit hashes, package names, and session ids in description, not title.
- Description is one concise sentence about remaining user-relevant work. Do not start with "I will", "我会", "现在", or "接下来".
- quote must be an exact source text span from sourceObservationId.
- dedupeKey must be a short stable slug of core action and object. Never use raw JSON, paths, logs, call ids, or trace fragments.

Good examples:
- "后续需要修复 CI 失败，并重新跑测试。" -> title "修复 CI 失败并重新跑测试"
- "clone the AI-Todo repo into the subdirectory" -> title "Clone the AI-Todo repository into the subdirectory"
- "read README and dependency config before migration" -> title "Read README and dependency configuration"
- "fix the dark mode button contrast" -> title "Fix dark mode button contrast"
- "push branch codex/current-feature to remote" -> title "推送当前工作分支到远程仓库"; keep the branch in description
- "修正目录显示文字（去掉重复编号）并更新页码缓存后重渲染" -> same intent as a single card

Negative examples:
- "做最后一次状态确认", "health check passed", "Viewer URL works", "Bash(git status) process exited 0" -> no todos
`.trim();

export function createLlmRunner(
  config: AppConfig["llm"],
  secrets: AppSecrets
): (observations: ObservationForOrganize[]) => Promise<LlmExtractResult> {
  return async (observations) => {
    if (!config.enabled || !secrets.llmApiKey) return { ok: false, warning: "llm_config_missing" };
    const visibleObservations = observations.filter((observation) =>
      observation.role === "user" || observation.role === "assistant"
    );
    const blocks = visibleObservations.map((observation) => ({
      sourceObservationId: observation.id,
      sessionId: observation.sessionId,
      timestamp: observation.createdAt,
      source: observation.source,
      role: observation.role,
      text: observation.text
    }));
    if (blocks.length === 0) return { ok: true, todos: [] };

    try {
      return {
        ok: true,
        todos: await requestTodos(config, secrets.llmApiKey, JSON.stringify({
          blocks,
          taskChains: buildTaskChains(visibleObservations)
        }))
      };
    } catch (error) {
      const reason = (error as Error).message;
      if (reason === "timeout") return { ok: false, warning: "llm_timeout", reason, retryable: true };
      if (reason === "invalid_json" || reason === "invalid_schema") {
        return { ok: false, warning: "llm_output_invalid", reason, retryable: true };
      }
      return {
        ok: false,
        warning: "llm_provider_failed",
        reason: providerFailureReason(reason),
        retryable: true
      };
    }
  };
}

function buildTaskChains(observations: ObservationForOrganize[]): Array<Record<string, unknown>> {
  const bySession = new Map<string, ObservationForOrganize[]>();
  for (const observation of observations) {
    const group = bySession.get(observation.sessionId) ?? [];
    group.push(observation);
    bySession.set(observation.sessionId, group);
  }
  const chains: Array<Record<string, unknown>> = [];
  for (const [sessionId, group] of bySession) {
    group.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let activeChain: {
      user: ObservationForOrganize;
      replies: ObservationForOrganize[];
      continuationIds: string[];
    } | null = null;
    const flush = () => {
      if (!activeChain) return;
      const latestReply = activeChain.replies.at(-1);
      const allText = [activeChain.user.text, ...activeChain.replies.map((reply) => reply.text)].join(" ");
      chains.push({
        chainId: `${sessionId}:${activeChain.user.id}`,
        sessionId,
        userObservationId: activeChain.user.id,
        userIntent: activeChain.user.text,
        assistantObservationIds: activeChain.replies.map((reply) => reply.id),
        latestAssistantObservationId: latestReply?.id,
        latestAssistantReply: latestReply?.text ?? "",
        latestStatusObservationId: latestReply?.id,
        latestStatus: latestReply?.text ?? "",
        completionState: inferCompletionState(allText),
        completionSummary: latestReply?.text ?? "",
        nextStep: inferNextStep(latestReply?.text ?? activeChain.user.text),
        observationIds: [
          activeChain.user.id,
          ...activeChain.replies.map((reply) => reply.id),
          ...activeChain.continuationIds
        ],
        dedupeKey: simpleDedupeKey(activeChain.user.text),
        source: activeChain.user.source,
        timestamp: activeChain.user.createdAt
      });
      activeChain = null;
    };
    for (const current of group) {
      if (current.role === "user") {
        if (activeChain && isLowInformationUserTurn(current.text)) {
          activeChain.continuationIds.push(current.id);
          continue;
        }
        flush();
        activeChain = { user: current, replies: [], continuationIds: [] };
        continue;
      }
      if (current.role === "assistant" && activeChain) activeChain.replies.push(current);
    }
    flush();
  }
  return chains;
}

async function requestTodos(config: AppConfig["llm"], apiKey: string, userContent: string): Promise<LlmTodoCandidate[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(chatCompletionsUrl(config.endpoint), {
      method: "POST",
      headers: {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        reasoning_effort: config.thinkingDepth,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: TODO_EXTRACTION_PROMPT },
          { role: "user", content: userContent }
        ]
      }),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`http_${response.status}`);
    return parseChatCompletionResponse(text);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new Error("timeout");
    if (isKnownRunnerError((error as Error).message)) throw error;
    throw new Error("network_error");
  } finally {
    clearTimeout(timer);
  }
}

function chatCompletionsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/u, "")}/chat/completions`;
}

function parseChatCompletionResponse(text: string): LlmTodoCandidate[] {
  const body = parseJsonRecord(text);
  const direct = parseTodoEnvelope(body);
  if (direct) return direct;

  const content = (((body.choices as unknown[])?.[0] as Record<string, unknown> | undefined)?.message as Record<string, unknown> | undefined)?.content;
  if (typeof content !== "string") throw new Error("invalid_schema");
  const envelope = parseJsonRecord(stripJsonFence(content));
  const todos = parseTodoEnvelope(envelope);
  if (!todos) throw new Error("invalid_schema");
  return todos;
}

function parseJsonRecord(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_schema");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as Error).message === "invalid_schema") throw error;
    throw new Error("invalid_json");
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return match?.[1] ?? trimmed;
}

function parseTodoEnvelope(envelope: Record<string, unknown>): LlmTodoCandidate[] | null {
  if (!Array.isArray(envelope.todos)) return null;
  const todos: LlmTodoCandidate[] = [];
  for (const item of envelope.todos) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.title !== "string" ||
      typeof record.description !== "string" ||
      typeof record.confidence !== "number" ||
      typeof record.sourceObservationId !== "string" ||
      typeof record.quote !== "string" ||
      typeof record.dedupeKey !== "string"
    ) return null;
    todos.push({
      title: record.title,
      description: record.description,
      confidence: record.confidence,
      sourceObservationId: record.sourceObservationId,
      quote: record.quote,
      dedupeKey: record.dedupeKey
    });
  }
  return todos;
}

function providerFailureReason(reason: string): string {
  if (/^http_\d{3}$/u.test(reason)) return reason;
  if (reason === "network_error") return reason;
  return "unknown_provider_error";
}

function isKnownRunnerError(reason: string): boolean {
  return reason === "timeout" ||
    reason === "invalid_json" ||
    reason === "invalid_schema" ||
    reason === "network_error" ||
    /^http_\d{3}$/u.test(reason);
}

function isLowInformationUserTurn(text: string): boolean {
  return /^(?:继续|重试|再来一次|继续推进|继续吧|retry|continue|go on|again)$/iu.test(text.trim());
}

function inferCompletionState(text: string): "completed" | "blocked" | "in_progress" | "unknown" {
  if (/(?:已完成|已通过|done|completed|fixed|resolved)/iu.test(text)) return "completed";
  if (/(?:blocked|阻塞|失败|failed|error|timeout|无法|不能)/iu.test(text)) return "blocked";
  if (/(?:剩余|remaining|下一步|next|todo|需要|will|待)/iu.test(text)) return "in_progress";
  return "unknown";
}

function inferNextStep(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const match = normalized.match(/(?:remaining|下一步|后续|还需要|需要|仍需|still remaining)[:：]?\s*([^。.!?]+[。.!?]?)/iu);
  return (match?.[1] ?? normalized).trim();
}

function simpleDedupeKey(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[`"'“”‘’]/gu, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/giu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 80) || "todo-chain";
}
