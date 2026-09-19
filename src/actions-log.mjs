// Real, persisted records of the fix actions (restock orders, ad-spend
// changes) the detective agent actually took — kept separate from board-store.mjs because this is an append-only
// log of consequences, not the live investigation state, and it must
// survive independently of any one board run. Both actions are simulated
// here (no real inventory-system or ad-platform integration exists), and
// every record says so explicitly rather than looking like a real transaction —
// the same honesty PharmaFlow's fulfillment.mjs applies to its own
// simulated orders/notifications.
//
// createActionsLog() is a factory (not a module-level singleton), the same
// pattern as PharmaFlow's fulfillment.mjs, so tests can point it at a
// scratch file instead of the real data file.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACTIONS_PATH = path.join(__dirname, "..", "data", "restock-actions.json");
const DEFAULT_MARKETING_ACTIONS_PATH = path.join(__dirname, "..", "data", "marketing-actions.json");

async function readJsonList(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf-8"));
  } catch (err) {
    // A log that has never been written to simply has no entries yet.
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

function createActionsLog(actionsPath = DEFAULT_ACTIONS_PATH, marketingActionsPath = DEFAULT_MARKETING_ACTIONS_PATH) {
  const readActions = () => readJsonList(actionsPath);

  async function recordRestockAction({ caseId, sku, quantity, note }) {
    const actions = await readActions();
    const record = {
      id: `RESTOCK-${randomUUID().slice(0, 8)}`,
      caseId,
      sku,
      quantity,
      note,
      status: "simulated",
      requestedAt: new Date().toISOString(),
    };
    actions.push(record);
    await writeFile(actionsPath, JSON.stringify(actions, null, 2) + "\n", "utf-8");
    return record;
  }

  async function listRestockActions() {
    return readActions();
  }

  async function recordMarketingAction({ caseId, dailyAdSpend, note }) {
    const actions = await readJsonList(marketingActionsPath);
    const record = {
      id: `ADSPEND-${randomUUID().slice(0, 8)}`,
      caseId,
      dailyAdSpend,
      note,
      status: "simulated",
      requestedAt: new Date().toISOString(),
    };
    actions.push(record);
    await writeFile(marketingActionsPath, JSON.stringify(actions, null, 2) + "\n", "utf-8");
    return record;
  }

  async function listMarketingActions() {
    return readJsonList(marketingActionsPath);
  }

  return { recordRestockAction, listRestockActions, recordMarketingAction, listMarketingActions };
}

export { createActionsLog };
