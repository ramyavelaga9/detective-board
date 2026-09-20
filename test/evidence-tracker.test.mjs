import { test } from "node:test";
import assert from "node:assert/strict";
import { createEvidenceTracker } from "../src/evidence-tracker.mjs";

test("latestFor returns the most recent result of a tool, so a repeated call pairs with its own verdict", () => {
  const tracker = createEvidenceTracker();
  tracker.record("get_inventory_status", '{"sku":"SKU-447","stock":0}');
  tracker.record("get_inventory_status", '{"sku":"SKU-101","stock":140}');
  assert.equal(tracker.latestFor("get_inventory_status"), '{"sku":"SKU-101","stock":140}');
});

test("each tool's evidence is tracked independently", () => {
  const tracker = createEvidenceTracker();
  tracker.record("get_weather", '{"severe":false}');
  tracker.record("get_refund_events", "[]");
  assert.equal(tracker.latestFor("get_weather"), '{"severe":false}');
  assert.equal(tracker.latestFor("get_refund_events"), "[]");
});

test("latestFor is undefined for a tool that has not run (edge case: verdict before its evidence)", () => {
  assert.equal(createEvidenceTracker().latestFor("get_weather"), undefined);
});

test("an empty or whitespace result is not evidence and clears the tool's older entry (invalid input case)", () => {
  const tracker = createEvidenceTracker();
  tracker.record("get_weather", '{"severe":false}');
  tracker.record("get_weather", "   ");
  assert.equal(tracker.latestFor("get_weather"), undefined);
});

test("an error result clears the tool's entry, so a verdict on a failed call is not paired with older evidence (edge case: errored result)", () => {
  const tracker = createEvidenceTracker();
  tracker.record("get_inventory_status", '{"sku":"SKU-447","stock":0}');
  tracker.record("get_inventory_status", '{"error":[{"type":"text","text":"No SKU found with id SKU-9"}]}');
  assert.equal(tracker.latestFor("get_inventory_status"), undefined);
});

test("a non-string result is ignored instead of throwing (invalid input case)", () => {
  const tracker = createEvidenceTracker();
  assert.doesNotThrow(() => tracker.record("get_weather", undefined));
  assert.equal(tracker.latestFor("get_weather"), undefined);
});

test("separate trackers do not share state", () => {
  const first = createEvidenceTracker();
  first.record("get_weather", "{}");
  assert.equal(createEvidenceTracker().latestFor("get_weather"), undefined);
});
