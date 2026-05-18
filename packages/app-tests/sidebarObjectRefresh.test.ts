import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const treeItemSource = readFileSync(join(process.cwd(), "apps/desktop/src/components/sidebar/TreeItem.vue"), "utf8");

function extractRefreshTableListBody(): string {
  const match = treeItemSource.match(/async function refreshTableList\(node: TreeNode\) \{([\s\S]*?)\n\}/);
  assert.ok(match, "TreeItem.vue should define refreshTableList");
  return match[1]!;
}

test("object mutations refresh through the expansion-preserving object list path", () => {
  const body = extractRefreshTableListBody();

  assert.match(body, /refreshObjectListTreeNode/);
  assert.doesNotMatch(body, /loadTables\(/);
  assert.doesNotMatch(body, /loadSqlServerDatabaseObjects\(/);
});
