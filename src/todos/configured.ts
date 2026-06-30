import { loadConfig, loadSecrets } from "../config.js";
import type { Database } from "../db/index.js";
import { createLlmRunner } from "../extract/llm-runner.js";
import type { AppPaths } from "../paths.js";
import { organizeTodos, type OrganizeOptions } from "./service.js";

export async function organizeConfiguredTodos(
  db: Database,
  paths: AppPaths,
  options: OrganizeOptions = {}
) {
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  return organizeTodos(db, {
    ...options,
    scope: options.scope ?? config.organize,
    llmExtractor: options.llmExtractor ?? createLlmRunner(config.llm, secrets)
  });
}

export interface LlmDoctorStatus {
  enabled: boolean;
  keyConfigured: boolean;
  model: string;
  endpoint: string;
}

export function getLlmDoctorStatus(paths: AppPaths): LlmDoctorStatus {
  const config = loadConfig(paths);
  const secrets = loadSecrets(paths);
  return {
    enabled: config.llm.enabled,
    keyConfigured: !!secrets.llmApiKey,
    model: config.llm.model,
    endpoint: config.llm.endpoint
  };
}
