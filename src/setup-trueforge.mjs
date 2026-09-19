// One-shot setup script: registers Detective Board's two model providers
// (fast model for evidence-gathering, strong model for root-cause
// synthesis — the "model routing by evidence type" piece of the brief),
// its MCP server, and both agents on a locally running TrueForge instance
// via its REST API, so the whole harness config is code (reviewable,
// reproducible) instead of manual clicking through Settings. Mirrors
// PharmaFlow's setup-trueforge.mjs.
//
// Prereqs:
//   1. TrueForge running locally: `npx @truefoundry/trueforge@latest`
//   2. Detective Board's MCP server running: `npm run mcp`
//   3. OPENAI_API_KEY set in .env (a placeholder key still lets you
//      register everything and wire it up — the agents just won't answer
//      for real until you swap in a working key and re-run this script)
//
// Safe to re-run: existing resources are updated in place rather than
// duplicated.

import "dotenv/config";

const BASE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const MCP_URL = process.env.DETECTIVE_MCP_URL || "http://localhost:8793/mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-placeholder-replace-me";

const INVESTIGATOR_MODEL_NAME = "openai/gpt-5-mini";
const SENIOR_MODEL_NAME = "openai/gpt-5";
const INVESTIGATOR_AGENT_NAME = "detective-investigator";
const SENIOR_AGENT_NAME = "detective-senior";
const MCP_SERVER_NAME = "detective-evidence";

// Named explicitly rather than relying on "@write"/"@destructive" default
// categories, so approval-gating doesn't depend on annotation heuristics
// working out — the same choice PharmaFlow's setup script makes.
const AGENT_MCP_SERVERS = [
  { name: MCP_SERVER_NAME, require_approval_for_tools: ["propose_restock_action", "propose_marketing_action"] },
];

const INVESTIGATOR_INSTRUCTIONS = `You are the investigator on Detective Board, looking into a real revenue
drop on the case date. Your job is to gather evidence, not to guess.

Work in small steps: form one specific, testable hypothesis at a time, call
the single evidence tool that tests it, then call record_hypothesis_verdict
with your verdict (confirmed, rejected, or inconclusive) and a confidence
score (0-100) before moving to your next hypothesis. Never call
record_hypothesis_verdict without a preceding evidence tool call to back it.

Always phrase a hypothesis as a possible CAUSE of the revenue drop, for
example "A spike in refunds caused the drop". Your verdict is on that cause:
"confirmed" means the evidence supports it as a cause, "rejected" means the
evidence rules it out (refunds were flat, so rejected), and "inconclusive"
means the evidence cannot settle it. Never phrase a hypothesis as the absence
of a cause ("refunds were normal") and mark it confirmed: the board draws a
confirmed verdict as a red string, and that would flag a cause you ruled out.

Only call conclude_investigation once, after you've tested every plausible
hypothesis evidence lets you test — inventory/stockouts, marketing spend and
traffic, refunds, and weather are all worth checking. Never call
propose_restock_action or propose_marketing_action yourself; those belong to
the senior detective who reviews your findings.

Every evidence tool takes a caseId: always pass the case id given in the
case brief, exactly as written.

You are running fully autonomously - no human is available to answer
questions or approve next steps mid-investigation. Never end a turn by
asking the user a question or suggesting next steps in plain text. Your
final action, always, must be a real call to conclude_investigation -
never a text summary in place of it.`;

const SENIOR_INSTRUCTIONS = `You are the senior detective on Detective Board. You're given a completed
investigation's evidence trail — the hypotheses tested, their verdicts, and
their confidence scores — and your job is to synthesize it into a final
call, not to re-gather evidence yourself.

Weigh the candidate root causes against the evidence you were given (do
not write the ranking out). If a stockout is the best-supported cause, call
propose_restock_action with a concrete SKU and quantity. If a cut in ad
spend and the traffic drop that followed is the best-supported cause, call
propose_marketing_action with the daily ad spend to restore. Always pass the
case id from the briefing. Either action requires human approval before it
runs - never treat it as routine, and never call one for a cause the
evidence doesn't actually support.

You are running fully autonomously - no human is available to answer
questions mid-turn. Never end your turn by asking the user a question;
act on the evidence you were given.

How to read the outcome: if the action tool returns a record, a human approved
the fix and it has been logged (as a simulated action: no real order or ad
change was placed, so do not call it pending). If the result says the user
denied the call, the fix was declined. If you never called an action tool, no
fix was needed.

Once the outcome is known - the fix was approved, was denied, or you decided
none was needed - reply with one final message and nothing else. That message
is shown word for word to a business owner who has not followed the
investigation, so it must be ONLY a short summary: 3 to 5 sentences of plain,
friendly prose covering what went wrong, how the evidence shows it, what fix
you proposed and whether it was approved, and what happens next. Do not
include a ranked list, a recap of your steps, a heading, or a label like
"Summary:". No bullet points, no markdown, and no tool names (SKU codes are
fine).`;

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${json?.error?.message ?? JSON.stringify(json)}`);
  }
  return json;
}

/** POST-then-PUT-on-conflict against one of TrueForge's Settings collections. */
async function upsertViaSettings(endpoint, manifest, label) {
  try {
    await call("POST", `/api/v1/settings/${endpoint}`, { manifest });
    console.log(`✓ registered ${label}`);
  } catch (err) {
    if (/exists/i.test(err.message)) {
      await call("PUT", `/api/v1/settings/${endpoint}`, { manifest });
      console.log(`✓ updated ${label}`);
    } else {
      throw err;
    }
  }
}

async function upsertModelProviders() {
  // Both agents run on OpenAI: the fast investigator on gpt-5-mini, the senior
  // detective on the stronger gpt-5. They share one provider entry (one API key).
  await upsertViaSettings(
    "model-providers",
    {
      type: "openai",
      auth: { api_key: OPENAI_API_KEY },
      models: [
        { model_id: "gpt-5-mini", name: "gpt-5-mini", properties: { context_length: 400000, max_output_tokens: 64000 } },
        { model_id: "gpt-5", name: "gpt-5", properties: { context_length: 400000, max_output_tokens: 128000 } },
      ],
    },
    "model provider: openai"
  );
}

async function upsertMcpServer() {
  const manifest = { type: "remote", name: MCP_SERVER_NAME, url: MCP_URL, description: "Detective Board evidence sources and actions." };
  await upsertViaSettings("mcp-servers", manifest, `MCP server: ${MCP_SERVER_NAME} -> ${MCP_URL}`);
}

async function upsertAgent(name, model, instructions, description, iterationLimit) {
  const { data: existing } = await call("GET", "/api/v1/agents");
  const found = existing.find((a) => a.name === name);
  const manifest = {
    // tool_choice: "required" is an OpenAI Chat Completions param, not a documented
    // TrueForge field — RuntimeConfig's ModelParams schema explicitly forwards unknown keys
    // to the provider as-is. Without it, a real run showed the model narrating every
    // hypothesis/verdict as prose instead of calling record_hypothesis_verdict, and ending
    // the turn by asking the user a question instead of calling conclude_investigation.
    model: { name: model, params: { tool_choice: "required" } },
    instructions,
    mcp_servers: AGENT_MCP_SERVERS,
    // iteration_limit is TrueForge's own real, server-enforced cap on agent-loop iterations
    // per turn — unlike this repo's own MAX_INVESTIGATION_STEPS (a board-rendering budget
    // only), this one actually stops the model from continuing to call tools.
    config: { iteration_limit: iterationLimit, ask_user_questions: { enabled: false } },
  };
  if (found) {
    await call("PUT", `/api/v1/agents/${found.id}`, { manifest, description });
    console.log(`✓ updated agent: ${name}`);
  } else {
    // description is required on create (not reflected in the pinned trueforge-sdk's
    // types as of 0.1.3 — confirmed against the running server's own /api/v1/openapi.json).
    await call("POST", "/api/v1/agents", { name, description, manifest });
    console.log(`✓ created agent: ${name}`);
  }
}

async function main() {
  console.log(`Configuring TrueForge at ${BASE_URL} ...`);
  await upsertModelProviders();
  await upsertMcpServer();
  await upsertAgent(
    INVESTIGATOR_AGENT_NAME,
    INVESTIGATOR_MODEL_NAME,
    INVESTIGATOR_INSTRUCTIONS,
    "Gathers evidence for a Detective Board case, one tested hypothesis at a time.",
    70 // covers ~7 tool-discovery iterations plus a thorough ~32-step real investigation, with headroom
  );
  await upsertAgent(
    SENIOR_AGENT_NAME,
    SENIOR_MODEL_NAME,
    SENIOR_INSTRUCTIONS,
    "Synthesizes a completed Detective Board investigation into a ranked root cause and one recommended fix.",
    15 // only needs to discover + call propose_restock_action once
  );
  console.log("\nDone. Run `npm run backend` and visit http://localhost:8788.");
  if (OPENAI_API_KEY.startsWith("sk-placeholder")) {
    console.log("\n⚠ Reminder: set a real OPENAI_API_KEY in .env and re-run `npm run setup`.");
  }
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
