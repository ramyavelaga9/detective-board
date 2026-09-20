// Translates one real TrueForge stream event into a board event the
// frontend can render, producing board-shaped output (nodes,
// edges, conclusions).
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

/**
 * The investigator self-reports which evidence tool a verdict rests on, and it often adds
 * detail ("get_weather (northeast)", "get_inventory_status for SKU-101"). The board links a
 * verdict to its evidence card by tool name, so an exact-match lookup silently dropped every
 * decorated verdict: the card stayed "analysis pending" and its red line never appeared.
 * Keep just the real tool name when one is in the text; otherwise return the text trimmed.
 */
function normalizeEvidenceSource(evidenceSource) {
  if (typeof evidenceSource !== "string") return evidenceSource;
  const text = evidenceSource.trim().toLowerCase();
  const known = Object.keys(EVIDENCE_SOURCE_BY_TOOL)
    .filter((tool) => text.includes(tool))
    .sort((a, b) => text.indexOf(a) - text.indexOf(b));
  return known[0] ?? evidenceSource.trim();
}

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

function shortDate(value) {
  if (typeof value !== "string") return "";
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[2]}/${match[3]}` : value;
}

function humanize(value) {
  return String(value ?? "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return number >= 1000 ? `${(number / 1000).toFixed(number % 1000 ? 1 : 0)}k` : String(number);
}

/**
 * A board card is a clue, not a generic tool receipt. Keep its title tied to
 * the query that created it, so several calls to the same tool remain visibly
 * distinct even before a verdict is attached.
 */
function describeEvidenceSubject(toolName, args = {}) {
  switch (toolName) {
    case "get_inventory_status": return args.sku || "Inventory check";
    case "get_weather": return [humanize(args.region), shortDate(args.date)].filter(Boolean).join(" · ") || "Weather check";
    case "get_sku_sales_breakdown": return shortDate(args.date) ? `SKU mix · ${shortDate(args.date)}` : "SKU sales mix";
    case "get_marketing_metrics": return `${args.days ?? 30}-day campaign trend`;
    case "get_refund_events": return `${args.days ?? 30}-day refund pattern`;
    case "get_revenue_timeseries": return `${args.days ?? 30}-day revenue trend`;
    case "get_revenue_deviation": return "Revenue deviation";
    case "propose_restock_action": return args.sku ? `Restock ${args.sku}` : "Restock proposal";
    case "propose_marketing_action": return args.dailyAdSpend ? `$${compactNumber(args.dailyAdSpend)}/day restore` : "Spend restore";
    default: return describeEvidenceSource(toolName);
  }
}

/** Extract one useful, plain-language fact from the tool payload for the card. */
function describeEvidenceFact(toolName, resultText) {
  let parsed;
  try {
    parsed = JSON.parse(resultText);
  } catch {
    return summarizeEvidenceResult(resultText);
  }

  if (toolName === "get_inventory_status" && parsed && !Array.isArray(parsed)) {
    const stock = compactNumber(parsed.stock);
    if (stock == null) return summarizeEvidenceResult(resultText);
    return parsed.stockoutSince ? `${stock} on hand · out since ${shortDate(parsed.stockoutSince)}` : `${stock} on hand · available`;
  }
  if (toolName === "get_weather" && parsed && !Array.isArray(parsed)) {
    return `${humanize(parsed.condition)} · ${parsed.severe ? "severe" : "normal"}`;
  }
  if (toolName === "get_revenue_deviation" && parsed && !Array.isArray(parsed)) {
    return `${parsed.percentChange > 0 ? "+" : ""}${parsed.percentChange}% vs 14-day average`;
  }
  if (toolName === "get_sku_sales_breakdown" && Array.isArray(parsed)) {
    const units = parsed.reduce((total, row) => total + (Number(row?.units) || 0), 0);
    return `${parsed.length} SKUs · ${units} units sold`;
  }
  if (toolName === "get_marketing_metrics" && Array.isArray(parsed) && parsed.length) {
    const first = parsed[0];
    const last = parsed.at(-1);
    return `$${compactNumber(first.adSpend)} → $${compactNumber(last.adSpend)}/day`;
  }
  if (toolName === "get_refund_events" && Array.isArray(parsed) && parsed.length) {
    const last = parsed.at(-1);
    return `${compactNumber(last.refundCount)} refunds · $${compactNumber(last.refundAmount)}/day`;
  }
  if (toolName === "get_revenue_timeseries" && Array.isArray(parsed) && parsed.length) {
    const last = parsed.at(-1);
    return `$${compactNumber(last.revenue)} · ${compactNumber(last.orders)} orders`;
  }
  if (toolName === "propose_restock_action" && parsed && !Array.isArray(parsed)) {
    return `${compactNumber(parsed.quantity)} units · simulated`;
  }
  if (toolName === "propose_marketing_action" && parsed && !Array.isArray(parsed)) {
    return `$${compactNumber(parsed.dailyAdSpend)}/day · simulated`;
  }
  return summarizeEvidenceResult(resultText);
}

/** `verdictId` (the verdict call's id) lets a later second opinion find the card this verdict landed on. */
function toVerdictEdgeEvent(args, verdictId) {
  const { hypothesis, evidenceSource, verdict, confidence } = args ?? {};
  try {
    const classified = classifyConnection({ verdict, confidence });
    return { type: "edge_added", verdictId, hypothesis, evidenceSource: normalizeEvidenceSource(evidenceSource), ...classified };
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
    label: describeEvidenceSubject(streamEvent.toolName, streamEvent.args),
    detail: "Collecting evidence…",
    source: streamEvent.toolName,
  };
}

function toToolResultEvent(streamEvent) {
  return {
    type: "node_result",
    id: streamEvent.toolCallId,
    summary: summarizeEvidenceResult(streamEvent.resultText),
    detail: describeEvidenceFact(streamEvent.toolName, streamEvent.resultText),
  };
}

function toApprovalRequiredEvent(streamEvent) {
  return { type: "approval_required", toolName: streamEvent.toolName, toolCallId: streamEvent.toolCallId };
}

function toBoardEvent(streamEvent) {
  if (streamEvent.type === "tool_call" && streamEvent.toolName === "record_hypothesis_verdict") {
    return toVerdictEdgeEvent(streamEvent.args, streamEvent.toolCallId);
  }
  if (streamEvent.type === "tool_call" && streamEvent.toolName === "conclude_investigation") {
    return toConclusionEvent(streamEvent.args);
  }
  if (streamEvent.type === "tool_call") return toToolCallEvent(streamEvent);
  if (streamEvent.type === "tool_result") return toToolResultEvent(streamEvent);
  if (streamEvent.type === "approval_required") return toApprovalRequiredEvent(streamEvent);
  return null;
}

export {
  describeEvidenceSource,
  describeEvidenceSubject,
  describeEvidenceFact,
  normalizeEvidenceSource,
  summarizeEvidenceResult,
  toBoardEvent,
  NODELESS_TOOLS,
};
