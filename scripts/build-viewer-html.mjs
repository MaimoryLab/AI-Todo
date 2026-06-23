#!/usr/bin/env node
// Assemble src/viewer/index.html from the ordered fragments in
// src/viewer/parts/. index.html is a GENERATED artifact: it is committed (so
// the viewer server, the build `cp`, and the tests that readFileSync it keep
// working unchanged), but its source of truth is parts/*. The assembly is a
// pure byte-for-byte concatenation in manifest order — no templating, no
// wrapping — so the viewer's runtime placeholders (__AGENTMEMORY_VIEWER_NONCE__
// / __AGENTMEMORY_VERSION__) and the strict CSP are untouched.
//
// Usage:
//   node scripts/build-viewer-html.mjs           regenerate index.html from parts/
//   node scripts/build-viewer-html.mjs --check    fail (exit 1) if index.html is stale
//   node scripts/build-viewer-html.mjs --watch    rebuild on any change under parts/
import { readFileSync, writeFileSync, watch } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const viewerDir = join(here, "..", "src", "viewer");
const partsDir = join(viewerDir, "parts");
const outFile = join(viewerDir, "index.html");

function assemble() {
  const manifest = JSON.parse(readFileSync(join(partsDir, "manifest.json"), "utf-8"));
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error("parts/manifest.json must be a non-empty array of fragment filenames");
  }
  return manifest.map((name) => readFileSync(join(partsDir, name), "utf-8")).join("");
}

const args = new Set(process.argv.slice(2));

if (args.has("--check")) {
  const expected = readFileSync(outFile, "utf-8");
  if (assemble() !== expected) {
    console.error(
      "src/viewer/index.html is out of sync with src/viewer/parts/.\n" +
        "Run `npm run viewer:build` and commit the regenerated index.html.",
    );
    process.exit(1);
  }
  console.log("viewer index.html is up to date with parts/");
} else if (args.has("--watch")) {
  const rebuild = () => {
    try {
      writeFileSync(outFile, assemble());
      console.log("rebuilt src/viewer/index.html");
    } catch (err) {
      console.error("viewer rebuild failed:", err.message);
    }
  };
  rebuild();
  watch(partsDir, { recursive: true }, rebuild);
  console.log(`watching ${partsDir} (recursive) — Ctrl+C to stop`);
} else {
  writeFileSync(outFile, assemble());
  console.log("wrote src/viewer/index.html from parts/");
}
