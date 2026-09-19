import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasCase,
  listCases,
  getCaseDate,
  getRevenueTimeseries,
  getRevenueDeviation,
  getSkuSalesBreakdown,
  getInventoryStatus,
  getMarketingMetrics,
  getRefundEvents,
  getWeather,
  STOCKOUT_SKU,
  LOW_STOCK_SKU,
} from "../src/evidence-store.mjs";

const STOCKOUT_CASE = "DB-1001";
const SLIDE_CASE = "DB-1002";

test("listCases lists both cases in board order, each with an id, title, and date", () => {
  const cases = listCases();
  assert.deepEqual(cases.map((c) => c.id), [STOCKOUT_CASE, SLIDE_CASE]);
  for (const c of cases) {
    assert.ok(c.title.length > 0);
    assert.match(c.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("hasCase is true for known cases and false for anything else (invalid input case)", () => {
  assert.equal(hasCase(STOCKOUT_CASE), true);
  assert.equal(hasCase(SLIDE_CASE), true);
  assert.equal(hasCase("DB-9999"), false);
  assert.equal(hasCase(undefined), false);
});

test("every evidence function rejects an unknown case, naming the valid ones (invalid input case)", () => {
  assert.throws(() => getRevenueDeviation("DB-9999"), /Unknown case "DB-9999".*DB-1001, DB-1002/);
  assert.throws(() => getRevenueTimeseries("DB-9999", 5), RangeError);
  assert.throws(() => getInventoryStatus("DB-9999", "SKU-101"), RangeError);
});

test("getRevenueTimeseries returns one entry per requested day, ending on each case's own date", () => {
  for (const caseId of [STOCKOUT_CASE, SLIDE_CASE]) {
    const series = getRevenueTimeseries(caseId, 10);
    assert.equal(series.length, 10);
    assert.equal(series.at(-1).date, getCaseDate(caseId));
  }
});

test("the two cases are anchored to different dates", () => {
  assert.notEqual(getCaseDate(STOCKOUT_CASE), getCaseDate(SLIDE_CASE));
});

test("getRevenueTimeseries throws for a non-positive days value (invalid input case)", () => {
  assert.throws(() => getRevenueTimeseries(STOCKOUT_CASE, 0), RangeError);
  assert.throws(() => getRevenueTimeseries(STOCKOUT_CASE, -5), RangeError);
});

test("getRevenueTimeseries throws for a non-integer days value (invalid input case)", () => {
  assert.throws(() => getRevenueTimeseries(STOCKOUT_CASE, 3.5), RangeError);
});

test("getMarketingMetrics shares the same day-range validation as revenue (invalid input case)", () => {
  assert.throws(() => getMarketingMetrics(STOCKOUT_CASE, 0), RangeError);
});

test("both cases open on a real double-digit-percent revenue drop on their case date", () => {
  for (const caseId of [STOCKOUT_CASE, SLIDE_CASE]) {
    const deviation = getRevenueDeviation(caseId);
    assert.equal(deviation.date, getCaseDate(caseId));
    assert.ok(deviation.percentChange <= -20, `${caseId}: expected a real drop, got ${deviation.percentChange}%`);
    assert.ok(deviation.percentChange >= -50, `${caseId}: expected a plausible drop, got ${deviation.percentChange}%`);
  }
});

// ---- DB-1001: the stockout case ----

test("DB-1001: the stockout SKU sells well in the week before the case date, then drops to zero on it", () => {
  const caseDate = getCaseDate(STOCKOUT_CASE);
  const dayBefore = getRevenueTimeseries(STOCKOUT_CASE, 2)[0].date;
  const onCaseDate = getSkuSalesBreakdown(STOCKOUT_CASE, caseDate).find((s) => s.sku === STOCKOUT_SKU);
  const beforeCaseDate = getSkuSalesBreakdown(STOCKOUT_CASE, dayBefore).find((s) => s.sku === STOCKOUT_SKU);
  assert.equal(onCaseDate.units, 0);
  assert.ok(beforeCaseDate.units > 0);
});

test("DB-1001: getInventoryStatus reports zero stock for the stockout SKU and healthy stock for others", () => {
  assert.equal(getInventoryStatus(STOCKOUT_CASE, STOCKOUT_SKU).stock, 0);
  assert.ok(getInventoryStatus(STOCKOUT_CASE, "SKU-101").stock > 0);
});

test("DB-1001: marketing spend and sessions are flat, a red herring the agent should rule out", () => {
  const metrics = getMarketingMetrics(STOCKOUT_CASE, 10);
  assert.equal(new Set(metrics.map((m) => m.adSpend)).size, 1);
  assert.equal(new Set(metrics.map((m) => m.sessions)).size, 1);
});

test("DB-1001: no severe weather anywhere on the case date, a red herring the agent should rule out", () => {
  assert.equal(getWeather(STOCKOUT_CASE, "northeast", getCaseDate(STOCKOUT_CASE)).severe, false);
});

// ---- DB-1002: the ad-cut slide case ----

test("DB-1002: ad spend is cut and sessions slide with it, while conversion rate holds steady", () => {
  const metrics = getMarketingMetrics(SLIDE_CASE, 6);
  const before = metrics[0];
  const last = metrics.at(-1);
  assert.ok(last.adSpend < before.adSpend / 2, "ad spend should be cut by more than half");
  assert.ok(last.sessions < before.sessions, "traffic should have fallen with the spend");
  assert.equal(last.conversionRate, before.conversionRate, "conversion rate is flat, so this is a traffic problem");
});

test("DB-1002: the slide is gradual, sessions fall on each of the three days after the cut", () => {
  const [, , , dayOne, dayTwo, dayThree] = getMarketingMetrics(SLIDE_CASE, 6);
  assert.ok(dayOne.sessions > dayTwo.sessions && dayTwo.sessions > dayThree.sessions);
});

test("DB-1002: no SKU stocks out, and every SKU sells less on the case date (broad decline, not one SKU)", () => {
  const caseDate = getCaseDate(SLIDE_CASE);
  const dayBefore = getRevenueTimeseries(SLIDE_CASE, 5)[0].date;
  const onCaseDate = getSkuSalesBreakdown(SLIDE_CASE, caseDate);
  const beforeSlide = getSkuSalesBreakdown(SLIDE_CASE, dayBefore);
  for (const sku of onCaseDate) {
    assert.ok(sku.units > 0, `${sku.sku} should still be selling`);
    assert.ok(sku.units < beforeSlide.find((s) => s.sku === sku.sku).units, `${sku.sku} should sell less`);
  }
});

test("DB-1002: the low-stock SKU is low but not out, a red herring the agent should rule out", () => {
  const status = getInventoryStatus(SLIDE_CASE, LOW_STOCK_SKU);
  assert.ok(status.stock > 0 && status.stock < 20);
  assert.equal(status.stockoutSince, null);
  assert.equal(getInventoryStatus(SLIDE_CASE, STOCKOUT_SKU).stock > 0, true, "DB-1001's stockout SKU is healthy here");
});

test("DB-1002: a real storm hits one region on the case date, but not the days the slide began", () => {
  const dates = getRevenueTimeseries(SLIDE_CASE, 3).map((d) => d.date);
  assert.equal(getWeather(SLIDE_CASE, "northeast", dates[2]).severe, true);
  assert.equal(getWeather(SLIDE_CASE, "northeast", dates[0]).severe, false);
  assert.equal(getWeather(SLIDE_CASE, "west", dates[2]).severe, false);
});

test("DB-1002: refunds stay flat, a red herring the agent should rule out", () => {
  const refunds = getRefundEvents(SLIDE_CASE, 10);
  assert.equal(new Set(refunds.map((r) => r.refundCount)).size, 1);
});

test("getSkuSalesBreakdown returns an empty array for a date outside the known window (invalid input case)", () => {
  assert.deepEqual(getSkuSalesBreakdown(STOCKOUT_CASE, "1999-01-01"), []);
});

test("getInventoryStatus returns null for an unknown SKU (invalid input case)", () => {
  assert.equal(getInventoryStatus(STOCKOUT_CASE, "SKU-DOES-NOT-EXIST"), null);
});

test("getWeather returns null for an unknown region (invalid input case)", () => {
  assert.equal(getWeather(STOCKOUT_CASE, "atlantis", getCaseDate(STOCKOUT_CASE)), null);
});
