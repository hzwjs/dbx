import { strict as assert } from "node:assert";
import test from "node:test";
import { buildExecutableObjectSourceSql, objectSourceSaveExecutionMode } from "../../src/lib/objectSourceEditor.ts";

test("SQL Server edited source saves as ALTER", () => {
  const sql = buildExecutableObjectSourceSql({
    databaseType: "sqlserver",
    objectType: "PROCEDURE",
    schema: "dbo",
    name: "usp_demo",
    source: "CREATE PROCEDURE dbo.usp_demo AS SELECT 1;",
  });

  assert.equal(sql, "ALTER PROCEDURE dbo.usp_demo AS SELECT 1;");
});

test("SQL Server edited CREATE OR ALTER source saves as ALTER", () => {
  const sql = buildExecutableObjectSourceSql({
    databaseType: "sqlserver",
    objectType: "VIEW",
    schema: "dbo",
    name: "vw_demo",
    source: "CREATE OR ALTER VIEW dbo.vw_demo AS SELECT 1 AS id;",
  });

  assert.equal(sql, "ALTER VIEW dbo.vw_demo AS SELECT 1 AS id;");
});

test("SQL Server object source saves as a single batch", () => {
  assert.equal(objectSourceSaveExecutionMode("sqlserver"), "single");
});

test("Kingbase object source saves as a single statement", () => {
  assert.equal(objectSourceSaveExecutionMode("kingbase"), "single");
});

test("Postgres-family object source saves as a single statement", () => {
  assert.equal(objectSourceSaveExecutionMode("postgres"), "single");
  assert.equal(objectSourceSaveExecutionMode("gaussdb"), "single");
});

test("MySQL object source saves as a single statement", () => {
  assert.equal(objectSourceSaveExecutionMode("mysql"), "single");
});

test("Postgres view body opens as CREATE OR REPLACE VIEW", () => {
  const sql = buildExecutableObjectSourceSql({
    databaseType: "postgres",
    objectType: "VIEW",
    schema: "public",
    name: "active users",
    source: " SELECT id, name FROM users WHERE active ",
  });

  assert.equal(sql, 'CREATE OR REPLACE VIEW "public"."active users" AS\nSELECT id, name FROM users WHERE active;');
});
