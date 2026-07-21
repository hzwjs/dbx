import assert from "node:assert/strict";
import { test } from "vitest";
import { cancelSqlFileBatch, createSqlFileBatch, getSqlFileBatch, listSqlFileBatches } from "@/lib/backend/http";
import { listenSqlFileBatch } from "@/lib/sql/httpSqlFileBatch";
import { preferredWebSqlFileBatch, type WebSqlFileBatchSnapshot } from "@/lib/sql/webSqlFileBatch";

function snapshot(batchId: string, status: WebSqlFileBatchSnapshot["status"], updatedAtMs: number): WebSqlFileBatchSnapshot {
  return {
    batchId,
    revision: updatedAtMs,
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

test("HTTP batch functions use encoded API paths and server response shapes", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const created = snapshot("created", "running", 10);
  const listed = [snapshot("listed", "completed", 20)];
  const fetched = snapshot("batch/id", "cancelled", 30);
  const responses = [created, listed, fetched, { cancelled: true }];
  globalThis.fetch = (async (input, init) => {
    requests.push({ input, init });
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;

  try {
    const request = { connectionIds: ["connection-a"], database: "app", filePath: "/tmp/seed.sql", continueOnError: true };
    assert.deepEqual(await createSqlFileBatch(request), created);
    assert.deepEqual(await listSqlFileBatches(), listed);
    assert.deepEqual(await getSqlFileBatch("batch/id"), fetched);
    assert.equal(await cancelSqlFileBatch("batch/id"), true);

    assert.deepEqual(
      requests.map(({ input, init }) => ({ url: String(input), method: init?.method ?? "GET", headers: init?.headers, body: init?.body })),
      [
        { url: "/api/sql-file/batches", method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
        { url: "/api/sql-file/batches", method: "GET", headers: undefined, body: undefined },
        { url: "/api/sql-file/batches/batch%2Fid", method: "GET", headers: undefined, body: undefined },
        { url: "/api/sql-file/batches/batch%2Fid/cancel", method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SSE batch listener closes on terminal snapshots, errors, and cleanup", () => {
  const originalEventSource = globalThis.EventSource;
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    onerror: (() => void) | null = null;
    closes = 0;

    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }

    close() {
      this.closes += 1;
    }
  }
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

  try {
    const received: WebSqlFileBatchSnapshot[] = [];
    const cleanup = listenSqlFileBatch("batch/id", (next) => received.push(next));
    const eventSource = FakeEventSource.instances[0]!;
    const terminal = snapshot("batch/id", "completed", 20);

    assert.equal(eventSource.url, "/api/sql-file/batches/batch%2Fid/events");
    eventSource.onmessage?.({ data: JSON.stringify(terminal) } as MessageEvent<string>);
    assert.deepEqual(received, [terminal]);
    assert.equal(eventSource.closes, 1);
    eventSource.onerror?.();
    assert.equal(eventSource.closes, 2);
    cleanup();
    assert.equal(eventSource.closes, 3);
  } finally {
    globalThis.EventSource = originalEventSource;
  }
});
