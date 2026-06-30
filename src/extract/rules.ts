import { createHash } from "node:crypto";

export interface RuleCandidate {
  title: string;
  description: string;
  mergeKey: string;
}

const ACTION_PATTERN = /\b(fix|add|implement|create|update)\b|需要|修复|添加|实现/i;

export function extractRuleCandidate(text: string): RuleCandidate | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || !ACTION_PATTERN.test(normalized)) return null;

  const title = titleFromText(normalized);
  if (!title) return null;

  return {
    title,
    description: normalized,
    mergeKey: normalizeMergeKey(title)
  };
}

function titleFromText(text: string): string {
  const withoutPrefix = text
    .replace(/^please\s+/i, "")
    .replace(/^(todo|need|needs):?\s*/i, "")
    .replace(/^to\s+/i, "")
    .replace(/^(need|needs)\s+to\s+/i, "")
    .replace(/[.!?。！？]+$/g, "")
    .trim();
  if (!ACTION_PATTERN.test(withoutPrefix)) return "";

  const sentence = withoutPrefix.split(/(?:\s+so\s+|\s+because\s+|[,;，；])/i)[0]?.trim() ?? "";
  if (!sentence) return "";
  const titled = sentence.charAt(0).toUpperCase() + sentence.slice(1, 100);
  return titled.replace(/\b(cli|api|http|json)\b/gi, (match) => match.toUpperCase());
}

function normalizeMergeKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}

export function stableId(...parts: string[]): string {
  return createHash("sha1").update(parts.join("\0")).digest("hex");
}
