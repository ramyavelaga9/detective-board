import { test } from "node:test";
import assert from "node:assert/strict";
import { createReviewBook } from "../src/review-book.mjs";

const verdictEvent = (verdictId, verdict = "confirmed", confidence = 90) => ({ verdictId, hypothesis: `hypothesis ${verdictId}`, evidenceSource: "get_weather", verdict, confidence });
const complete = (verdict, confidence) => ({ status: "complete", verdict, confidence, reasoning: "r", whatWouldChangeMyMind: "w" });

test("a hypothesis has no review until one is started, and starting marks it pending", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  assert.equal(book.hypotheses("DB-1")[0].jev, null);
  assert.equal(book.startReview("DB-1", "v1"), true);
  assert.deepEqual(book.hypotheses("DB-1")[0].jev, { status: "pending" });
});

test("pending counts how many started reviews have finished", () => {
  const book = createReviewBook();
  for (const id of ["v1", "v2", "v3"]) book.addHypothesis("DB-1", verdictEvent(id));
  book.startReview("DB-1", "v1");
  book.startReview("DB-1", "v2");
  assert.deepEqual(book.pending("DB-1"), { done: 0, total: 2 });
  book.completeReview("DB-1", "v1", complete("supports", 90));
  book.failReview("DB-1", "v2");
  assert.deepEqual(book.pending("DB-1"), { done: 2, total: 2 });
});

test("a hypothesis that was never reviewed does not count towards the total (edge case: Jev off or no evidence)", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  assert.deepEqual(book.pending("DB-1"), { done: 0, total: 0 });
});

test("completeReview stores the review and returns the hypothesis it settled", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  book.startReview("DB-1", "v1");
  const settled = book.completeReview("DB-1", "v1", complete("doubts", 80));
  assert.equal(settled.jev.verdict, "doubts");
});

test("a late answer for a verdict that is not on the case is ignored (edge case: a run that was reset)", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  book.startReview("DB-1", "v1");
  book.reset("DB-1");
  assert.equal(book.completeReview("DB-1", "v1", complete("supports", 90)), null);
  assert.deepEqual(book.hypotheses("DB-1"), []);
});

test("a review settles only once: a second answer or a failure after completion is ignored", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  book.startReview("DB-1", "v1");
  book.completeReview("DB-1", "v1", complete("supports", 90));
  assert.equal(book.completeReview("DB-1", "v1", complete("doubts", 50)), null);
  assert.equal(book.failReview("DB-1", "v1"), null);
  assert.equal(book.hypotheses("DB-1")[0].jev.verdict, "supports");
});

test("settling a review that was never started is ignored (invalid input case)", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  assert.equal(book.completeReview("DB-1", "v1", complete("supports", 90)), null);
  assert.equal(book.startReview("DB-1", "no-such-verdict"), false);
});

test("cases are kept apart", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  book.addHypothesis("DB-2", verdictEvent("v2"));
  book.reset("DB-1");
  assert.equal(book.hypotheses("DB-1").length, 0);
  assert.equal(book.hypotheses("DB-2").length, 1);
});

test("the gate blocks Approve until every started review has settled", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1"));
  book.addHypothesis("DB-1", verdictEvent("v2", "rejected"));
  book.startReview("DB-1", "v1");
  book.startReview("DB-1", "v2");
  book.completeReview("DB-1", "v1", complete("supports", 95));
  assert.equal(book.gate("DB-1").state, "blocked");
  book.completeReview("DB-1", "v2", complete("doubts", 95));
  assert.equal(book.gate("DB-1").state, "ok");
});

test("the gate flags the confirmed hypothesis the fix acts on when Jev doubts it", () => {
  const book = createReviewBook();
  book.addHypothesis("DB-1", verdictEvent("v1", "confirmed", 90));
  book.addHypothesis("DB-1", verdictEvent("v2", "rejected", 99));
  book.startReview("DB-1", "v1");
  book.completeReview("DB-1", "v1", complete("doubts", 91));
  const gate = book.gate("DB-1");
  assert.equal(gate.state, "review");
  assert.equal(gate.acted.hypothesis, "hypothesis v1");
  assert.equal(gate.requiresConfirm, true);
});

test("the gate on a case with no hypotheses at all is clear (edge case: nothing to review)", () => {
  assert.equal(createReviewBook().gate("DB-9").state, "ok");
});
