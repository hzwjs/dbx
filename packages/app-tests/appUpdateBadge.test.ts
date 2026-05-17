import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import test from "node:test";

test("toolbar update button can show a red update badge", () => {
  const source = readFileSync("src/components/layout/AppToolbar.vue", "utf8");

  assert.match(source, /hasUpdateAvailable/);
  assert.match(source, /v-if="hasUpdateAvailable"/);
  assert.match(source, /bg-red-500/);
});

test("app schedules hourly silent update checks and clears the timer", () => {
  const source = readFileSync("src/App.vue", "utf8");

  assert.match(source, /UPDATE_CHECK_INTERVAL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(source, /setInterval\(\(\)\s*=>\s*{[\s\S]*checkUpdates\(\{\s*silent:\s*true\s*}\)/);
  assert.match(source, /clearInterval\(updateCheckTimer\)/);
});

test("app passes update availability to the toolbar badge", () => {
  const source = readFileSync("src/App.vue", "utf8");

  assert.match(source, /:has-update-available="hasUpdateAvailable"/);
});

test("driver manager entry can show an update count badge", () => {
  const toolbarSource = readFileSync("src/components/layout/AppToolbar.vue", "utf8");
  const tabSource = readFileSync("src/components/layout/AppTabBar.vue", "utf8");
  const appSource = readFileSync("src/App.vue", "utf8");

  assert.match(toolbarSource, /agentDriverUpdateCount/);
  assert.match(toolbarSource, /v-if="agentDriverUpdateCount > 0"/);
  assert.match(tabSource, /agentDriverUpdateCount/);
  assert.match(appSource, /:agent-driver-update-count="agentDriverUpdateCount"/);
});
