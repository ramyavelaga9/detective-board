import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createActionsLog } from "../src/actions-log.mjs";

/** A fresh scratch actions file per test, so tests never touch the real data file. */
async function withTempLog(run) {
  const dir = await mkdtemp(path.join(tmpdir(), "detective-board-actions-"));
  const actionsPath = path.join(dir, "restock-actions.json");
  const marketingPath = path.join(dir, "marketing-actions.json");
  await writeFile(actionsPath, "[]\n", "utf-8");
  try {
    await run(createActionsLog(actionsPath, marketingPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("recordRestockAction persists a real record, clearly labeled as simulated", () =>
  withTempLog(async (log) => {
    const record = await log.recordRestockAction({ caseId: "DB-1001", sku: "SKU-447", quantity: 200, note: "Restock the stockout SKU" });
    assert.match(record.id, /^RESTOCK-/);
    assert.equal(record.status, "simulated", "must never claim to be a real transaction");
    const actions = await log.listRestockActions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].sku, "SKU-447");
  }));

test("listRestockActions on an empty log returns an empty array, not a fabricated entry (invalid input case)", () =>
  withTempLog(async (log) => {
    assert.deepEqual(await log.listRestockActions(), []);
  }));

test("multiple restock actions accumulate independently across calls", () =>
  withTempLog(async (log) => {
    await log.recordRestockAction({ caseId: "DB-1001", sku: "SKU-447", quantity: 200, note: "first" });
    await log.recordRestockAction({ caseId: "DB-1002", sku: "SKU-229", quantity: 50, note: "second" });
    const actions = await log.listRestockActions();
    assert.equal(actions.length, 2);
    assert.equal(actions[1].caseId, "DB-1002");
  }));

test("recordMarketingAction persists a real record, clearly labeled as simulated", () =>
  withTempLog(async (log) => {
    const record = await log.recordMarketingAction({ caseId: "DB-1002", dailyAdSpend: 1200, note: "Restore the paused campaign budget" });
    assert.match(record.id, /^ADSPEND-/);
    assert.equal(record.status, "simulated", "must never claim to be a real transaction");
    const actions = await log.listMarketingActions();
    assert.equal(actions.length, 1);
    assert.equal(actions[0].dailyAdSpend, 1200);
  }));

test("a marketing action never lands in the restock log, and vice versa", () =>
  withTempLog(async (log) => {
    await log.recordMarketingAction({ caseId: "DB-1002", dailyAdSpend: 1200, note: "budget" });
    await log.recordRestockAction({ caseId: "DB-1001", sku: "SKU-447", quantity: 10, note: "stock" });
    assert.equal((await log.listMarketingActions()).length, 1);
    assert.equal((await log.listRestockActions()).length, 1);
  }));

test("listMarketingActions before anything was ever recorded returns an empty array, not an error (invalid input case)", () =>
  withTempLog(async (log) => {
    assert.deepEqual(await log.listMarketingActions(), []);
  }));
