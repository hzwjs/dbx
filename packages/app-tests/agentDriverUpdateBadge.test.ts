import assert from "node:assert/strict";
import test from "node:test";

import { countAvailableAgentDriverUpdates } from "../../src/lib/agentDriverUpdateBadge.ts";

test("returns zero when there are no available agent driver updates", () => {
  assert.equal(countAvailableAgentDriverUpdates([]), 0);
  assert.equal(countAvailableAgentDriverUpdates([{ update_available: false }, { update_available: false }]), 0);
});

test("counts available agent driver updates", () => {
  assert.equal(
    countAvailableAgentDriverUpdates([
      { update_available: true },
      { update_available: false },
      { update_available: true },
    ]),
    2,
  );
});
