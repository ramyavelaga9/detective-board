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

## The case

The demo case is fixed and deterministic: revenue on Sep 17 dropped sharply
against the prior 14-day average. The real cause is a stockout on one SKU
that had been a top seller in the week before; marketing spend, refunds,
and weather are red herrings the agent investigates and rules out. See
`src/evidence-store.mjs` for the full synthetic dataset.

## Model routing

Two TrueForge agents split the work by evidence type:

- **`detective-investigator`** (a fast/cheap model) runs the tool-calling
  loop — form a hypothesis, call the evidence tool that tests it, record a
  verdict — until it concludes.
- **`detective-senior`** (Gemini, via the `gemini-flash-latest` alias — free-tier
  Gemini keys get zero quota for "-pro" models regardless of version, and dated
  model versions deprecate within months; swap this for a pinned "-pro" model
  in `src/setup-trueforge.mjs` if your Google AI Studio project has billing
  enabled) is handed the full
  evidence trail once, to synthesize a ranked root cause and propose the
  one fix. Only this agent can call `propose_restock_action`, which is
  gated behind human approval via TrueForge's native
  `tool.approval_required` pause.

## Memory

A single lightweight, in-memory "investigation history" layer
(`src/investigation-history.mjs`) tracks which hypotheses were already
confirmed or rejected on this case, so a repeated run doesn't waste steps
re-testing them. It's deliberately just this one layer — no schema memory,
no business-context memory — scoped to fit the hackathon's time budget.

## Running it

```bash
npm install
cp .env.example .env   # fill in OPENAI_API_KEY and GEMINI_API_KEY
```

If `.env.example` isn't present (some sandboxes block writing `.env*`
files), create `.env` yourself with:

```
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
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
