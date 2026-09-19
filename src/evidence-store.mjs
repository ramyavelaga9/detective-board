// Synthetic evidence for the Detective Board's demo case: a revenue drop
// with one real cause (a SKU stockout) and three red herrings (marketing,
// refunds, weather). Every function is anchored to CASE_DATE rather than
// the real wall clock, so the case ("revenue dropped noticeably yesterday")
// is reproducible on any machine, on any day, instead of drifting with
// when it's actually run. A real deployment would swap this for a live
// Shopify/GA4/etc. connection — this is a deliberately simple stand-in for
// a hackathon prototype, the same role store.mjs plays in PharmaFlow.

const CASE_DATE = "2026-09-17";
const HISTORY_DAYS = 65;
const AVG_ORDER_VALUE = 85;
const ANOMALY_DROP_FACTOR = 0.66; // ~34% revenue drop on CASE_DATE
const STOCKOUT_SKU = "SKU-447";
const SPIKE_WINDOW_DAYS = 7; // days before CASE_DATE where the stockout SKU was a top seller

const SKUS = [
  { sku: "SKU-101", name: "Ceramic Pour-Over Kit" },
  { sku: "SKU-229", name: "Weighted Blanket, Queen" },
  { sku: STOCKOUT_SKU, name: "Aurora Desk Lamp" },
  { sku: "SKU-518", name: "Cork Yoga Mat" },
  { sku: "SKU-630", name: "Insulated Travel Mug" },
];

const REGIONS = new Set(["northeast", "midwest", "west"]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function assertPositiveIntegerDays(days) {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }
}

/** ISO date strings for the `days` calendar days ending on CASE_DATE, oldest first. */
function dateRangeEndingOnCaseDate(days) {
  assertPositiveIntegerDays(days);
  const end = new Date(`${CASE_DATE}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(end.getTime() - (days - 1 - i) * MS_PER_DAY);
    return date.toISOString().slice(0, 10);
  });
}

/** Deterministic baseline revenue with mild wave variation — a stand-in for real seasonality, not randomness. */
function baselineRevenueForIndex(i) {
  return 20000 + 800 * Math.sin(i / 3);
}

function isInSpikeWindow(date) {
  const dates = dateRangeEndingOnCaseDate(HISTORY_DAYS);
  const caseIndex = dates.indexOf(CASE_DATE);
  const dateIndex = dates.indexOf(date);
  return dateIndex >= 0 && dateIndex < caseIndex && dateIndex >= caseIndex - SPIKE_WINDOW_DAYS;
}

function getCaseDate() {
  return CASE_DATE;
}

function getRevenueTimeseries(days = HISTORY_DAYS) {
  const dates = dateRangeEndingOnCaseDate(days);
  return dates.map((date, i) => {
    const isAnomalyDay = date === CASE_DATE;
    const revenue = Math.round(baselineRevenueForIndex(i) * (isAnomalyDay ? ANOMALY_DROP_FACTOR : 1));
    return { date, revenue, orders: Math.round(revenue / AVG_ORDER_VALUE) };
  });
}

/** Revenue on CASE_DATE against the prior 14-day rolling average — the headline anomaly the case opens with. */
function getRevenueDeviation() {
  const series = getRevenueTimeseries(HISTORY_DAYS);
  const latest = series[series.length - 1];
  const priorWindow = series.slice(-15, -1); // the 14 days immediately before CASE_DATE
  const rollingAverage = Math.round(priorWindow.reduce((sum, day) => sum + day.revenue, 0) / priorWindow.length);
  const percentChange = Math.round(((latest.revenue - rollingAverage) / rollingAverage) * 100);
  return { date: latest.date, latestRevenue: latest.revenue, rollingAverage, percentChange };
}

function getSkuSalesBreakdown(date) {
  const dates = dateRangeEndingOnCaseDate(HISTORY_DAYS);
  if (!dates.includes(date)) return [];
  const isAnomalyDay = date === CASE_DATE;
  const inSpikeWindow = isInSpikeWindow(date);
  return SKUS.map(({ sku, name }) => {
    const isStockoutSku = sku === STOCKOUT_SKU;
    let units = 12; // normal day, any SKU
    if (isStockoutSku && isAnomalyDay) units = 0;
    else if (isStockoutSku && inSpikeWindow) units = 42;
    return { sku, name, units, revenue: units * (AVG_ORDER_VALUE / 2) };
  });
}

function getInventoryStatus(sku) {
  const match = SKUS.find((s) => s.sku === sku);
  if (!match) return null;
  if (sku === STOCKOUT_SKU) {
    return { sku, name: match.name, stock: 0, stockoutSince: "2026-09-16" };
  }
  return { sku, name: match.name, stock: 140, stockoutSince: null };
}

function getMarketingMetrics(days = HISTORY_DAYS) {
  const dates = dateRangeEndingOnCaseDate(days);
  return dates.map((date) => ({ date, adSpend: 1200, sessions: 3400, conversionRate: 2.8 }));
}

function getRefundEvents(days = HISTORY_DAYS) {
  const dates = dateRangeEndingOnCaseDate(days);
  return dates.map((date) => ({ date, refundCount: 6, refundAmount: 510, topReason: "size_or_fit" }));
}

function getWeather(region, date) {
  if (!REGIONS.has(region)) return null;
  return { region, date, condition: "clear", severe: false };
}

export {
  getCaseDate,
  getRevenueTimeseries,
  getRevenueDeviation,
  getSkuSalesBreakdown,
  getInventoryStatus,
  getMarketingMetrics,
  getRefundEvents,
  getWeather,
  SKUS,
  STOCKOUT_SKU,
};
