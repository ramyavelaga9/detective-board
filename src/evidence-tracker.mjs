// Remembers the most recent result of each evidence tool during a turn, so a
// verdict the investigator records ("right after the evidence tool call it's
// based on") can be checked against the evidence it actually rests on.
//
// A tool can be called several times in one turn (three weather regions, two
// inventory checks), so only the latest result per tool is kept. A result
// that is empty or an error isn't evidence: it clears the tool's entry, so a
// verdict on a failed call is skipped instead of being paired with an older,
// unrelated result.
//
// createEvidenceTracker() is a factory (not a module-level singleton), the
// same pattern as board-store.mjs, so tests and each turn get a fresh instance.

function isUsableEvidence(resultText) {
  return typeof resultText === "string" && resultText.trim() !== "" && !resultText.trimStart().startsWith('{"error"');
}

function createEvidenceTracker() {
  const latestByTool = new Map();

  function record(toolName, resultText) {
    if (isUsableEvidence(resultText)) latestByTool.set(toolName, resultText);
    else latestByTool.delete(toolName);
  }

  function latestFor(toolName) {
    return latestByTool.get(toolName);
  }

  return { record, latestFor };
}

export { createEvidenceTracker };
