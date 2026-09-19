// Real, persisted records of restock actions the detective agent actually
// took — kept separate from board-store.mjs because this is an append-only
// log of consequences, not the live investigation state, and it must
// survive independently of any one board run. "Placing a restock order" is
// simulated here (no real inventory-system integration exists), and every
// record says so explicitly rather than looking like a real transaction —
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

function createActionsLog(actionsPath = DEFAULT_ACTIONS_PATH) {
  async function readActions() {
    const raw = await readFile(actionsPath, "utf-8");
    return JSON.parse(raw);
  }

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

  return { recordRestockAction, listRestockActions };
}

export { createActionsLog };
