// The board's live event log, per case — what /api/investigate streams out
// as it happens, and what a reconnecting client replays via the snapshot
// endpoint after a dropped connection. Deliberately in-memory only:
// this is the live state of
// one demo run, not a case-history store.
//
// createBoardStore() is a factory rather than a module-level singleton so
// tests can use a fresh instance instead of shared global state.

function createBoardStore() {
  const eventsByCase = new Map();

  function addEvent(caseId, event) {
    const events = eventsByCase.get(caseId) ?? [];
    events.push(event);
    eventsByCase.set(caseId, events);
    return event;
  }

  function getSnapshot(caseId) {
    return [...(eventsByCase.get(caseId) ?? [])];
  }

  function resetCase(caseId) {
    eventsByCase.delete(caseId);
  }

  return { addEvent, getSnapshot, resetCase };
}

export { createBoardStore };
