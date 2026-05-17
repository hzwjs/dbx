import assert from "node:assert/strict";
import test from "node:test";
import { buildCreateDatabaseSql, supportsCreateDatabaseCharset } from "../../src/lib/createDatabaseSql.ts";

test("builds MySQL create database SQL with charset and collation", () => {
  assert.equal(
    buildCreateDatabaseSql({
      databaseType: "mysql",
      driverProfile: "mysql",
      name: "app db",
      charset: "utf8mb4",
      collation: "utf8mb4_unicode_ci",
    }),
    "CREATE DATABASE `app db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;",
  );
});

test("omits charset clauses for non-MySQL database types", () => {
  assert.equal(
    buildCreateDatabaseSql({
      databaseType: "postgres",
      name: "analytics",
      charset: "utf8mb4",
      collation: "utf8mb4_unicode_ci",
    }),
    'CREATE DATABASE "analytics";',
  );
});

test("recognizes MySQL-compatible driver profiles", () => {
  assert.equal(supportsCreateDatabaseCharset("mysql", "oceanbase"), true);
  assert.equal(supportsCreateDatabaseCharset("mysql", "doris"), true);
  assert.equal(supportsCreateDatabaseCharset("postgres", undefined), false);
});
