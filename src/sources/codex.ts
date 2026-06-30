import type { Database } from "../db/index.js";
import { scanJsonlSource } from "./jsonl-source.js";

export function scanCodexSessions(db: Database, root: string) {
  return scanJsonlSource(db, "codex", root);
}
