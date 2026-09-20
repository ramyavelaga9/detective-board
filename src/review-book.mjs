// Per case: each hypothesis the investigator recorded, and Jev's review of it
// as it moves from pending to complete (or failed). The approval route reads
// it to decide whether Approve is allowed yet, and to show Jev's view of the
// hypothesis a fix acts on. Deliberately in-memory only, the same tradeoff as
// board-store.mjs: it is the live state of one demo run.
//
// A review only settles while it is pending, so a late answer from a run that
// has since been reset (or a second answer for the same verdict) is ignored
// instead of reaching the board.
//
// createReviewBook() is a factory (not a module-level singleton) so tests can
// use a fresh instance instead of shared global state.

import { approvalGate, pickActedOn } from "./jev-review.mjs";

function createReviewBook() {
  const hypothesesByCase = new Map();

  function forCase(caseId) {
    if (!hypothesesByCase.has(caseId)) hypothesesByCase.set(caseId, new Map());
    return hypothesesByCase.get(caseId);
  }

  function addHypothesis(caseId, { verdictId, hypothesis, evidenceSource, verdict, confidence }) {
    forCase(caseId).set(verdictId, { verdictId, hypothesis, evidenceSource, verdict, confidence, jev: null });
  }

  /** Marks a known hypothesis as under review; false if the verdict is not on this case. */
  function startReview(caseId, verdictId) {
    const hypothesis = forCase(caseId).get(verdictId);
    if (!hypothesis) return false;
    hypothesis.jev = { status: "pending" };
    return true;
  }

  function settle(caseId, verdictId, review) {
    const hypothesis = forCase(caseId).get(verdictId);
    if (hypothesis?.jev?.status !== "pending") return null;
    hypothesis.jev = review;
    return hypothesis;
  }

  const completeReview = (caseId, verdictId, review) => settle(caseId, verdictId, review);
  const failReview = (caseId, verdictId) => settle(caseId, verdictId, { status: "failed" });

  function hypotheses(caseId) {
    return [...forCase(caseId).values()];
  }

  /** How many reviews have finished out of all that were started. */
  function pending(caseId) {
    const reviewed = hypotheses(caseId).filter((hypothesis) => hypothesis.jev);
    return { done: reviewed.filter((hypothesis) => hypothesis.jev.status !== "pending").length, total: reviewed.length };
  }

  function gate(caseId) {
    return approvalGate({ acted: pickActedOn(hypotheses(caseId)), pending: pending(caseId) });
  }

  function reset(caseId) {
    hypothesesByCase.delete(caseId);
  }

  return { addHypothesis, startReview, completeReview, failReview, hypotheses, pending, gate, reset };
}

export { createReviewBook };
