export async function api<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(userFacingError(data?.error ?? data?.message ?? "Request failed"));
  }
  return data as T;
}

export function userFacingError(error: string): string {
  if (error === "llm_config_missing") return "Extraction needs setup.";
  if (error === "path_not_found") return "Source path needs setup.";
  if (error === "config_invalid") return "Settings need review.";
  if (error === "database_unavailable") return "Local database is unavailable.";
  if (error === "organize_failed") return "Organize failed. Open diagnostics for details.";
  return error.replace(/_/g, " ");
}
