import type { Database } from "../db/index.js";
import { scanJsonlSource } from "./jsonl-source.js";

export function scanClaudeCodeSessions(db: Database, root: string) {
  return scanJsonlSource(db, "claude-code", root);
}
