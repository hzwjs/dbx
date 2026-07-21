import assert from "node:assert/strict";
import { test } from "vitest";
import type { SqlFileProgress, SqlFileStatus } from "@/lib/backend/api";
import { createSqlFileBatchTargets, failSqlFileBatchTarget, reduceSqlFileBatchProgress, skipPendingSqlFileBatchTargets, summarizeSqlFileBatch } from "@/lib/sql/sqlFileBatchExecution";

function progress(status: SqlFileStatus, statementIndex = 0, statementSummary = "", error: string | null = null): SqlFileProgress {
  return {
    executionId: "run-a",
    status,
    statementIndex,
    successCount: 0,
    failureCount: 0,
    affectedRows: 0,
    elapsedMs: 0,
    statementSummary,
    error,
  };
}

test("creates ordered pending batch targets with unique execution IDs", () => {
  const targets = createSqlFileBatchTargets(["connection-b", "connection-a"], (connectionId) => `run-${connectionId}`);

  assert.deepEqual(targets, [
    {
      connectionId: "connection-b",
      executionId: "run-connection-b",
      status: "pending",
      statementIndex: 0,
      successCount: 0,
      failureCount: 0,
      affectedRows: 0,
      elapsedMs: 0,
      statementSummary: "",
      error: "",
      failures: [],
    },
    {
      connectionId: "connection-a",
      executionId: "run-connection-a",
      status: "pending",
      statementIndex: 0,
      successCount: 0,
      failureCount: 0,
      affectedRows: 0,
      elapsedMs: 0,
      statementSummary: "",
      error: "",
      failures: [],
    },
  ]);
});

test("transitions a target through started and running progress", () => {
  let target = createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!;

  target = reduceSqlFileBatchProgress(target, progress("started", 1, "CREATE TABLE items"));
  assert.equal(target.status, "running");
  assert.equal(target.statementIndex, 1);

  target = reduceSqlFileBatchProgress(target, { ...progress("running", 2, "INSERT INTO items"), successCount: 1, affectedRows: 3, elapsedMs: 8 });
  assert.deepEqual(target, {
    ...target,
    status: "running",
    statementIndex: 2,
    successCount: 1,
    affectedRows: 3,
    elapsedMs: 8,
    statementSummary: "INSERT INTO items",
  });
});

test("marks a completed target with no failures as successful", () => {
  const target = reduceSqlFileBatchProgress(createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!, { ...progress("done", 3, "COMMIT"), successCount: 3, affectedRows: 7, elapsedMs: 42 });

  assert.equal(target.status, "success");
  assert.equal(target.failureCount, 0);
  assert.equal(target.affectedRows, 7);
});

test("marks a completed target with failures as partial", () => {
  const target = reduceSqlFileBatchProgress(createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!, { ...progress("done", 3), successCount: 2, failureCount: 1 });

  assert.equal(target.status, "partial");
});

test("marks terminal error and cancellation progress", () => {
  const initial = createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!;
  const failed = reduceSqlFileBatchProgress(initial, progress("error", 2, "ALTER TABLE", "permission denied"));
  const cancelled = reduceSqlFileBatchProgress(initial, progress("cancelled", 2, "ALTER TABLE"));

  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "permission denied");
  assert.equal(cancelled.status, "cancelled");
});

test("retains every failed statement before a partial completion", () => {
  let target = createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!;
  target = reduceSqlFileBatchProgress(target, progress("statementFailed", 2, "ALTER A", "duplicate A"));
  target = reduceSqlFileBatchProgress(target, progress("statementFailed", 4, "ALTER B", "duplicate B"));
  target = reduceSqlFileBatchProgress(target, progress("done", 4));
  assert.equal(target.status, "partial");
  assert.deepEqual(
    target.failures.map((item) => item.error),
    ["duplicate A", "duplicate B"],
  );
});

test("does not duplicate a statement failure when its terminal error event follows", () => {
  let target = createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!;
  target = reduceSqlFileBatchProgress(target, progress("statementFailed", 2, "ALTER A", "duplicate A"));
  target = reduceSqlFileBatchProgress(target, progress("error", 2, "ALTER A", "duplicate A"));

  assert.equal(target.status, "failed");
  assert.equal(target.failures.length, 1);
  assert.equal(target.error, "duplicate A");
});

test("records a setup failure without progress", () => {
  const target = failSqlFileBatchTarget(createSqlFileBatchTargets(["a"], (id) => `run-${id}`)[0]!, "connection unavailable");

  assert.equal(target.status, "failed");
  assert.equal(target.error, "connection unavailable");
});

test("skips only pending targets", () => {
  const [pending, running, completed] = createSqlFileBatchTargets(["pending", "running", "completed"], (id) => `run-${id}`);
  const targets = skipPendingSqlFileBatchTargets([pending!, reduceSqlFileBatchProgress(running!, progress("running")), reduceSqlFileBatchProgress(completed!, progress("done"))]);

  assert.deepEqual(
    targets.map((target) => target.status),
    ["skipped", "running", "success"],
  );
});

test("summarizes terminal batch target statuses", () => {
  const [success, partial, failed, cancelled, skipped, pending] = createSqlFileBatchTargets(["success", "partial", "failed", "cancelled", "skipped", "pending"], (id) => `run-${id}`);
  const targets = [
    reduceSqlFileBatchProgress(success!, progress("done")),
    reduceSqlFileBatchProgress(partial!, { ...progress("done"), failureCount: 1 }),
    reduceSqlFileBatchProgress(failed!, progress("error", 0, "", "failure")),
    reduceSqlFileBatchProgress(cancelled!, progress("cancelled")),
    skipPendingSqlFileBatchTargets([skipped!])[0]!,
    pending!,
  ];

  assert.deepEqual(summarizeSqlFileBatch(targets), {
    success: 1,
    partial: 1,
    failed: 1,
    cancelled: 1,
    skipped: 1,
  });
});
