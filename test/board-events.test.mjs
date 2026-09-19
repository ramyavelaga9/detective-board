import { test } from "node:test";
import assert from "node:assert/strict";
import { describeEvidenceSource, normalizeEvidenceSource, summarizeEvidenceResult, toBoardEvent } from "../src/board-events.mjs";

test("describeEvidenceSource maps known evidence tools to a board label", () => {
  assert.equal(describeEvidenceSource("get_inventory_status"), "Inventory");
  assert.equal(describeEvidenceSource("get_weather"), "Weather");
});

test("describeEvidenceSource labels both fix actions as 'Action' on the board", () => {
  assert.equal(describeEvidenceSource("propose_restock_action"), "Action");
  assert.equal(describeEvidenceSource("propose_marketing_action"), "Action");
});

test("describeEvidenceSource falls back to 'Unknown' for an unrecognized tool (invalid input case)", () => {
  assert.equal(describeEvidenceSource("delete_everything"), "Unknown");
});

test("summarizeEvidenceResult counts JSON array and object results", () => {
  assert.equal(summarizeEvidenceResult("[]"), "0 records returned");
  assert.equal(summarizeEvidenceResult('[{"a":1}]'), "1 record returned");
  assert.equal(summarizeEvidenceResult('[{"a":1},{"a":2}]'), "2 records returned");
  assert.equal(summarizeEvidenceResult('{"sku":"SKU-447"}'), "1 record returned");
});

test("summarizeEvidenceResult falls back to a truncated preview for plain text", () => {
  const long = "x".repeat(100);
  assert.equal(summarizeEvidenceResult(long), `${"x".repeat(80)}...`);
});

test("summarizeEvidenceResult handles empty content without throwing (invalid input case)", () => {
  assert.equal(summarizeEvidenceResult(""), "No result content");
  assert.equal(summarizeEvidenceResult(undefined), "No result content");
});

test("toBoardEvent turns a plain evidence tool call into a node_added event", () => {
  const event = toBoardEvent({ type: "tool_call", toolCallId: "c1", toolName: "get_inventory_status", args: { sku: "SKU-447" } });
  assert.deepEqual(event, { type: "node_added", id: "c1", label: "Inventory", source: "get_inventory_status" });
});

test("toBoardEvent turns a tool result into a node_result event", () => {
  const event = toBoardEvent({ type: "tool_result", toolCallId: "c1", toolName: "get_inventory_status", resultText: "[]" });
  assert.deepEqual(event, { type: "node_result", id: "c1", summary: "0 records returned" });
});

test("toBoardEvent turns a record_hypothesis_verdict call into a styled edge_added event", () => {
  const event = toBoardEvent({
    type: "tool_call",
    toolCallId: "c2",
    toolName: "record_hypothesis_verdict",
    args: { hypothesis: "SKU-447 stockout", evidenceSource: "get_inventory_status", verdict: "confirmed", confidence: 92 },
  });
  assert.equal(event.type, "edge_added");
  assert.equal(event.edgeStyle, "solid-red");
  assert.equal(event.confidence, 92);
});

test("toBoardEvent skips (returns null for) a malformed verdict instead of crashing the relay (edge case: bad model output)", () => {
  const event = toBoardEvent({
    type: "tool_call",
    toolCallId: "c3",
    toolName: "record_hypothesis_verdict",
    args: { hypothesis: "weather", evidenceSource: "get_weather", verdict: "maybe", confidence: 50 },
  });
  assert.equal(event, null);
});

test("toBoardEvent turns a conclude_investigation call into a conclusion event", () => {
  const event = toBoardEvent({
    type: "tool_call",
    toolCallId: "c4",
    toolName: "conclude_investigation",
    args: { rootCause: "SKU-447 stockout", confidence: 90, recommendedAction: "Restock SKU-447" },
  });
  assert.deepEqual(event, { type: "conclusion", rootCause: "SKU-447 stockout", confidence: 90, recommendedAction: "Restock SKU-447" });
});

test("toBoardEvent turns an approval_required stream event into an approval_required board event", () => {
  const event = toBoardEvent({ type: "approval_required", toolName: "propose_restock_action", toolCallId: "c5" });
  assert.deepEqual(event, { type: "approval_required", toolName: "propose_restock_action", toolCallId: "c5" });
});

test("toBoardEvent returns null for an unrecognized stream event type (invalid input case)", () => {
  assert.equal(toBoardEvent({ type: "something_else" }), null);
});

test("normalizeEvidenceSource keeps just the tool name when the model adds detail to it (the missing-red-line bug)", () => {
  assert.equal(normalizeEvidenceSource("get_weather (northeast)"), "get_weather");
  assert.equal(normalizeEvidenceSource("get_inventory_status (SKU-101)"), "get_inventory_status");
  assert.equal(normalizeEvidenceSource("  Get_Inventory_Status for SKU-447 "), "get_inventory_status");
  assert.equal(normalizeEvidenceSource("the get_sku_sales_breakdown tool"), "get_sku_sales_breakdown");
});

test("normalizeEvidenceSource leaves an exact tool name unchanged", () => {
  assert.equal(normalizeEvidenceSource("get_refund_events"), "get_refund_events");
});

test("normalizeEvidenceSource picks the first tool named when a source mentions two", () => {
  assert.equal(normalizeEvidenceSource("get_sku_sales_breakdown then get_inventory_status"), "get_sku_sales_breakdown");
});

test("normalizeEvidenceSource passes through an unrecognized source and non-strings untouched (invalid input case)", () => {
  assert.equal(normalizeEvidenceSource("  some other source  "), "some other source");
  assert.equal(normalizeEvidenceSource(undefined), undefined);
  assert.equal(normalizeEvidenceSource(null), null);
  assert.equal(normalizeEvidenceSource(""), "");
});

test("a verdict on a decorated evidence source still reaches the board under the real tool name", () => {
  const event = toBoardEvent({
    type: "tool_call",
    toolName: "record_hypothesis_verdict",
    args: { hypothesis: "Stockout was limited", evidenceSource: "get_inventory_status (SKU-101)", verdict: "confirmed", confidence: 75 },
  });
  assert.equal(event.evidenceSource, "get_inventory_status");
  assert.equal(event.edgeStyle, "solid-red");
  assert.equal(event.confidence, 75);
});
