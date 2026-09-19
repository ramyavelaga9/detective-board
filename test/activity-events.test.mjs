import { test } from "node:test";
import assert from "node:assert/strict";
import { toThinkingActivity, toToolStartedActivity, toToolFinishedActivity } from "../src/activity-events.mjs";

test("a started evidence tool is announced by its real name", () => {
  assert.deepEqual(toToolStartedActivity("get_weather"), { kind: "tool_started", text: "Calling get_weather..." });
});

test("TrueForge's own tool discovery and the verdict/conclusion tools get plain-language labels", () => {
  assert.equal(toToolStartedActivity("list_tools").text, "Discovering available tools...");
  assert.equal(toToolStartedActivity("get_tool_info").text, "Reading tool details...");
  assert.equal(toToolStartedActivity("record_hypothesis_verdict").text, "Recording a verdict...");
  assert.equal(toToolStartedActivity("conclude_investigation").text, "Drawing a conclusion...");
});

test("both approval-gated fix tools get a plain-language label", () => {
  assert.equal(toToolStartedActivity("propose_restock_action").text, "Proposing a restock fix...");
  assert.equal(toToolStartedActivity("propose_marketing_action").text, "Proposing an ad-spend fix...");
});

test("a finished tool reuses the same label", () => {
  assert.deepEqual(toToolFinishedActivity("list_tools"), { kind: "tool_finished", text: "Discovering available tools: done" });
});

test("thinking text names the agent that is working, and falls back for an unknown role (invalid input case)", () => {
  assert.match(toThinkingActivity("investigator").text, /^Investigator/);
  assert.match(toThinkingActivity("senior").text, /^Senior detective/);
  assert.equal(toThinkingActivity(undefined).kind, "thinking");
  assert.equal(toThinkingActivity(undefined).text, "Agent is thinking...");
});
