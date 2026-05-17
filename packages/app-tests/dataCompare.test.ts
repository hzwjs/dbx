import { strict as assert } from "node:assert";
import test from "node:test";
import { compareDataRows, generateDataSyncSql } from "../../src/lib/dataCompare.ts";

test("compares rows by primary key and reports added, removed, and modified rows", () => {
  const diff = compareDataRows({
    columns: ["id", "name", "active"],
    keyColumns: ["id"],
    sourceRows: [
      [1, "Ada", true],
      [2, "Bob", false],
      [4, "Dora", true],
    ],
    targetRows: [
      [1, "Ada", true],
      [2, "Bobby", false],
      [3, "Cara", true],
    ],
  });

  assert.deepEqual(
    diff.added.map((row) => row.keyValues),
    [{ id: 4 }],
  );
  assert.deepEqual(
    diff.removed.map((row) => row.keyValues),
    [{ id: 3 }],
  );
  assert.deepEqual(
    diff.modified.map((row) => row.changes),
    [[{ column: "name", source: "Bob", target: "Bobby" }]],
  );
});

test("generates data synchronization SQL", () => {
  const diff = compareDataRows({
    columns: ["id", "name", "active"],
    keyColumns: ["id"],
    sourceRows: [
      [1, "Ada", true],
      [2, "Bob", false],
    ],
    targetRows: [
      [1, "Ada Lovelace", true],
      [3, "Cara", true],
    ],
  });

  assert.equal(
    generateDataSyncSql({
      tableName: "users",
      schema: "public",
      columns: ["id", "name", "active"],
      keyColumns: ["id"],
      diff,
      databaseType: "postgres",
    }),
    [
      `INSERT INTO "public"."users" ("id", "name", "active") VALUES (2, 'Bob', FALSE);`,
      `UPDATE "public"."users" SET "name" = 'Ada' WHERE "id" = 1;`,
      `DELETE FROM "public"."users" WHERE "id" = 3;`,
    ].join("\n"),
  );
});

test("requires at least one key column", () => {
  assert.throws(
    () => compareDataRows({ columns: ["id"], keyColumns: [], sourceRows: [[1]], targetRows: [[1]] }),
    /At least one key column/,
  );
});

test("rejects duplicate row keys", () => {
  assert.throws(
    () =>
      compareDataRows({
        columns: ["id", "name"],
        keyColumns: ["id"],
        sourceRows: [
          [1, "Ada"],
          [1, "Ada Clone"],
        ],
        targetRows: [[1, "Ada"]],
      }),
    /Duplicate source key/,
  );
});
