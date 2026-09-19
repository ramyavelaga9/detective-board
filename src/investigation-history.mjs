// A lightweight, single-layer stand-in for the "investigation history"
// memory layer: which hypotheses have already been confirmed or rejected
// on a case, so a fresh investigation run doesn't waste steps re-testing
// them. Deliberately not persisted and deliberately just this one layer —
// no schema memory, no business-context memory — since those are out of
// scope for the hackathon's time budget.
//
// createInvestigationHistory() is a factory (not a module-level
// singleton), the same pattern as PharmaFlow's event-log.mjs, so tests can
// use a fresh instance instead of shared global state.

import { assertValidVerdict } from "./verdict.mjs";

function createInvestigationHistory() {
  const recordsByCase = new Map();

  function recordVerdict(caseId, hypothesis, verdict) {
    assertValidVerdict(verdict);
    const records = recordsByCase.get(caseId) ?? [];
    const record = { hypothesis, verdict, recordedAt: new Date().toISOString() };
    records.push(record);
    recordsByCase.set(caseId, records);
    return record;
  }

  // "inconclusive" doesn't count as tested — the whole point of that
  // verdict is that the agent should try again with better evidence.
  function hasBeenTested(caseId, hypothesis) {
    const records = recordsByCase.get(caseId) ?? [];
    return records.some((record) => record.hypothesis === hypothesis && record.verdict !== "inconclusive");
  }

  function getHistory(caseId) {
    return [...(recordsByCase.get(caseId) ?? [])];
  }

  function resetCase(caseId) {
    recordsByCase.delete(caseId);
  }

  return { recordVerdict, hasBeenTested, getHistory, resetCase };
}

export { createInvestigationHistory };
