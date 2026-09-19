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
//   3. OPENAI_API_KEY and GEMINI_API_KEY set in .env (placeholder keys
//      still let you register everything and wire it up — the agents just
//      won't answer for real until you swap in working keys and re-run
//      this script)
//
// Safe to re-run: existing resources are updated in place rather than
// duplicated.

import "dotenv/config";

const BASE_URL = process.env.TRUEFORGE_URL || "http://localhost:8790";
const MCP_URL = process.env.DETECTIVE_MCP_URL || "http://localhost:8793/mcp";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-placeholder-replace-me";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "gemini-placeholder-replace-me";

const INVESTIGATOR_MODEL_NAME = "openai/gpt-5-mini";
const SENIOR_MODEL_NAME = "google-gemini/gemini-flash-latest";
const INVESTIGATOR_AGENT_NAME = "detective-investigator";
const SENIOR_AGENT_NAME = "detective-senior";
const MCP_SERVER_NAME = "detective-evidence";

// Named explicitly rather than relying on "@write"/"@destructive" default
// categories, so approval-gating doesn't depend on annotation heuristics
// working out — the same choice PharmaFlow's setup script makes.
const AGENT_MCP_SERVERS = [{ name: MCP_SERVER_NAME, require_approval_for_tools: ["propose_restock_action"] }];

const INVESTIGATOR_INSTRUCTIONS = `You are the investigator on Detective Board, looking into a real revenue
drop on the case date. Your job is to gather evidence, not to guess.

Work in small steps: form one specific, testable hypothesis at a time, call
the single evidence tool that tests it, then call record_hypothesis_verdict
with your verdict (confirmed, rejected, or inconclusive) and a confidence
score (0-100) before moving to your next hypothesis. Never call
record_hypothesis_verdict without a preceding evidence tool call to back it.

Only call conclude_investigation once, after you've tested every plausible
hypothesis evidence lets you test — inventory/stockouts, marketing spend,
refunds, and weather are all worth checking. Never call
propose_restock_action yourself; that belongs to the senior detective who
reviews your findings.

You are running fully autonomously - no human is available to answer
questions or approve next steps mid-investigation. Never end a turn by
asking the user a question or suggesting next steps in plain text. Your
final action, always, must be a real call to conclude_investigation -
never a text summary in place of it.`;

const SENIOR_INSTRUCTIONS = `You are the senior detective on Detective Board. You're given a completed
investigation's evidence trail — the hypotheses tested, their verdicts, and
their confidence scores — and your job is to synthesize it into a final
call, not to re-gather evidence yourself.

Rank the candidate root causes by the evidence you were given, and if a
stockout is the best-supported cause, call propose_restock_action with a
concrete SKU and quantity. This requires human approval before it runs —
never treat it as routine, and never call it for a cause the evidence
doesn't actually support.

You are running fully autonomously - no human is available to answer
questions mid-turn. Never end your turn by asking the user a question;
act on the evidence you were given.`;

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
  await upsertViaSettings(
    "model-providers",
    {
      type: "openai",
      auth: { api_key: OPENAI_API_KEY },
      models: [{ model_id: "gpt-5-mini", name: "gpt-5-mini", properties: { context_length: 400000, max_output_tokens: 64000 } }],
    },
    "model provider: openai"
  );
  await upsertViaSettings(
    "model-providers",
    {
      type: "google-gemini",
      auth: { api_key: GEMINI_API_KEY },
      // Every dated "-pro" model gets zero quota on Gemini's free tier (a live run
      // against gemini-3.1-pro-preview hit a 429 with limit: 0 for the free tier
      // specifically), and dated flash models deprecate for new API keys within
      // months (gemini-2.5-pro, then gemini-2.5-flash both 404'd during development
      // here, each pointing at a newer dated version as the replacement). Using the
      // "-latest" alias instead of a pinned version avoids re-breaking on the next
      // deprecation - Google moves the alias forward on their end. If you have billing
      // enabled on your Google AI Studio project, swap this for a "-pro" model instead.
      models: [
        { model_id: "gemini-flash-latest", name: "gemini-flash-latest", properties: { context_length: 1000000, max_output_tokens: 65536 } },
      ],
    },
    "model provider: google-gemini"
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
    // tool_choice: "required" is an OpenAI/Gemini Chat Completions param, not a documented
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
  if (OPENAI_API_KEY.startsWith("sk-placeholder") || GEMINI_API_KEY.startsWith("gemini-placeholder")) {
    console.log("\n⚠ Reminder: set real OPENAI_API_KEY / GEMINI_API_KEY in .env and re-run `npm run setup`.");
  }
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
