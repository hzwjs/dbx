import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";

const source = readFileSync("src/components/structure/TableStructureEditorDialog.vue", "utf8");

test("column comments can be expanded into a multiline editor", () => {
  assert.match(source, /PopoverContent/);
  assert.match(source, /v-model="column\.comment"/);
  assert.match(source, /<textarea[\s\S]*v-model="column\.comment"/);
  assert.match(source, /t\("structureEditor\.editComment"\)/);
});

test("structure editor keeps columns when optional metadata fails", () => {
  assert.match(source, /const nextColumns = await api\.getColumns/);
  assert.match(source, /api\s*\n\s*\.listIndexes[\s\S]*\.catch\(\(\) => \[\]\)/);
  assert.match(source, /api\s*\n\s*\.listForeignKeys[\s\S]*\.catch\(\(\) => \[\]\)/);
  assert.match(source, /api\s*\n\s*\.listTriggers[\s\S]*\.catch\(\(\) => \[\]\)/);
});
