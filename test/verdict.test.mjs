import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyConnection, resolveApprovalOutcome, clampConfidence, assertValidVerdict } from "../src/verdict.mjs";

test("classifyConnection maps each verdict to its board edge style", () => {
  assert.equal(classifyConnection({ verdict: "confirmed", confidence: 90 }).edgeStyle, "solid-red");
  assert.equal(classifyConnection({ verdict: "rejected", confidence: 10 }).edgeStyle, "dashed-gray");
  assert.equal(classifyConnection({ verdict: "inconclusive", confidence: 50 }).edgeStyle, "dotted-amber");
});

test("classifyConnection throws for an unknown verdict (invalid input case)", () => {
  assert.throws(() => classifyConnection({ verdict: "maybe", confidence: 50 }), RangeError);
});

test("clampConfidence clamps out-of-range and non-numeric values instead of corrupting the board", () => {
  assert.equal(clampConfidence(150), 100);
  assert.equal(clampConfidence(-20), 0);
  assert.equal(clampConfidence(NaN), 0);
  assert.equal(clampConfidence("90"), 0);
});

test("classifyConnection clamps a malformed confidence score rather than throwing", () => {
  const result = classifyConnection({ verdict: "confirmed", confidence: 250 });
  assert.equal(result.confidence, 100);
});

test("resolveApprovalOutcome maps allow/deny to a board-renderable outcome", () => {
  assert.deepEqual(resolveApprovalOutcome("allow"), { type: "approval_resolved", outcome: "approved" });
  assert.deepEqual(resolveApprovalOutcome("deny"), { type: "approval_resolved", outcome: "denied" });
});

test("resolveApprovalOutcome throws for an unknown decision (invalid input case)", () => {
  assert.throws(() => resolveApprovalOutcome("maybe"), RangeError);
  assert.throws(() => resolveApprovalOutcome(undefined), RangeError);
});

test("assertValidVerdict does not throw for any of the three real verdicts", () => {
  assert.doesNotThrow(() => assertValidVerdict("confirmed"));
  assert.doesNotThrow(() => assertValidVerdict("rejected"));
  assert.doesNotThrow(() => assertValidVerdict("inconclusive"));
});
