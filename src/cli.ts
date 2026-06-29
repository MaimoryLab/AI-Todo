#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { openDatabase } from "./db/index.js";
import { getAppPaths } from "./paths.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = argv[0] ?? "doctor";

  if (command === "doctor") {
    const paths = getAppPaths();
    mkdirSync(paths.configDir, { recursive: true });
    mkdirSync(paths.dataDir, { recursive: true });
    openDatabase(paths).close();
    console.log(`config: ${paths.configDir}`);
    console.log(`data: ${paths.dataDir}`);
    console.log("ok");
    return 0;
  }

  if (command === "open") {
    console.log("ai-todo viewer is not implemented yet");
    return 0;
  }

  console.error(`unknown command: ${command}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main();
}
