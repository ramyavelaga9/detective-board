import { test } from "node:test";
import assert from "node:assert/strict";
import { createInvestigationHistory } from "../src/investigation-history.mjs";

test("a confirmed hypothesis is reported as already tested", () => {
  const history = createInvestigationHistory();
  history.recordVerdict("DB-1001", "SKU-447 stockout", "confirmed");
  assert.equal(history.hasBeenTested("DB-1001", "SKU-447 stockout"), true);
});

test("an inconclusive verdict is not treated as tested — the agent should be free to retest it", () => {
  const history = createInvestigationHistory();
  history.recordVerdict("DB-1001", "weather disruption", "inconclusive");
  assert.equal(history.hasBeenTested("DB-1001", "weather disruption"), false);
});

test("a hypothesis never recorded is not treated as tested", () => {
  const history = createInvestigationHistory();
  assert.equal(history.hasBeenTested("DB-1001", "never tested"), false);
});

test("recordVerdict throws for an unrecognized verdict (invalid input case)", () => {
  const history = createInvestigationHistory();
  assert.throws(() => history.recordVerdict("DB-1001", "SKU-447 stockout", "maybe"), RangeError);
});

test("history is scoped per case id — one case's records never leak into another's", () => {
  const history = createInvestigationHistory();
  history.recordVerdict("DB-1001", "marketing spend cut", "rejected");
  assert.equal(history.hasBeenTested("DB-1001", "marketing spend cut"), true);
  assert.equal(history.hasBeenTested("DB-2002", "marketing spend cut"), false);
});

test("resetCase clears a case's history, so a fresh run can retest a previously confirmed hypothesis (edge case: stale memory across repeated runs)", () => {
  const history = createInvestigationHistory();
  history.recordVerdict("DB-1001", "SKU-447 stockout", "confirmed");
  assert.equal(history.hasBeenTested("DB-1001", "SKU-447 stockout"), true);
  history.resetCase("DB-1001");
  assert.equal(history.hasBeenTested("DB-1001", "SKU-447 stockout"), false);
  assert.deepEqual(history.getHistory("DB-1001"), []);
});

test("getHistory returns a snapshot copy, not a live reference to internal state", () => {
  const history = createInvestigationHistory();
  history.recordVerdict("DB-1001", "refund spike", "rejected");
  const snapshot = history.getHistory("DB-1001");
  snapshot.push({ hypothesis: "tampered", verdict: "confirmed" });
  assert.equal(history.getHistory("DB-1001").length, 1);
});
