// Detective Board — vanilla JS, no framework/build step.

const CASE_NODE_ID = "__case__";
const NODE_W = 184;
const NODE_H = 108;
const CASE_W = 224;
const CASE_H = 112;

const ICON_BY_EVENT_TYPE = {
  node_added: "ph-magnifying-glass",
  node_result: "ph-file-text",
  edge_added: "ph-link",
  conclusion: "ph-lightbulb-filament",
  approval_required: "ph-warning-circle",
  approval_resolved: "ph-check-circle",
  step_limit_reached: "ph-hourglass-high",
};

// Log-only progress lines streamed as "activity" events (see src/activity-events.mjs).
const ICON_BY_ACTIVITY_KIND = {
  thinking: "ph-dots-three-circle",
  tool_started: "ph-gear-six",
  tool_finished: "ph-check",
};

const state = {
  caseId: null,
  nodes: [],
  edges: [],
  selectedNodeId: null,
  conclusion: null,
};

const el = (id) => document.getElementById(id);

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** Reads a Server-Sent Events response, dispatching each event to a handler by name. */
async function consumeSSE(response, handlers) {
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const eventMatch = chunk.match(/^event: (.+)$/m);
      const dataMatch = chunk.match(/^data: (.+)$/m);
      if (!eventMatch || !dataMatch) continue;
      handlers[eventMatch[1]]?.(JSON.parse(dataMatch[1]));
    }
  }
}

// ---- Board rendering (D3 force graph) ----

const svg = d3.select("#board");
const edgeLayer = svg.append("g").attr("class", "edges");
const nodeLayer = svg.append("g").attr("class", "nodes");

let width = 0;
let height = 0;

function evidencePosition(index) {
  const positions = [
    [0.18, 0.20], [0.79, 0.18], [0.16, 0.58], [0.82, 0.56],
    [0.31, 0.82], [0.68, 0.80], [0.50, 0.14], [0.50, 0.87],
  ];
  const [x, y] = positions[index % positions.length];
  return { x: width * x, y: height * y };
}

/** Keeps every node's card fully on-screen regardless of viewport size, so a resize (or a phone rotation) never strands one off the edge. */
function keepInBounds() {
  for (const node of state.nodes) {
    const halfW = (node.type === "case" ? CASE_W : NODE_W) / 2;
    const halfH = (node.type === "case" ? CASE_H : NODE_H) / 2;
    node.x = Math.min(width - halfW, Math.max(halfW, node.x));
    node.y = Math.min(height - halfH, Math.max(halfH, node.y));
  }
}

const simulation = d3
  .forceSimulation([])
  .force("charge", d3.forceManyBody().strength(-40))
  .force("link", d3.forceLink([]).id((d) => d.id).distance(210))
  .force("collide", d3.forceCollide(112))
  .force("bounds", keepInBounds);

function resizeBoard() {
  // The board is display:none while the case picker is showing, so it has no size to measure.
  if (el("workspace").hidden) return;
  const rect = el("board").parentElement.getBoundingClientRect();
  width = rect.width;
  height = rect.height;
  svg.attr("viewBox", `0 0 ${width} ${height}`);
  simulation.force("center", d3.forceCenter(width / 2, height / 2));
  const caseNode = state.nodes.find((n) => n.id === CASE_NODE_ID);
  if (caseNode) {
    caseNode.fx = width / 2;
    caseNode.fy = height / 2;
  }
  for (const node of state.nodes) {
    if (node.layout && node.id !== CASE_NODE_ID) {
      node.x = width * node.layout[0];
      node.y = height * node.layout[1];
      node.fx = node.x;
      node.fy = node.y;
    }
  }
  // Reheat so existing (non-fixed) nodes actually drift to the new center/bounds
  // instead of sitting wherever they were laid out for the previous viewport size.
  if (state.nodes.length) restartSimulation();
}

function ensureCaseNode() {
  if (state.nodes.some((n) => n.id === CASE_NODE_ID)) return;
  state.nodes.push({ id: CASE_NODE_ID, label: "THE CASE", type: "case", x: width / 2, y: height / 2, fx: width / 2, fy: height / 2 });
}

function resolveEnd(x) {
  return typeof x === "object" ? x : state.nodes.find((n) => n.id === x);
}

function nodeClass(d) {
  const parts = ["node"];
  if (d.type === "case") parts.push("case");
  if (d.verdict) parts.push(`verdict-${d.verdict}`);
  return parts.join(" ");
}

/** A real thread hangs below its anchors; this is deliberately a deep cubic curve, not a graph edge. */
function stringGeometry(edge) {
  const s = resolveEnd(edge.source);
  const t = resolveEnd(edge.target);
  if (!s || !t) return null;
  const sourcePin = pinPoint(s);
  const targetPin = pinPoint(t);
  const distance = Math.hypot(targetPin.x - sourcePin.x, targetPin.y - sourcePin.y);
  const sag = Math.max(42, Math.min(116, distance * 0.28));
  return { sourcePin, targetPin, sag };
}

function edgePath(edge) {
  const geometry = stringGeometry(edge);
  if (!geometry) return "";
  const { sourcePin, targetPin, sag } = geometry;
  return `M${sourcePin.x},${sourcePin.y} C${sourcePin.x},${sourcePin.y + sag} ${targetPin.x},${targetPin.y + sag} ${targetPin.x},${targetPin.y}`;
}

function stringMidpoint(edge) {
  const geometry = stringGeometry(edge);
  if (!geometry) return { x: 0, y: 0 };
  const { sourcePin, targetPin, sag } = geometry;
  return {
    x: (sourcePin.x + targetPin.x) / 2,
    y: (sourcePin.y + targetPin.y) / 2 + sag * 0.75,
  };
}

function pinPoint(node) {
  const h = node.type === "case" ? CASE_H : NODE_H;
  return { x: node.x, y: node.y - h / 2 + 8 };
}

function dragBehavior() {
  function started(event, d) {
    if (!event.active) simulation.alphaTarget(0.3).restart();
    d.fx = d.x;
    d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x;
    d.fy = event.y;
  }
  function ended(event, d) {
    if (!event.active) simulation.alphaTarget(0);
    d.fx = event.x;
    d.fy = event.y;
    d.layout = null;
  }
  return d3.drag().on("start", started).on("drag", dragged).on("end", ended);
}

function buildNodeCard(selection) {
  selection.each(function (d) {
    const g = d3.select(this);
    const isCase = d.type === "case";
    const w = isCase ? CASE_W : NODE_W;
    const h = isCase ? CASE_H : NODE_H;
    g.append("rect").attr("class", "card-shadow").attr("x", -w / 2 + 4).attr("y", -h / 2 + 5).attr("width", w).attr("height", h).attr("rx", 3);
    g.append("rect").attr("class", "card").attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", 2);
    g.append("path").attr("class", "paper-fold").attr("d", `M${w / 2 - 20},${-h / 2}h20v20z`);
    g.append("line").attr("class", "card-rule").attr("x1", -w / 2 + 16).attr("x2", w / 2 - 16).attr("y1", isCase ? 10 : 14).attr("y2", isCase ? 10 : 14);
    g.append("text").attr("class", "source-label").attr("x", -w / 2 + 16).attr("y", -h / 2 + 37);
    g.append("text").attr("class", "label").attr("x", -w / 2 + 16).attr("y", -h / 2 + (isCase ? 52 : 51));
    g.append("text").attr("class", "verdict-label").attr("x", -w / 2 + 16).attr("y", h / 2 - 15);
    g.append("circle").attr("class", "pin-shadow").attr("cx", 0).attr("cy", -h / 2 + 10).attr("r", 6.5);
    g.append("circle").attr("class", "pin").attr("cx", 0).attr("cy", -h / 2 + 8).attr("r", 5.5);
    g.append("circle").attr("class", "pin-glint").attr("cx", -1.7).attr("cy", -h / 2 + 6.2).attr("r", 1.35);
  });
}

function sourceLabel(node) {
  if (node.type === "case") return "ACTIVE INVESTIGATION";
  return String(node.source || "Evidence MCP").replace(/^get_/, "").replaceAll("_", " ").toUpperCase();
}

function verdictLabel(node) {
  if (node.type === "case") return "Root cause under review";
  if (!node.verdict) return "Lead collected · analysis pending";
  const labels = { confirmed: "Confirmed causal lead", rejected: "Ruled out", inconclusive: "Needs more evidence" };
  return labels[node.verdict] || "Assessment recorded";
}

function setMultilineText(selection, value, maxChars = 24) {
  selection.each(function (d) {
    const text = d3.select(this);
    const words = String(value(d)).split(/\s+/);
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxChars && line) { lines.push(line); line = word; }
      else line = candidate;
    }
    if (line) lines.push(line);
    const x = text.attr("x");
    text.text("");
    lines.slice(0, 2).forEach((part, index) => text.append("tspan").attr("x", x).attr("dy", index ? 16 : 0).text(part));
  });
}

function updateBoardReadout(node) {
  const readout = el("board-readout");
  if (!node || node.type === "case") {
    readout.innerHTML = "Case board ready <span>Awaiting evidence</span>";
    return;
  }
  readout.innerHTML = `${escapeHtml(node.label)} <span>${escapeHtml(verdictLabel(node))}</span>`;
}

function render() {
  const visibleEdges = state.edges.filter((e) => !e.hidden);

  const edgeSel = edgeLayer.selectAll("g.edge-group").data(visibleEdges, (d) => d.id);
  edgeSel.exit().remove();
  // "animate-in" lives on the wrapping <g>, not the path, and only touches
  // opacity/transform (never stroke-dasharray) — a rapid run can re-render
  // this edge (and stomp the class) well before the animation's 0.5s is up,
  // which is safe to interrupt for opacity but would have permanently
  // corrupted a dash-offset "drawing" effect's units mid-flight.
  const edgeEnter = edgeSel.enter().append("g").attr("class", "edge-group animate-in");
  edgeEnter.append("path").attr("class", (d) => `edge ${d.edgeStyle}`);
  edgeEnter.append("rect").attr("class", "edge-label-bg");
  edgeEnter.append("text").attr("class", "edge-label");
  edgeSel.select("path").attr("class", (d) => `edge ${d.edgeStyle}`);
  const edgeAll = edgeEnter.merge(edgeSel);
  edgeAll.select("text").text((d) => (d.confidence != null ? `${d.confidence}%` : ""));

  const nodeSel = nodeLayer.selectAll("g.node").data(state.nodes, (d) => d.id);
  nodeSel.exit().remove();
  // Same reasoning as the edges above: only the update selection's class is
  // rewritten on verdict changes, so a freshly entering node's one-shot
  // "enter" class survives long enough to actually animate.
  const selectNode = (_event, d) => {
    state.selectedNodeId = d.id;
    updateBoardReadout(d);
    render();
  };
  const nodeEnter = nodeSel.enter().append("g").attr("class", (d) => `${nodeClass(d)} enter`)
    .attr("tabindex", 0).attr("role", "button").attr("aria-label", (d) => `Inspect ${d.label}`).call(dragBehavior())
    .on("click", (_event, d) => {
      selectNode(_event, d);
    })
    .on("keydown", (event, d) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectNode(event, d); }
    });
  buildNodeCard(nodeEnter);
  nodeSel.attr("class", nodeClass);
  const nodeAll = nodeEnter.merge(nodeSel).classed("selected", (d) => d.id === state.selectedNodeId);
  nodeAll.select("text.source-label").text(sourceLabel);
  nodeAll.select("text.verdict-label").text(verdictLabel);
  setMultilineText(nodeAll.select("text.label"), (d) => d.label, 23);

  simulation.on("tick", () => {
    edgeAll.select("path").attr("d", edgePath);
    edgeAll.select("text").attr("x", (d) => {
      const s = resolveEnd(d.source);
      const t = resolveEnd(d.target);
      return stringMidpoint(d).x;
    });
    edgeAll.select("text").attr("y", (d) => {
      const s = resolveEnd(d.source);
      const t = resolveEnd(d.target);
      return stringMidpoint(d).y;
    });
    edgeAll.select("rect.edge-label-bg").attr("x", (d) => {
      const label = d.confidence != null ? `${d.confidence}%` : "";
      const s = resolveEnd(d.source); const t = resolveEnd(d.target);
      return stringMidpoint(d).x - (label.length * 3.6 + 9);
    }).attr("y", (d) => {
      const s = resolveEnd(d.source); const t = resolveEnd(d.target);
      return stringMidpoint(d).y - 8;
    }).attr("width", (d) => d.confidence != null ? `${d.confidence}%`.length * 7.2 + 18 : 0).attr("height", 18);
    nodeAll.attr("transform", (d) => `translate(${d.x},${d.y})`);
  });
}

function restartSimulation() {
  simulation.nodes(state.nodes);
  simulation.force("link").links(state.edges.filter((e) => !e.hidden));
  simulation.alpha(0.8).restart();
  render();
}

function addEvidenceNode(id, label, source) {
  if (state.nodes.some((n) => n.id === id)) return;
  const evidenceIndex = state.nodes.filter((n) => n.type === "evidence").length;
  const position = evidencePosition(evidenceIndex);
  const layouts = [[0.18, 0.20], [0.79, 0.18], [0.16, 0.58], [0.82, 0.56], [0.31, 0.82], [0.68, 0.80], [0.50, 0.14], [0.50, 0.87]];
  // New evidence starts in a deliberate open slot and stays there until the user moves it.
  state.nodes.push({ id, label, source, type: "evidence", ...position, layout: layouts[evidenceIndex % layouts.length], fx: position.x, fy: position.y });
  state.edges.push({ id: `link-${id}`, source: CASE_NODE_ID, target: id, edgeStyle: "dashed-gray", confidence: null, hidden: true });
  restartSimulation();
}

function setNodeResult(id, summary) {
  const node = state.nodes.find((n) => n.id === id);
  if (node) node.resultSummary = summary;
  if (state.selectedNodeId === id) updateBoardReadout(node);
}

/** Links a self-reported verdict to the most recent still-unlinked node from the same evidence source. */
function addConnectionEdge({ hypothesis, evidenceSource, verdict, confidence, edgeStyle }) {
  const edge = [...state.edges].reverse().find((e) => {
    const target = resolveEnd(e.target);
    return e.hidden && target?.source === evidenceSource;
  });
  if (!edge) return;
  const node = resolveEnd(edge.target);
  node.verdict = verdict;
  node.hypothesis = hypothesis;
  edge.edgeStyle = edgeStyle;
  edge.confidence = confidence;
  edge.hidden = false;
  restartSimulation();
  if (state.selectedNodeId === node.id) updateBoardReadout(node);
}

// ---- Case file panel + event log ----

// The newest "thinking" line ticks up its elapsed seconds while the model works, so a
// slow step (a reasoning model can take 30s+ before its next tool call) reads as
// "still working" instead of a frozen log. Any newer log line stops it.
let liveTicker = null;

function stopLiveTicker() {
  if (liveTicker) clearInterval(liveTicker);
  liveTicker = null;
}

function startLiveTicker(span, baseText) {
  const startedAt = Date.now();
  liveTicker = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    if (seconds >= 3) span.textContent = `${baseText} ${seconds}s`;
  }, 1000);
}

function logEvent(iconClass, text, extraClass = "") {
  stopLiveTicker();
  const li = document.createElement("li");
  if (extraClass) li.className = extraClass;
  const icon = document.createElement("i");
  icon.className = `ph ${iconClass}`;
  const span = document.createElement("span");
  span.textContent = text;
  li.append(icon, span);
  el("event-log").prepend(li);
  return li;
}

function describeEventForLog(event) {
  switch (event.type) {
    case "node_added":
      return `Evidence gathered: ${event.label} (${event.source})`;
    case "node_result":
      return `Result: ${event.summary}`;
    case "edge_added":
      return `Verdict on "${event.hypothesis}": ${event.verdict} (${event.confidence}%)`;
    case "conclusion":
      return `Conclusion: ${event.rootCause} (${event.confidence}%)`;
    case "approval_required":
      return `Approval required: ${event.toolName}`;
    case "approval_resolved":
      return `Fix ${event.outcome}`;
    case "step_limit_reached":
      return `Step limit reached (${event.maxSteps} steps)`;
    default:
      return JSON.stringify(event);
  }
}

function renderConclusion(event) {
  state.conclusion = event;
  const box = el("conclusion");
  box.classList.remove("empty");
  box.innerHTML =
    `<i class="ph-fill ph-lightbulb-filament"></i><div>` +
    `<strong>${escapeHtml(event.rootCause)}</strong><br/>` +
    `Confidence: ${event.confidence}%<br/>` +
    `Recommended: ${escapeHtml(event.recommendedAction)}</div>`;
}

function showApproval(event) {
  el("approval").classList.remove("hidden");
  el("approval-text").textContent = `The senior detective wants to run "${event.toolName}". Approve the fix?`;
}

function hideApprovalWithOutcome(event) {
  el("approval").classList.add("hidden");
  const box = el("conclusion");
  box.insertAdjacentHTML("beforeend", `<div class="approval-outcome">Fix ${escapeHtml(event.outcome)}.</div>`);
}

function handleBoardEvent(event) {
  const extraClass = event.type === "edge_added" ? `verdict-${event.verdict}` : "";
  logEvent(ICON_BY_EVENT_TYPE[event.type] ?? "ph-info", describeEventForLog(event), extraClass);
  if (event.type === "node_added") addEvidenceNode(event.id, event.label, event.source);
  else if (event.type === "node_result") setNodeResult(event.id, event.summary);
  else if (event.type === "edge_added") addConnectionEdge(event);
  else if (event.type === "conclusion") renderConclusion(event);
  else if (event.type === "approval_required") {
    showApproval(event);
    setCaseStatus(state.caseId, "awaiting");
  } else if (event.type === "approval_resolved") hideApprovalWithOutcome(event);
}

function handleActivity(activity) {
  const li = logEvent(ICON_BY_ACTIVITY_KIND[activity.kind] ?? "ph-info", activity.text, "activity");
  if (activity.kind === "thinking") startLiveTicker(li.querySelector("span"), activity.text);
}

// ---- Case closed: senior summary, stamp, confetti ----

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function fireConfetti() {
  if (!window.confetti || prefersReducedMotion()) return;
  const colors = ["#c23b3b", "#c2953b", "#f2e9d8", "#7d7368"];
  window.confetti({ particleCount: 150, spread: 95, startVelocity: 45, origin: { x: 0.5, y: 0.55 }, colors });
  const end = Date.now() + 2200;
  (function sideCannons() {
    window.confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.7 }, colors });
    window.confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.7 }, colors });
    if (Date.now() < end) requestAnimationFrame(sideCannons);
  })();
}

function fallbackSummary(fixOutcome) {
  const c = state.conclusion;
  if (!c) return "The senior detective has closed the case.";
  const fix =
    fixOutcome === "denied" ? "The proposed fix was declined." : fixOutcome === "approved" ? "The fix was approved." : "";
  return `${c.rootCause}. Recommended action: ${c.recommendedAction}. ${fix}`.trim();
}

function stampCase(fixOutcome) {
  const solved = fixOutcome !== "denied";
  const stamp = el("case-stamp");
  el("case-stamp-title").textContent = solved ? "Case Solved" : "Case Closed";
  el("case-stamp-sub").textContent = solved ? `Case ${state.caseId}` : "Fix declined";
  stamp.classList.toggle("declined", !solved);
  // Re-adding the element's animation on a rerun needs a reflow between hide and show.
  stamp.classList.add("hidden");
  void stamp.offsetWidth;
  stamp.classList.remove("hidden");
  if (solved) setTimeout(fireConfetti, 350);
}

function handleSummary({ text, fixOutcome }) {
  el("summary-text").textContent = text || fallbackSummary(fixOutcome);
  el("summary").classList.remove("hidden");
  logEvent("ph-file-text", "Senior detective's summary is ready");
  logEvent("ph-check-circle", fixOutcome === "denied" ? "Case closed - fix declined" : "Case solved");
  setCaseStatus(state.caseId, fixOutcome === "denied" ? "closed" : "solved");
  stampCase(fixOutcome);
}

function resetCaseClosure() {
  el("summary").classList.add("hidden");
  el("case-stamp").classList.add("hidden");
  window.confetti?.reset?.();
}

async function respondToApproval(decision) {
  setBusy(true);
  setCaseStatus(state.caseId, "investigating");
  el("approve-btn").disabled = true;
  el("deny-btn").disabled = true;
  try {
    const res = await fetch("/api/investigate/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: state.caseId, decision }),
    });
    await consumeSSE(res, {
      activity: handleActivity,
      board_event: handleBoardEvent,
      summary: handleSummary,
      done: stopLiveTicker,
      error: (data) => logEvent("ph-warning", `Error: ${data.message}`),
    });
  } catch (err) {
    logEvent("ph-warning", `Error: ${err.message}`);
  } finally {
    stopLiveTicker();
    el("approve-btn").disabled = false;
    el("deny-btn").disabled = false;
    settleCaseStatus();
    setBusy(false);
  }
}

async function startInvestigation() {
  el("start-btn").disabled = true;
  setBusy(true);
  setCaseStatus(state.caseId, "investigating");
  state.nodes = [];
  state.edges = [];
  state.selectedNodeId = null;
  ensureCaseNode();
  restartSimulation();
  el("conclusion").className = "conclusion empty";
  el("conclusion").innerHTML = `<i class="ph ph-lightbulb-filament"></i><div>No conclusion yet. Start the investigation to build the case.</div>`;
  el("event-log").innerHTML = "";
  el("approval").classList.add("hidden");
  updateBoardReadout();
  stopLiveTicker();
  state.conclusion = null;
  resetCaseClosure();

  try {
    const res = await fetch("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: state.caseId, resetMemory: el("reset-memory").checked }),
    });
    await consumeSSE(res, {
      session: (data) => logEvent("ph-play", `Session started (${data.role ?? "investigator"})`),
      activity: handleActivity,
      board_event: handleBoardEvent,
      summary: handleSummary,
      done: stopLiveTicker,
      error: (data) => logEvent("ph-warning", `Error: ${data.message}`),
    });
  } catch (err) {
    logEvent("ph-warning", `Error: ${err.message}`);
  } finally {
    stopLiveTicker();
    el("start-btn").disabled = false;
    settleCaseStatus();
    setBusy(false);
  }
}

// ---- Cases: picker, per-case saved views, and the case rail ----

const STATUS_LABEL = {
  open: "Not started",
  investigating: "Investigating",
  awaiting: "Awaiting approval",
  solved: "Solved",
  closed: "Closed",
};

const STATUS_ICON = {
  open: "ph-folder-open",
  investigating: "ph-magnifying-glass",
  awaiting: "ph-warning-circle",
  solved: "ph-check-circle",
  closed: "ph-x-circle",
};

const EMPTY_CONCLUSION_HTML = `<i class="ph ph-lightbulb-filament"></i><div>No conclusion yet. Start the investigation to build the case.</div>`;

let cases = []; // [{ id, title, date, headline }] from /api/cases
let busy = false; // true while an investigation or an approval is streaming
const caseViews = new Map(); // caseId -> that case's saved board, log, and case-file panel

/** Each case keeps its own board, event log, conclusion, summary, and stamp, so switching cases never loses work. */
function viewFor(caseId) {
  if (!caseViews.has(caseId)) {
    caseViews.set(caseId, {
      status: "open",
      nodes: [],
      edges: [],
      conclusion: null,
      conclusionClass: "conclusion empty",
      conclusionHtml: EMPTY_CONCLUSION_HTML,
      logHtml: "",
      summary: { visible: false, text: "" },
      stamp: { visible: false, title: "", sub: "", declined: false },
      approval: { visible: false, text: "" },
    });
  }
  return caseViews.get(caseId);
}

function saveView() {
  if (!state.caseId) return;
  const v = viewFor(state.caseId);
  v.nodes = state.nodes;
  v.edges = state.edges;
  v.conclusion = state.conclusion;
  v.conclusionClass = el("conclusion").className;
  v.conclusionHtml = el("conclusion").innerHTML;
  v.logHtml = el("event-log").innerHTML;
  v.summary = { visible: !el("summary").classList.contains("hidden"), text: el("summary-text").textContent };
  v.stamp = {
    visible: !el("case-stamp").classList.contains("hidden"),
    title: el("case-stamp-title").textContent,
    sub: el("case-stamp-sub").textContent,
    declined: el("case-stamp").classList.contains("declined"),
  };
  v.approval = { visible: !el("approval").classList.contains("hidden"), text: el("approval-text").textContent };
}

function loadView(caseId) {
  const v = viewFor(caseId);
  state.nodes = v.nodes;
  state.edges = v.edges;
  state.conclusion = v.conclusion;
  state.selectedNodeId = null;
  ensureCaseNode();
  // The board only has a measurable size once the workspace is visible. Measuring here also
  // re-pins the case node and re-lays-out every card in its slot, so a restored view that dates
  // from a different window size still fits.
  resizeBoard();
  updateBoardReadout();

  el("conclusion").className = v.conclusionClass;
  el("conclusion").innerHTML = v.conclusionHtml;
  el("event-log").innerHTML = v.logHtml;
  el("summary-text").textContent = v.summary.text;
  el("summary").classList.toggle("hidden", !v.summary.visible);
  el("case-stamp-title").textContent = v.stamp.title;
  el("case-stamp-sub").textContent = v.stamp.sub;
  el("case-stamp").classList.toggle("declined", v.stamp.declined);
  el("case-stamp").classList.toggle("hidden", !v.stamp.visible);
  el("approval-text").textContent = v.approval.text;
  el("approval").classList.toggle("hidden", !v.approval.visible);
}

function setCaseStatus(caseId, status) {
  viewFor(caseId).status = status;
  renderRail();
  renderCards();
}

/** A run that ends without a verdict or a pending approval (an error, the step limit) leaves nothing in progress. */
function settleCaseStatus() {
  const v = viewFor(state.caseId);
  if (v.status === "investigating") setCaseStatus(state.caseId, "open");
}

function setBusy(value) {
  busy = value;
  renderRail();
}

function statusBadge(className, status) {
  const badge = document.createElement("span");
  badge.className = className;
  badge.dataset.status = status;
  const icon = document.createElement("i");
  icon.className = `ph ${STATUS_ICON[status]}`;
  badge.append(icon, document.createTextNode(STATUS_LABEL[status]));
  return badge;
}

let cardsHaveAnimated = false;

function renderCards() {
  const grid = el("case-grid");
  grid.replaceChildren();
  if (!cases.length) {
    const empty = document.createElement("li");
    empty.className = "picker-sub";
    empty.textContent = "No cases are available yet.";
    grid.append(empty);
    return;
  }
  cases.forEach((c, i) => {
    const li = document.createElement("li");
    li.style.setProperty("--i", i);
    const button = document.createElement("button");
    button.className = "case-card";
    button.type = "button";
    button.dataset.caseId = c.id;
    button.setAttribute("aria-label", `Open case ${c.id}, ${c.title}`);

    const pin = document.createElement("span");
    pin.className = "case-card-pin";
    const number = document.createElement("span");
    number.className = "case-card-number";
    number.textContent = c.id;
    const title = document.createElement("span");
    title.className = "case-card-title";
    title.textContent = c.title;
    const headline = document.createElement("span");
    headline.className = "case-card-headline";
    headline.textContent = c.headline;

    const foot = document.createElement("span");
    foot.className = "case-card-foot";
    const date = document.createElement("span");
    date.className = "case-card-date";
    date.textContent = c.date;
    const arrow = document.createElement("i");
    arrow.className = "ph ph-arrow-right case-card-open";
    foot.append(date, statusBadge("case-card-status", viewFor(c.id).status), arrow);

    button.append(pin, number, title, headline, foot);
    button.addEventListener("click", () => openCase(c.id));
    li.append(button);
    grid.append(li);
  });
  // Entrance animation only on the first render; later renders (a status change) must not replay it.
  if (!cardsHaveAnimated) {
    cardsHaveAnimated = true;
    grid.classList.add("case-card-anim");
    setTimeout(() => grid.classList.remove("case-card-anim"), 1200);
  }
}

function renderRail() {
  const list = el("rail-list");
  list.replaceChildren();
  for (const c of cases) {
    const isActive = c.id === state.caseId;
    const locked = busy && !isActive;
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = "rail-item";
    button.type = "button";
    button.setAttribute("aria-current", String(isActive));
    if (locked) {
      button.setAttribute("aria-disabled", "true");
      button.title = "Finish the current investigation first";
    }
    const number = document.createElement("span");
    number.className = "rail-number";
    number.textContent = c.id;
    button.append(number, statusBadge("rail-status", viewFor(c.id).status));
    button.addEventListener("click", () => {
      if (!locked && !isActive) openCase(c.id);
    });
    li.append(button);
    list.append(li);
  }
  el("all-cases-btn").disabled = busy;
}

function openCase(caseId) {
  if (busy) return;
  if (state.caseId && state.caseId !== caseId) saveView();
  state.caseId = caseId;
  document.body.dataset.view = "workspace";
  el("picker").hidden = true;
  el("workspace").hidden = false;
  el("topbar-case-label").textContent = `Case ${caseId}`;
  stopLiveTicker();
  window.confetti?.reset?.();
  loadView(caseId);
  renderRail();
}

function showPicker() {
  if (busy) return;
  saveView();
  document.body.dataset.view = "picker";
  el("workspace").hidden = true;
  el("picker").hidden = false;
  renderCards();
}

async function loadCases() {
  el("picker-error").hidden = true;
  try {
    const res = await fetch("/api/cases");
    if (!res.ok) throw new Error(`The server answered ${res.status}`);
    cases = (await res.json()).cases ?? [];
    renderCards();
  } catch (err) {
    el("case-grid").replaceChildren();
    el("picker-error-text").textContent = `Could not load the cases. ${err.message}.`;
    el("picker-error").hidden = false;
  }
}

window.addEventListener("resize", resizeBoard);
updateBoardReadout();

el("picker-retry-btn").addEventListener("click", loadCases);
el("all-cases-btn").addEventListener("click", showPicker);
loadCases();

el("start-btn").addEventListener("click", startInvestigation);
el("approve-btn").addEventListener("click", () => respondToApproval("allow"));
el("deny-btn").addEventListener("click", () => respondToApproval("deny"));
