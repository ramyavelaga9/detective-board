# Detective Board

An autonomous investigation agent that finds out why revenue dropped, and shows its work on a live conspiracy board.

It gathers evidence from several sources through MCP tools, tests one hypothesis at a time, and pins every verdict to the board as a red string with a confidence score. A second, stronger agent reads the whole trail, proposes one fix, and writes a plain-English summary. Nothing with a real side effect runs until a human clicks **Approve**.

Built for the [Agent Harness Hackathon](https://luma.com/truefoundry-agent-harness-hackathon-sep19-2026) (TrueFoundry x HackerSquad, sponsored by OpenAI) on [TrueForge](https://github.com/truefoundry/trueforge), TrueFoundry's open-source agent harness.

## What you see

1. **Case picker.** The app opens on a box for every case. Pick one to open its board.
2. **Case rail.** A slim list of all cases on the left, each with its status (Not started, Investigating, Awaiting approval, Solved, Closed). Each case keeps its own board, event log, summary, and phase while you switch. The rail locks while an investigation is running.
3. **The board.** Every clue is a pinned paper card labeled with its evidence source and, once the detective has a verdict, the hypothesis it tested (two cards can share a source, such as marketing data used for two different hypotheses). Red strings tie each verdict back to the case, with the agent's confidence score:

   | Line | Verdict | Card label |
   |---|---|---|
   | Solid red | Confirmed | Confirmed causal lead |
   | Dashed gray | Rejected | Ruled out |
   | Dotted amber | Inconclusive | Needs more evidence |
   | (no line) | No verdict recorded | Lead collected, analysis pending |

   Click a card to inspect it: the Case File shows the detective's hypothesis and Jev's reading of it side by side. With Jev enabled (below), each hypothesis card also carries a paper-clip chip such as "Jev · Doubts · 59%", and a card where Jev disagrees with the detective gets an amber ring and a "Jev disagrees" tag.
4. **Phase tracker.** Gathering evidence, testing leads, senior review, awaiting decision, case closed.
5. **Live event log.** Every step as it starts: the model thinking (with elapsed seconds on slow steps), TrueForge's tool discovery, each tool call the moment its name arrives, every verdict, and the conclusion.
6. **Case file.** The investigator's conclusion, the approval banner, and the senior detective's summary.
7. **Case closed.** A "CASE SOLVED" stamp and confetti (a declined fix shows "CASE CLOSED" with no confetti).

## The cases

Both cases are fixed and deterministic. The data is synthetic (see `src/evidence-store.mjs`), so every run starts from the same facts.

- **DB-1001, Overnight revenue drop.** Revenue on Sep 17 fell about a third against the prior 14-day average. The real cause is a stockout on one SKU that had been a top seller the week before. Marketing spend, refunds, and weather are red herrings. The fix is a restock (`propose_restock_action`).
- **DB-1002, Three-day revenue slide.** Revenue slipped over three days to Sep 14. The real cause is a cut in paid ad spend, which took traffic down with it while conversion stayed flat, so every SKU sold less. A low-stock SKU, normal refunds, and a storm in one region are the red herrings. The fix is restoring ad spend (`propose_marketing_action`).

## How it works

```
Browser (vanilla JS + D3)
   |  POST /api/investigate, Server-Sent Events back
Backend (Express, :8788)  ----- board events, activity events, summary
   |  TrueForge SDK, turn streams
TrueForge (:8790)  ----- detective-investigator (gpt-5-mini)
   |                     detective-senior       (gpt-5)
   |  MCP over Streamable HTTP
Evidence MCP server (:8793)  ----- evidence tools + fix tools
```

1. **Investigator** (`detective-investigator`, OpenAI `gpt-5-mini`) gets a case brief. It tests one hypothesis at a time: it calls one evidence tool, then `record_hypothesis_verdict` with a verdict and confidence. It finishes with `conclude_investigation`.
2. **Senior detective** (`detective-senior`, OpenAI `gpt-5`) is handed the investigator's conclusion and evidence trail once. It weighs the causes and calls the matching fix tool. It is the only agent allowed to.
3. **Human approval.** `propose_restock_action` and `propose_marketing_action` are listed in `require_approval_for_tools`. TrueForge emits `tool.approval_required` and pauses the turn. The UI resumes it with the human's decision.
4. **Summary.** After the decision, the senior writes a short plain-English summary. The backend sends it as a `summary` event and the UI closes the case.

The board is derived directly from the real streamed tool calls (`src/board-events.mjs`), so there is no second source of truth. The investigator names its evidence source loosely (for example `get_weather (northeast)`), so the board normalizes it to the real tool name before linking a verdict to its card.

### MCP tools

Every evidence tool takes a required `caseId`, so one MCP server serves all cases.

| Tool | Purpose |
|---|---|
| `get_revenue_deviation` | Headline anomaly: case-date revenue against the prior 14-day average |
| `get_revenue_timeseries` | Daily revenue and orders |
| `get_sku_sales_breakdown` | Per-SKU units and revenue for one date |
| `get_inventory_status` | Stock level and stockout status for one SKU |
| `get_marketing_metrics` | Daily ad spend, sessions, conversion rate |
| `get_refund_events` | Daily refund counts, amounts, top reason |
| `get_weather` | Weather condition for a region and date |
| `record_hypothesis_verdict` | Self-reported verdict and confidence (drives the board) |
| `conclude_investigation` | Root cause, confidence, recommended action |
| `propose_restock_action` | **Approval-gated.** Logs a simulated restock |
| `propose_marketing_action` | **Approval-gated.** Logs a simulated ad-spend change |

### Jev's review of each hypothesis (optional)

The investigator's verdict and confidence are self-reported by an LLM, so they are not calibrated. If `TYPESAFE_API_KEY` is set, every hypothesis is also reviewed by [Jev](https://docs.typesafe.ai), TypeSafe AI's "System One" model, which returns a choice with calibrated probabilities instead of text. The backend sends Jev the hypothesis and the evidence tool's latest result as one question ("does the evidence support, contradict, or say nothing about the hypothesis?"). Reviews run in parallel, in the background, so they never slow the investigation.

Each hypothesis carries a review: `verdict` (`supports`, `doubts`, or `unsure`), `confidence` (0 to 100), `reasoning`, and `whatWouldChangeMyMind`. Jev returns no prose, so the last two are worded from its probabilities (its top reading and its runner-up), and the inspect view says so. A review is `pending`, `complete`, or `failed`, and a missing or failed review is simply left out of the UI.

- **Disagreement** is a direct conflict: the detective confirmed and Jev doubts it, or the detective ruled it out and Jev supports it. Agreement stays visually quiet; only a disagreement gets the amber ring and tag.
- **Where it shows:** a chip on each card, the inspect view, a Detective-versus-Jev table in the Case File (a row selects its card), "Jev review 4/5" beside the stepper, and one event-log line per review. The Decision stage does not unlock until every review has finished. The header's "Show Jev's view" toggle hides all of it except the approval box.
- **Approval gating:** the approval box shows Jev's verdict on the hypothesis the fix acts on (the confirmed one the detective is most sure of). If Jev disagrees, or is under 70% confident, the box turns amber, says so, and Approve needs a second, confirming click. While reviews are still running, Approve is disabled. Deny is always one click. The backend enforces this (`POST /api/investigate/approval` returns 409 without `confirmed: true`), not just the UI.

Without a key, or if the Jev API is unreachable, slow, or rate limited, hypotheses simply get no review. To see the pending, agreeing, and disagreeing states without an API key, start the backend with `JEV_MOCK=1`: it swaps in scripted reviews that cycle through an agreeing, a conflicting, and an unsure reading, each taking about a second and a half.

### What TrueForge handles

Model routing across two agents, the MCP connection and progressive tool discovery, streaming, a server-enforced `iteration_limit` (70 for the investigator, 15 for the senior), and the native approval pause and resume. One idempotent script (`npm run setup`) registers the model provider, the MCP server, and both agents through TrueForge's REST API, so the harness config is code.

### Memory

A small in-memory investigation-history layer (`src/investigation-history.mjs`) records the hypotheses tested on each case and their verdicts, so a repeated run does not spend steps re-testing them. The **Reset memory** checkbox clears it for that case before a run. It lives in the backend process and is cleared when the backend restarts.

## Running it locally

Requires Node.js 22 (what the Docker image uses) and an OpenAI API key.

```bash
npm install
```

Create a `.env` file in the project root:

```
OPENAI_API_KEY=sk-...
```

Optionally add `TYPESAFE_API_KEY=...` to enable Jev's review of each hypothesis.

Then, in separate terminals:

```bash
npx @truefoundry/trueforge@latest   # the harness itself, on :8790
npm run mcp                         # evidence MCP server, on :8793
npm run setup                       # registers the provider, MCP server, and both agents
npm run backend                     # dashboard + SSE API, on :8788
```

`npm run dev` starts the MCP server and the backend together.

Open http://localhost:8788, pick a case, and click **Start Investigation**. A full run takes a few minutes: the investigator works through several hypotheses, then the senior reviews the trail. When the approval banner appears, approve or deny the fix.

Re-run `npm run setup` whenever you change an agent's instructions or model in `src/setup-trueforge.mjs`.

The page loads D3, Phosphor icons, canvas-confetti, and Google Fonts from CDNs, so the UI needs an internet connection.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | (required) | Registered with TrueForge by `npm run setup` |
| `TYPESAFE_API_KEY` | (optional) | Enables Jev's review of each hypothesis. Read by the backend only |
| `JEV_MOCK` | (unset) | Set to `1` to use scripted Jev reviews instead of the API, for demos and UI work |
| `PORT` | `8788` | Backend port |
| `MCP_PORT` | `8793` | Evidence MCP server port |
| `TRUEFORGE_URL` | `http://localhost:8790` | Where TrueForge is running |
| `DETECTIVE_MCP_URL` | `http://localhost:8793/mcp` | MCP URL that TrueForge is told to call |
| `DETECTIVE_INVESTIGATOR_AGENT_NAME` | `detective-investigator` | Agent name the backend starts sessions with |
| `DETECTIVE_SENIOR_AGENT_NAME` | `detective-senior` | Agent name for the senior session |

### Backend API

| Route | Purpose |
|---|---|
| `GET /api/cases` | The case list, with a headline computed from each case's own data |
| `POST /api/investigate` | Body `{ caseId, resetMemory }`. Streams SSE: `session`, `activity`, `board_event`, `delta`, `summary`, `error`, `done` |
| `POST /api/investigate/approval` | Body `{ caseId, decision: "allow" \| "deny", confirmed }`. Resumes the paused turn and streams the rest. An allow returns 409 while Jev reviews are running, or without `confirmed: true` when Jev flagged the fix |
| `GET /api/investigate/:caseId/jev-gate` | Where Approve stands: blocked, needs a confirm, or clear, plus Jev's view of the hypothesis being acted on |
| `GET /api/investigate/:caseId/snapshot` | The case's board events so far (in memory) |
| `GET /api/health` | Health check |

An unknown or missing `caseId` returns a 400.

## Deploying

The `Dockerfile` and `render.yaml` run TrueForge, the MCP server, and the backend together in one container. TrueForge and the MCP server bind to localhost only, and only the backend's `$PORT` is exposed. Set `OPENAI_API_KEY` in the host's environment.

This is a temporary demo deploy, not a hardened production one: TrueForge's standalone mode has no built-in auth, so take the deployment down when the demo window is over.

## Tests

```bash
npm test
```

Runs `node --test` over the pure, dependency-free modules: the evidence data for both cases, verdict scoring, board-event translation (including evidence-source normalization), activity events, tool-call accumulation, the evidence tracker, the Jev client (against a fake `fetch`) and mock, the disagreement and approval-gating rules, the review book, the card text wrapper, investigation history and loop limits, board snapshotting, and the action logs. The MCP server, setup script, and backend need a live TrueForge instance, so they are not unit tested directly.

## Project structure

```
src/
  backend.mjs               Express server, SSE relay, approval flow
  evidence-mcp-server.mjs   MCP tools (evidence + fixes)
  evidence-store.mjs        Case registry and the synthetic datasets
  setup-trueforge.mjs       Registers provider, MCP server, and agents
  board-events.mjs          Stream events to board events
  activity-events.mjs       Log-only "what is the agent doing" lines
  jev-check.mjs             Asks Jev to review a hypothesis
  jev-review.mjs            Review shape, disagreement rule, approval gate
  jev-mock.mjs              Scripted stand-in for Jev (JEV_MOCK=1)
  review-book.mjs           Per-case hypotheses and their review state
  evidence-tracker.mjs      Latest result per evidence tool, to pair with a verdict
  tool-call-accumulator.mjs Reassembles streamed tool calls
  verdict.mjs               Verdict, confidence, edge style, approval outcome
  investigation-history.mjs Per-case memory
  investigation-loop.mjs    Board step budget
  board-store.mjs           In-memory board events per case
  actions-log.mjs           Simulated restock and ad-spend logs
web/                        Vanilla JS + D3 UI (no build step)
test/                       Unit tests
data/                       Action logs written by approved fixes
```

## Adding a case

1. Add a case config to the registry in `src/evidence-store.mjs`: an id, title, case date, and how revenue, SKU sales, inventory, marketing, refunds, and weather behave on and before that date.
2. Add tests for the new case's data in `test/evidence-store.test.mjs`.
3. If the case needs a new tool (a new evidence source or a new kind of fix), add it in `src/evidence-mcp-server.mjs` and register it in `EVIDENCE_SOURCE_BY_TOOL` in `src/board-events.mjs` (its board label, and the list the board uses to normalize the investigator's evidence source) and `TOOL_LABELS` in `src/activity-events.mjs` (its event-log wording).
4. If that tool is a fix with a side effect, also list it in `require_approval_for_tools` and in the senior's instructions in `src/setup-trueforge.mjs`, and in `APPROVAL_GATED_TOOLS` in `src/backend.mjs`.
5. Run `npm run setup` again. The picker and rail pick the case up automatically from `GET /api/cases`.

## Limitations

- **Synthetic data and simulated actions.** No real store, inventory system, or ad platform is connected. Approved fixes write a record marked `simulated`.
- **In-memory state.** Board events and investigation memory live in the backend process, and each case's saved view lives in the open page. A backend restart or page reload clears them.
- **LLM output varies between runs.** The evidence is deterministic, but the models are not. An investigator can occasionally add a cause the data does not support, so read the conclusion against the evidence trail on the board.
- **Single-user demo.** There is no auth, and approvals are keyed by case, so two people running the same case at once would interfere.

## Authors

Ramya Velaga and Sanjay Noolu, at the Agent Harness Hackathon, Santa Clara, Sep 19, 2026.
