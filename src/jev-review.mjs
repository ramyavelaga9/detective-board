// The shape of Jev's review of one hypothesis, and the rules built on it:
// whether Jev disagrees with the detective, and whether an approval needs
// more care. Kept pure and dependency-free so it is trivially testable and
// shared by the SSE relay (backend.mjs) and the approval route.
//
// Jev is a "System One" model: it returns a choice with a probability for
// each option and a confidence, never prose. So `verdict` and `confidence`
// are Jev's own; `reasoning` and `whatWouldChangeMyMind` are worded from its
// probabilities (its top reading and its runner-up) and say so in the UI.
//
// Detective verdicts are the investigator's: confirmed | rejected |
// inconclusive. Jev's are supports | doubts | unsure.

/** @typedef {"confirmed" | "rejected" | "inconclusive"} DetectiveVerdict */
/** @typedef {"supports" | "doubts" | "unsure"} JevVerdict */
/**
 * A review is still running, has failed, or is complete. `confidence` is 0 to 100.
 * @typedef {{ status: "pending" }
 *   | { status: "failed" }
 *   | { status: "complete", verdict: JevVerdict, confidence: number, reasoning: string, whatWouldChangeMyMind: string }} JevReview
 */

// Below this Jev confidence (0 to 100), approving the fix needs an explicit confirm.
const CONFIRM_CONFIDENCE_FLOOR = 70;

// Jev answers how the evidence relates to the hypothesis.
const JEV_VERDICT_BY_RELATION = { supports: "supports", contradicts: "doubts", says_nothing: "unsure" };

// The Jev verdict that reads a hypothesis the same way the detective did.
const MATCHING_JEV_VERDICT = { confirmed: "supports", rejected: "doubts", inconclusive: "unsure" };

// The Jev verdict that flatly contradicts it. An inconclusive detective verdict has no opposite.
const CONFLICTING_JEV_VERDICT = { confirmed: "doubts", rejected: "supports" };

const READING_PHRASE = {
  supports: "supports the hypothesis",
  contradicts: "contradicts it",
  says_nothing: "says nothing about it",
};

const CHANGE_PHRASE = {
  supports: "showed this factor was present and would reduce revenue",
  contradicts: "showed this factor was normal or absent",
  says_nothing: "left the hypothesis unaddressed",
};

const toPercent = (probability) => Math.round(probability * 100);

function isKnownRelation(relation) {
  return relation in JEV_VERDICT_BY_RELATION;
}

/** True only for a direct conflict: the detective confirmed and Jev doubts, or the detective ruled out and Jev supports. */
function jevDisagrees(detectiveVerdict, jevVerdict) {
  const conflicting = CONFLICTING_JEV_VERDICT[detectiveVerdict];
  return conflicting !== undefined && conflicting === jevVerdict;
}

/** "agrees" when Jev reads it the same way, "disagrees" on a direct conflict, otherwise "differs" (for example Jev is unsure). */
function alignJevWithDetective(detectiveVerdict, jevVerdict) {
  if (jevDisagrees(detectiveVerdict, jevVerdict)) return "disagrees";
  return MATCHING_JEV_VERDICT[detectiveVerdict] === jevVerdict ? "agrees" : "differs";
}

function rankReadings(probabilities) {
  return Object.entries(probabilities)
    .filter(([relation]) => isKnownRelation(relation))
    .sort(([, first], [, second]) => second - first);
}

function describeReading(ranked) {
  const parts = ranked.map(([relation, probability]) => `${READING_PHRASE[relation]} ${toPercent(probability)}%`);
  return `Jev's reading of the evidence: ${parts.join(", ")}.`;
}

function describeChangeOfMind(ranked) {
  const [runnerUp, probability] = ranked[1] ?? [];
  if (!runnerUp) return "Jev has no competing reading to weigh.";
  return `Evidence that ${CHANGE_PHRASE[runnerUp]} would move Jev (that reading is at ${toPercent(probability)}% now).`;
}

/** Builds a complete review from Jev's raw answer: its choice, a probability per option, and its 0 to 1 confidence. */
function buildCompleteReview({ choice, probabilities, confidence }) {
  const ranked = rankReadings(probabilities);
  return {
    status: "complete",
    verdict: JEV_VERDICT_BY_RELATION[choice],
    confidence: toPercent(confidence),
    reasoning: describeReading(ranked),
    whatWouldChangeMyMind: describeChangeOfMind(ranked),
  };
}

/** What a review adds to a verdict on the board: the review itself, and how it lines up with the detective. */
function describeReviewOutcome(detectiveVerdict, review) {
  if (review.status !== "complete") return { jev: review, disagrees: false, alignment: "differs" };
  const alignment = alignJevWithDetective(detectiveVerdict, review.verdict);
  return { jev: review, disagrees: alignment === "disagrees", alignment };
}

/** The hypothesis a fix acts on: the confirmed one the detective is most sure of (the latest wins a tie). */
function pickActedOn(hypotheses) {
  return hypotheses
    .filter((hypothesis) => hypothesis.verdict === "confirmed")
    .reduce((best, hypothesis) => (!best || hypothesis.confidence >= best.confidence ? hypothesis : best), null);
}

function summarizeActedOn(acted) {
  if (!acted) return null;
  const jev = acted.jev?.status === "complete" ? acted.jev : null;
  return {
    hypothesis: acted.hypothesis,
    evidenceSource: acted.evidenceSource,
    detective: { verdict: acted.verdict, confidence: acted.confidence },
    jev,
    disagrees: Boolean(jev) && jevDisagrees(acted.verdict, jev.verdict),
  };
}

function gateReason(acted) {
  if (!acted?.jev) return null;
  if (acted.disagrees) return "disagrees";
  return acted.jev.confidence < CONFIRM_CONFIDENCE_FLOOR ? "low-confidence" : null;
}

const GATE_COPY = {
  disagrees: "Jev disagrees. Review before approving.",
  "low-confidence": "Jev is not confident. Review before approving.",
};

/**
 * Whether Approve is allowed, and with what care, given the hypothesis being acted on and how many
 * Jev reviews have finished. Reviews still running block approval; a disagreement or a low-confidence
 * review requires an explicit confirm; a missing or failed review changes nothing.
 * @param {{ acted: object | null, pending: { done: number, total: number } }} input
 */
function approvalGate({ acted, pending }) {
  const summary = summarizeActedOn(acted);
  if (pending.done < pending.total) {
    return { state: "blocked", requiresConfirm: false, reason: null, copy: `Waiting for Jev review (${pending.done}/${pending.total}).`, pending, acted: summary };
  }
  const reason = gateReason(summary);
  return { state: reason ? "review" : "ok", requiresConfirm: Boolean(reason), reason, copy: GATE_COPY[reason] ?? null, pending, acted: summary };
}

/** Whether an approval request may proceed. Deny is always allowed; an allow needs a finished, and if flagged confirmed, review. */
function checkApproval({ decision, confirmed, gate }) {
  if (decision !== "allow") return { ok: true };
  if (gate.state === "blocked") return { ok: false, status: 409, error: gate.copy };
  if (gate.requiresConfirm && !confirmed) return { ok: false, status: 409, error: `${gate.copy} Confirm to approve.` };
  return { ok: true };
}

export {
  CONFIRM_CONFIDENCE_FLOOR,
  JEV_VERDICT_BY_RELATION,
  alignJevWithDetective,
  approvalGate,
  buildCompleteReview,
  checkApproval,
  describeReviewOutcome,
  isKnownRelation,
  jevDisagrees,
  pickActedOn,
};
