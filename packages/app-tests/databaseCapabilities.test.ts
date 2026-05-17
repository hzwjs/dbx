import assert from "node:assert/strict";
import test from "node:test";
import {
  SCHEMA_AWARE_TYPES,
  TREE_SCHEMA_TYPES,
  getDatabaseCapability,
  supportsDatabaseCreation,
  supportsDatabaseSearch,
  supportsDriverManagement,
  supportsFieldLineage,
  supportsObjectBrowser,
  supportsObjectBrowserTreeNode,
  supportsSchemaDiagram,
  supportsSqlFileExecution,
  supportsTableImport,
  supportsTableTruncate,
  supportsTableStructureEditing,
  supportsTransfer,
  usesPostgresLikeStructureCopy,
  usesTreeSchemaMode,
} from "../../src/lib/databaseCapabilities.ts";

test("treats Trino catalogs as schema tree roots", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("trino"), true);
});

test("treats TDengine databases as schema tree roots and agent driver databases", () => {
  assert.equal(TREE_SCHEMA_TYPES.has("tdengine"), true);
  assert.equal(SCHEMA_AWARE_TYPES.has("tdengine"), true);
  assert.equal(supportsDriverManagement("tdengine"), true);
});

test("treats Access as a local single-database agent driver", () => {
  assert.equal(SCHEMA_AWARE_TYPES.has("access"), false);
  assert.equal(supportsDriverManagement("access"), true);
  assert.equal(supportsDatabaseSearch("access"), true);
  assert.equal(supportsTableImport("access"), true);
});

test("describes schema tree mode through the capability helper", () => {
  assert.equal(usesTreeSchemaMode("trino"), true);
  assert.equal(usesTreeSchemaMode("h2"), true);
  assert.equal(usesTreeSchemaMode("mysql"), false);
  assert.equal(usesTreeSchemaMode(undefined), false);
});

test("treats Trino tables as schema-qualified SQL targets", () => {
  assert.equal(SCHEMA_AWARE_TYPES.has("trino"), true);
});

test("describes table editing capabilities for special database engines", () => {
  assert.deepEqual(getDatabaseCapability("hive").tableData, {
    insert: true,
    updateRequiresPrimaryKey: false,
    deleteRequiresPrimaryKey: false,
    requiresTransactionalTableForExistingRows: true,
    transaction: false,
  });

  assert.deepEqual(getDatabaseCapability("trino").tableData, {
    insert: true,
    updateRequiresPrimaryKey: true,
    deleteRequiresPrimaryKey: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: false,
  });

  assert.equal(getDatabaseCapability("oracle").syntheticKey, "oracle-rowid");
  assert.equal(getDatabaseCapability("neo4j").syntheticKey, "neo4j-element-id");
});

test("uses conservative table editing defaults for unknown or keyless relational engines", () => {
  assert.deepEqual(getDatabaseCapability("postgres").tableData, {
    insert: false,
    updateRequiresPrimaryKey: true,
    deleteRequiresPrimaryKey: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
  assert.deepEqual(getDatabaseCapability(undefined).tableData, {
    insert: false,
    updateRequiresPrimaryKey: true,
    deleteRequiresPrimaryKey: true,
    requiresTransactionalTableForExistingRows: false,
    transaction: true,
  });
});

test("describes feature support through capability helpers", () => {
  assert.equal(supportsSqlFileExecution("mysql"), true);
  assert.equal(supportsSqlFileExecution("redis"), false);
  assert.equal(supportsSchemaDiagram("oracle"), true);
  assert.equal(supportsSchemaDiagram("trino"), false);
  assert.equal(supportsDatabaseSearch("neo4j"), true);
  assert.equal(supportsDatabaseSearch("redis"), false);
  assert.equal(supportsTableImport("duckdb"), true);
  assert.equal(supportsTableImport("hive"), false);
  assert.equal(supportsTableStructureEditing("postgres"), true);
  assert.equal(supportsTableStructureEditing("oracle"), false);
  assert.equal(supportsDatabaseCreation("clickhouse"), true);
  assert.equal(supportsDatabaseCreation("sqlite"), false);
  assert.equal(supportsFieldLineage("gaussdb"), true);
  assert.equal(supportsFieldLineage("trino"), false);
  assert.equal(supportsTransfer("duckdb"), true);
  assert.equal(supportsTransfer("hive"), false);
  assert.equal(supportsDriverManagement("oracle"), true);
  assert.equal(supportsDriverManagement("mysql"), false);
  assert.equal(usesPostgresLikeStructureCopy("gaussdb"), true);
  assert.equal(usesPostgresLikeStructureCopy("mysql"), false);
  assert.equal(supportsObjectBrowser("mysql"), true);
  assert.equal(supportsObjectBrowser("mongodb"), false);
  assert.equal(supportsTableTruncate("mysql"), true);
  assert.equal(supportsTableTruncate("duckdb"), false);
});

test("schema-aware database nodes do not open an object browser tab", () => {
  assert.equal(supportsObjectBrowserTreeNode("postgres", "database"), false);
  assert.equal(supportsObjectBrowserTreeNode("postgres", "schema"), true);
  assert.equal(supportsObjectBrowserTreeNode("mysql", "database"), true);
  assert.equal(supportsObjectBrowserTreeNode("mongodb", "database"), false);
});
