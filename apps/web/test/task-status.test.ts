import test from "node:test";
import assert from "node:assert/strict";
import { outcomeSchema, taskIds, type Outcome } from "@heybox/contracts";
import { runStatus, taskStatus } from "../src/lib/task-status.ts";

const completed: Outcome = {
  status: "completed",
  snapshot: { exp: 100, coin: 200, tasks: taskIds.map((id) => ({ id, state: "finish" })) },
  expDelta: 0,
  coinDelta: 0,
};

test("old zero-reward records stay completed; skip requires explicit execution evidence", () => {
  const old = outcomeSchema.parse(completed);
  assert.equal(old.batteryDelta, undefined);
  assert.equal(old.execution, undefined);
  assert.equal(taskStatus("sign", "completed", old), "completed");
  assert.equal(runStatus("completed", old), "completed");
});

test("skipped tasks are complete, while the daily run is skipped only if all four were skipped", () => {
  const skipped = outcomeSchema.parse({
    ...completed,
    batteryDelta: 0,
    execution: Object.fromEntries(taskIds.map((id) => [id, "skipped"])),
  });
  assert.ok(taskIds.every((id) => taskStatus(id, "completed", skipped) === "skipped"));
  assert.equal(runStatus("completed", skipped), "skipped");
  assert.equal(runStatus("failed", skipped), "failed");
  skipped.execution!["1"] = "executed";
  assert.equal(taskStatus("1", "completed", skipped), "completed");
  assert.equal(runStatus("completed", skipped), "completed");
});

test("a started task is not completed or skipped until its final state is verified", () => {
  const result: Outcome = {
    ...completed,
    status: "failed",
    execution: { sign: "executed", "1": "skipped" },
    snapshot: {
      ...completed.snapshot!,
      tasks: taskIds.map((id) => ({ id, state: id === "1" ? "finish" : "waiting" })),
    },
  };
  assert.equal(taskStatus("sign", "failed", result), "failed");
  assert.equal(taskStatus("1", "failed", result), "skipped");
  assert.equal(taskStatus("sign", "running", result), "confirming");
  assert.equal(taskStatus("sign"), "waiting");
});

test("uncertain attempts cannot be displayed as an all-skipped run", () => {
  const result: Outcome = {
    ...completed,
    uncertain: true,
    execution: Object.fromEntries(taskIds.map((id) => [id, "skipped"])),
  };
  assert.equal(runStatus("completed", result), "completed");
  assert.ok(taskIds.every((id) => taskStatus(id, "completed", result) === "completed"));
});
