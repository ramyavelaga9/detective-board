import { test } from "node:test";
import assert from "node:assert/strict";
import { nextLoopDecision, MAX_INVESTIGATION_STEPS } from "../src/investigation-loop.mjs";

test("continues while under the step budget and not yet concluded", () => {
  assert.equal(nextLoopDecision({ stepCount: 1, concluded: false }), "continue");
  assert.equal(nextLoopDecision({ stepCount: MAX_INVESTIGATION_STEPS - 1, concluded: false }), "continue");
});

test("reports conclude once the agent has concluded, regardless of step count", () => {
  assert.equal(nextLoopDecision({ stepCount: 1, concluded: true }), "conclude");
});

test("reports step_limit_reached once the budget is hit without a conclusion (edge case: a run that never concludes must still terminate)", () => {
  assert.equal(nextLoopDecision({ stepCount: MAX_INVESTIGATION_STEPS, concluded: false }), "step_limit_reached");
  assert.equal(nextLoopDecision({ stepCount: MAX_INVESTIGATION_STEPS + 5, concluded: false }), "step_limit_reached");
});

test("a conclusion on the very last allowed step still wins over the step limit", () => {
  assert.equal(nextLoopDecision({ stepCount: MAX_INVESTIGATION_STEPS, concluded: true }), "conclude");
});

test("a custom maxSteps overrides the default budget", () => {
  assert.equal(nextLoopDecision({ stepCount: 3, concluded: false, maxSteps: 3 }), "step_limit_reached");
  assert.equal(nextLoopDecision({ stepCount: 2, concluded: false, maxSteps: 3 }), "continue");
});
