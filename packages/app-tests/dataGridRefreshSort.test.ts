import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";

const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

test("toolbar refresh preserves header sort order", () => {
  const match = source.match(/async function onToolbarRefresh\(\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "DataGrid should define onToolbarRefresh");
  assert.match(match[1], /currentOrderBy\(\)/);
  assert.doesNotMatch(match[1], /orderByInput\.value\.trim\(\) \|\| undefined/);
});

test("header sort starts from first page and top row", () => {
  const match = source.match(/function toggleSort\(colName: string, colIdx: number\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "DataGrid should define toggleSort");
  assert.match(match[1], /currentPage\.value = 1/);
  assert.match(match[1], /resetGridVerticalScroll\(true\)/);
  assert.match(match[1], /syncOrderByInputWithSort\(colName, "asc"\)/);
  assert.match(match[1], /syncOrderByInputWithSort\(colName, "desc"\)/);
});

test("header sort mirrors the active sort into ORDER BY input", () => {
  assert.match(
    source,
    /function syncOrderByInputWithSort\(column: string \| null, direction: "asc" \| "desc" \| null\)/,
  );
  assert.match(
    source,
    /orderByInput\.value = column && direction \? `\$\{queryColumnRef\(column\)\} \$\{direction\.toUpperCase\(\)\}` : ""/,
  );
});

test("visible row numbers use display index after sorting", () => {
  assert.match(source, /displayIndex: number/);
  assert.match(source, /\.map\(\(item, displayIndex\) => \(\{ \.\.\.item, displayIndex \}\)\)/);
  assert.match(source, /<template #default="\{ item \}">/);
  assert.match(source, /\{\{ item\.displayIndex \+ 1 \}\}/);
});

test("rollback refresh preserves header sort order", () => {
  const match = source.match(/function onToolbarRollback\(\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "DataGrid should define onToolbarRollback");
  assert.match(match[1], /currentOrderBy\(\)/);
  assert.doesNotMatch(match[1], /orderByInput\.value\.trim\(\) \|\| undefined/);
});

test("data result refresh preserves local column filters", () => {
  assert.doesNotMatch(source, /watch\(\s*\(\)\s*=>\s*props\.result,[\s\S]*?localColumnFilters\.value\s*=\s*\{\}/);
  assert.match(source, /localFilterScopeKey/);
});
