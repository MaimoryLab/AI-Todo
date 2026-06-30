import assert from "node:assert/strict";
import test from "node:test";
import { extractRuleCandidate } from "../src/extract/rules.js";

test("rules extract concise titles and preserve descriptions", () => {
  const candidate = extractRuleCandidate("Please add CLI list output so users can inspect pending work.");

  assert.ok(candidate);
  assert.equal(candidate.title, "Add CLI list output");
  assert.equal(candidate.description, "Please add CLI list output so users can inspect pending work.");
});

test("rules ignore polite chatter and completed status updates", () => {
  assert.equal(extractRuleCandidate("Please take a look when you have time."), null);
  assert.equal(extractRuleCandidate("Implemented the doctor command."), null);
  assert.equal(extractRuleCandidate("Thanks, this is done now."), null);
});

test("rules produce stable merge keys for similar requests", () => {
  const first = extractRuleCandidate("Please add CLI list output");
  const second = extractRuleCandidate("Need to add cli list output.");

  assert.ok(first);
  assert.ok(second);
  assert.equal(first.mergeKey, second.mergeKey);
  assert.equal(first.title, "Add CLI list output");
});

test("rules clean todo prefixes and support Chinese action requests", () => {
  assert.equal(extractRuleCandidate("todo: fix login redirect.")?.title, "Fix login redirect");
  assert.equal(extractRuleCandidate("需要修复设置保存")?.title, "需要修复设置保存");
  assert.equal(extractRuleCandidate("请添加导出按钮")?.title, "请添加导出按钮");
  assert.equal(extractRuleCandidate("请看看这个，谢谢"), null);
});
