import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("organize button shows busy state and estimated duration copy", () => {
  const js = readFileSync("public/app.js", "utf8");
  const css = readFileSync("public/app.css", "utf8");

  assert.match(js, /button\.classList\.add\("is-busy"\)/);
  assert.match(js, /button\.setAttribute\("aria-busy", "true"\)/);
  assert.match(js, /button\.textContent = "Organizing\.\.\."/);
  assert.match(js, /This may take about/);
  assert.match(js, /only the newest/);
  assert.match(js, /organize\.maxSessions \?\? 16/);
  assert.match(css, /button\.primary\.is-busy/);
  assert.match(css, /@keyframes spin/);
});
