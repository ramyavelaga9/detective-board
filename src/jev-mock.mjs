// A stand-in for the Jev client (the same interface as createJevClient) so the
// review UI can be built, demoed, and tested without an API key. Selected by
// the backend with JEV_MOCK=1; the real client is swapped back in by leaving
// that unset.
//
// It is deterministic: successive reviews cycle through a reading that agrees
// with the detective, one that conflicts with it, and an unsure one, and each
// takes a moment, so the pending, agreeing, and disagreeing states all show up
// in an ordinary run.

import { buildCompleteReview, JEV_VERDICT_BY_RELATION } from "./jev-review.mjs";

const DEFAULT_DELAY_MS = 1500;

const AGREEING = { confirmed: "supports", rejected: "contradicts", inconclusive: "says_nothing" };
const CONFLICTING = { confirmed: "contradicts", rejected: "supports", inconclusive: "supports" };
const UNSURE = { confirmed: "says_nothing", rejected: "says_nothing", inconclusive: "says_nothing" };

const SCRIPT = [
  { relations: AGREEING, confidence: 0.92 },
  { relations: CONFLICTING, confidence: 0.74 },
  { relations: UNSURE, confidence: 0.61 },
];

/** Puts `confidence` on the chosen reading and splits the rest 70/30 between the other two. */
function probabilitiesFor(choice, confidence) {
  const [runnerUp, last] = Object.keys(JEV_VERDICT_BY_RELATION).filter((relation) => relation !== choice);
  const remainder = 1 - confidence;
  return { [choice]: confidence, [runnerUp]: remainder * 0.7, [last]: remainder * 0.3 };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createMockJevClient({ delayMs = DEFAULT_DELAY_MS, waitImpl = wait } = {}) {
  let calls = 0;

  async function checkVerdict({ detectiveVerdict }) {
    const { relations, confidence } = SCRIPT[calls % SCRIPT.length];
    calls += 1;
    await waitImpl(delayMs);
    const choice = relations[detectiveVerdict] ?? "says_nothing";
    return buildCompleteReview({ choice, probabilities: probabilitiesFor(choice, confidence), confidence });
  }

  return { isEnabled: () => true, checkVerdict };
}

export { createMockJevClient };
