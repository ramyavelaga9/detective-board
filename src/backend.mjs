// Detective Board web backend.
//
// Serves the board UI and drives two TrueForge agents — a fast
// "detective-investigator" that gathers evidence and a stronger
// "detective-senior" that synthesizes a root cause once the investigator
// concludes — relaying both as Server-Sent Events to the browser. The
// board's nodes/edges are derived directly
// from the real streamed tool calls/results (via board-events.mjs), not
// from a second source of truth, and TrueForge's native
// tool.approval_required pause is what actually gates propose_restock_action.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { getRevenueDeviation, hasCase, listCases } from "./evidence-store.mjs";
import { createBoardStore } from "./board-store.mjs";
import { createInvestigationHistory } from "./investigation-history.mjs";
import { toBoardEvent, NODELESS_TOOLS } from "./board-events.mjs";
import { nextLoopDecision, MAX_INVESTIGATION_STEPS } from "./investigation-loop.mjs";
import { resolveApprovalOutcome } from "./verdict.mjs";
import { createToolCallAccumulator, resolveActualToolCall, peekActualToolName } from "./tool-call-accumulator.mjs";
import { toThinkingActivity, toToolStartedActivity, toToolFinishedActivity } from "./activity-events.mjs";
import { createEvidenceTracker } from "./evidence-tracker.mjs";
import { createJevClient } from "./jev-check.mjs";
import { createMockJevClient } from "./jev-mock.mjs";
import { checkApproval, describeReviewOutcome } from "./jev-review.mjs";
import { createReviewBook } from "./review-book.mjs";

const APPROVAL_GATED_TOOLS = new Set(["propose_restock_action", "propose_marketing_action"]);
// TrueForge's own progressive tool-discovery calls, not evidence - see the
// META_TOOLS check in processTurn for why these are excluded from both the
// step budget and the board.
const META_TOOLS = new Set(["list_tools", "get_tool_info"]);
const INVESTIGATOR_AGENT_NAME = process.env.DETECTIVE_INVESTIGATOR_AGENT_NAME || "detective-investigator";
const SENIOR_AGENT_NAME = process.env.DETECTIVE_SENIOR_AGENT_NAME || "detective-senior";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8788;
const TRUEFORGE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";

// 120s (the SDK's original default) cut it close for one turn of a thorough,
// many-hypothesis investigation - raised alongside server.requestTimeout above.
const trueforge = new TrueForge({ baseUrl: TRUEFORGE_URL, timeoutInSeconds: 600 });

const boardStore = createBoardStore();
const investigationHistory = createInvestigationHistory();
const reviewBook = createReviewBook();
// Optional: with no TYPESAFE_API_KEY the client is disabled and verdicts get no Jev review.
// JEV_MOCK=1 swaps in scripted reviews (see jev-mock.mjs) for demos and UI work.
const useMockJev = process.env.JEV_MOCK === "1";
const jev = useMockJev ? createMockJevClient() : createJevClient({ apiKey: process.env.TYPESAFE_API_KEY });
if (useMockJev) console.log("Jev reviews are scripted (JEV_MOCK=1), not from the Jev API.");

// caseId -> { toolCallId, threadId, sessionId } for the one paused
// fix-action call (restock or ad spend) per case currently awaiting a human decision.
const pendingApprovals = new Map();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "web")));

/** Matches the transient provider-overload errors observed from Gemini's preview flash model under load - worth one retry, unlike a real config/auth failure. */
function isTransientProviderError(message) {
  return /\b503\b|UNAVAILABLE|high demand/i.test(message ?? "");
}

/**
 * Opens a Server-Sent Events response and returns its send function. Sends after the
 * stream has ended are ignored: a second opinion can land after the route finished,
 * and writing to an ended response would throw.
 */
function openEventStream(res) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  return (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** Records Jev's answer (or its failure) and tells the board; a late answer from a reset run settles nothing and is dropped. */
function settleReview(emit, caseId, verdictEvent, review) {
  const { verdictId, verdict } = verdictEvent;
  const settled = review ? reviewBook.completeReview(caseId, verdictId, review) : reviewBook.failReview(caseId, verdictId);
  if (settled) emit({ type: "verdict_checked", verdictId, ...describeReviewOutcome(verdict, settled.jev) });
}

/**
 * Starts Jev's review of a verdict in the background. The board hears "verdict_review_started"
 * now and "verdict_checked" when it settles, so a review is never left pending: a failed or
 * throwing review is settled as failed.
 */
function requestSecondOpinion(emit, caseId, evidenceText, verdictEvent) {
  const { verdictId, hypothesis, evidenceSource, verdict } = verdictEvent;
  if (!evidenceText || !jev.isEnabled() || !reviewBook.startReview(caseId, verdictId)) return;
  emit({ type: "verdict_review_started", verdictId, evidenceSource });
  jev
    .checkVerdict({ hypothesis, evidence: evidenceText, detectiveVerdict: verdict })
    .then((review) => settleReview(emit, caseId, verdictEvent, review))
    .catch((err) => {
      console.error("Jev review failed:", err);
      settleReview(emit, caseId, verdictEvent, null);
    });
}

/**
 * Processes one turn's real events - tool calls, tool results,
 * approval-required pauses, turn completion - relaying each as a board
 * event to the browser and to board-store, and recording confirmed/
 * rejected verdicts into investigation-history as they arrive. Returns
 * whether the turn concluded, and (via `onConclusion`) the conclusion
 * itself, so the caller can hand off to the senior detective.
 *
 * By default a turn-processing failure is sent to the client immediately as
 * an "error" event. Passing `onError` suppresses that so a caller can retry
 * first (see runSeniorTurnWithRetry) instead of alarming the user over a
 * transient failure that a retry might just fix.
 *
 * Alongside board events, sends log-only "activity" events (see
 * activity-events.mjs) so the event log narrates every step live - the turn
 * starting, each tool call the moment its name streams in (including
 * TrueForge's own tool discovery, which never reaches the board), and the
 * model thinking between calls - instead of going quiet until a board event.
 * `role` ("investigator" | "senior") picks the wording of those lines.
 *
 * When a senior turn finishes for good (not paused for approval), the
 * senior's final message is sent as a "summary" event so the UI can show it
 * and close the case. `fixOutcome` ("none" | "approved" | "denied") is
 * passed through so the UI knows how the proposed fix ended.
 */
async function processTurn(send, caseId, sessionId, inputItems, { role, fixOutcome = "none", onConclusion, onError } = {}) {
  let stepCount = 0;
  let concluded = false;
  let messageText = "";

  function emit(event) {
    if (!event) return;
    boardStore.addEvent(caseId, event);
    send("board_event", event);
  }

  const announce = (activity) => send("activity", activity);

  try {
    // Before opening the stream: creating it and waiting on the model's first
    // tokens is exactly the stretch where the log used to sit silent.
    announce(toThinkingActivity(role));
    const stream = await trueforge.sessions.createTurnStream(sessionId, { input: inputItems });
    const toolCalls = createToolCallAccumulator();
    const evidence = createEvidenceTracker();
    const loggedCalls = new Set();
    const announcedCalls = new Set();
    const pendingCalls = new Set();
    let stepLimitHit = false;

    turnLoop: for await (const event of stream) {
      switch (event.type) {
        case "model.message.delta": {
          if (event.content) {
            messageText += event.content;
            send("delta", { text: event.content });
          }
          for (const tc of event.toolCalls ?? []) {
            const call = toolCalls.applyDelta(tc);
            // Announce the step as soon as the tool's name is known, without waiting for
            // its arguments to finish streaming (which is what the board node below needs).
            const startedName = peekActualToolName(call);
            if (startedName && !announcedCalls.has(call)) {
              announcedCalls.add(call);
              pendingCalls.add(call);
              announce(toToolStartedActivity(startedName));
            }
            if (!call.name || loggedCalls.has(call)) continue;
            const resolved = resolveActualToolCall(call);
            // A call_tool-wrapped invocation needs its args fully streamed before the
            // real wrapped tool name can be read out of them - resolveActualToolCall
            // returns null on the still-incomplete JSON an early delta carries, so retry
            // on the next delta instead of giving up. Marking it logged only once resolved
            // matters: giving up here silently dropped every real evidence tool's board
            // node forever, while its result still rendered later once the call had
            // actually finished (args complete by then).
            if (!resolved) continue;
            loggedCalls.add(call);
            // TrueForge's own progressive tool-discovery calls (list_tools, get_tool_info)
            // aren't evidence and shouldn't cost a step - counting them against the budget
            // let the model exhaust it just learning what tools exist, before ever calling
            // one for real.
            if (META_TOOLS.has(resolved.name)) continue;

            stepCount += 1;
            if (nextLoopDecision({ stepCount, concluded }) === "step_limit_reached") {
              emit({ type: "step_limit_reached", maxSteps: MAX_INVESTIGATION_STEPS });
              stepLimitHit = true;
              break turnLoop;
            }

            let args = {};
            try {
              args = JSON.parse(resolved.args || "{}");
            } catch {
              // Malformed tool-call args shouldn't crash the stream relay.
            }
            const boardEvent = toBoardEvent({ type: "tool_call", toolCallId: call.id, toolName: resolved.name, args });
            emit(boardEvent);
            if (boardEvent?.type === "edge_added") {
              investigationHistory.recordVerdict(caseId, boardEvent.hypothesis, boardEvent.verdict);
              reviewBook.addHypothesis(caseId, boardEvent);
              requestSecondOpinion(emit, caseId, evidence.latestFor(boardEvent.evidenceSource), boardEvent);
            }
            if (boardEvent?.type === "conclusion") {
              concluded = true;
              onConclusion?.(boardEvent);
            }
          }
          break;
        }
        case "tool.response": {
          const call = toolCalls.getById(event.toolCallId);
          const resolved = resolveActualToolCall(call);
          // Evidence/verdict/conclusion tools already show up as board events; only
          // tool discovery has no other line to show its result arrived.
          if (resolved && META_TOOLS.has(resolved.name)) announce(toToolFinishedActivity(resolved.name));
          const skipRender = resolved && (META_TOOLS.has(resolved.name) || NODELESS_TOOLS.has(resolved.name));
          if (!skipRender) {
            emit(
              toBoardEvent({
                type: "tool_result",
                toolCallId: event.toolCallId,
                toolName: resolved?.name,
                resultText: event.content,
              })
            );
            if (resolved) evidence.record(resolved.name, event.content);
          }
          toolCalls.complete(event.toolCallId);
          pendingCalls.delete(call);
          // Nothing else is in flight, so the model is now deciding what to do next.
          if (pendingCalls.size === 0 && !concluded) announce(toThinkingActivity(role));
          break;
        }
        case "tool.approval_required": {
          for (const tc of event.toolCalls ?? []) {
            const resolved = resolveActualToolCall(toolCalls.getById(tc.id));
            if (!APPROVAL_GATED_TOOLS.has(resolved?.name)) continue;
            pendingApprovals.set(caseId, { toolCallId: tc.id, threadId: event.threadId, sessionId });
            emit(toBoardEvent({ type: "approval_required", toolName: resolved.name, toolCallId: tc.id }));
          }
          break;
        }
        case "turn.done": {
          const status = event.state?.status ?? "done";
          if (status === "error") {
            const message = event.state.message || "The agent hit an error completing that turn.";
            if (onError) onError(new Error(message));
            else send("error", { message });
          }
          // A turn that ends waiting on a human approval isn't finished yet - the summary
          // belongs to the turn that runs after the decision.
          const awaitingApproval = (event.state?.requiredActions ?? []).length > 0;
          if (role === "senior" && status === "done" && !awaitingApproval) {
            send("summary", { text: messageText.trim(), fixOutcome });
          }
          send("done", { status });
          break;
        }
        default:
          break;
      }
    }
    // A natural "turn.done" already sent its own "done" event above; a step-limit
    // break stops consuming the stream before that ever arrives, so send one here
    // instead of leaving the client's turn hanging with no terminal event at all.
    if (stepLimitHit) send("done", { status: "step_limit_reached" });
  } catch (err) {
    console.error("Turn processing error:", err);
    if (onError) onError(err);
    else send("error", { message: err.message ?? String(err) });
  }
  return { concluded };
}

/**
 * Retries the senior detective's turn once on a transient provider outage -
 * a live run against Gemini's preview flash model hit a 503 "high demand"
 * error under load, which a short retry cleared on the next attempt. A
 * real config/auth failure isn't transient, so it's surfaced immediately
 * instead of silently retried and delayed.
 */
async function runSeniorTurnWithRetry(send, caseId, sessionId, inputItems, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let turnError = null;
    const result = await processTurn(send, caseId, sessionId, inputItems, {
      role: "senior",
      onError: (err) => {
        turnError = err;
      },
    });
    if (!turnError) return result;
    if (attempt >= maxAttempts || !isTransientProviderError(turnError.message)) {
      send("error", { message: turnError.message ?? String(turnError) });
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

// The cases the picker lists: id, title, and a headline computed from the case's own
// evidence (never a hand-written number), so the card can't drift from the data.
app.get("/api/cases", (_req, res) => {
  res.json({
    cases: listCases().map(({ id, title, date }) => {
      const { percentChange } = getRevenueDeviation(id);
      const direction = percentChange < 0 ? "fell" : "rose";
      return { id, title, date, headline: `Revenue ${direction} ${Math.abs(percentChange)}% against the prior 14-day average` };
    }),
  });
});

app.post("/api/investigate", async (req, res) => {
  const { caseId, resetMemory } = req.body ?? {};
  if (!caseId) return res.status(400).json({ error: "caseId is required" });
  if (!hasCase(caseId)) {
    return res.status(400).json({ error: `Unknown case "${caseId}". Choose one of: ${listCases().map((c) => c.id).join(", ")}` });
  }
  boardStore.resetCase(caseId);
  reviewBook.reset(caseId);
  if (resetMemory) investigationHistory.resetCase(caseId);

  const send = openEventStream(res);

  // SSE headers are already committed above, so a failure here can't fall back to
  // an HTTP error status - it has to surface as an "error" event on the open
  // stream and explicitly end it, or a TrueForge outage leaves the browser
  // hanging on "Session started..." forever with no response body at all.
  try {
    const { data: session } = await trueforge.sessions.create({ agent: { name: INVESTIGATOR_AGENT_NAME } });
    send("session", { caseId, sessionId: session.id, role: "investigator" });

    const deviation = getRevenueDeviation(caseId);
    const priorHistory = investigationHistory.getHistory(caseId);
    const memoryNote = priorHistory.length
      ? ` Already tested in a prior run on this case - do not retest: ${priorHistory
          .map((r) => `${r.hypothesis} (${r.verdict})`)
          .join("; ")}.`
      : "";
    const caseBrief =
      `Case ${caseId}: revenue on ${deviation.date} was $${deviation.latestRevenue}, ` +
      `${deviation.percentChange}% versus the prior 14-day average of $${deviation.rollingAverage}. ` +
      `Pass caseId "${caseId}" to every evidence tool. ` +
      `Investigate the root cause and recommend one concrete fix.${memoryNote}`;

    let conclusionEvent = null;
    const { concluded } = await processTurn(send, caseId, session.id, [{ type: "user.message", content: caseBrief }], {
      role: "investigator",
      onConclusion: (event) => {
        conclusionEvent = event;
      },
    });

    if (concluded && conclusionEvent) {
      const { data: seniorSession } = await trueforge.sessions.create({ agent: { name: SENIOR_AGENT_NAME } });
      send("session", { caseId, sessionId: seniorSession.id, role: "senior" });
      const briefing =
        `Case ${caseId}. The investigator concluded: "${conclusionEvent.rootCause}" ` +
        `(confidence ${conclusionEvent.confidence}), recommending: "${conclusionEvent.recommendedAction}". ` +
        `Full evidence trail: ${JSON.stringify(investigationHistory.getHistory(caseId))}.`;
      await runSeniorTurnWithRetry(send, caseId, seniorSession.id, [{ type: "user.message", content: briefing }]);
    }
  } catch (err) {
    console.error("Failed to start investigation:", err);
    send("error", { message: err.message ?? String(err) });
  }

  res.end();
});

app.get("/api/investigate/:caseId/snapshot", (req, res) => {
  res.json({ caseId: req.params.caseId, events: boardStore.getSnapshot(req.params.caseId) });
});

// Where Approve stands: still waiting on Jev reviews, needs an explicit confirm, or clear to go.
app.get("/api/investigate/:caseId/jev-gate", (req, res) => {
  res.json(reviewBook.gate(req.params.caseId));
});

// Resumes a paused turn after a human approve/reject decision. Resolves
// from pendingApprovals rather than any client-supplied session details,
// so a stale or forged request can't resume someone else's paused turn.
app.post("/api/investigate/approval", async (req, res) => {
  const { caseId, decision, reason, confirmed } = req.body ?? {};
  if (!caseId) return res.status(400).json({ error: "caseId is required" });

  let outcome;
  try {
    outcome = resolveApprovalOutcome(decision);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const pending = pendingApprovals.get(caseId);
  if (!pending) return res.status(400).json({ error: `Case ${caseId} has no pending approval` });
  const approval = checkApproval({ decision, confirmed: confirmed === true, gate: reviewBook.gate(caseId) });
  if (!approval.ok) return res.status(approval.status).json({ error: approval.error });
  pendingApprovals.delete(caseId);

  const send = openEventStream(res);
  boardStore.addEvent(caseId, outcome);
  send("board_event", outcome);

  const toolApproval = decision === "allow" ? { status: "allow" } : { status: "deny", reason };
  await processTurn(
    send,
    caseId,
    pending.sessionId,
    [{ type: "user.tool_approval", threadId: pending.threadId, toolCallId: pending.toolCallId, approval: toolApproval }],
    { role: "senior", fixOutcome: decision === "allow" ? "approved" : "denied" }
  );
  res.end();
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "detective-board-backend" }));

const server = app.listen(PORT, () => {
  console.log(`Detective Board listening on http://localhost:${PORT}`);
});

// Node's http.Server kills any single request past 5 minutes by default
// (requestTimeout) - a real multi-step investigation plus a senior-detective
// handoff (each a real LLM round trip, sometimes with a provider-outage
// retry) can comfortably run longer than that. Without this, the server
// keeps working and completes for real (evidence gathered, approval
// resolved, action recorded) while the browser's SSE connection to it gets
// silently destroyed mid-stream - the investigation "worked" but nobody
// watching the board ever saw it happen.
server.requestTimeout = 0;
