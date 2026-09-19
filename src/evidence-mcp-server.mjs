// Detective Board MCP tool server.
//
// Exposes the case's evidence sources as MCP tools over Streamable HTTP so
// a TrueForge agent can gather real (if synthetic) evidence and log real
// records — the "harder problem" piece of the hackathon brief, the same
// role PharmaFlow's mcp-server.mjs plays. Register it in TrueForge
// (Settings > Connectors, or via `npm run setup`) pointing at
// http://localhost:8793/mcp.
//
// The server holds every case's evidence at once and stays stateless, so
// each evidence tool takes the case id (given in the case brief) instead of
// the server tracking which case an agent is on.
//
// record_hypothesis_verdict and conclude_investigation are structured
// self-report tools with no server-side state: the backend derives the
// board's nodes/edges directly from these tool calls as they stream past
// (see board-events.mjs), so there is nothing for this process to persist
// on their behalf. propose_restock_action and propose_marketing_action are
// the tools with a real side effect, which is exactly why they're the ones
// gated for human approval.

import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import * as evidence from "./evidence-store.mjs";
import { createActionsLog } from "./actions-log.mjs";

const PORT = process.env.MCP_PORT || 8793;
const actionsLog = createActionsLog();

const caseIdSchema = z.string().describe("The case id from the case brief, e.g. 'DB-1001'");

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
}

function buildServer() {
  const server = new McpServer({ name: "detective-evidence", version: "0.1.0" });

  server.registerTool(
    "get_revenue_deviation",
    {
      title: "Get revenue deviation",
      description: "Get the case's headline anomaly: revenue on the case date against the prior 14-day rolling average.",
      inputSchema: { caseId: caseIdSchema },
    },
    async ({ caseId }) => {
      try {
        return jsonResult(evidence.getRevenueDeviation(caseId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_revenue_timeseries",
    {
      title: "Get revenue timeseries",
      description: "Get daily revenue and order counts for the given number of days ending on the case date.",
      inputSchema: { caseId: caseIdSchema, days: z.number().int().min(1).max(65).default(65).describe("Look-back window in days") },
    },
    async ({ caseId, days }) => {
      try {
        return jsonResult(evidence.getRevenueTimeseries(caseId, days));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_sku_sales_breakdown",
    {
      title: "Get SKU sales breakdown",
      description: "Get per-SKU units and revenue for a single date.",
      inputSchema: { caseId: caseIdSchema, date: z.string().describe("ISO date, e.g. '2026-09-17'") },
    },
    async ({ caseId, date }) => {
      try {
        return jsonResult(evidence.getSkuSalesBreakdown(caseId, date));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_inventory_status",
    {
      title: "Get inventory status",
      description: "Get current stock level and stockout status for a single SKU.",
      inputSchema: { caseId: caseIdSchema, sku: z.string().describe("SKU id, e.g. 'SKU-447'") },
    },
    async ({ caseId, sku }) => {
      try {
        const status = evidence.getInventoryStatus(caseId, sku);
        if (!status) return { content: [{ type: "text", text: `No SKU found with id ${sku}` }], isError: true };
        return jsonResult(status);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_marketing_metrics",
    {
      title: "Get marketing metrics",
      description: "Get daily ad spend, sessions, and conversion rate for the given number of days ending on the case date.",
      inputSchema: { caseId: caseIdSchema, days: z.number().int().min(1).max(65).default(65).describe("Look-back window in days") },
    },
    async ({ caseId, days }) => {
      try {
        return jsonResult(evidence.getMarketingMetrics(caseId, days));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_refund_events",
    {
      title: "Get refund events",
      description: "Get daily refund counts, amounts, and top reason for the given number of days ending on the case date.",
      inputSchema: { caseId: caseIdSchema, days: z.number().int().min(1).max(65).default(65).describe("Look-back window in days") },
    },
    async ({ caseId, days }) => {
      try {
        return jsonResult(evidence.getRefundEvents(caseId, days));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_weather",
    {
      title: "Get weather",
      description: "Get the weather condition for a region on a single date.",
      inputSchema: {
        caseId: caseIdSchema,
        region: z.string().describe("One of 'northeast', 'midwest', 'west'"),
        date: z.string().describe("ISO date, e.g. '2026-09-17'"),
      },
    },
    async ({ caseId, region, date }) => {
      try {
        const weather = evidence.getWeather(caseId, region, date);
        if (!weather) return { content: [{ type: "text", text: `No weather data for region ${region}` }], isError: true };
        return jsonResult(weather);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "record_hypothesis_verdict",
    {
      title: "Record hypothesis verdict",
      description:
        "Record your verdict on one specific hypothesis after checking it against evidence: which evidence source you used, whether it's confirmed, rejected, or inconclusive, and your confidence (0-100). Call this once per hypothesis you test, right after the evidence tool call it's based on.",
      inputSchema: {
        hypothesis: z.string().describe("The specific, testable hypothesis, e.g. 'SKU-447 stockout drove the drop'"),
        evidenceSource: z.string().describe("The tool name whose result this verdict is based on"),
        verdict: z.enum(["confirmed", "rejected", "inconclusive"]),
        confidence: z.number().min(0).max(100),
      },
    },
    async ({ hypothesis, evidenceSource, verdict, confidence }) =>
      jsonResult({ recorded: true, hypothesis, evidenceSource, verdict, confidence })
  );

  server.registerTool(
    "conclude_investigation",
    {
      title: "Conclude investigation",
      description:
        "Conclude the investigation with your single best-supported root cause, your confidence (0-100), and one concrete recommended action. Call this only once, after testing your hypotheses.",
      inputSchema: {
        rootCause: z.string(),
        confidence: z.number().min(0).max(100),
        recommendedAction: z.string(),
      },
    },
    async ({ rootCause, confidence, recommendedAction }) =>
      jsonResult({ concluded: true, rootCause, confidence, recommendedAction })
  );

  server.registerTool(
    "propose_restock_action",
    {
      title: "Propose a restock action",
      description:
        "Propose restocking a specific SKU as the fix for this case. This is a consequential action and requires human approval before it runs — never call it speculatively, only as the recommended fix for a confirmed stockout.",
      inputSchema: {
        caseId: caseIdSchema,
        sku: z.string(),
        quantity: z.number().int().min(1),
        note: z.string().describe("A short, concrete note: why this SKU and quantity"),
      },
    },
    async ({ caseId, sku, quantity, note }) => {
      try {
        const record = await actionsLog.recordRestockAction({ caseId, sku, quantity, note });
        return jsonResult(record);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "propose_marketing_action",
    {
      title: "Propose an ad-spend action",
      description:
        "Propose setting the daily ad spend back to a specific amount as the fix for this case. This is a consequential action and requires human approval before it runs - never call it speculatively, only as the recommended fix for a confirmed drop in marketing spend and traffic.",
      inputSchema: {
        caseId: caseIdSchema,
        dailyAdSpend: z.number().int().min(1).describe("The daily ad spend, in dollars, to restore"),
        note: z.string().describe("A short, concrete note: why this amount"),
      },
    },
    async ({ caseId, dailyAdSpend, note }) => {
      try {
        const record = await actionsLog.recordMarketingAction({ caseId, dailyAdSpend, note });
        return jsonResult(record);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

// Stateless mode (sessionIdGenerator: undefined): each request is handled
// independently with no session/initialize handshake to track, the same
// choice PharmaFlow's mcp-server.mjs makes, matching TrueForge calling in
// as a plain remote MCP server rather than holding a long-lived connection.
app.all("/mcp", async (req, res) => {
  if (req.headers.accept && req.headers.accept.includes("text/html")) {
    return res.type("text/plain").send("Detective Board MCP server active on /mcp (Streamable HTTP transport)");
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

app.get("/health", (_req, res) => res.json({ ok: true, service: "detective-board-mcp-server" }));

app.listen(PORT, () => {
  console.log(`Detective Board MCP server listening on http://localhost:${PORT}/mcp`);
});
