import { strict as assert } from "node:assert";
import test from "node:test";
import { buildRenameObjectSql, supportsObjectRename } from "../../src/lib/objectRenameSql.ts";

test("builds MySQL table and view rename statements", () => {
  assert.equal(
    buildRenameObjectSql({
      databaseType: "mysql",
      objectType: "TABLE",
      oldName: "users",
      newName: "app users",
    }),
    "RENAME TABLE `users` TO `app users`;",
  );
  assert.equal(
    buildRenameObjectSql({
      databaseType: "goldendb",
      objectType: "VIEW",
      oldName: "active_users",
      newName: "enabled_users",
    }),
    "RENAME TABLE `active_users` TO `enabled_users`;",
  );
});

test("builds PostgreSQL table and view rename statements", () => {
  assert.equal(
    buildRenameObjectSql({
      databaseType: "postgres",
      objectType: "TABLE",
      schema: "public",
      oldName: "orders",
      newName: "archived orders",
    }),
    'ALTER TABLE "public"."orders" RENAME TO "archived orders";',
  );
  assert.equal(
    buildRenameObjectSql({
      databaseType: "postgres",
      objectType: "VIEW",
      schema: "public",
      oldName: "active_users",
      newName: "enabled_users",
    }),
    'ALTER VIEW "public"."active_users" RENAME TO "enabled_users";',
  );
});

test("builds SQL Server rename statements for all object kinds", () => {
  assert.equal(
    buildRenameObjectSql({
      databaseType: "sqlserver",
      objectType: "FUNCTION",
      schema: "dbo",
      oldName: "fn_total",
      newName: "fn_order_total",
    }),
    "EXEC sp_rename N'dbo.fn_total', N'fn_order_total', N'OBJECT';",
  );
  assert.equal(supportsObjectRename("sqlserver", "PROCEDURE"), true);
});

test("builds Oracle-family table and view rename statements", () => {
  assert.equal(
    buildRenameObjectSql({
      databaseType: "oracle",
      objectType: "TABLE",
      schema: "HR",
      oldName: "EMPLOYEES",
      newName: "STAFF",
    }),
    'ALTER TABLE "HR"."EMPLOYEES" RENAME TO "STAFF";',
  );
  assert.equal(
    buildRenameObjectSql({
      databaseType: "dameng",
      objectType: "VIEW",
      schema: "SYSDBA",
      oldName: "ACTIVE_USERS",
      newName: "ENABLED_USERS",
    }),
    'ALTER VIEW "SYSDBA"."ACTIVE_USERS" RENAME TO "ENABLED_USERS";',
  );
});

test("reports unsupported routine rename cases", () => {
  assert.equal(supportsObjectRename("mysql", "PROCEDURE"), false);
  assert.equal(supportsObjectRename("postgres", "FUNCTION"), false);
  assert.throws(
    () =>
      buildRenameObjectSql({
        databaseType: "mysql",
        objectType: "PROCEDURE",
        oldName: "refresh_cache",
        newName: "refresh_cache_v2",
      }),
    /Renaming PROCEDURE is not supported/,
  );
});
