import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const requirements = join(root, "requirements-langextract.txt");
const venv = join(root, ".agentmemory-python");
const python = process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python");

function run(command, args) {
  return spawnSync(command, args, { stdio: "inherit" });
}

if (!existsSync(requirements)) {
  process.stderr.write("[agentmemory] requirements-langextract.txt not found; skipping LangExtract setup.\n");
  process.exit(0);
}

if (!existsSync(python)) {
  const created = run("python3", ["-m", "venv", venv]);
  if (created.status !== 0) {
    process.stderr.write("[agentmemory] Could not create .agentmemory-python venv; set LANGEXTRACT_PYTHON manually.\n");
    process.exit(0);
  }
}

const installed = run(python, ["-m", "pip", "install", "-r", requirements]);
if (installed.status !== 0) {
  process.stderr.write("[agentmemory] LangExtract Python deps were not installed; set LANGEXTRACT_PYTHON manually.\n");
  process.exit(0);
}

