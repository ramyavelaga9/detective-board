import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolCallAccumulator, resolveActualToolCall } from "../src/tool-call-accumulator.mjs";

test("accumulates a name and arguments streamed across several deltas", () => {
  const acc = createToolCallAccumulator();
  acc.applyDelta({ index: 0, id: "call_1", function: { name: "get_inventory", arguments: "" } });
  acc.applyDelta({ index: 0, function: { name: "_status", arguments: '{"sku":' } });
  const call = acc.applyDelta({ index: 0, function: { arguments: '"SKU-447"}' } });
  assert.equal(call.name, "get_inventory_status");
  assert.equal(call.args, '{"sku":"SKU-447"}');
  assert.equal(call.id, "call_1");
});

test("a call's id stays stable even when later deltas omit it", () => {
  const acc = createToolCallAccumulator();
  acc.applyDelta({ index: 0, id: "call_1", function: { name: "get_weather" } });
  const second = acc.applyDelta({ index: 0, function: { arguments: '{"region":"west"}' } });
  assert.equal(second.id, "call_1", "the real id must not be replaced by an index fallback on a later delta");
});

test("a second round reusing the same stream index does not concatenate onto a finished call (the real bug this fixes)", () => {
  const acc = createToolCallAccumulator();
  acc.applyDelta({ index: 0, id: "call_round1", function: { name: "get_revenue_deviation", arguments: "{}" } });
  acc.complete("call_round1");
  const call = acc.applyDelta({ index: 0, id: "call_round2", function: { name: "get_weather", arguments: "{}" } });
  assert.equal(call.name, "get_weather", "must not be 'get_revenue_deviationget_weather'");
  assert.equal(call.args, "{}");
});

test("getById finds a call only after its real id has been seen (invalid input case)", () => {
  const acc = createToolCallAccumulator();
  assert.equal(acc.getById("call_never_seen"), undefined);
  acc.applyDelta({ index: 0, id: "call_1", function: { name: "record_hypothesis_verdict" } });
  assert.equal(acc.getById("call_1").name, "record_hypothesis_verdict");
});

test("complete() on an unknown id is a no-op, not a throw", () => {
  const acc = createToolCallAccumulator();
  assert.doesNotThrow(() => acc.complete("never-existed"));
});

test("resolveActualToolCall passes through a direct call unchanged", () => {
  const resolved = resolveActualToolCall({ name: "propose_restock_action", args: '{"sku":"SKU-447"}' });
  assert.equal(resolved.name, "propose_restock_action");
  assert.equal(resolved.args, '{"sku":"SKU-447"}');
});

test("resolveActualToolCall unwraps TrueForge's call_tool meta-tool (the real bug this fixes)", () => {
  const wrapped = {
    name: "call_tool",
    args: '{"mcp_server":"detective-evidence","tool_name":"propose_restock_action","input":{"sku":"SKU-447","quantity":200}}',
  };
  const resolved = resolveActualToolCall(wrapped);
  assert.equal(resolved.name, "propose_restock_action");
  assert.deepEqual(JSON.parse(resolved.args), { sku: "SKU-447", quantity: 200 });
});

test("resolveActualToolCall returns null for a wrapped call with no tool_name (invalid input case)", () => {
  const wrapped = { name: "call_tool", args: '{"mcp_server":"detective-evidence"}' };
  assert.equal(resolveActualToolCall(wrapped), null);
});

test("resolveActualToolCall returns null for malformed JSON args instead of throwing", () => {
  assert.doesNotThrow(() => resolveActualToolCall({ name: "call_tool", args: "not json" }));
  assert.equal(resolveActualToolCall({ name: "call_tool", args: "not json" }), null);
});

test("resolveActualToolCall returns null for a null call", () => {
  assert.equal(resolveActualToolCall(null), null);
});
