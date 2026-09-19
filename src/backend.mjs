// Detective Board web backend.
//
// Serves the board UI and drives two TrueForge agents — a fast
// "detective-investigator" that gathers evidence and a stronger
// "detective-senior" that synthesizes a root cause once the investigator
// concludes — relaying both as Server-Sent Events to the browser. Mirrors
// PharmaFlow's backend.mjs: the board's nodes/edges are derived directly
// from the real streamed tool calls/results (via board-events.mjs), not
// from a second source of truth, and TrueForge's native
// tool.approval_required pause is what actually gates propose_restock_action.

import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import { getRevenueDeviation } from "./evidence-store.mjs";
import { createBoardStore } from "./board-store.mjs";
import { createInvestigationHistory } from "./investigation-history.mjs";
import { toBoardEvent, NODELESS_TOOLS } from "./board-events.mjs";
import { nextLoopDecision, MAX_INVESTIGATION_STEPS } from "./investigation-loop.mjs";
import { resolveApprovalOutcome } from "./verdict.mjs";
import { createToolCallAccumulator, resolveActualToolCall } from "./tool-call-accumulator.mjs";

const APPROVAL_GATED_TOOLS = new Set(["propose_restock_action"]);
// TrueForge's own progressive tool-discovery calls, not evidence - see the
// META_TOOLS check in processTurn for why these are excluded from both the
// step budget and the board.
const META_TOOLS = new Set(["list_tools", "get_tool_info"]);
const CASE_ID = "DB-1001";
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

// caseId -> { toolCallId, threadId, sessionId } for the one paused
// propose_restock_action call currently awaiting a human decision.
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
 */
async function processTurn(send, sessionId, inputItems, { onConclusion, onError } = {}) {
  let stepCount = 0;
  let concluded = false;

  function emit(event) {
    if (!event) return;
    boardStore.addEvent(CASE_ID, event);
    send("board_event", event);
  }

  try {
    const stream = await trueforge.sessions.createTurnStream(sessionId, { input: inputItems });
    const toolCalls = createToolCallAccumulator();
    const loggedCalls = new Set();
    let stepLimitHit = false;

    turnLoop: for await (const event of stream) {
      switch (event.type) {
        case "model.message.delta": {
          if (event.content) send("delta", { text: event.content });
          for (const tc of event.toolCalls ?? []) {
            const call = toolCalls.applyDelta(tc);
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
              investigationHistory.recordVerdict(CASE_ID, boardEvent.hypothesis, boardEvent.verdict);
            }
            if (boardEvent?.type === "conclusion") {
              concluded = true;
              onConclusion?.(boardEvent);
            }
          }
          break;
        }
        case "tool.response": {
          const resolved = resolveActualToolCall(toolCalls.getById(event.toolCallId));
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
          }
          toolCalls.complete(event.toolCallId);
          break;
        }
        case "tool.approval_required": {
          for (const tc of event.toolCalls ?? []) {
            const resolved = resolveActualToolCall(toolCalls.getById(tc.id));
            if (!APPROVAL_GATED_TOOLS.has(resolved?.name)) continue;
            pendingApprovals.set(CASE_ID, { toolCallId: tc.id, threadId: event.threadId, sessionId });
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
async function runSeniorTurnWithRetry(send, sessionId, inputItems, maxAttempts = 2) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let turnError = null;
    const result = await processTurn(send, sessionId, inputItems, {
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

app.post("/api/investigate", async (req, res) => {
  const { resetMemory } = req.body ?? {};
  boardStore.resetCase(CASE_ID);
  if (resetMemory) investigationHistory.resetCase(CASE_ID);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // SSE headers are already committed above, so a failure here can't fall back to
  // an HTTP error status - it has to surface as an "error" event on the open
  // stream and explicitly end it, or a TrueForge outage leaves the browser
  // hanging on "Session started..." forever with no response body at all.
  try {
    const { data: session } = await trueforge.sessions.create({ agent: { name: INVESTIGATOR_AGENT_NAME } });
    send("session", { caseId: CASE_ID, sessionId: session.id, role: "investigator" });

    const deviation = getRevenueDeviation();
    const priorHistory = investigationHistory.getHistory(CASE_ID);
    const memoryNote = priorHistory.length
      ? ` Already tested in a prior run on this case - do not retest: ${priorHistory
          .map((r) => `${r.hypothesis} (${r.verdict})`)
          .join("; ")}.`
      : "";
    const caseBrief =
      `Case ${CASE_ID}: revenue on ${deviation.date} was $${deviation.latestRevenue}, ` +
      `${deviation.percentChange}% versus the prior 14-day average of $${deviation.rollingAverage}. ` +
      `Investigate the root cause and recommend one concrete fix.${memoryNote}`;

    let conclusionEvent = null;
    const { concluded } = await processTurn(send, session.id, [{ type: "user.message", content: caseBrief }], {
      onConclusion: (event) => {
        conclusionEvent = event;
      },
    });

    if (concluded && conclusionEvent) {
      const { data: seniorSession } = await trueforge.sessions.create({ agent: { name: SENIOR_AGENT_NAME } });
      send("session", { caseId: CASE_ID, sessionId: seniorSession.id, role: "senior" });
      const briefing =
        `Case ${CASE_ID}. The investigator concluded: "${conclusionEvent.rootCause}" ` +
        `(confidence ${conclusionEvent.confidence}), recommending: "${conclusionEvent.recommendedAction}". ` +
        `Full evidence trail: ${JSON.stringify(investigationHistory.getHistory(CASE_ID))}.`;
      await runSeniorTurnWithRetry(send, seniorSession.id, [{ type: "user.message", content: briefing }]);
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

// Resumes a paused turn after a human approve/reject decision. Resolves
// from pendingApprovals rather than any client-supplied session details,
// so a stale or forged request can't resume someone else's paused turn.
app.post("/api/investigate/approval", async (req, res) => {
  const { caseId, decision, reason } = req.body ?? {};
  if (!caseId) return res.status(400).json({ error: "caseId is required" });

  let outcome;
  try {
    outcome = resolveApprovalOutcome(decision);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const pending = pendingApprovals.get(caseId);
  if (!pending) return res.status(400).json({ error: `Case ${caseId} has no pending approval` });
  pendingApprovals.delete(caseId);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  boardStore.addEvent(caseId, outcome);
  send("board_event", outcome);

  const approval = decision === "allow" ? { status: "allow" } : { status: "deny", reason };
  await processTurn(send, pending.sessionId, [
    { type: "user.tool_approval", threadId: pending.threadId, toolCallId: pending.toolCallId, approval },
  ]);
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
