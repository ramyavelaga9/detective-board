# Detective Board — Autonomous Investigation Agent

Detective Board investigates a real-world break the way a detective would:
it gathers evidence from multiple sources via MCP tools, tests one specific
hypothesis at a time, and builds a literal conspiracy board — evidence
nodes, red strings between them, confidence scores on each connection — as
it goes. It proposes a root cause and a fix, gated behind human approval
before anything actually happens.

Built on [TrueForge](https://github.com/truefoundry/trueforge), the same
open-source agent harness [pharmaflow](../pharmaflow) uses, for the Agent
Harness Hackathon.

## The cases

The app opens on a case picker. Choosing a case opens its board, with a slim
list of all cases on the left so you can switch between them; each case keeps
its own board, event log, summary, and status while you do. Both cases are
fixed and deterministic (see `src/evidence-store.mjs` for the synthetic
datasets):

- **DB-1001, Overnight revenue drop.** Revenue on Sep 17 fell sharply against
  the prior 14-day average. The real cause is a stockout on one SKU that had
  been a top seller the week before; marketing spend, refunds, and weather are
  red herrings. The fix is a restock (`propose_restock_action`).
- **DB-1002, Three-day revenue slide.** Revenue slipped over three days to
  Sep 14. The real cause is a cut in paid ad spend, which took traffic down
  with it while conversion stayed flat, so every SKU sold less. A low-stock
  SKU, normal refunds, and a storm in one region are the red herrings. The fix
  is restoring ad spend (`propose_marketing_action`).

Every evidence tool takes a `caseId`, so one MCP server serves all cases. Both
fix tools are gated behind human approval and write to a simulated action log
(`data/restock-actions.json`, `data/marketing-actions.json`).

## Model routing

Two TrueForge agents split the work by evidence type:

- **`detective-investigator`** (OpenAI `gpt-5-mini`, fast/cheap) runs the tool-calling
  loop — form a hypothesis, call the evidence tool that tests it, record a
  verdict — until it concludes.
- **`detective-senior`** (OpenAI `gpt-5`, a stronger model than the investigator's
  `gpt-5-mini`) is handed the full
  evidence trail once, to synthesize a ranked root cause and propose the
  one fix. Only this agent can call `propose_restock_action` or
  `propose_marketing_action`, which are gated behind human approval via
  TrueForge's native `tool.approval_required` pause.

## Memory

A single lightweight, in-memory "investigation history" layer
(`src/investigation-history.mjs`) tracks which hypotheses were already
confirmed or rejected on this case, so a repeated run doesn't waste steps
re-testing them. It's deliberately just this one layer — no schema memory,
no business-context memory — scoped to fit the hackathon's time budget.

## Running it

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY
```

If `.env.example` isn't present (some sandboxes block writing `.env*`
files), create `.env` yourself with:

```
OPENAI_API_KEY=sk-...
```

Then, in three terminals:

```bash
npx @truefoundry/trueforge@latest   # the harness itself, on :8790
npm run mcp                         # evidence MCP server, on :8793
npm run setup                       # registers model providers, MCP server, and both agents
npm run backend                     # dashboard + SSE API, on :8788
```

Open http://localhost:8788 and click **Start Investigation**.

## Tests

```bash
npm test
```

Runs `node --test` over the pure, dependency-free modules (evidence data,
verdict scoring, board-event translation, investigation history/loop,
board snapshotting, and the restock action log). The MCP server,
TrueForge setup script, and backend aren't unit tested directly — they
need a live TrueForge instance — the same split PharmaFlow uses.
