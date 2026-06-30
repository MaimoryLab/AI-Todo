import { readFileSync } from "node:fs";

export interface JsonlRecord {
  value: Record<string, unknown>;
  line: number;
}

export function parseJsonl(text: string): JsonlRecord[] {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line, index: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .map(({ line, index }) => {
      try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("record is not an object");
        }
        return { value, line: index };
      } catch (error) {
        throw new Error(`Invalid JSONL at line ${index}: ${(error as Error).message}`);
      }
    });
}

export function readJsonlFile(path: string): JsonlRecord[] {
  return parseJsonl(readFileSync(path, "utf8"));
}
