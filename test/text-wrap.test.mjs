import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// text-wrap.js is a classic browser script, so load it into a bare context the way a page would.
const context = {};
vm.runInNewContext(readFileSync(new URL("../web/text-wrap.js", import.meta.url), "utf-8"), context);
// Arrays made inside the vm context are from another realm, so copy them into this one for deep equality.
const wrapWithEllipsis = (...args) => [...context.wrapWithEllipsis(...args)];

test("short text stays on one line", () => {
  assert.deepEqual(wrapWithEllipsis("Refunds spiked", 30, 2), ["Refunds spiked"]);
});

test("longer text wraps at word boundaries onto a second line", () => {
  assert.deepEqual(wrapWithEllipsis("A spike in refunds caused the revenue drop", 30, 2), ["A spike in refunds caused the", "revenue drop"]);
});

test("text that exactly fills the lines is not given an ellipsis", () => {
  assert.deepEqual(wrapWithEllipsis("aaaaa bbbbb ccccc ddddd", 11, 2), ["aaaaa bbbbb", "ccccc ddddd"]);
});

test("text that does not fit is cut on the last line with an ellipsis, and no line is over the limit", () => {
  const lines = wrapWithEllipsis("A drop in paid ad spend (starting 2026-09-12) reduced sessions and caused the revenue drop", 30, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith("…"));
  assert.ok(lines.every((line) => line.length <= 30));
  assert.equal(lines[0], "A drop in paid ad spend");
});

test("two hypotheses on the same evidence read differently even when cut (the reason the line exists)", () => {
  const spend = wrapWithEllipsis("A drop in paid ad spend reduced sessions and caused the revenue drop", 30, 2);
  const conversion = wrapWithEllipsis("A site outage or drop in conversion rate caused the revenue drop", 30, 2);
  assert.notDeepEqual(spend, conversion);
});

test("a single word longer than a line is cut to fit instead of overflowing the card (edge case: long token)", () => {
  const lines = wrapWithEllipsis("Supercalifragilisticexpialidocious-and-then-some", 20, 2);
  assert.ok(lines.every((line) => line.length <= 20));
  assert.ok(lines[0].endsWith("…"));
});

test("an ellipsis never pushes the last line past the limit", () => {
  const lines = wrapWithEllipsis("aaaaaaaaaaaa bbbbbbbbbbbb cccccccccccc", 12, 2);
  assert.ok(lines.every((line) => line.length <= 12));
  assert.ok(lines.at(-1).endsWith("…"));
});

test("a single-line limit cuts the text to one line", () => {
  assert.deepEqual(wrapWithEllipsis("one two three four", 9, 1), ["one two…"]);
});

test("missing, empty, or whitespace-only text gives no lines instead of throwing (invalid input case)", () => {
  assert.deepEqual(wrapWithEllipsis(undefined, 30, 2), []);
  assert.deepEqual(wrapWithEllipsis(null, 30, 2), []);
  assert.deepEqual(wrapWithEllipsis("", 30, 2), []);
  assert.deepEqual(wrapWithEllipsis("   \n  ", 30, 2), []);
});

test("extra spaces and newlines are collapsed", () => {
  assert.deepEqual(wrapWithEllipsis("  refunds   spiked \n today ", 30, 2), ["refunds spiked today"]);
});
