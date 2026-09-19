// Turns a hypothesis-evidence pairing (as self-reported by the investigator
// agent via the record_hypothesis_verdict tool) into a board-renderable red
// string: a verdict, a clamped confidence score, and the line style that
// verdict draws as. Kept pure and dependency-free so it's trivially
// testable and reusable from both the SSE relay (board-events.mjs) and the
// approval flow in backend.mjs.

const VALID_VERDICTS = new Set(["confirmed", "rejected", "inconclusive"]);
const EDGE_STYLE_BY_VERDICT = { confirmed: "solid-red", rejected: "dashed-gray", inconclusive: "dotted-amber" };
const VALID_APPROVAL_DECISIONS = new Set(["allow", "deny"]);

function assertValidVerdict(verdict) {
  if (!VALID_VERDICTS.has(verdict)) {
    throw new RangeError(`Unknown verdict: ${verdict}. Expected one of ${[...VALID_VERDICTS].join(", ")}.`);
  }
}

/** Confidence scores come from the model, so a garbage value degrades to 0 rather than corrupting the board. */
function clampConfidence(confidence) {
  if (typeof confidence !== "number" || Number.isNaN(confidence)) return 0;
  return Math.min(100, Math.max(0, Math.round(confidence)));
}

function classifyConnection({ verdict, confidence }) {
  assertValidVerdict(verdict);
  return { verdict, confidence: clampConfidence(confidence), edgeStyle: EDGE_STYLE_BY_VERDICT[verdict] };
}

/** Maps a human's approve/deny decision to the board event announcing the outcome — never a silent no-op either way. */
function resolveApprovalOutcome(decision) {
  if (!VALID_APPROVAL_DECISIONS.has(decision)) {
    throw new RangeError(`Unknown approval decision: ${decision}. Expected "allow" or "deny".`);
  }
  return { type: "approval_resolved", outcome: decision === "allow" ? "approved" : "denied" };
}

export { VALID_VERDICTS, assertValidVerdict, clampConfidence, classifyConnection, resolveApprovalOutcome };
