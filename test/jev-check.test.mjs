import { test } from "node:test";
import assert from "node:assert/strict";
import { buildVerdictRequest, createJevClient, parseVerdictAnswer, truncateEvidence } from "../src/jev-check.mjs";

const answerFor = (choice, confidence = 0.95) => ({
  answers: { verdict: { type: "choice", choice, confidence, probabilities: { [choice]: confidence, says_nothing: 1 - confidence } } },
});

/** A fetch that answers each call with the next response in order and records every call. */
function fakeFetch(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length, responses.length) - 1];
    if (next instanceof Error) throw next;
    return { status: next.status, ok: next.status >= 200 && next.status < 300, json: async () => next.body };
  };
  return { fetchImpl, calls };
}

const clientWith = (fetchImpl, overrides = {}) =>
  createJevClient({ apiKey: "test-key", fetchImpl, retryDelayMs: 0, log: () => {}, ...overrides });

const CHECK = { hypothesis: "SKU-447 stockout caused the drop", evidence: '{"stock":0}' };

test("buildVerdictRequest sends the hypothesis and evidence as named state with one three-way choice question", () => {
  const body = buildVerdictRequest({ hypothesis: "h", evidence: "e" });
  assert.equal(body.model, "jev-latest");
  assert.deepEqual(body.state, { hypothesis: "h", evidence: "e" });
  assert.equal(body.questions.verdict.type, "choice");
  assert.deepEqual(Object.keys(body.questions.verdict.criteria), ["supports", "contradicts", "says_nothing"]);
});

test("truncateEvidence keeps short evidence and cuts a huge payload down, marked as truncated (edge case: large payloads)", () => {
  assert.equal(truncateEvidence("short"), "short");
  const cut = truncateEvidence("x".repeat(50), 10);
  assert.equal(cut, `${"x".repeat(10)} [truncated]`);
});

test("parseVerdictAnswer returns Jev's choice with its probabilities and confidence", () => {
  const parsed = parseVerdictAnswer(answerFor("contradicts", 0.9));
  assert.equal(parsed.choice, "contradicts");
  assert.equal(parsed.confidence, 0.9);
  assert.equal(parsed.probabilities.contradicts, 0.9);
});

test("parseVerdictAnswer returns null for a reply that is not the shape we asked for (invalid input case)", () => {
  assert.equal(parseVerdictAnswer(undefined), null);
  assert.equal(parseVerdictAnswer({}), null);
  assert.equal(parseVerdictAnswer(answerFor("maybe")), null, "an option we never offered");
  assert.equal(parseVerdictAnswer({ answers: { verdict: { choice: "supports", probabilities: { supports: 1 } } } }), null, "no confidence");
  assert.equal(parseVerdictAnswer({ answers: { verdict: { choice: "supports", confidence: 0.9 } } }), null, "no probabilities");
});

test("checkVerdict calls Jev with the bearer key and returns a complete review", async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 200, body: answerFor("supports", 0.93) });
  const review = await clientWith(fetchImpl).checkVerdict(CHECK);
  assert.equal(review.status, "complete");
  assert.equal(review.verdict, "supports");
  assert.equal(review.confidence, 93);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(JSON.parse(calls[0].init.body).state, { hypothesis: CHECK.hypothesis, evidence: CHECK.evidence });
});

test("checkVerdict does nothing and never calls the network without an API key (edge case: Jev unavailable)", async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 200, body: answerFor("supports") });
  const client = createJevClient({ fetchImpl, log: () => {} });
  assert.equal(client.isEnabled(), false);
  assert.equal(await client.checkVerdict(CHECK), null);
  assert.equal(calls.length, 0);
});

test("a rejected key (401) is logged once and switches the client off instead of failing every verdict", async () => {
  const logged = [];
  const { fetchImpl, calls } = fakeFetch({ status: 401, body: {} });
  const client = clientWith(fetchImpl, { log: (message) => logged.push(message) });
  assert.equal(await client.checkVerdict(CHECK), null);
  assert.equal(client.isEnabled(), false);
  assert.equal(await client.checkVerdict(CHECK), null);
  assert.equal(calls.length, 1, "no second request after the key was rejected");
  assert.equal(logged.length, 1);
});

test("a rate limit (429) is retried once and the retry's answer is used", async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 429, body: {} }, { status: 200, body: answerFor("contradicts") });
  const review = await clientWith(fetchImpl).checkVerdict(CHECK);
  assert.equal(review.verdict, "doubts");
  assert.equal(calls.length, 2);
});

test("an overload that persists (529 twice) gives up after one retry with no review", async () => {
  const { fetchImpl, calls } = fakeFetch({ status: 529, body: {} });
  assert.equal(await clientWith(fetchImpl).checkVerdict(CHECK), null);
  assert.equal(calls.length, 2);
});

test("a request Jev rejects (422) is logged and skipped, not retried", async () => {
  const logged = [];
  const { fetchImpl, calls } = fakeFetch({ status: 422, body: {} });
  assert.equal(await clientWith(fetchImpl, { log: (message) => logged.push(message) }).checkVerdict(CHECK), null);
  assert.equal(calls.length, 1);
  assert.match(logged[0], /422/);
});

test("a network failure or a timeout yields no review instead of throwing (edge case: Jev unavailable)", async () => {
  const timeout = new DOMException("The operation timed out", "TimeoutError");
  assert.equal(await clientWith(fakeFetch(new TypeError("fetch failed")).fetchImpl).checkVerdict(CHECK), null);
  assert.equal(await clientWith(fakeFetch(timeout).fetchImpl).checkVerdict(CHECK), null);
});

test("a malformed reply (bad JSON, or not the answer shape) yields no review (invalid input case)", async () => {
  const badJson = { fetchImpl: async () => ({ status: 200, ok: true, json: async () => JSON.parse("{not json") }) };
  assert.equal(await clientWith(badJson.fetchImpl).checkVerdict(CHECK), null);
  assert.equal(await clientWith(fakeFetch({ status: 200, body: { answers: {} } }).fetchImpl).checkVerdict(CHECK), null);
});
