// A safety valve for the SSE relay in backend.mjs: without a hard step
// budget, a model that never calls conclude_investigation would leave the
// board (and the browser tab) spinning forever on one run.
//
// Counts only real evidence/action tool calls (backend.mjs excludes
// TrueForge's own list_tools/get_tool_info discovery calls from this
// budget entirely), so this only needs to cover actual investigation work:
// one evidence call + one record_hypothesis_verdict per hypothesis, plus
// one conclude_investigation. A real run tested weather per-region as three
// separate hypotheses on top of the other five, hitting 20 steps before it
// could conclude - 32 leaves headroom for that level of thoroughness.
const MAX_INVESTIGATION_STEPS = 32;

/** "continue" | "conclude" | "step_limit_reached" — never lets an unconcluded run run past maxSteps. */
function nextLoopDecision({ stepCount, concluded, maxSteps = MAX_INVESTIGATION_STEPS }) {
  if (concluded) return "conclude";
  if (stepCount >= maxSteps) return "step_limit_reached";
  return "continue";
}

export { MAX_INVESTIGATION_STEPS, nextLoopDecision };
