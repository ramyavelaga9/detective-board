// Log-only "activity" events: a live play-by-play of what the agent is doing
// right now (thinking, calling a tool, discovering tools) for the event log.
//
// These are deliberately separate from board events (board-events.mjs): a
// board event describes something that changes the board (a node, an edge, a
// conclusion) and is stored in the case snapshot, whereas activity is
// ephemeral progress - including steps the board never shows, like
// TrueForge's own tool discovery - so the log can mirror what TrueForge's
// own UI shows instead of going quiet between board changes.

const TOOL_LABELS = {
  list_tools: "Discovering available tools",
  get_tool_info: "Reading tool details",
  record_hypothesis_verdict: "Recording a verdict",
  conclude_investigation: "Drawing a conclusion",
  propose_restock_action: "Proposing a restock fix",
  propose_marketing_action: "Proposing an ad-spend fix",
};

const THINKING_TEXT_BY_ROLE = {
  investigator: "Investigator is deciding the next step...",
  senior: "Senior detective is reviewing the evidence...",
};

function describeTool(toolName) {
  return TOOL_LABELS[toolName] ?? `Calling ${toolName}`;
}

/** The agent is between tool calls, waiting on the model. */
function toThinkingActivity(role) {
  return { kind: "thinking", text: THINKING_TEXT_BY_ROLE[role] ?? "Agent is thinking..." };
}

/** A tool call has just started - sent as soon as its name is known, before its arguments finish streaming. */
function toToolStartedActivity(toolName) {
  return { kind: "tool_started", text: `${describeTool(toolName)}...` };
}

/** A tool's result has arrived - only used for tools with no board event of their own to show it. */
function toToolFinishedActivity(toolName) {
  return { kind: "tool_finished", text: `${describeTool(toolName)}: done` };
}

export { toThinkingActivity, toToolStartedActivity, toToolFinishedActivity };
