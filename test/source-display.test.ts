import assert from "node:assert/strict";
import test from "node:test";
import { attachmentMarkdownText, attachmentViewsFromText } from "../src/attachments.js";
import { sourceDisplayText } from "../src/web/src/components/observation-text.js";

test("sourceDisplayText keeps attachment lines available for rendering", () => {
  assert.equal(
    sourceDisplayText("Image: Image #1 (/var/folders/demo/codex-clipboard.png)"),
    "Image: Image #1 (/var/folders/demo/codex-clipboard.png)"
  );
  assert.equal(
    sourceDisplayText("Files mentioned: brief.md (/home/example/Documents/brief.md)"),
    "Files mentioned: brief.md (/home/example/Documents/brief.md)"
  );
  assert.equal(
    sourceDisplayText("File: notes.md (~/Downloads/notes.md)"),
    "File: notes.md (~/Downloads/notes.md)"
  );
  assert.equal(
    sourceDisplayText("Image: screenshot (C:\\Users\\ppio\\AppData\\Local\\Temp\\screenshot.png)"),
    "Image: screenshot (C:\\Users\\ppio\\AppData\\Local\\Temp\\screenshot.png)"
  );
});

test("sourceDisplayText preserves non-attachment text", () => {
  const text = [
    "Use /var/tmp/cache in the example.",
    "",
    "```",
    "Image: Image #1 (/var/folders/demo/codex-clipboard.png)",
    "```",
    "Link: https://example.com/image.png"
  ].join("\n");

  assert.equal(sourceDisplayText(text), text);
});

test("sourceDisplayText summarizes turn-aborted system events", () => {
  assert.equal(
    sourceDisplayText("<turn_aborted> The user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. </turn_aborted>"),
    "Turn interrupted by the user."
  );
});

test("attachmentViewsFromText parses attachment lines without rewriting ordinary links", () => {
  const text = [
    "Image: Screenshot (/tmp/screenshot.png)",
    "Files mentioned: brief.md (/home/example/Documents/brief.md)",
    "Link: https://example.com/image.png"
  ].join("\n");

  assert.deepEqual(attachmentViewsFromText(text), [
    { index: 0, kind: "image", label: "Screenshot", path: "/tmp/screenshot.png" },
    { index: 1, kind: "file", label: "brief.md", path: "/home/example/Documents/brief.md" }
  ]);
  assert.equal(attachmentMarkdownText(text), [
    "![Screenshot](/attachments?observationId=obs-1&index=0)",
    "[brief.md](/attachments?observationId=obs-1&index=1)",
    "Link: https://example.com/image.png"
  ].join("\n"));
});

test("attachmentMarkdownText leaves remote attachments on their original URL", () => {
  assert.equal(
    attachmentMarkdownText("Image: Remote (https://example.com/image.png)", "obs-2"),
    "![Remote](https://example.com/image.png)"
  );
});
