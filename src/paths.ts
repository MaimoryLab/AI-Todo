import { homedir } from "node:os";
import { join } from "node:path";

export interface AppPaths {
  configDir: string;
  dataDir: string;
  dbPath: string;
}

export function getAppPaths(baseDir = process.env.AI_TODO_HOME ?? join(homedir(), ".ai-todo")): AppPaths {
  const dataDir = join(baseDir, "data");
  return {
    configDir: baseDir,
    dataDir,
    dbPath: join(dataDir, "ai-todo.sqlite")
  };
}
