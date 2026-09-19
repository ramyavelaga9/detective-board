// Synthetic evidence for the Detective Board's demo cases. Each case is a
// revenue drop with one real cause and several red herrings the agent has to
// rule out:
//
//   DB-1001  Overnight drop: a top-selling SKU stocks out (marketing,
//            refunds, and weather are the red herrings).
//   DB-1002  Three-day slide: paid ad spend is cut, so traffic and revenue
//            slip together across every SKU (a low-stock SKU, normal
//            refunds, and one stormy region are the red herrings).
//
// Every function is anchored to a case's own date rather than the real wall
// clock, so each case ("revenue dropped noticeably yesterday") is
// reproducible on any machine, on any day, instead of drifting with when
// it's actually run. A real deployment would swap this for a live
// Shopify/GA4/etc. connection - this is a deliberately simple stand-in for
// a hackathon prototype, the same role store.mjs plays in PharmaFlow.

const HISTORY_DAYS = 65;
const AVG_ORDER_VALUE = 85;
const BASE_SESSIONS = 3400;
const BASE_AD_SPEND = 1200;
const BASE_CONVERSION_RATE = 2.8;
const BASE_UNITS_PER_SKU = 12;

const STOCKOUT_SKU = "SKU-447";
const LOW_STOCK_SKU = "SKU-518";
const SPIKE_WINDOW_DAYS = 7; // days before DB-1001's date where the stockout SKU was a top seller

const SKUS = [
  { sku: "SKU-101", name: "Ceramic Pour-Over Kit" },
  { sku: "SKU-229", name: "Weighted Blanket, Queen" },
  { sku: STOCKOUT_SKU, name: "Aurora Desk Lamp" },
  { sku: LOW_STOCK_SKU, name: "Cork Yoga Mat" },
  { sku: "SKU-630", name: "Insulated Travel Mug" },
];

const REGIONS = new Set(["northeast", "midwest", "west"]);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function assertPositiveIntegerDays(days) {
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`days must be a positive integer, got ${days}`);
  }
}

/** ISO date strings for the `days` calendar days ending on `endDate`, oldest first. */
function dateRangeEnding(endDate, days) {
  assertPositiveIntegerDays(days);
  const end = new Date(`${endDate}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const date = new Date(end.getTime() - (days - 1 - i) * MS_PER_DAY);
    return date.toISOString().slice(0, 10);
  });
}

/** Deterministic baseline revenue with mild wave variation - a stand-in for real seasonality, not randomness. */
function baselineRevenueForIndex(i) {
  return 20000 + 800 * Math.sin(i / 3);
}

const flatMarketing = (date) => ({ date, adSpend: BASE_AD_SPEND, sessions: BASE_SESSIONS, conversionRate: BASE_CONVERSION_RATE });
const flatRefunds = (date) => ({ date, refundCount: 6, refundAmount: 510, topReason: "size_or_fit" });
const clearWeather = (region, date) => ({ region, date, condition: "clear", severe: false });
const healthyInventory = (sku, name) => ({ sku, name, stock: 140, stockoutSince: null });

// ---- DB-1001: overnight drop from a SKU stockout ----

const STOCKOUT_CASE_DATE = "2026-09-17";

function isInStockoutSpikeWindow(date) {
  const dates = dateRangeEnding(STOCKOUT_CASE_DATE, HISTORY_DAYS);
  const caseIndex = dates.indexOf(STOCKOUT_CASE_DATE);
  const dateIndex = dates.indexOf(date);
  return dateIndex >= 0 && dateIndex < caseIndex && dateIndex >= caseIndex - SPIKE_WINDOW_DAYS;
}

const stockoutCase = {
  id: "DB-1001",
  title: "Overnight revenue drop",
  caseDate: STOCKOUT_CASE_DATE,
  revenueFactor: (date) => (date === STOCKOUT_CASE_DATE ? 0.66 : 1), // ~34% drop on the case date
  skuUnits: (sku, date) => {
    if (sku !== STOCKOUT_SKU) return BASE_UNITS_PER_SKU;
    if (date === STOCKOUT_CASE_DATE) return 0;
    return isInStockoutSpikeWindow(date) ? 42 : BASE_UNITS_PER_SKU;
  },
  inventory: (sku, name) =>
    sku === STOCKOUT_SKU ? { sku, name, stock: 0, stockoutSince: "2026-09-16" } : healthyInventory(sku, name),
  marketing: flatMarketing,
  refunds: flatRefunds,
  weather: clearWeather,
};

// ---- DB-1002: three-day slide after paid ad spend is cut ----

const SLIDE_CASE_DATE = "2026-09-14";
const AD_CUT_SPEND = 300;
// Sessions for the three days after the ad cut, ending on the case date: retargeting
// traffic fades over a few days rather than vanishing at once, hence a slide, not a cliff.
const SLIDE_SESSIONS_BY_DATE = { "2026-09-12": 3050, "2026-09-13": 2650, "2026-09-14": 2350 };

/** Share of normal traffic still arriving that day; 1 before the ad cut. */
function slideTrafficShare(date) {
  return (SLIDE_SESSIONS_BY_DATE[date] ?? BASE_SESSIONS) / BASE_SESSIONS;
}

const slideCase = {
  id: "DB-1002",
  title: "Three-day revenue slide",
  caseDate: SLIDE_CASE_DATE,
  // Conversion rate stays flat, so revenue follows traffic: this is a traffic problem, not a conversion one.
  revenueFactor: slideTrafficShare,
  // Every SKU slides together, unlike DB-1001 where one SKU goes to zero.
  skuUnits: (_sku, date) => Math.round(BASE_UNITS_PER_SKU * slideTrafficShare(date)),
  // Low, but still selling: a red herring, not a stockout.
  inventory: (sku, name) =>
    sku === LOW_STOCK_SKU ? { sku, name, stock: 9, stockoutSince: null } : healthyInventory(sku, name),
  marketing: (date) =>
    date in SLIDE_SESSIONS_BY_DATE
      ? { date, adSpend: AD_CUT_SPEND, sessions: SLIDE_SESSIONS_BY_DATE[date], conversionRate: BASE_CONVERSION_RATE }
      : flatMarketing(date),
  refunds: flatRefunds,
  // A real storm on the case date, but the slide began two days earlier under clear skies.
  weather: (region, date) =>
    region === "northeast" && date === SLIDE_CASE_DATE
      ? { region, date, condition: "heavy_rain", severe: true }
      : clearWeather(region, date),
};

const CASES = new Map([stockoutCase, slideCase].map((c) => [c.id, c]));

function getCase(caseId) {
  const found = CASES.get(caseId);
  if (!found) {
    throw new RangeError(`Unknown case "${caseId}". Known cases: ${[...CASES.keys()].join(", ")}`);
  }
  return found;
}

function hasCase(caseId) {
  return CASES.has(caseId);
}

/** Every case's id, title, and date, in board order - what the case picker lists. */
function listCases() {
  return [...CASES.values()].map(({ id, title, caseDate }) => ({ id, title, date: caseDate }));
}

function getCaseDate(caseId) {
  return getCase(caseId).caseDate;
}

function getRevenueTimeseries(caseId, days = HISTORY_DAYS) {
  const { caseDate, revenueFactor } = getCase(caseId);
  return dateRangeEnding(caseDate, days).map((date, i) => {
    const revenue = Math.round(baselineRevenueForIndex(i) * revenueFactor(date));
    return { date, revenue, orders: Math.round(revenue / AVG_ORDER_VALUE) };
  });
}

/** Revenue on the case date against the prior 14-day rolling average - the headline anomaly the case opens with. */
function getRevenueDeviation(caseId) {
  const series = getRevenueTimeseries(caseId, HISTORY_DAYS);
  const latest = series[series.length - 1];
  const priorWindow = series.slice(-15, -1); // the 14 days immediately before the case date
  const rollingAverage = Math.round(priorWindow.reduce((sum, day) => sum + day.revenue, 0) / priorWindow.length);
  const percentChange = Math.round(((latest.revenue - rollingAverage) / rollingAverage) * 100);
  return { date: latest.date, latestRevenue: latest.revenue, rollingAverage, percentChange };
}

function getSkuSalesBreakdown(caseId, date) {
  const { caseDate, skuUnits } = getCase(caseId);
  if (!dateRangeEnding(caseDate, HISTORY_DAYS).includes(date)) return [];
  return SKUS.map(({ sku, name }) => {
    const units = skuUnits(sku, date);
    return { sku, name, units, revenue: units * (AVG_ORDER_VALUE / 2) };
  });
}

function getInventoryStatus(caseId, sku) {
  const { inventory } = getCase(caseId);
  const match = SKUS.find((s) => s.sku === sku);
  return match ? inventory(sku, match.name) : null;
}

function getMarketingMetrics(caseId, days = HISTORY_DAYS) {
  const { caseDate, marketing } = getCase(caseId);
  return dateRangeEnding(caseDate, days).map(marketing);
}

function getRefundEvents(caseId, days = HISTORY_DAYS) {
  const { caseDate, refunds } = getCase(caseId);
  return dateRangeEnding(caseDate, days).map(refunds);
}

function getWeather(caseId, region, date) {
  const { weather } = getCase(caseId);
  return REGIONS.has(region) ? weather(region, date) : null;
}

export {
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
  SKUS,
  STOCKOUT_SKU,
  LOW_STOCK_SKU,
};
