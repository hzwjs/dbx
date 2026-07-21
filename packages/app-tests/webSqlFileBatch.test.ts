import assert from "node:assert/strict";
import { test } from "vitest";
import { preferredWebSqlFileBatch, type WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";

function snapshot(batchId: string, status: WebSqlFileBatchSnapshot["status"], updatedAtMs: number): WebSqlFileBatchSnapshot {
  return {
    batchId,
    fileName: "seed.sql",
    database: "app",
    continueOnError: true,
    status,
    createdAtMs: updatedAtMs - 1,
    updatedAtMs,
    targets: [
      {
        connectionId: "connection-b",
        executionId: `${batchId}-b`,
        status: "success",
        statementIndex: 2,
        successCount: 2,
        failureCount: 0,
        affectedRows: 4,
        elapsedMs: 8,
        statementSummary: "COMMIT",
        error: "",
        failures: [],
      },
      {
        connectionId: "connection-a",
        executionId: `${batchId}-a`,
        status: "failed",
        statementIndex: 1,
        successCount: 0,
        failureCount: 1,
        affectedRows: 0,
        elapsedMs: 3,
        statementSummary: "CREATE TABLE items",
        error: "denied",
        failures: [{ statementIndex: 1, statementSummary: "CREATE TABLE items", error: "denied" }],
      },
    ],
    summary: { success: 1, partial: 0, failed: 1, cancelled: 0, skipped: 0 },
  };
}

test("batch snapshots preserve server target order and summary", () => {
  const next = snapshot("batch-1", "running", 20);

  assert.deepEqual(next.targets.map((target) => target.connectionId), ["connection-b", "connection-a"]);
  assert.deepEqual(next.summary, { success: 1, partial: 0, failed: 1, cancelled: 0, skipped: 0 });
  assert.equal(preferredWebSqlFileBatch([snapshot("old", "completed", 30), next])?.batchId, "batch-1");
});
