import { strict as assert } from "node:assert";
import test from "node:test";
import {
  filterVisibleDatabaseNames,
  normalizeVisibleDatabaseSelection,
  visibleDatabaseFilterIsEnabled,
} from "../../src/lib/visibleDatabases.ts";

test("undefined visible database filter keeps every database", () => {
  assert.deepEqual(filterVisibleDatabaseNames(["app", "analytics"], undefined), ["app", "analytics"]);
  assert.equal(visibleDatabaseFilterIsEnabled(undefined), false);
});

test("configured visible database filter keeps selected databases in source order", () => {
  assert.deepEqual(filterVisibleDatabaseNames(["app", "analytics", "billing"], ["billing", "app"]), [
    "app",
    "billing",
  ]);
  assert.equal(visibleDatabaseFilterIsEnabled(["billing", "app"]), true);
});

test("empty configured visible database filter hides every database", () => {
  assert.deepEqual(filterVisibleDatabaseNames(["app", "analytics"], []), []);
  assert.equal(visibleDatabaseFilterIsEnabled([]), true);
});

test("normalizes selected database names against fresh database names", () => {
  assert.deepEqual(normalizeVisibleDatabaseSelection(["billing", "missing", "app", "app"], ["app", "billing"]), [
    "billing",
    "app",
  ]);
});
