import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildSqlCompletionItems,
  getSqlFunctionSignatureHelp,
  shouldAutoOpenSqlCompletion,
  type SqlCompletionColumn,
  type SqlCompletionTable,
} from "../../src/lib/sqlCompletion.ts";

const tables: SqlCompletionTable[] = [
  { name: "users", schema: "public", type: "table" },
  { name: "user_profiles", schema: "public", type: "table" },
  { name: "orders", schema: "public", type: "table" },
];

const columnsByTable = new Map<string, SqlCompletionColumn[]>([
  [
    "public.users",
    [
      { name: "id", table: "users", schema: "public", dataType: "bigint" },
      { name: "name", table: "users", schema: "public", dataType: "varchar" },
      { name: "email", table: "users", schema: "public", dataType: "varchar" },
    ],
  ],
  [
    "public.orders",
    [
      { name: "id", table: "orders", schema: "public", dataType: "bigint" },
      { name: "user_id", table: "orders", schema: "public", dataType: "bigint" },
      { name: "status", table: "orders", schema: "public", dataType: "varchar" },
    ],
  ],
]);

test("suggests SQL keywords for generic keyword input", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "SELECT");
  assert.equal(items[0]?.type, "keyword");
});

test("suggests matching table names after FROM", () => {
  const sql = "select * from us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.slice(0, 2).map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("ranks prefix matches above substring matches for table names", () => {
  const sql = "select * from user";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.filter((item) => item.type === "table").map((item) => item.label),
    ["users", "user_profiles"],
  );
});

test("suggests columns for an explicit alias qualifier", () => {
  const sql = "select u. from public.users u";
  const cursor = "select u.".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const columnItems = items.filter((item) => item.type === "column");
  assert.deepEqual(
    columnItems.map((item) => item.label),
    ["id", "name", "email"],
  );
});

test("suggests columns from referenced tables in select list", () => {
  const sql = "select na from public.users u join public.orders o on u.id = o.user_id";
  const cursor = "select na".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "name");
  assert.equal(items[0]?.type, "column");
});

test("suggests tables after LEFT JOIN", () => {
  const sql = "select * from users left join us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.label === "users" && item.type === "table"));
  assert.ok(items.some((item) => item.label === "user_profiles" && item.type === "table"));
});

test("suggests tables after comma in FROM clause", () => {
  const sql = "select * from users, or";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.label === "orders" && item.type === "table"));
});

test("suggests keywords when typing without context", () => {
  const sql = "us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "USING"));
});

test("always includes keywords alongside table suggestions", () => {
  const sql = "select * from us";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "table"));
  assert.ok(items.some((item) => item.type === "keyword" && item.label === "USING"));
});

test("suggests SQL Server IF keyword for conditional DDL", () => {
  const sql = "DROP TABLE I";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "IF"));
});

test("suggests SQL Server IIF and CHOOSE scalar functions", () => {
  const iifItems = buildSqlCompletionItems("SELECT II", "SELECT II".length, {
    tables,
    columnsByTable,
  });
  const chooseItems = buildSqlCompletionItems("SELECT CHO", "SELECT CHO".length, {
    tables,
    columnsByTable,
  });

  assert.ok(iifItems.some((item) => item.type === "keyword" && item.label === "IIF"));
  assert.ok(chooseItems.some((item) => item.type === "keyword" && item.label === "CHOOSE"));
});

test("suggests SQL Server data types in CREATE TABLE column definitions", () => {
  const sql = "CREATE TABLE dbo.jobs (id ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.ok(items.some((item) => item.type === "keyword" && item.label === "INT"));
  assert.ok(items.some((item) => item.type === "keyword" && item.label === "BIGINT"));
  assert.ok(items.some((item) => item.type === "keyword" && item.label === "NVARCHAR"));
});

test("does not auto-open completion after structural punctuation", () => {
  for (const sql of ["select count(*)", "select * from users;", "select * from users,"]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), false, sql);
  }
});

test("auto-opens completion after word characters and explicit dot qualifiers", () => {
  for (const sql of ["sel", "select * from us", "select u."]) {
    assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true, sql);
  }
});

test("auto-opens completion after ON whitespace for join conditions", () => {
  const sql = "select * from public.users u join public.orders o on ";

  assert.equal(shouldAutoOpenSqlCompletion(sql, sql.length), true);
});

test("limits table suggestions for large schemas after filtering by prefix", () => {
  const largeTables: SqlCompletionTable[] = Array.from({ length: 500 }, (_, index) => ({
    name: `erp_invoice_${String(index).padStart(4, "0")}`,
    schema: "dbo",
    type: "table",
  }));

  const sql = "select * from erp_invoice_";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables: largeTables,
    columnsByTable,
  });

  const tableItems = items.filter((item) => item.type === "table");
  assert.equal(tableItems.length, 200);
  assert.equal(tableItems[0]?.label, "erp_invoice_0000");
  assert.equal(tableItems.at(-1)?.label, "erp_invoice_0199");
});

test("suggests SQL snippets for common abbreviations", () => {
  const items = buildSqlCompletionItems("sel", 3, {
    tables,
    columnsByTable,
  });

  const snippet = items.find((item) => item.type === "snippet" && item.label === "select *");
  assert.ok(snippet);
  assert.equal(snippet.apply, "SELECT *\nFROM ${table}\nLIMIT 100;");
});

test("suggests DATE_FORMAT as parameter snippet", () => {
  const sql = "select date_";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const snippet = items.find((item) => item.type === "snippet" && item.label === "DATE_FORMAT");
  assert.ok(snippet);
  assert.equal(snippet.detail, "function");
  assert.equal(snippet.apply, "DATE_FORMAT(${date}, ${format})");
});

test("matches alias qualifier case-insensitively", () => {
  const sql = "select O. from public.orders o";
  const cursor = "select O.".length;
  const items = buildSqlCompletionItems(sql, cursor, {
    tables,
    columnsByTable,
  });

  const columnItems = items.filter((item) => item.type === "column");
  assert.deepEqual(
    columnItems.map((item) => item.label),
    ["id", "user_id", "status"],
  );
});

test("suggests referenced columns after ORDER BY", () => {
  const sql = "select name from public.users u order by na";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "name");
  assert.equal(items[0]?.type, "column");
});

test("prioritizes select aliases in ORDER BY completion", () => {
  const sql = "select u.name as display_name, count(*) order_count from public.users u order by ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.deepEqual(
    items.slice(0, 2).map((item) => [item.label, item.detail]),
    [
      ["display_name", "SELECT alias"],
      ["order_count", "SELECT alias"],
    ],
  );
});

test("prioritizes select aliases in GROUP BY completion", () => {
  const sql = "select u.name as display_name from public.users u group by ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  assert.equal(items[0]?.label, "display_name");
  assert.equal(items[0]?.detail, "SELECT alias");
});

test("suggests likely join condition snippets after ON", () => {
  const sql = "select * from public.users u join public.orders o on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const joinCondition = items.find((item) => item.type === "snippet" && item.label === "u.id = o.user_id");
  assert.ok(joinCondition);
  assert.equal(joinCondition.apply, "u.id = o.user_id");
});

test("suggests likely join condition snippets when joined table owns the id column", () => {
  const sql = "select * from public.orders o join public.users u on ";
  const items = buildSqlCompletionItems(sql, sql.length, {
    tables,
    columnsByTable,
  });

  const joinCondition = items.find((item) => item.type === "snippet" && item.label === "o.user_id = u.id");
  assert.ok(joinCondition);
  assert.equal(joinCondition.apply, "o.user_id = u.id");
});

test("returns function signature help inside function arguments", () => {
  const sql = "select date_format(created_at, ";
  const signature = getSqlFunctionSignatureHelp(sql, sql.length);

  assert.deepEqual(signature, {
    name: "DATE_FORMAT",
    signature: "DATE_FORMAT(date, format)",
    activeParameter: 1,
    parameters: ["date", "format"],
  });
});

test("returns null signature help outside function calls", () => {
  assert.equal(getSqlFunctionSignatureHelp("select created_at from users", "select created_at".length), null);
});
