import { createInterface } from "node:readline";
import type { Database } from "../db/index.js";
import { openDatabase } from "../db/index.js";
import { getAppPaths } from "../paths.js";
import { callMcpTool, listMcpTools } from "./index.js";

interface JsonRpcRequest {
  id?: string | number | null;
  method?: string;
  params?: any;
}

export async function runMcpStdio(): Promise<void> {
  const paths = getAppPaths();
  const db = openDatabase(paths);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const response = await handleJsonRpcLine(db, line, paths);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    db.close();
  }
}

export async function handleJsonRpcLine(db: Database, line: string, paths = getAppPaths()): Promise<unknown | null> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }

  if (request.method === "notifications/initialized") return null;

  try {
    if (request.method === "initialize") {
      return successResponse(request.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ai-todo", version: "0.1.0" }
      });
    }

    if (request.method === "tools/list") {
      return successResponse(request.id, { tools: listMcpTools() });
    }

    if (request.method === "tools/call") {
      const result = await callMcpTool(db, request.params?.name, request.params?.arguments ?? {}, paths);
      return successResponse(request.id, {
        content: [{ type: "text", text: JSON.stringify(result) }]
      });
    }

    return errorResponse(request.id, -32601, "Method not found");
  } catch (error) {
    return errorResponse(request.id, -32000, (error as Error).message);
  }
}

function successResponse(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function errorResponse(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
