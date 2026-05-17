import { strict as assert } from "node:assert";
import test from "node:test";
import {
  buildExplainSql,
  flattenExplainPlanNodes,
  parseExplainResult,
  supportsExplainPlan,
} from "../../src/lib/explainPlan.ts";

test("builds PostgreSQL JSON explain SQL from a selected query", () => {
  const result = buildExplainSql("postgres", " select * from users where id = 1; ");

  assert.deepEqual(result, {
    ok: true,
    sql: "EXPLAIN (FORMAT JSON) select * from users where id = 1",
  });
});

test("builds MySQL JSON explain SQL and rejects unsafe statement kinds", () => {
  assert.deepEqual(buildExplainSql("mysql", "SELECT * FROM users;"), {
    ok: true,
    sql: "EXPLAIN FORMAT=JSON SELECT * FROM users",
  });

  assert.equal(buildExplainSql("mysql", "delete from users").ok, false);
});

test("reports explain support by database type", () => {
  assert.equal(supportsExplainPlan("postgres"), true);
  assert.equal(supportsExplainPlan("mysql"), true);
  assert.equal(supportsExplainPlan("sqlite"), false);
});

test("parses PostgreSQL FORMAT JSON output into plan nodes", () => {
  const plan = parseExplainResult("postgres", {
    columns: ["QUERY PLAN"],
    rows: [[[
      {
        Plan: {
          "Node Type": "Nested Loop",
          "Startup Cost": 0.42,
          "Total Cost": 42.9,
          "Plan Rows": 12,
          Plans: [
            {
              "Node Type": "Index Scan",
              "Relation Name": "users",
              "Index Name": "users_pkey",
              "Startup Cost": 0.28,
              "Total Cost": 8.3,
              "Plan Rows": 1,
            },
            {
              "Node Type": "Seq Scan",
              "Relation Name": "orders",
              "Filter": "(user_id = users.id)",
              "Total Cost": 31.2,
              "Plan Rows": 20,
            },
          ],
        },
      },
    ]]],
    affected_rows: 0,
    execution_time_ms: 3,
  });

  assert.equal(plan.nodes[0].title, "Nested Loop");
  assert.equal(plan.nodes[0].cost, "0.42..42.9");
  assert.equal(plan.nodes[0].rows, "12");
  assert.equal(plan.nodes[0].children[0].relation, "users");
  assert.equal(plan.nodes[0].children[0].index, "users_pkey");
  assert.equal(flattenExplainPlanNodes(plan.nodes).map((node) => node.nodeType).join(","), "Nested Loop,Index Scan,Seq Scan");
});

test("parses MySQL FORMAT=JSON output into plan nodes", () => {
  const plan = parseExplainResult("mysql", {
    columns: ["EXPLAIN"],
    rows: [[JSON.stringify({
      query_block: {
        select_id: 1,
        nested_loop: [
          {
            table: {
              table_name: "users",
              access_type: "ref",
              key: "idx_users_email",
              rows_examined_per_scan: 3,
              cost_info: { query_cost: "1.20" },
              attached_condition: "users.email is not null",
            },
          },
          {
            table: {
              table_name: "orders",
              access_type: "ALL",
              rows_examined_per_scan: 200,
              cost_info: { read_cost: "18.00" },
            },
          },
        ],
      },
    })]],
    affected_rows: 0,
    execution_time_ms: 2,
  });

  const flat = flattenExplainPlanNodes(plan.nodes);
  assert.equal(flat[0].nodeType, "query_block");
  assert.equal(flat[1].title, "ref on users");
  assert.equal(flat[1].index, "idx_users_email");
  assert.equal(flat[1].cost, "1.20");
  assert.equal(flat[2].rows, "200");
});
