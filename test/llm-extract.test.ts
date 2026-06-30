import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { defaultConfig } from "../src/config.js";
import { createLlmRunner } from "../src/extract/llm-runner.js";

const observation = {
  id: "obs-1",
  sessionId: "session-1",
  source: "browser" as const,
  role: "user",
  text: "Please add LLM settings UI",
  createdAt: "2026-01-01T00:00:00.000Z"
};

const assistantObservation = {
  id: "obs-2",
  sessionId: "session-1",
  source: "browser" as const,
  role: "assistant",
  text: "The settings UI is added; the remaining work is wiring the save action.",
  createdAt: "2026-01-01T00:01:00.000Z"
};

test("LLM runner reports missing api key before provider call", async () => {
  const runner = createLlmRunner(defaultConfig().llm, {});
  assert.deepEqual(await runner([observation]), { ok: false, warning: "llm_config_missing" });
});

test("LLM runner sends OpenAI-compatible request and parses grounded todos", async () => {
  const server = await startMockProvider(async (request) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer dummy-llm-key-value");
    const payload = await readJson(request);
    assert.equal(payload.model, "test/model");
    assert.equal(payload.temperature, 0);
    assert.equal(payload.reasoning_effort, "medium");
    assert.deepEqual(payload.response_format, { type: "json_object" });
    const userMessage = payload.messages.find((message: any) => message.role === "user");
    const userPayload = JSON.parse(userMessage.content);
    assert.equal(userPayload.blocks[0].sourceObservationId, "obs-1");
    assert.equal(userPayload.taskChains[0].latestAssistantReply, assistantObservation.text);
    assert.equal(userPayload.taskChains[0].completionState, "in_progress");
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            todos: [{
              title: "Add LLM settings UI",
              description: "Wire the save action after the LLM settings UI is added.",
              metadata: {
                completionState: "in_progress",
                completionSummary: "The settings UI is added; save action wiring remains.",
                nextStep: "Wire the save action.",
                sourceObservationId: "obs-2"
              },
              confidence: 0.91,
              sourceObservationId: "obs-1",
              quote: "Please add LLM settings UI",
              dedupeKey: "add-llm-settings-ui"
            }]
          })
        }
      }]
    });
  });

  try {
    const runner = createLlmRunner(
      { ...defaultConfig().llm, model: "test/model", endpoint: server.url("/v1") },
      { llmApiKey: "dummy-llm-key-value" }
    );
    const result = await runner([observation, assistantObservation]);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.todos[0].title, "Add LLM settings UI");
    assert.equal(result.ok && result.todos[0].metadata?.completionSummary, "The settings UI is added; save action wiring remains.");
    assert.equal(result.ok && result.todos[0].metadata?.nextStep, "Wire the save action.");
  } finally {
    await server.close();
  }
});

test("LLM runner keeps title anchored to user intent and metadata to agent progress", async () => {
  const server = await startMockProvider(async (request) => {
    const payload = await readJson(request);
    const systemMessage = payload.messages.find((message: any) => message.role === "system");
    assert.match(systemMessage.content, /title is a concise summary of the user's requested outcome/);
    assert.match(systemMessage.content, /metadata\.completionSummary/);
    return jsonResponse({
      choices: [{
        message: {
          content: JSON.stringify({
            todos: [{
              title: "Add LLM settings UI",
              description: "Finish wiring the saved LLM settings path.",
              metadata: {
                completionState: "in_progress",
                completionSummary: "The settings UI is added; the save action is still remaining."
              },
              confidence: 0.9,
              sourceObservationId: "obs-1",
              quote: "Please add LLM settings UI",
              dedupeKey: "add-llm-settings-ui"
            }]
          })
        }
      }]
    });
  });

  try {
    const runner = createLlmRunner(
      { ...defaultConfig().llm, model: "test/model", endpoint: server.url("/v1") },
      { llmApiKey: "dummy-llm-key-value" }
    );
    const result = await runner([observation, assistantObservation]);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.todos[0].title, "Add LLM settings UI");
    assert.notEqual(result.ok && result.todos[0].title, assistantObservation.text);
    assert.equal(result.ok && result.todos[0].metadata?.completionSummary, "The settings UI is added; the save action is still remaining.");
  } finally {
    await server.close();
  }
});

test("LLM runner merges low-information continuation turns into previous task chain", async () => {
  const server = await startMockProvider(async (request) => {
    const payload = await readJson(request);
    const userMessage = payload.messages.find((message: any) => message.role === "user");
    const userPayload = JSON.parse(userMessage.content);
    assert.equal(userPayload.taskChains.length, 1);
    assert.ok(userPayload.taskChains[0].observationIds.includes("obs-3"));
    return jsonResponse({ todos: [] });
  });

  try {
    const runner = createLlmRunner(
      { ...defaultConfig().llm, endpoint: server.url("") },
      { llmApiKey: "dummy-llm-key-value" }
    );
    const result = await runner([
      observation,
      assistantObservation,
      {
        id: "obs-3",
        sessionId: "session-1",
        source: "browser" as const,
        role: "user",
        text: "continue",
        createdAt: "2026-01-01T00:02:00.000Z"
      },
      {
        id: "obs-4",
        sessionId: "session-1",
        source: "browser" as const,
        role: "assistant",
        text: "Still remaining: wire the save action.",
        createdAt: "2026-01-01T00:03:00.000Z"
      }
    ]);
    assert.deepEqual(result, { ok: true, todos: [] });
  } finally {
    await server.close();
  }
});

test("LLM runner maps invalid model output to output warning", async () => {
  const server = await startMockProvider(async () => jsonResponse({
    choices: [{ message: { content: "not json" } }]
  }));

  try {
    const runner = createLlmRunner(
      { ...defaultConfig().llm, endpoint: server.url("") },
      { llmApiKey: "dummy-llm-key-value" }
    );
    assert.deepEqual(await runner([observation]), {
      ok: false,
      warning: "llm_output_invalid",
      reason: "invalid_json",
      retryable: true
    });
  } finally {
    await server.close();
  }
});

test("LLM runner preserves HTTP provider failure reasons", async () => {
  const server = await startMockProvider(async () => ({ status: 401, body: { error: "bad key" } }));

  try {
    const runner = createLlmRunner(
      { ...defaultConfig().llm, endpoint: server.url("") },
      { llmApiKey: "dummy-llm-key-value" }
    );
    assert.deepEqual(await runner([observation]), {
      ok: false,
      warning: "llm_provider_failed",
      reason: "http_401",
      retryable: true
    });
  } finally {
    await server.close();
  }
});

test("LLM runner maps slow provider calls to timeout", async () => {
  const server = await startMockProvider(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    return jsonResponse({ todos: [] });
  });

  try {
    const runner = createLlmRunner(
      { ...defaultConfig().llm, endpoint: server.url(""), timeoutMs: 10 },
      { llmApiKey: "dummy-llm-key-value" }
    );
    assert.deepEqual(await runner([observation]), {
      ok: false,
      warning: "llm_timeout",
      reason: "timeout",
      retryable: true
    });
  } finally {
    await server.close();
  }
});

function jsonResponse(body: unknown, status = 200) {
  return { status, body };
}

async function startMockProvider(
  handler: (request: IncomingMessage) => Promise<{ status: number; body: unknown }>
) {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const result = await handler(request);
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: (path: string) => `http://127.0.0.1:${address.port}${path}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

async function readJson(request: IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}
