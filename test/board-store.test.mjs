import { test } from "node:test";
import assert from "node:assert/strict";
import { createBoardStore } from "../src/board-store.mjs";

test("addEvent accumulates events for a case in order", () => {
  const store = createBoardStore();
  store.addEvent("DB-1001", { type: "node_added", id: "n1" });
  store.addEvent("DB-1001", { type: "node_added", id: "n2" });
  assert.deepEqual(store.getSnapshot("DB-1001"), [
    { type: "node_added", id: "n1" },
    { type: "node_added", id: "n2" },
  ]);
});

test("getSnapshot returns an empty array for a case with no events yet (edge case: a client reconnecting before anything happened)", () => {
  const store = createBoardStore();
  assert.deepEqual(store.getSnapshot("DB-NEVER-STARTED"), []);
});

test("getSnapshot lets a dropped-and-reconnected client replay everything recorded so far (edge case: SSE reconnect mid-investigation)", () => {
  const store = createBoardStore();
  store.addEvent("DB-1001", { type: "node_added", id: "n1" });
  const firstRead = store.getSnapshot("DB-1001");
  store.addEvent("DB-1001", { type: "node_added", id: "n2" });
  const secondRead = store.getSnapshot("DB-1001");
  assert.equal(firstRead.length, 1);
  assert.equal(secondRead.length, 2);
});

test("getSnapshot returns a copy, so mutating it never corrupts the store", () => {
  const store = createBoardStore();
  store.addEvent("DB-1001", { type: "node_added", id: "n1" });
  const snapshot = store.getSnapshot("DB-1001");
  snapshot.push({ type: "tampered" });
  assert.equal(store.getSnapshot("DB-1001").length, 1);
});

test("resetCase clears a case's events so a new run starts with a clean board", () => {
  const store = createBoardStore();
  store.addEvent("DB-1001", { type: "node_added", id: "n1" });
  store.resetCase("DB-1001");
  assert.deepEqual(store.getSnapshot("DB-1001"), []);
});

test("events are scoped per case id", () => {
  const store = createBoardStore();
  store.addEvent("DB-1001", { type: "node_added", id: "n1" });
  assert.deepEqual(store.getSnapshot("DB-2002"), []);
});
