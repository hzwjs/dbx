import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";

function exportedFunctions(path: string): string[] {
  const source = readFileSync(path, "utf8");
  return [...source.matchAll(/^export (?:async )?function (\w+)/gm)].map((match) => match[1]).sort();
}

test("Tauri and HTTP backends expose the same API functions", () => {
  assert.deepEqual(exportedFunctions("src/lib/http.ts"), exportedFunctions("src/lib/tauri.ts"));
});
