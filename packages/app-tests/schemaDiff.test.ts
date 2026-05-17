import { strict as assert } from "node:assert";
import test from "node:test";
import { diffForeignKeys, diffIndexes, generateSyncSql, type TableDiff } from "../../src/lib/schemaDiff.ts";
import type { ForeignKeyInfo, IndexInfo } from "../../src/types/database.ts";

function index(overrides: Partial<IndexInfo>): IndexInfo {
  return {
    name: "idx_users_email",
    columns: ["email"],
    is_unique: false,
    is_primary: false,
    ...overrides,
  };
}

function foreignKey(overrides: Partial<ForeignKeyInfo>): ForeignKeyInfo {
  return {
    name: "orders_user_id_fk",
    column: "user_id",
    ref_table: "users",
    ref_column: "id",
    ...overrides,
  };
}

test("detects modified indexes, not only added or removed indexes", () => {
  const diffs = diffIndexes(
    [index({ name: "idx_orders_status", columns: ["status", "created_at"], is_unique: false })],
    [index({ name: "idx_orders_status", columns: ["status"], is_unique: true })],
  );

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, "modified");
  assert.deepEqual(diffs[0].changes, ["unique: YES → NO", "columns: status → status, created_at"]);
});

test("detects foreign key additions, removals, and target changes", () => {
  const diffs = diffForeignKeys(
    [
      foreignKey({ name: "orders_user_id_fk" }),
      foreignKey({ name: "orders_account_id_fk", column: "account_id", ref_table: "accounts" }),
    ],
    [
      foreignKey({ name: "orders_user_id_fk", ref_table: "members" }),
      foreignKey({ name: "orders_region_id_fk", column: "region_id", ref_table: "regions" }),
    ],
  );

  assert.deepEqual(
    diffs.map((diff) => [diff.type, diff.name]),
    [
      ["modified", "orders_user_id_fk"],
      ["added", "orders_account_id_fk"],
      ["removed", "orders_region_id_fk"],
    ],
  );
});

test("generates sync SQL for index and foreign key changes", () => {
  const diffs: TableDiff[] = [
    {
      type: "modified",
      name: "orders",
      indexes: [
        {
          type: "modified",
          name: "idx_orders_status",
          source: index({ name: "idx_orders_status", columns: ["status", "created_at"], is_unique: true }),
        },
      ],
      foreignKeys: [
        {
          type: "modified",
          name: "orders_user_id_fk",
          source: foreignKey({ name: "orders_user_id_fk", ref_table: "users" }),
        },
      ],
    },
  ];

  assert.equal(
    generateSyncSql(diffs, "postgres"),
    [
      'ALTER TABLE "orders" DROP CONSTRAINT "orders_user_id_fk";',
      'DROP INDEX IF EXISTS "idx_orders_status";',
      'CREATE UNIQUE INDEX "idx_orders_status" ON "orders" ("status", "created_at");',
      'ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id");',
    ].join("\n"),
  );
});

test("qualifies generated schema sync SQL with target schema", () => {
  const diffs: TableDiff[] = [
    {
      type: "modified",
      name: "orders",
      columns: [
        {
          type: "added",
          name: "status",
          source: {
            name: "status",
            data_type: "text",
            is_nullable: true,
            column_default: null,
            is_primary_key: false,
            extra: null,
          },
        },
      ],
      indexes: [
        { type: "added", name: "idx_orders_status", source: index({ name: "idx_orders_status", columns: ["status"] }) },
      ],
    },
  ];

  assert.equal(
    generateSyncSql(diffs, "postgres", "sales"),
    [
      "-- Alter table: orders",
      'ALTER TABLE "sales"."orders"  ADD COLUMN "status" text;',
      "",
      'CREATE INDEX "idx_orders_status" ON "sales"."orders" ("status");',
    ].join("\n"),
  );
});
