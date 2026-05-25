import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  combineWhereInputs,
  filterModeNeedsValue,
  parseFilterValue,
} from "../../apps/desktop/src/lib/dataGridColumnFilter.ts";

test("combines manual and structured where inputs", () => {
  assert.equal(combineWhereInputs("status = 1", undefined), "status = 1");
  assert.equal(combineWhereInputs(undefined, "parent_id = 2"), "parent_id = 2");
  assert.equal(combineWhereInputs("status = 1", "parent_id = 2"), "(status = 1) AND (parent_id = 2)");
  assert.equal(combineWhereInputs(" where status = 1; ", " where parent_id = 2; "), "(status = 1) AND (parent_id = 2)");
});

test("filter builder knows which modes require a value", () => {
  assert.equal(filterModeNeedsValue("equals"), true);
  assert.equal(filterModeNeedsValue("like"), true);
  assert.equal(filterModeNeedsValue("is-null"), false);
  assert.equal(filterModeNeedsValue("is-not-null"), false);
});

test("parses typed filter values for numeric and boolean columns", () => {
  assert.equal(parseFilterValue("42", { data_type: "INT" }), 42);
  assert.equal(parseFilterValue("true", { data_type: "BOOLEAN" }), true);
  assert.equal(parseFilterValue("'abc'", { data_type: "VARCHAR" }), "abc");
  assert.equal(parseFilterValue("00123", { data_type: "VARCHAR" }), "00123");
});

test("data grid exposes the visual filter builder UI", () => {
  const source = readFileSync("apps/desktop/src/components/grid/DataGrid.vue", "utf8");

  assert.match(source, /filterBuilderOpen/);
  assert.match(source, /structuredFilterRules/);
  assert.match(source, /applyStructuredFilters/);
  assert.match(source, /class="w-\[380px\] max-w-\[calc\(100vw-24px\)\] gap-3 p-3"/);
  assert.match(source, /combineWhereInputs\(whereFilterInput\.value, appliedStructuredWhereInput\.value\)/);
});
