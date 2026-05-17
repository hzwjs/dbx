import { strict as assert } from "node:assert";
import test from "node:test";
import { DBX_ROWID_COLUMN } from "../../src/lib/tableEditing.ts";
import { buildTableSelectSql } from "../../src/lib/tableSelectSql.ts";

test("builds a MySQL table WHERE query from search input", () => {
  const sql = buildTableSelectSql({
    databaseType: "mysql",
    tableName: "users",
    primaryKeys: ["id"],
    whereInput: "where status = 'active'",
    limit: 100,
  });

  assert.equal(sql, "SELECT * FROM `users` WHERE (status = 'active') ORDER BY `id` ASC LIMIT 100;");
});

test("builds a schema-qualified PostgreSQL table WHERE query", () => {
  const sql = buildTableSelectSql({
    databaseType: "postgres",
    schema: "public",
    tableName: "orders",
    whereInput: "WHERE amount > 10",
    limit: 50,
    offset: 100,
  });

  assert.equal(sql, 'SELECT * FROM "public"."orders" WHERE (amount > 10) LIMIT 50 OFFSET 100;');
});

test("builds schema-qualified Trino table data queries", () => {
  const sql = buildTableSelectSql({
    databaseType: "trino",
    schema: "tiny",
    tableName: "nation",
    limit: 100,
  });

  assert.equal(sql, 'SELECT * FROM "tiny"."nation" LIMIT 100;');
});

test("builds Hive table data queries with backtick identifiers", () => {
  const sql = buildTableSelectSql({
    databaseType: "hive",
    tableName: "departments",
    primaryKeys: ["dept id"],
    limit: 100,
  });

  assert.equal(sql, "SELECT * FROM `departments` ORDER BY `dept id` ASC LIMIT 100;");
});

test("builds TDengine table data queries with backtick identifiers", () => {
  const sql = buildTableSelectSql({
    databaseType: "tdengine",
    schema: "test_db",
    tableName: "meters",
    columns: ["ts", "current", "voltage", "location", "groupid"],
    primaryKeys: ["ts"],
    limit: 100,
  });

  assert.equal(
    sql,
    "SELECT tbname, `ts` AS `ts`, `current` AS `current`, `voltage` AS `voltage`, `location` AS `location`, `groupid` AS `groupid` FROM `test_db`.`meters` ORDER BY `ts` ASC LIMIT 100;",
  );
});

test("builds Informix table data queries without database-qualified delimited identifiers", () => {
  const sql = buildTableSelectSql({
    databaseType: "informix",
    schema: "testdb",
    tableName: "dbx_grid_edit_probe",
    primaryKeys: ["id"],
    limit: 100,
  });

  assert.equal(sql, "SELECT * FROM dbx_grid_edit_probe ORDER BY id ASC LIMIT 100;");
});

test("builds Access table data queries with backtick identifiers", () => {
  const sql = buildTableSelectSql({
    databaseType: "access",
    tableName: "Order Details",
    primaryKeys: ["Order ID"],
    limit: 100,
    offset: 200,
  });

  assert.equal(sql, "SELECT * FROM `Order Details` ORDER BY `Order ID` ASC LIMIT 100 OFFSET 200;");
});

test("expands Hive table data queries into aliased table columns", () => {
  const sql = buildTableSelectSql({
    databaseType: "hive",
    tableName: "departments",
    columns: ["id", "name"],
    limit: 100,
  });

  assert.equal(sql, "SELECT `id` AS `id`, `name` AS `name` FROM `departments` LIMIT 100;");
});

test("builds SQL Server first page query with schema-aware brackets", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "accounts",
    whereInput: "where id = 1",
    limit: 25,
    primaryKeys: ["id"],
  });

  assert.equal(
    sql,
    "SELECT * FROM [dbo].[accounts] WHERE (id = 1) ORDER BY [id] ASC OFFSET 0 ROWS FETCH NEXT 25 ROWS ONLY",
  );
});

test("builds SQL Server later pages with OFFSET and FETCH", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "sales",
    tableName: "orders",
    primaryKeys: ["order_id"],
    limit: 50,
    offset: 100,
  });

  assert.equal(sql, "SELECT * FROM [sales].[orders] ORDER BY [order_id] ASC OFFSET 100 ROWS FETCH NEXT 50 ROWS ONLY");
});

test("builds SQL Server pages with fallback order columns when there is no primary key", () => {
  const sql = buildTableSelectSql({
    databaseType: "sqlserver",
    schema: "dbo",
    tableName: "logs",
    fallbackOrderColumns: ["created_at"],
    limit: 50,
    offset: 50,
  });

  assert.equal(sql, "SELECT * FROM [dbo].[logs] ORDER BY [created_at] ASC OFFSET 50 ROWS FETCH NEXT 50 ROWS ONLY");
});

test("builds Oracle table data queries with ROWID for keyless editing", () => {
  const sql = buildTableSelectSql({
    databaseType: "oracle",
    schema: "DBXTEST",
    tableName: "DBX_LOAD_TABLE_006",
    primaryKeys: [DBX_ROWID_COLUMN],
    includeRowId: true,
    limit: 100,
  });

  assert.equal(
    sql,
    `SELECT ROWIDTOCHAR(t.ROWID) AS "__DBX_ROWID", t.* FROM "DBXTEST"."DBX_LOAD_TABLE_006" t ORDER BY t.ROWID ASC FETCH FIRST 100 ROWS ONLY`,
  );
});

test("builds Neo4j table data queries as Cypher label matches", () => {
  const sql = buildTableSelectSql({
    databaseType: "neo4j",
    tableName: "Employee",
    primaryKeys: ["id"],
    limit: 100,
    offset: 200,
  });

  assert.equal(
    sql,
    "MATCH (n:`Employee`) RETURN elementId(n) AS `__DBX_ELEMENT_ID`, n ORDER BY n.`id` ASC SKIP 200 LIMIT 100;",
  );
});

test("expands Neo4j table data queries into node property columns", () => {
  const sql = buildTableSelectSql({
    databaseType: "neo4j",
    tableName: "Employee",
    columns: ["id", "first name", "role"],
    primaryKeys: ["id"],
    limit: 100,
  });

  assert.equal(
    sql,
    "MATCH (n:`Employee`) RETURN elementId(n) AS `__DBX_ELEMENT_ID`, n.`id` AS `id`, n.`first name` AS `first name`, n.`role` AS `role` ORDER BY n.`id` ASC LIMIT 100;",
  );
});
