import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKV, mockSdk } from "./helpers/mocks.js";
import { KV } from "../src/state/schema.js";
import type { ScanCheckpoint } from "../src/types.js";
import { getSearchIndex } from "../src/functions/search.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../src/functions/audit.js", () => ({ safeAudit: vi.fn() }));

// Wrap ingestJsonlFile so we can assert reads / inject failures, keeping
// everything else in replay.ts (isSensitive/isSymlink/findJsonlFiles) real.
const { ingestSpy } = vi.hoisted(() => ({ ingestSpy: vi.fn() }));
vi.mock("../src/functions/replay.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/functions/replay.js")>();
  ingestSpy.mockImplementation(actual.ingestJsonlFile);
  return { ...actual, ingestJsonlFile: ingestSpy };
});

import {
  registerSourceScanFunctions,
  scanCodexSource,
  type CodexScanResult,
} from "../src/functions/source-scan-codex.js";

const fixture = readFileSync(join(__dirname, "fixtures/jsonl", "codex-session.jsonl"), "utf-8");

let dir: string;
beforeEach(async () => {
  getSearchIndex().clear();
  ingestSpy.mockClear();
  dir = await mkdtemp(join(tmpdir(), "codex-scan-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scanCodexSource", () => {
  it("ingests new files, then skips unchanged files WITHOUT re-reading them", async () => {
    const kv = mockKV();
    const file = join(dir, "rollout-1.jsonl");
    await writeFile(file, fixture);

    const first = await scanCodexSource(kv as never, { path: dir });
    expect(first.imported).toBe(1);
    expect(first.sessionIds).toEqual(["codex-real-session"]);
    expect(ingestSpy).toHaveBeenCalledTimes(1);

    const cp = await kv.get<ScanCheckpoint>(KV.scanCheckpoints, "codex");
    expect(cp?.lastSuccessAt).toBeTruthy();
    expect(JSON.parse(cp!.cursor)[file]).toMatchObject({ size: expect.any(Number) });

    ingestSpy.mockClear();
    const second = await scanCodexSource(kv as never, { path: dir });
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(ingestSpy).not.toHaveBeenCalled(); // unchanged file was never read
  });

  it("re-reads a file after it changes (grows)", async () => {
    const kv = mockKV();
    const file = join(dir, "rollout-1.jsonl");
    await writeFile(file, fixture);
    await scanCodexSource(kv as never, { path: dir });

    ingestSpy.mockClear();
    await writeFile(file, `${fixture}\n${fixture.split("\n")[0]}`); // grow -> size changes
    const rescan = await scanCodexSource(kv as never, { path: dir });
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    expect(rescan.skipped).toBe(0);
  });

  it("records a failed file, keeps the batch going, and retries it next scan", async () => {
    const kv = mockKV();
    await writeFile(join(dir, "a.jsonl"), fixture);
    await writeFile(join(dir, "b.jsonl"), fixture);

    ingestSpy.mockImplementationOnce(() => {
      throw new Error("boom");
    }); // first file processed throws; the batch must continue

    const scan = await scanCodexSource(kv as never, { path: dir });
    expect(scan.errors).toBe(1);
    expect(scan.scanned).toBe(2);

    const cp = await kv.get<ScanCheckpoint>(KV.scanCheckpoints, "codex");
    expect(cp?.lastError).toContain("boom");
    expect(Object.keys(JSON.parse(cp!.cursor))).toHaveLength(1); // only the file that succeeded

    ingestSpy.mockClear();
    await scanCodexSource(kv as never, { path: dir });
    expect(ingestSpy).toHaveBeenCalledTimes(1); // the previously-failed file is retried
  });

  it("runs via the registered mem::source-scan::codex trigger (what auto-scan invokes)", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerSourceScanFunctions(sdk as never, kv as never);
    await writeFile(join(dir, "rollout-1.jsonl"), fixture);

    const res = (await sdk.trigger("mem::source-scan::codex", { path: dir })) as CodexScanResult;
    expect(res.success).toBe(true);
    expect(res.imported).toBe(1);
    expect(res.sessionIds).toEqual(["codex-real-session"]);
  });
});
