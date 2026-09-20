// Detective Board — vanilla JS, no framework/build step.

const CASE_NODE_ID = "__case__";
const NODE_W = 184;
const NODE_H = 156;
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
  decisionRequested: false,
};

const el = (id) => document.getElementById(id);

const PHASES = ["evidence", "leads", "senior", "decision"];
const PHASE_COPY = {
  ready: "Ready to investigate",
  evidence: "Gathering evidence",
  leads: "Testing leads",
  senior: "Senior review",
  decision: "Awaiting decision",
  closing: "Closing the case",
  closed: "Case closed",
};

function renderInvestigationPhase(phase = "ready") {
  const tracker = el("investigation-phase");
  if (!tracker) return;
  const activeIndex = PHASES.indexOf(phase === "closing" || phase === "closed" ? "decision" : phase);
  el("phase-live").innerHTML = `<i class="ph ${phase === "closed" ? "ph-check-circle" : "ph-push-pin-simple"}"></i> ${escapeHtml(PHASE_COPY[phase] ?? PHASE_COPY.ready)}`;
  tracker.setAttribute("aria-label", `Investigation phase: ${PHASE_COPY[phase] ?? PHASE_COPY.ready}`);
  tracker.dataset.phase = phase;
  tracker.querySelectorAll(".phase-steps li").forEach((step, index) => {
    step.classList.toggle("is-complete", activeIndex >= 0 && index < activeIndex);
    step.classList.toggle("is-active", activeIndex === index && phase !== "closed");
    if (phase === "closed" && index === PHASES.length - 1) step.classList.add("is-complete");
  });
}

function setInvestigationPhase(phase) {
  if (!state.caseId) return;
  viewFor(state.caseId).phase = phase;
  renderInvestigationPhase(phase);
}

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
  if (d.jev?.status === "pending" || d.jev?.status === "complete") parts.push(`jev-${d.jev.status}`);
  if (d.disagrees) parts.push("jev-disagrees");
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
    if (!isCase) g.append("rect").attr("class", "jev-ring").attr("x", -w / 2 - 5).attr("y", -h / 2 - 5).attr("width", w + 10).attr("height", h + 10).attr("rx", 5);
    g.append("rect").attr("class", "card-shadow").attr("x", -w / 2 + 4).attr("y", -h / 2 + 5).attr("width", w).attr("height", h).attr("rx", 3);
    g.append("rect").attr("class", "card").attr("x", -w / 2).attr("y", -h / 2).attr("width", w).attr("height", h).attr("rx", 2);
    g.append("path").attr("class", "paper-fold").attr("d", `M${w / 2 - 20},${-h / 2}h20v20z`);
    g.append("line").attr("class", "card-rule").attr("x1", -w / 2 + 16).attr("x2", w / 2 - 16).attr("y1", isCase ? 10 : -h / 2 + 58).attr("y2", isCase ? 10 : -h / 2 + 58);
    g.append("text").attr("class", "source-label").attr("x", -w / 2 + 16).attr("y", -h / 2 + (isCase ? 37 : 24));
    g.append("text").attr("class", "label").attr("x", -w / 2 + 16).attr("y", -h / 2 + (isCase ? 52 : 46));
    if (!isCase) g.append("text").attr("class", "hypothesis-line").attr("x", -w / 2 + 16).attr("y", -h / 2 + 72);
    if (!isCase) g.append("text").attr("class", "evidence-detail").attr("x", -w / 2 + 16).attr("y", -h / 2 + 100);
    g.append("text").attr("class", "verdict-label").attr("x", -w / 2 + 16).attr("y", isCase ? h / 2 - 15 : -h / 2 + 114);
    g.append("circle").attr("class", "pin-shadow").attr("cx", 0).attr("cy", -h / 2 + 10).attr("r", 6.5);
    g.append("circle").attr("class", "pin").attr("cx", 0).attr("cy", -h / 2 + 8).attr("r", 5.5);
    g.append("circle").attr("class", "pin-glint").attr("cx", -1.7).attr("cy", -h / 2 + 6.2).attr("r", 1.35);
    if (!isCase) buildJevMarkers(g, w, h);
  });
}

// Jev's marks on a hypothesis card, hidden until a review exists: a paper-clip chip in the card's
// bottom row (inside the card, so it moves with it and never sits over another card's content),
// and, when Jev disagrees, an amber ring and a tag above the card's top-left corner.
function buildJevMarkers(g, w, h) {
  const chip = g.append("g").attr("class", "jev-chip").attr("transform", `translate(${-w / 2 + 16},${-h / 2 + JEV_CHIP_TOP})`);
  chip.append("rect").attr("class", "jev-chip-bg").attr("height", JEV_CHIP_HEIGHT).attr("rx", 3);
  chip.append("text").attr("class", "jev-chip-icon").attr("x", 7).attr("y", 14).text(PAPERCLIP_GLYPH);
  chip.append("text").attr("class", "jev-chip-label").attr("x", 24).attr("y", 14);
  const tag = g.append("g").attr("class", "jev-tag").attr("transform", `translate(${-w / 2},${-h / 2 - 20})`);
  tag.append("rect").attr("width", 92).attr("height", 16).attr("rx", 3);
  tag.append("text").attr("x", 8).attr("y", 12).text("Jev disagrees");
}

const JEV_CHIP_TOP = 124; // from the card's top edge; the chip row sits below the status line
const JEV_CHIP_HEIGHT = 20;
const HYPOTHESIS_LINE_CHARS = 30; // what fits the card's 152px text width at 10px
const HYPOTHESIS_LINES = 2;
const JEV_CHIP_PAD = 30; // icon and padding around the label
const JEV_CHIP_CHAR_PX = 5.8;
const PAPERCLIP_GLYPH = "\ue39a"; // the Phosphor icon font's paper clip, so no icon is hand-drawn

const JEV_VERDICT_LABEL = { supports: "Supports", doubts: "Doubts", unsure: "Unsure" };
const DETECTIVE_VERDICT_LABEL = { confirmed: "Confirmed", rejected: "Ruled out", inconclusive: "Inconclusive" };

function jevChipText(node) {
  if (node.jev?.status === "pending") return "Jev · reviewing…";
  if (node.jev?.status !== "complete") return "";
  return `Jev · ${JEV_VERDICT_LABEL[node.jev.verdict] ?? "Unsure"} · ${node.jev.confidence}%`;
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
  renderInspectPanel(node);
  if (!node || node.type === "case") {
    readout.innerHTML = "Case board ready <span>Awaiting evidence</span>";
    return;
  }
  readout.innerHTML = `${escapeHtml(node.label)} <span>${escapeHtml(verdictLabel(node))}</span>`;
}

/** The Case File's inspect view of the selected hypothesis: the detective's reasoning beside Jev's. */
function renderInspectPanel(node) {
  const panel = el("inspect-panel");
  const inspecting = Boolean(node && node.type !== "case" && node.hypothesis);
  panel.hidden = !inspecting;
  panel.innerHTML = inspecting ? inspectHtml(node) : "";
}

/** The detective's hypothesis beside Jev's reading of it, then what would change Jev's mind. */
function inspectHtml(node) {
  const detective =
    `<section><h4>Detective</h4>` +
    `<p class="inspect-verdict">${escapeHtml(DETECTIVE_VERDICT_LABEL[node.verdict] ?? node.verdict)} · ${node.confidence}%</p>` +
    `<p>${escapeHtml(node.hypothesis)}</p></section>`;
  const title = `<h3><i class="ph ph-magnifying-glass"></i> ${escapeHtml(node.label)}</h3>`;
  return `${title}<div class="inspect-grid">${detective}${jevInspectHtml(node)}</div>${jevChangeOfMindHtml(node)}`;
}

function jevInspectHtml(node) {
  const jev = node.jev;
  let body = "<p>Jev has not reviewed this hypothesis.</p>";
  if (jev?.status === "pending") body = "<p>Reviewing the evidence…</p>";
  if (jev?.status === "complete") {
    body = `<p class="inspect-verdict">${escapeHtml(JEV_VERDICT_LABEL[jev.verdict] ?? "Unsure")} · ${jev.confidence}%</p><p>${escapeHtml(jev.reasoning)}</p>`;
  }
  return `<section class="jev-only jev-inspect${node.disagrees ? " disagrees" : ""}"><h4>Jev</h4>${body}</section>`;
}

function jevChangeOfMindHtml(node) {
  if (node.jev?.status !== "complete") return "";
  return (
    `<p class="jev-only inspect-change"><b>What would change Jev's mind</b> ${escapeHtml(node.jev.whatWouldChangeMyMind)}</p>` +
    `<p class="jev-only inspect-note">Jev returns probabilities, not prose. These lines are worded from them.</p>`
  );
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
  const selectNode = (_event, d) => selectNodeById(d.id);
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
  nodeAll.select("text.hypothesis-line").each(function (d) {
    const text = d3.select(this);
    text.text("");
    wrapWithEllipsis(d.hypothesis, HYPOTHESIS_LINE_CHARS, HYPOTHESIS_LINES).forEach((part, index) =>
      text.append("tspan").attr("x", text.attr("x")).attr("dy", index ? 12 : 0).text(part)
    );
  });
  nodeAll.select("text.evidence-detail").text((d) => d.detail || "Collecting evidence…");
  nodeAll.select("text.jev-chip-label").text(jevChipText);
  nodeAll.select("rect.jev-chip-bg").attr("width", (d) => JEV_CHIP_PAD + jevChipText(d).length * JEV_CHIP_CHAR_PX);
  nodeAll.attr("aria-label", (d) => d.type === "case" ? `Inspect ${d.label}` : `Inspect ${sourceLabel(d)}: ${d.label}. ${d.detail || "Collecting evidence"}${d.hypothesis ? `. Hypothesis: ${d.hypothesis}` : ""}${d.disagrees ? ". Jev disagrees with the detective." : ""}`);

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

function addEvidenceNode(id, label, detail, source) {
  if (state.nodes.some((n) => n.id === id)) return;
  const evidenceIndex = state.nodes.filter((n) => n.type === "evidence").length;
  const position = evidencePosition(evidenceIndex);
  const layouts = [[0.18, 0.20], [0.79, 0.18], [0.16, 0.58], [0.82, 0.56], [0.31, 0.82], [0.68, 0.80], [0.50, 0.14], [0.50, 0.87]];
  // New evidence starts in a deliberate open slot and stays there until the user moves it.
  state.nodes.push({ id, label, detail, source, type: "evidence", ...position, layout: layouts[evidenceIndex % layouts.length], fx: position.x, fy: position.y });
  state.edges.push({ id: `link-${id}`, source: CASE_NODE_ID, target: id, edgeStyle: "dashed-gray", confidence: null, hidden: true });
  restartSimulation();
}

function setNodeResult(id, summary, detail) {
  const node = state.nodes.find((n) => n.id === id);
  if (node) {
    node.resultSummary = summary;
    node.detail = detail || summary;
  }
  if (state.selectedNodeId === id) updateBoardReadout(node);
}

/**
 * Links a self-reported verdict to the most recent still-unlinked card from the same evidence
 * source. If the model named a source no card matches, fall back to the most recent unlinked
 * evidence card: the verdict tool is meant to be called right after the evidence call it rests
 * on, and dropping the verdict instead would leave a confirmed lead with no red line.
 */
function addConnectionEdge({ verdictId, hypothesis, evidenceSource, verdict, confidence, edgeStyle }) {
  const unlinked = [...state.edges].reverse().filter((e) => e.hidden);
  const isEvidence = (e) => !String(resolveEnd(e.target)?.source).startsWith("propose_");
  const edge =
    unlinked.find((e) => resolveEnd(e.target)?.source === evidenceSource) ?? unlinked.find(isEvidence);
  if (!edge) return;
  const node = resolveEnd(edge.target);
  node.verdict = verdict;
  node.verdictId = verdictId;
  node.confidence = confidence;
  node.hypothesis = hypothesis;
  edge.edgeStyle = edgeStyle;
  edge.confidence = confidence;
  edge.hidden = false;
  restartSimulation();
  if (state.selectedNodeId === node.id) updateBoardReadout(node);
}

function selectNodeById(id) {
  const node = state.nodes.find((n) => n.id === id);
  if (!node) return;
  state.selectedNodeId = id;
  updateBoardReadout(node);
  render();
  renderJevRollup();
}

// ---- Jev's review of each hypothesis ----

const jevLogLines = new Map(); // verdictId -> the event-log line for that review, updated in place when it finishes

const reviewName = (node) => node.label.toLowerCase();
const shorten = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

function jevProgress() {
  const reviewed = state.nodes.filter((n) => n.jev);
  return { done: reviewed.filter((n) => n.jev.status !== "pending").length, total: reviewed.length };
}

/** "Jev review 4/5" beside the stepper: reviews run in parallel with the investigation, so they are a count, not a stage. */
function renderJevProgress() {
  const { done, total } = jevProgress();
  el("jev-progress").hidden = total === 0;
  el("jev-progress").classList.toggle("is-done", total > 0 && done === total);
  el("jev-progress-text").textContent = `Jev review ${done}/${total}`;
}

/** The Decision stage stays locked until approval has been requested and every Jev review has finished. */
function syncDecisionStage() {
  if (!state.decisionRequested) return;
  const { done, total } = jevProgress();
  if (done === total) setInvestigationPhase("decision");
}

function settleJevLogLine(node, event) {
  const text =
    event.jev.status === "complete"
      ? `Jev reviewed ${reviewName(node)}: ${event.jev.verdict} (${event.jev.confidence}%)`
      : `Jev could not review ${reviewName(node)}`;
  const line = jevLogLines.get(event.verdictId) ?? logEvent("ph-paperclip", text);
  line.querySelector("span").textContent = text;
  line.classList.toggle("verdict-inconclusive", event.disagrees);
}

/** A Jev review starting or finishing. One for a verdict that is not on this board (a stale run's late answer) is dropped. */
function applyJevEvent(event) {
  const node = state.nodes.find((n) => n.verdictId === event.verdictId);
  if (!node) return;
  if (event.type === "verdict_review_started") {
    node.jev = { status: "pending" };
    jevLogLines.set(event.verdictId, logEvent("ph-paperclip", `Jev reviewing ${reviewName(node)}…`));
  } else {
    node.jev = event.jev;
    node.disagrees = event.disagrees;
    node.alignment = event.alignment;
    settleJevLogLine(node, event);
  }
  render();
  if (state.selectedNodeId === node.id) updateBoardReadout(node);
  renderJevRollup();
  renderJevProgress();
  syncDecisionStage();
  if (!el("approval").classList.contains("hidden")) refreshApprovalGate();
}

function jevSummaryText(hypotheses) {
  const reviewed = hypotheses.filter((n) => n.jev?.status === "complete");
  const still = hypotheses.filter((n) => n.jev?.status === "pending").length;
  const count = (alignment) => reviewed.filter((n) => n.alignment === alignment).length;
  if (!reviewed.length && !still) return "";
  const parts = reviewed.length ? [`Jev agrees on ${count("agrees")} of ${reviewed.length}`] : [];
  if (count("disagrees")) parts.push(`disagrees on ${count("disagrees")}`);
  if (count("differs")) parts.push(`differs on ${count("differs")}`);
  if (still) parts.push(`${still} still reviewing`);
  return `${parts.join(", ")}.`;
}

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function jevCellText(node) {
  if (node.jev?.status === "complete") return `${JEV_VERDICT_LABEL[node.jev.verdict] ?? "Unsure"} · ${node.jev.confidence}%`;
  return node.jev?.status === "pending" ? "reviewing…" : "none";
}

function rollupRow(node) {
  const tr = document.createElement("tr");
  tr.dataset.nodeId = node.id;
  tr.tabIndex = 0;
  tr.setAttribute("role", "button");
  tr.classList.toggle("selected", node.id === state.selectedNodeId);
  const detective = `${DETECTIVE_VERDICT_LABEL[node.verdict] ?? node.verdict} · ${node.confidence}%`;
  tr.append(cell(node.label), cell(detective), cell(jevCellText(node), `jev-only${node.disagrees ? " disagrees" : ""}`));
  return tr;
}

/** One row per hypothesis, the detective's verdict beside Jev's; a row selects its card on the board. */
function renderJevRollup() {
  const hypotheses = state.nodes.filter((n) => n.type !== "case" && n.verdict);
  const summary = jevSummaryText(hypotheses);
  el("jev-rollup").hidden = hypotheses.length === 0;
  el("jev-rollup-summary").textContent = summary;
  el("jev-rollup-summary").hidden = summary === "";
  el("jev-rollup-rows").replaceChildren(...hypotheses.map(rollupRow));
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

let approvalTool = ""; // the fix the senior detective wants to run
let approvalGate = null; // the server's latest word on whether Approve is allowed (see /jev-gate)
let approveConfirming = false; // the first click on a flagged Approve, waiting for the confirming one

function showApproval(event) {
  approvalTool = event.toolName;
  approvalGate = null;
  approveConfirming = false;
  el("approval").classList.remove("hidden");
  renderApprovalGate();
  refreshApprovalGate();
}

async function refreshApprovalGate() {
  try {
    const res = await fetch(`/api/investigate/${state.caseId}/jev-gate`);
    approvalGate = res.ok ? await res.json() : null;
  } catch {
    approvalGate = null;
  }
  approveConfirming = false;
  renderApprovalGate();
}

function renderApprovalJevLine(gate) {
  const line = el("approval-jev");
  const jev = gate?.acted?.jev;
  line.hidden = !jev;
  if (jev) line.textContent = `Jev on "${shorten(gate.acted.hypothesis, 70)}": ${JEV_VERDICT_LABEL[jev.verdict] ?? "Unsure"} · ${jev.confidence}%`;
}

/**
 * Jev's part of the approval box, from the server's gate: a flagged review (Jev disagrees, or is under
 * 70% confident) tints the box amber and makes Approve a two-click confirm; reviews still running
 * disable Approve. Deny is never held back. This stays visible when Jev's view is hidden, because it gates a real action.
 */
function renderApprovalGate() {
  const box = el("approval");
  box.classList.toggle("review", approvalGate?.state === "review");
  box.classList.toggle("blocked", approvalGate?.state === "blocked");
  el("approval-text").textContent = approvalGate?.copy
    ? `${approvalGate.copy} Proposed fix: ${approvalTool}.`
    : `The senior detective wants to run "${approvalTool}". Approve the fix?`;
  renderApprovalJevLine(approvalGate);
  const approve = el("approve-btn");
  approve.disabled = approvalGate?.state === "blocked";
  approve.classList.toggle("confirming", approveConfirming);
  approve.innerHTML = approveConfirming
    ? `<i class="ph-fill ph-warning-circle"></i> Confirm approve`
    : `<i class="ph-fill ph-check-circle"></i> Approve`;
}

function onApproveClick() {
  if (approvalGate?.requiresConfirm && !approveConfirming) {
    approveConfirming = true;
    renderApprovalGate();
    return;
  }
  respondToApproval("allow", approveConfirming);
}

function hideApprovalWithOutcome(event) {
  el("approval").classList.add("hidden");
  el("approval").classList.remove("review", "blocked");
  approvalGate = null;
  approveConfirming = false;
  // The conclusion box is a flex row (icon + text column): the outcome belongs under the text,
  // not as a third column floating to its right.
  const box = el("conclusion");
  (box.querySelector("div") ?? box).insertAdjacentHTML("beforeend", `<div class="approval-outcome">Fix ${escapeHtml(event.outcome)}.</div>`);
}

function handleBoardEvent(event) {
  if (event.type === "verdict_review_started" || event.type === "verdict_checked") return applyJevEvent(event);
  logEvent(ICON_BY_EVENT_TYPE[event.type] ?? "ph-info", describeEventForLog(event), event.type === "edge_added" ? `verdict-${event.verdict}` : "");
  if (event.type === "node_added") addEvidenceNode(event.id, event.label, event.detail, event.source);
  else if (event.type === "node_result") setNodeResult(event.id, event.summary, event.detail);
  else if (event.type === "edge_added") {
    addConnectionEdge(event);
    setInvestigationPhase("leads");
  }
  else if (event.type === "conclusion") renderConclusion(event);
  else if (event.type === "approval_required") {
    showApproval(event);
    setCaseStatus(state.caseId, "awaiting");
    state.decisionRequested = true;
    syncDecisionStage();
  } else if (event.type === "approval_resolved") {
    hideApprovalWithOutcome(event);
    state.decisionRequested = false;
    setInvestigationPhase("closing");
  }
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
  setInvestigationPhase("closed");
  stampCase(fixOutcome);
}

function resetCaseClosure() {
  el("summary").classList.add("hidden");
  el("case-stamp").classList.add("hidden");
  window.confetti?.reset?.();
}

async function respondToApproval(decision, confirmed = false) {
  setBusy(true);
  setCaseStatus(state.caseId, "investigating");
  setInvestigationPhase("closing");
  el("approve-btn").disabled = true;
  el("deny-btn").disabled = true;
  try {
    const res = await fetch("/api/investigate/approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: state.caseId, decision, confirmed }),
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
    el("deny-btn").disabled = false;
    renderApprovalGate();
    settleCaseStatus();
    setBusy(false);
  }
}

async function startInvestigation() {
  el("start-btn").disabled = true;
  setBusy(true);
  setCaseStatus(state.caseId, "investigating");
  setInvestigationPhase("evidence");
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
  state.decisionRequested = false;
  jevLogLines.clear();
  renderJevRollup();
  renderJevProgress();
  resetCaseClosure();

  try {
    const res = await fetch("/api/investigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseId: state.caseId, resetMemory: el("reset-memory").checked }),
    });
    await consumeSSE(res, {
      session: (data) => {
        if (data.role === "senior") setInvestigationPhase("senior");
        logEvent("ph-play", `Session started (${data.role ?? "investigator"})`);
      },
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
      approval: { visible: false, tool: "" },
      decisionRequested: false,
      phase: "ready",
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
  v.approval = { visible: !el("approval").classList.contains("hidden"), tool: approvalTool };
  v.decisionRequested = state.decisionRequested;
}

function loadView(caseId) {
  const v = viewFor(caseId);
  state.nodes = v.nodes;
  state.edges = v.edges;
  state.conclusion = v.conclusion;
  state.selectedNodeId = null;
  state.decisionRequested = v.decisionRequested;
  jevLogLines.clear();
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
  approvalTool = v.approval.tool;
  approvalGate = null;
  approveConfirming = false;
  el("approval").classList.toggle("hidden", !v.approval.visible);
  if (v.approval.visible) {
    renderApprovalGate();
    refreshApprovalGate();
  }
  renderInvestigationPhase(v.phase);
  renderJevRollup();
  renderJevProgress();
  syncDecisionStage();
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
el("approve-btn").addEventListener("click", onApproveClick);
el("deny-btn").addEventListener("click", () => respondToApproval("deny"));
el("show-jev").addEventListener("change", (event) => document.body.classList.toggle("jev-hidden", !event.target.checked));
el("jev-rollup-rows").addEventListener("click", (event) => {
  const row = event.target.closest("tr");
  if (row) selectNodeById(row.dataset.nodeId);
});
el("jev-rollup-rows").addEventListener("keydown", (event) => {
  const row = event.target.closest("tr");
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectNodeById(row.dataset.nodeId);
  }
});
