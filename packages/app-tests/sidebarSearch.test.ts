import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchSidebarLabel } from "../../src/lib/sidebarSearch.ts";

test("matches exact and prefix labels first", () => {
  assert.equal(matchSidebarLabel("orders", "orders")?.kind, "exact");
  assert.equal(matchSidebarLabel("orders_archive", "ord")?.kind, "prefix");
});

test("matches word prefixes in underscored and dotted identifiers", () => {
  assert.equal(matchSidebarLabel("user_orders", "ord")?.kind, "word-prefix");
  assert.equal(matchSidebarLabel("sales.customer_profile", "cust")?.kind, "word-prefix");
});

test("matches DataGrip-style abbreviations by identifier word boundaries", () => {
  assert.equal(matchSidebarLabel("additional_country", "ac")?.kind, "abbreviation");
  assert.equal(matchSidebarLabel("sales.customer_profile", "scp")?.kind, "abbreviation");
});

test("keeps one-character fuzzy matches disabled", () => {
  assert.equal(matchSidebarLabel("orders", "r")?.kind, "substring");
  assert.equal(matchSidebarLabel("orders", "x"), null);
});
