import { strict as assert } from "node:assert";
import test from "node:test";
import { mongoDocumentsToQueryResult, parseMongoFindCommand } from "../../src/lib/mongoShellCommand.ts";

test("parseMongoFindCommand parses db collection find with an empty JSON filter", () => {
  assert.deepEqual(parseMongoFindCommand("db.users.find({})"), {
    collection: "users",
    filter: "{}",
    skip: 0,
    limit: 100,
    sort: undefined,
  });
});

test("parseMongoFindCommand parses getCollection find with chained sort skip and limit", () => {
  assert.deepEqual(
    parseMongoFindCommand(
      'db.getCollection("audit.logs").find({"level":"warn"}).sort({"createdAt":-1}).skip(20).limit(10)',
    ),
    {
      collection: "audit.logs",
      filter: '{"level":"warn"}',
      skip: 20,
      limit: 10,
      sort: '{"createdAt":-1}',
    },
  );
});

test("parseMongoFindCommand rejects unsupported mongo shell commands", () => {
  assert.equal(parseMongoFindCommand("db.users.insertOne({})"), null);
});

test("mongoDocumentsToQueryResult turns mongo documents into grid rows", () => {
  const result = mongoDocumentsToQueryResult(
    [
      { _id: "1", name: "Ada", profile: { role: "admin" } },
      { _id: "2", active: true, name: "Lin" },
    ],
    5,
    12,
  );

  assert.deepEqual(result.columns, ["_id", "name", "profile", "active"]);
  assert.deepEqual(result.rows, [
    ["1", "Ada", '{"role":"admin"}', null],
    ["2", "Lin", null, true],
  ]);
  assert.equal(result.affected_rows, 12);
  assert.equal(result.execution_time_ms, 5);
  assert.equal(result.truncated, true);
});
