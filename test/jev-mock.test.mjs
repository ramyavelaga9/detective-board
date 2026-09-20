import { test } from "node:test";
import assert from "node:assert/strict";
import { createMockJevClient } from "../src/jev-mock.mjs";
import { alignJevWithDetective } from "../src/jev-review.mjs";

const instant = () => Promise.resolve();

test("the mock is always enabled, so the UI can be exercised with no API key", () => {
  assert.equal(createMockJevClient({ waitImpl: instant }).isEnabled(), true);
});

test("successive reviews cycle through agreeing, conflicting, and unsure readings of a confirmed hypothesis", async () => {
  const mock = createMockJevClient({ waitImpl: instant });
  const reviews = [];
  for (let i = 0; i < 4; i += 1) reviews.push(await mock.checkVerdict({ detectiveVerdict: "confirmed" }));
  assert.deepEqual(reviews.map((review) => review.verdict), ["supports", "doubts", "unsure", "supports"]);
  assert.deepEqual(reviews.map((review) => alignJevWithDetective("confirmed", review.verdict)), ["agrees", "disagrees", "differs", "agrees"]);
});

test("the mock conflicts with a ruled-out hypothesis the other way round", async () => {
  const mock = createMockJevClient({ waitImpl: instant });
  await mock.checkVerdict({ detectiveVerdict: "rejected" });
  const conflicting = await mock.checkVerdict({ detectiveVerdict: "rejected" });
  assert.equal(alignJevWithDetective("rejected", conflicting.verdict), "disagrees");
});

test("mock reviews are complete, typed reviews with the scripted confidence", async () => {
  const review = await createMockJevClient({ waitImpl: instant }).checkVerdict({ detectiveVerdict: "confirmed" });
  assert.equal(review.status, "complete");
  assert.equal(review.confidence, 92);
  assert.equal(typeof review.reasoning, "string");
  assert.equal(typeof review.whatWouldChangeMyMind, "string");
});

test("the mock takes its delay before answering, so a review is visibly pending", async () => {
  const waits = [];
  const mock = createMockJevClient({ delayMs: 1500, waitImpl: async (ms) => waits.push(ms) });
  await mock.checkVerdict({ detectiveVerdict: "confirmed" });
  assert.deepEqual(waits, [1500]);
});

test("the mock answers an unknown detective verdict as unsure instead of throwing (invalid input case)", async () => {
  const review = await createMockJevClient({ waitImpl: instant }).checkVerdict({ detectiveVerdict: "maybe" });
  assert.equal(review.verdict, "unsure");
});
