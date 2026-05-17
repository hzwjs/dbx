import { strict as assert } from "node:assert";
import test from "node:test";
import { restoreOpenTabsState, serializeOpenTabs } from "../../src/lib/openTabsPersistence.ts";
import type { QueryTab } from "../../src/types/database.ts";

function queryTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: "tab-1",
    title: "Query 1",
    connectionId: "conn-1",
    database: "app",
    schema: "public",
    sql: "select * from users",
    pinned: true,
    isExecuting: false,
    isCancelling: false,
    isExplaining: false,
    mode: "query",
    ...overrides,
  };
}

test("serializes unsaved query tabs with editor context", () => {
  const saved = serializeOpenTabs([queryTab()]);

  assert.deepEqual(saved, [
    {
      id: "tab-1",
      title: "Query 1",
      connectionId: "conn-1",
      database: "app",
      schema: "public",
      sql: "select * from users",
      savedSqlId: undefined,
      pinned: true,
      mode: "query",
      objectBrowser: undefined,
      objectSource: undefined,
      tableMeta: undefined,
    },
  ]);
});

test("serializes object source query tabs with save context", () => {
  const saved = serializeOpenTabs([
    queryTab({
      title: "fn_add",
      objectSource: {
        schema: "public",
        name: "fn_add",
        objectType: "FUNCTION",
      },
    }),
  ]);

  assert.deepEqual(saved[0]?.objectSource, {
    schema: "public",
    name: "fn_add",
    objectType: "FUNCTION",
  });
});

test("restores unsaved query tabs and active tab after restart", () => {
  const raw = JSON.stringify([
    queryTab({ id: "tab-1", sql: "select 1" }),
    queryTab({ id: "tab-2", title: "Query 2", sql: "select 2" }),
  ]);

  const restored = restoreOpenTabsState(raw, "tab-2");

  assert.deepEqual(
    restored.tabs.map((tab) => ({ id: tab.id, sql: tab.sql, isExecuting: tab.isExecuting })),
    [
      { id: "tab-1", sql: "select 1", isExecuting: false },
      { id: "tab-2", sql: "select 2", isExecuting: false },
    ],
  );
  assert.equal(restored.activeTabId, "tab-2");
});

test("restores object source save context", () => {
  const raw = JSON.stringify([
    queryTab({
      objectSource: {
        schema: "public",
        name: "fn_add",
        objectType: "FUNCTION",
      },
    }),
  ]);

  const restored = restoreOpenTabsState(raw, "tab-1");

  assert.deepEqual(restored.tabs[0]?.objectSource, {
    schema: "public",
    name: "fn_add",
    objectType: "FUNCTION",
  });
});

test("desktop restore keeps legacy query tabs without a mode", () => {
  const raw = JSON.stringify([
    {
      id: "legacy",
      title: "Query 1",
      connectionId: "conn-1",
      database: "app",
      sql: "select now()",
    },
    queryTab({ id: "data", title: "users", mode: "data" }),
  ]);

  const restored = restoreOpenTabsState(raw, "data", { queryOnly: true });

  assert.deepEqual(
    restored.tabs.map((tab) => ({ id: tab.id, mode: tab.mode })),
    [{ id: "legacy", mode: "query" }],
  );
  assert.equal(restored.activeTabId, "legacy");
});

test("ignores invalid persisted tab payloads", () => {
  const restored = restoreOpenTabsState(JSON.stringify([{ id: "missing-fields" }, queryTab()]), "missing-fields");

  assert.deepEqual(
    restored.tabs.map((tab) => tab.id),
    ["tab-1"],
  );
  assert.equal(restored.activeTabId, "tab-1");
});
