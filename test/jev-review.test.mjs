import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONFIRM_CONFIDENCE_FLOOR,
  alignJevWithDetective,
  approvalGate,
  buildCompleteReview,
  checkApproval,
  describeReviewOutcome,
  jevDisagrees,
  pickActedOn,
} from "../src/jev-review.mjs";

const complete = (verdict, confidence) => ({ status: "complete", verdict, confidence, reasoning: "r", whatWouldChangeMyMind: "w" });
const hypothesis = (verdict, confidence, jev = null) => ({ verdictId: `v-${verdict}-${confidence}`, hypothesis: "h", evidenceSource: "get_weather", verdict, confidence, jev });
const finished = { done: 3, total: 3 };

test("jevDisagrees is true when the detective confirmed and Jev doubts it", () => {
  assert.equal(jevDisagrees("confirmed", "doubts"), true);
});

test("jevDisagrees is true when the detective ruled it out and Jev supports it", () => {
  assert.equal(jevDisagrees("rejected", "supports"), true);
});

test("jevDisagrees is false when Jev agrees, is unsure, or the detective was inconclusive", () => {
  assert.equal(jevDisagrees("confirmed", "supports"), false);
  assert.equal(jevDisagrees("confirmed", "unsure"), false);
  assert.equal(jevDisagrees("rejected", "doubts"), false);
  assert.equal(jevDisagrees("rejected", "unsure"), false);
  for (const jevVerdict of ["supports", "doubts", "unsure"]) assert.equal(jevDisagrees("inconclusive", jevVerdict), false);
});

test("jevDisagrees is false for a verdict it does not know instead of throwing (invalid input case)", () => {
  assert.equal(jevDisagrees("maybe", "doubts"), false);
  assert.equal(jevDisagrees(undefined, undefined), false);
});

test("alignJevWithDetective tells agreement, disagreement, and everything in between apart", () => {
  assert.equal(alignJevWithDetective("confirmed", "supports"), "agrees");
  assert.equal(alignJevWithDetective("rejected", "doubts"), "agrees");
  assert.equal(alignJevWithDetective("inconclusive", "unsure"), "agrees");
  assert.equal(alignJevWithDetective("confirmed", "doubts"), "disagrees");
  assert.equal(alignJevWithDetective("confirmed", "unsure"), "differs");
  assert.equal(alignJevWithDetective("inconclusive", "supports"), "differs");
});

test("buildCompleteReview scales confidence to 0-100 and words the reading from Jev's probabilities", () => {
  const review = buildCompleteReview({ choice: "contradicts", probabilities: { supports: 0.3, contradicts: 0.59, says_nothing: 0.11 }, confidence: 0.59 });
  assert.equal(review.status, "complete");
  assert.equal(review.verdict, "doubts");
  assert.equal(review.confidence, 59);
  assert.match(review.reasoning, /contradicts it 59%, supports the hypothesis 30%, says nothing about it 11%/);
  assert.match(review.whatWouldChangeMyMind, /showed this factor was present and would reduce revenue.*30%/);
});

test("buildCompleteReview handles an answer with no competing reading (edge case: sparse probabilities)", () => {
  const review = buildCompleteReview({ choice: "supports", probabilities: { supports: 1 }, confidence: 1 });
  assert.equal(review.whatWouldChangeMyMind, "Jev has no competing reading to weigh.");
});

test("describeReviewOutcome flags a disagreement and carries the review", () => {
  const review = complete("doubts", 88);
  assert.deepEqual(describeReviewOutcome("confirmed", review), { jev: review, disagrees: true, alignment: "disagrees" });
});

test("describeReviewOutcome never reports a disagreement for a pending or failed review (edge case: in-progress and missing data)", () => {
  assert.deepEqual(describeReviewOutcome("confirmed", { status: "pending" }), { jev: { status: "pending" }, disagrees: false, alignment: "differs" });
  assert.equal(describeReviewOutcome("rejected", { status: "failed" }).disagrees, false);
});

test("pickActedOn picks the confirmed hypothesis the detective is most sure of", () => {
  const picked = pickActedOn([hypothesis("confirmed", 70), hypothesis("confirmed", 90), hypothesis("rejected", 99)]);
  assert.equal(picked.confidence, 90);
  assert.equal(picked.verdict, "confirmed");
});

test("pickActedOn lets the latest hypothesis win a tie", () => {
  const first = { ...hypothesis("confirmed", 80), verdictId: "first" };
  const second = { ...hypothesis("confirmed", 80), verdictId: "second" };
  assert.equal(pickActedOn([first, second]).verdictId, "second");
});

test("pickActedOn is null when nothing was confirmed or there are no hypotheses (edge case: missing data)", () => {
  assert.equal(pickActedOn([hypothesis("rejected", 95), hypothesis("inconclusive", 40)]), null);
  assert.equal(pickActedOn([]), null);
});

test("approvalGate is clear when Jev agrees with confidence at or above the floor", () => {
  const acted = hypothesis("confirmed", 90, complete("supports", CONFIRM_CONFIDENCE_FLOOR));
  const gate = approvalGate({ acted, pending: finished });
  assert.equal(gate.state, "ok");
  assert.equal(gate.requiresConfirm, false);
  assert.equal(gate.copy, null);
  assert.equal(gate.acted.jev.confidence, CONFIRM_CONFIDENCE_FLOOR);
});

test("approvalGate requires a confirm, with the disagreement copy, when Jev disagrees", () => {
  const acted = hypothesis("confirmed", 90, complete("doubts", 95));
  const gate = approvalGate({ acted, pending: finished });
  assert.equal(gate.state, "review");
  assert.equal(gate.requiresConfirm, true);
  assert.equal(gate.reason, "disagrees");
  assert.equal(gate.copy, "Jev disagrees. Review before approving.");
  assert.equal(gate.acted.disagrees, true);
});

test("approvalGate requires a confirm when Jev agrees but its confidence is below the floor", () => {
  const acted = hypothesis("confirmed", 90, complete("supports", CONFIRM_CONFIDENCE_FLOOR - 1));
  const gate = approvalGate({ acted, pending: finished });
  assert.equal(gate.requiresConfirm, true);
  assert.equal(gate.reason, "low-confidence");
  assert.equal(gate.acted.disagrees, false);
});

test("approvalGate blocks while any review is still running, and says how far along it is (edge case: in-progress)", () => {
  const acted = hypothesis("confirmed", 90, complete("supports", 95));
  const gate = approvalGate({ acted, pending: { done: 4, total: 5 } });
  assert.equal(gate.state, "blocked");
  assert.equal(gate.copy, "Waiting for Jev review (4/5).");
});

test("approvalGate is clear when the acted-on hypothesis has no Jev review, or its review failed (edge case: missing data)", () => {
  assert.equal(approvalGate({ acted: hypothesis("confirmed", 90), pending: finished }).state, "ok");
  assert.equal(approvalGate({ acted: hypothesis("confirmed", 90, { status: "failed" }), pending: finished }).state, "ok");
  assert.equal(approvalGate({ acted: null, pending: { done: 0, total: 0 } }).state, "ok");
});

test("checkApproval lets Deny through every time, even while blocked or flagged", () => {
  const blocked = approvalGate({ acted: null, pending: { done: 0, total: 2 } });
  assert.deepEqual(checkApproval({ decision: "deny", confirmed: false, gate: blocked }), { ok: true });
});

test("checkApproval refuses Approve while Jev is still reviewing", () => {
  const blocked = approvalGate({ acted: null, pending: { done: 1, total: 2 } });
  assert.deepEqual(checkApproval({ decision: "allow", confirmed: true, gate: blocked }), { ok: false, status: 409, error: "Waiting for Jev review (1/2)." });
});

test("checkApproval refuses an unconfirmed Approve when Jev disagrees, and accepts a confirmed one", () => {
  const flagged = approvalGate({ acted: hypothesis("confirmed", 90, complete("doubts", 95)), pending: finished });
  const refused = checkApproval({ decision: "allow", confirmed: false, gate: flagged });
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 409);
  assert.match(refused.error, /Jev disagrees\. Review before approving\. Confirm to approve\./);
  assert.deepEqual(checkApproval({ decision: "allow", confirmed: true, gate: flagged }), { ok: true });
});

test("checkApproval lets a clear Approve through without a confirm", () => {
  const clear = approvalGate({ acted: hypothesis("confirmed", 90, complete("supports", 95)), pending: finished });
  assert.deepEqual(checkApproval({ decision: "allow", confirmed: false, gate: clear }), { ok: true });
});
