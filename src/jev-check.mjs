// A second opinion on each verdict the investigator records, from TypeSafe's
// Jev model: a "System One" model that returns typed, calibrated decisions
// (a probability per option and a confidence) instead of text. The investigator
// is an LLM whose self-reported verdict and confidence are uncalibrated, so Jev
// independently reads the same evidence and gives its own verdict.
//
// This module only asks Jev and shapes its answer into a review (see
// jev-review.mjs); whether that review disagrees with the detective is decided
// there. The check is advisory and best-effort: it never blocks or overrides a
// verdict, and every failure (no key, timeout, rate limit, malformed reply)
// degrades to "no review" instead of an error.
//
// createJevClient() is a factory (not a module-level singleton) so tests can
// inject a fake fetch instead of calling the real API.

import { buildCompleteReview, isKnownRelation } from "./jev-review.mjs";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const EVIDENCE_CHAR_LIMIT = 6000;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_RETRY_DELAY_MS = 500;
const RETRYABLE_STATUSES = new Set([429, 529]);

const VERDICT_QUESTION = {
  type: "choice",
  instructions: "The hypothesis names a possible cause of a revenue drop. How does the evidence relate to it?",
  criteria: {
    supports: "The evidence shows the hypothesis is true: the factor was present and would reduce revenue",
    contradicts: "The evidence shows the hypothesis is false: the factor was normal or absent",
    says_nothing: "The evidence does not address the hypothesis either way",
  },
};

/** Evidence such as a 65-day timeseries can be large; keep the request small and cheap. */
function truncateEvidence(text, limit = EVIDENCE_CHAR_LIMIT) {
  return text.length > limit ? `${text.slice(0, limit)} [truncated]` : text;
}

function buildVerdictRequest({ hypothesis, evidence }) {
  return {
    model: JEV_MODEL,
    state: { hypothesis, evidence: truncateEvidence(evidence) },
    questions: { verdict: VERDICT_QUESTION },
  };
}

/** Reads Jev's answer as a choice with its probabilities and confidence; a reply that isn't the shape we asked for is null, never a guess. */
function parseVerdictAnswer(body) {
  const answer = body?.answers?.verdict;
  const { choice, probabilities, confidence } = answer ?? {};
  if (!isKnownRelation(choice) || typeof confidence !== "number") return null;
  if (typeof probabilities?.[choice] !== "number") return null;
  return { choice, probabilities, confidence };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createJevClient({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  log = console.warn,
} = {}) {
  // A 401 means the key is wrong: stop calling instead of failing on every verdict.
  let keyRejected = false;

  const isEnabled = () => Boolean(apiKey) && !keyRejected;

  function post(body) {
    return fetchImpl(JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  /** Rate limits and overload are usually brief, so one short retry, then give up. */
  async function postWithOneRetry(body) {
    const response = await post(body);
    if (!RETRYABLE_STATUSES.has(response.status)) return response;
    await wait(retryDelayMs);
    return post(body);
  }

  /** Resolves to a complete review, or null when Jev could not give one. */
  async function checkVerdict({ hypothesis, evidence }) {
    if (!isEnabled()) return null;
    try {
      const response = await postWithOneRetry(buildVerdictRequest({ hypothesis, evidence }));
      if (response.status === 401) {
        keyRejected = true;
        log("Jev second opinion disabled: TYPESAFE_API_KEY was rejected (401).");
        return null;
      }
      if (!response.ok) {
        log(`Jev second opinion skipped: HTTP ${response.status}.`);
        return null;
      }
      const answer = parseVerdictAnswer(await response.json());
      return answer ? buildCompleteReview(answer) : null;
    } catch {
      return null;
    }
  }

  return { isEnabled, checkVerdict };
}

export { buildVerdictRequest, createJevClient, parseVerdictAnswer, truncateEvidence };
