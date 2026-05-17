import assert from "node:assert/strict";
import test from "node:test";
import { showAgentDriverInstallHint } from "../../src/lib/agentDriverInstallHint.ts";

test("hides the agent driver install hint when the selected driver is installed", () => {
  assert.equal(showAgentDriverInstallHint("informix", [{ db_type: "informix", installed: true }]), false);
});

test("shows the agent driver install hint when the selected driver is missing", () => {
  assert.equal(showAgentDriverInstallHint("informix", [{ db_type: "informix", installed: false }]), true);
});

test("shows the agent driver install hint for TDengine when missing", () => {
  assert.equal(showAgentDriverInstallHint("tdengine", [{ db_type: "tdengine", installed: false }]), true);
});

test("shows the agent driver install hint for Access when missing", () => {
  assert.equal(showAgentDriverInstallHint("access", [{ db_type: "access", installed: false }]), true);
});

test("does not show agent driver install hints for built-in database types", () => {
  assert.equal(showAgentDriverInstallHint("mysql", [{ db_type: "informix", installed: false }]), false);
});
