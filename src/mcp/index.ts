import type { Database } from "../db/index.js";
import { getAppPaths, type AppPaths } from "../paths.js";
import { scanSource } from "../sources/scan.js";
import { organizeConfiguredTodos } from "../todos/configured.js";
import { listTodos, type OrganizeOptions, updateTodoStatus } from "../todos/service.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function listMcpTools(): McpTool[] {
  return [
    {
      name: "todo_scan",
      description: "Scan Codex or Claude Code session JSONL files into AI-Todo.",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["codex", "claude-code"] },
          path: { type: "string" }
        },
        required: ["source"]
      }
    },
    {
      name: "todo_organize",
      description: "Organize observations into evidence-grounded todo cards.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "todo_list",
      description: "List current todo cards.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "todo_update",
      description: "Mark a todo as done or ignored.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["done", "ignored"] }
        },
        required: ["id", "status"]
      }
    },
    {
      name: "todo_open",
      description: "Open the AI-Todo viewer when available.",
      inputSchema: { type: "object", properties: {} }
    }
  ];
}

export async function callMcpTool(
  db: Database,
  name: string,
  args: unknown,
  paths: AppPaths = getAppPaths(),
  options: { organizeOptions?: OrganizeOptions } = {}
): Promise<any> {
  const input = objectArgs(args);

  if (name === "todo_scan") {
    const scan = scanSource(db, input.source, input.path, paths);
    if (!scan.ok) throw new Error(scan.error === "unsupported_source" ? "unsupported source" : "path not found");
    return scan.result;
  }

  if (name === "todo_organize") {
    return await organizeConfiguredTodos(db, paths, options.organizeOptions);
  }

  if (name === "todo_list") {
    return listTodos(db);
  }

  if (name === "todo_update") {
    if (typeof input.id !== "string" || !input.id) throw new Error("missing todo id");
    if (input.status !== "done" && input.status !== "ignored") throw new Error("invalid status");
    if (!updateTodoStatus(db, input.id, input.status)) throw new Error("todo not found");
    return listTodos(db).find((todo) => todo.id === input.id);
  }

  if (name === "todo_open") {
    return { opened: false, message: "run ai-todo open to start the local UI" };
  }

  throw new Error(`unknown tool: ${name}`);
}

function objectArgs(args: unknown): Record<string, unknown> {
  return args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
}
