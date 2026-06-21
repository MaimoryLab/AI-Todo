import { createHash } from "node:crypto";

export const KV = {
  sessions: "mem:sessions",
  observations: (sessionId: string) => `mem:obs:${sessionId}`,
  memories: "mem:memories",
  summaries: "mem:summaries",
  config: "mem:config",
  metrics: "mem:metrics",
  health: "mem:health",
  embeddings: (obsId: string) => `mem:emb:${obsId}`,
  bm25Index: "mem:index:bm25",
  relations: "mem:relations",
  profiles: "mem:profiles",
  claudeBridge: "mem:claude-bridge",
  graphNodes: "mem:graph:nodes",
  graphEdges: "mem:graph:edges",
  semantic: "mem:semantic",
  procedural: "mem:procedural",
  teamShared: (teamId: string) => `mem:team:${teamId}:shared`,
  teamUsers: (teamId: string, userId: string) =>
    `mem:team:${teamId}:users:${userId}`,
  teamProfile: (teamId: string) => `mem:team:${teamId}:profile`,
  audit: "mem:audit",
  actions: "mem:actions",
  actionEdges: "mem:action-edges",
  leases: "mem:leases",
  routines: "mem:routines",
  routineRuns: "mem:routine-runs",
  signals: "mem:signals",
  inbox: "mem:inbox",
  delivery: "mem:delivery",
  checkpoints: "mem:checkpoints",
  mesh: "mem:mesh",
  sketches: "mem:sketches",
  facets: "mem:facets",
  sentinels: "mem:sentinels",
  crystals: "mem:crystals",
  lessons: "mem:lessons",
  reviewQueue: "mem:review-queue",
  insights: "mem:insights",
  graphEdgeHistory: "mem:graph:edge-history",
  enrichedChunks: (sessionId: string) => `mem:enriched:${sessionId}`,
  latentEmbeddings: (obsId: string) => `mem:latent:${obsId}`,
  retentionScores: "mem:retention",
  accessLog: "mem:access",
  imageRefs: "mem:image-refs",
  imageEmbeddings: "mem:image-embeddings",
  slots: "mem:slots",
  globalSlots: "mem:slots:global",
  state: "mem:state",
  commits: "mem:commits",
  sources: "mem:sources",
  scanCheckpoints: "mem:scan-checkpoints",
} as const;

export const STREAM = {
  name: "mem-live",
  group: (sessionId: string) => sessionId,
  viewerGroup: "viewer",
} as const;

export function generateId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}_${ts}_${rand}`;
}

export function fingerprintId(prefix: string, content: string): string {
  const hash = createHash("sha256").update(content).digest("hex");
  return `${prefix}_${hash.slice(0, 16)}`;
}

export function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\s+/).filter((t) => t.length > 2));
  const setB = new Set(b.split(/\s+/).filter((t) => t.length > 2));
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

// Canonical form used for BOTH similarity scoring and the length floor:
// lowercased, whitespace + punctuation/symbols stripped. The floor must see
// the same string the scorer does, or a whitespace-inflated short title (e.g.
// "fix ci" → "fixci", 5 chars) sneaks past a raw-length gate into the unstable
// sub-floor band and wrongly collapses with "fix cd".
function similarityChars(value: string): string {
  return String(value || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * Sørensen–Dice similarity over adjacent-character bigrams. Unlike
 * {@link jaccardSimilarity} (which splits on whitespace and so collapses a
 * whole space-free Chinese sentence into a single token), this works for CJK
 * text — the near-duplicate todo titles the rules/LLM extractors emit are
 * mostly Chinese. Strings are lowercased and stripped of whitespace and
 * punctuation/symbols first. Identical content → 1; disjoint → 0. Strings
 * shorter than 2 chars (no bigrams) fall back to exact equality.
 */
export function charBigramSimilarity(a: string, b: string): number {
  const ca = Array.from(similarityChars(a));
  const cb = Array.from(similarityChars(b));
  if (ca.length === 0 && cb.length === 0) return 1;
  if (ca.length < 2 || cb.length < 2) return ca.join("") === cb.join("") ? 1 : 0;
  const bigrams = (chars: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (let i = 0; i < chars.length - 1; i++) {
      const gram = chars[i] + chars[i + 1];
      counts.set(gram, (counts.get(gram) || 0) + 1);
    }
    return counts;
  };
  const ma = bigrams(ca);
  const mb = bigrams(cb);
  let overlap = 0;
  for (const [gram, count] of ma) {
    const other = mb.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  const total = ca.length - 1 + (cb.length - 1);
  return total === 0 ? 0 : (2 * overlap) / total;
}

// Near-duplicate todo-title policy. Surface similarity alone over-collapses:
// a single negation ("支持…" vs "不支持…"), a different number/version
// ("v2" vs "v3", "Node 18" vs "Node 20"), or one differing English word
// ("login" vs "logout") barely dents the bigram score yet flips the meaning.
// So we require BOTH high surface similarity AND the absence of any *salient*
// discriminator. The 0.70 bar is set above the ~0.667 band of pure two-char
// CJK substitutions (项目/仓库, 失效/超时 — possibly distinct tasks, kept apart)
// and below the ~0.74–0.95 band of insertions / word reorderings (genuine
// rewordings of one task). Tunable here in one place; both extractors call it.
const NEAR_DUP_THRESHOLD = 0.7;
const NEAR_DUP_MIN_CHARS = 6;
const LATIN_STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "and", "or", "with",
  "is", "be", "this", "that", "at", "by", "fix", "add", "update", "remove",
  "create", "support", "enable",
]);

function negationCount(text: string): number {
  let count = 0;
  const cjk = text.match(/[不未别勿无無非否莫禁]/gu);
  if (cjk) count += cjk.length;
  const latin = text
    .toLowerCase()
    .replace(/['’]/g, "")
    .match(/\b(no|not|never|without|none|off|cannot|cant|dont|doesnt|wont|isnt|disable|disabled|hide|hidden)\b/g);
  if (latin) count += latin.length;
  return count;
}

function numericTokens(text: string): string[] {
  const tokens: string[] = [];
  const nums = text.toLowerCase().match(/v?\d+(?:\.\d+)*/g);
  if (nums) tokens.push(...nums);
  const cjkOrdinals = text.match(/第[一二三四五六七八九十百零〇0-9]+|[一二三四五六七八九十][阶章期版步代号]/gu);
  if (cjkOrdinals) tokens.push(...cjkOrdinals);
  return tokens.sort();
}

function latinContentWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || [];
  return new Set(words.filter((word) => !LATIN_STOPWORDS.has(word)));
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameStringSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/**
 * True when two todo titles are near-duplicate rewordings of the SAME task.
 * Conservative by design: requires {@link charBigramSimilarity} ≥ 0.70 AND no
 * salient discriminator — a polarity flip, a differing number/version/ordinal,
 * or a differing Latin content word each VETO the collapse so distinct tasks
 * are never silently merged. Titles whose canonical form is shorter than 6
 * chars (unstable under bigram similarity) are never treated as near-dupes.
 *
 * The discriminators err toward keeping titles APART: a surviving duplicate is
 * cheap to dismiss, a wrong merge loses work. So some genuine rewordings are
 * intentionally NOT collapsed — version-format drift (v2.0 vs 2.0, 1.2.0 vs
 * 1.2), English inflection (add vs adds), and feature morphemes counted as
 * negation (无密码 vs 免密码). That recall loss is the accepted tradeoff.
 * Inputs should be normalized (lowercased, punctuation-stripped) titles.
 */
export function nearDuplicateTitle(a: string, b: string): boolean {
  if (Array.from(similarityChars(a)).length < NEAR_DUP_MIN_CHARS ||
      Array.from(similarityChars(b)).length < NEAR_DUP_MIN_CHARS) {
    return false;
  }
  if (charBigramSimilarity(a, b) < NEAR_DUP_THRESHOLD) return false;
  if (negationCount(a) !== negationCount(b)) return false;
  if (!sameStringList(numericTokens(a), numericTokens(b))) return false;
  if (!sameStringSet(latinContentWords(a), latinContentWords(b))) return false;
  return true;
}
