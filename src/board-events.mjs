// Translates one real TrueForge stream event into a board event the
// frontend can render — the same role tool-telemetry.mjs and
// tool-call-accumulator.mjs play in PharmaFlow's backend, but producing
// board-shaped output (nodes, edges, conclusions) instead of a log line.
//
// toBoardEvent never throws: a malformed or unexpected value from the
// model (a bad verdict, missing args) degrades to a skipped or partial
// event rather than crashing the stream relay mid-investigation.

import { classifyConnection } from "./verdict.mjs";

const EVIDENCE_SOURCE_BY_TOOL = {
  get_revenue_timeseries: "Revenue",
  get_revenue_deviation: "Revenue",
  get_sku_sales_breakdown: "Sales",
  get_inventory_status: "Inventory",
  get_marketing_metrics: "Marketing",
  get_refund_events: "Refunds",
  get_weather: "Weather",
  propose_restock_action: "Action",
  propose_marketing_action: "Action",
};

const PREVIEW_LIMIT = 80;

// These two tool calls render as an edge/conclusion, never a node - so their
// result never has a node to attach to. backend.mjs uses this to skip
// rendering their otherwise-orphaned "node_result" event.
const NODELESS_TOOLS = new Set(["record_hypothesis_verdict", "conclude_investigation"]);

function describeEvidenceSource(toolName) {
  return EVIDENCE_SOURCE_BY_TOOL[toolName] ?? "Unknown";
}

function summarizeEvidenceResult(resultText) {
  if (!resultText) return "No result content";
  try {
    const parsed = JSON.parse(resultText);
    if (Array.isArray(parsed)) return `${parsed.length} record${parsed.length === 1 ? "" : "s"} returned`;
    if (parsed && typeof parsed === "object") return "1 record returned";
  } catch {
    // Not JSON — fall through to a plain-text preview.
  }
  return resultText.length > PREVIEW_LIMIT ? `${resultText.slice(0, PREVIEW_LIMIT)}...` : resultText;
}

function toVerdictEdgeEvent(args) {
  const { hypothesis, evidenceSource, verdict, confidence } = args ?? {};
  try {
    const classified = classifyConnection({ verdict, confidence });
    return { type: "edge_added", hypothesis, evidenceSource, ...classified };
  } catch {
    return null;
  }
}

function toConclusionEvent(args) {
  const { rootCause, confidence, recommendedAction } = args ?? {};
  return { type: "conclusion", rootCause, confidence, recommendedAction };
}

function toToolCallEvent(streamEvent) {
  return {
    type: "node_added",
    id: streamEvent.toolCallId,
    label: describeEvidenceSource(streamEvent.toolName),
    source: streamEvent.toolName,
  };
}

function toToolResultEvent(streamEvent) {
  return { type: "node_result", id: streamEvent.toolCallId, summary: summarizeEvidenceResult(streamEvent.resultText) };
}

function toApprovalRequiredEvent(streamEvent) {
  return { type: "approval_required", toolName: streamEvent.toolName, toolCallId: streamEvent.toolCallId };
}

function toBoardEvent(streamEvent) {
  if (streamEvent.type === "tool_call" && streamEvent.toolName === "record_hypothesis_verdict") {
    return toVerdictEdgeEvent(streamEvent.args);
  }
  if (streamEvent.type === "tool_call" && streamEvent.toolName === "conclude_investigation") {
    return toConclusionEvent(streamEvent.args);
  }
  if (streamEvent.type === "tool_call") return toToolCallEvent(streamEvent);
  if (streamEvent.type === "tool_result") return toToolResultEvent(streamEvent);
  if (streamEvent.type === "approval_required") return toApprovalRequiredEvent(streamEvent);
  return null;
}

export { describeEvidenceSource, summarizeEvidenceResult, toBoardEvent, NODELESS_TOOLS };
