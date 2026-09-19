import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCaseDate,
  getRevenueTimeseries,
  getRevenueDeviation,
  getSkuSalesBreakdown,
  getInventoryStatus,
  getMarketingMetrics,
  getWeather,
  STOCKOUT_SKU,
} from "../src/evidence-store.mjs";

test("getRevenueTimeseries returns one entry per requested day, ending on the case date", () => {
  const series = getRevenueTimeseries(10);
  assert.equal(series.length, 10);
  assert.equal(series.at(-1).date, getCaseDate());
});

test("getRevenueTimeseries throws for a non-positive days value (invalid input case)", () => {
  assert.throws(() => getRevenueTimeseries(0), RangeError);
  assert.throws(() => getRevenueTimeseries(-5), RangeError);
});

test("getRevenueTimeseries throws for a non-integer days value (invalid input case)", () => {
  assert.throws(() => getRevenueTimeseries(3.5), RangeError);
});

test("getMarketingMetrics shares the same day-range validation as revenue (invalid input case)", () => {
  assert.throws(() => getMarketingMetrics(0), RangeError);
});

test("getRevenueDeviation reports a real double-digit-percent drop on the case date", () => {
  const deviation = getRevenueDeviation();
  assert.equal(deviation.date, getCaseDate());
  assert.ok(deviation.percentChange <= -20, `expected a real drop, got ${deviation.percentChange}%`);
  assert.ok(deviation.percentChange >= -50, `expected a plausible drop, got ${deviation.percentChange}%`);
});

test("the stockout SKU sells well in the week before the case date, then drops to zero on it", () => {
  const caseDate = getCaseDate();
  const dayBefore = getRevenueTimeseries(2)[0].date;
  const onCaseDate = getSkuSalesBreakdown(caseDate).find((s) => s.sku === STOCKOUT_SKU);
  const beforeCaseDate = getSkuSalesBreakdown(dayBefore).find((s) => s.sku === STOCKOUT_SKU);
  assert.equal(onCaseDate.units, 0);
  assert.ok(beforeCaseDate.units > 0);
});

test("getSkuSalesBreakdown returns an empty array for a date outside the known window (invalid input case)", () => {
  assert.deepEqual(getSkuSalesBreakdown("1999-01-01"), []);
});

test("getInventoryStatus reports zero stock for the stockout SKU and healthy stock for others", () => {
  assert.equal(getInventoryStatus(STOCKOUT_SKU).stock, 0);
  assert.ok(getInventoryStatus("SKU-101").stock > 0);
});

test("getInventoryStatus returns null for an unknown SKU (invalid input case)", () => {
  assert.equal(getInventoryStatus("SKU-DOES-NOT-EXIST"), null);
});

test("getWeather returns null for an unknown region (invalid input case)", () => {
  assert.equal(getWeather("atlantis", getCaseDate()), null);
});

test("getWeather reports no severe weather on the case date — a red herring the agent should rule out", () => {
  const weather = getWeather("northeast", getCaseDate());
  assert.equal(weather.severe, false);
});
