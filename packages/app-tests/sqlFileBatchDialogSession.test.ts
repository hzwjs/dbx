import assert from "node:assert/strict";
import { test } from "vitest";
import { decideSqlFileBatchDialogOpen, initialSqlFileBatchDialogSession, markSqlFileBatchBackgroundRestore } from "../../apps/desktop/src/lib/sql/sqlFileBatchDialogSession.ts";

test("background restore survives completion while closed and is consumed exactly once", () => {
  const backgroundSession = markSqlFileBatchBackgroundRestore(initialSqlFileBatchDialogSession());

  const firstReopen = decideSqlFileBatchDialogOpen(backgroundSession, false);
  assert.equal(firstReopen.reset, false);
  assert.equal(firstReopen.session.restoreOnNextOpen, false);

  const nextNormalReopen = decideSqlFileBatchDialogOpen(firstReopen.session, false);
  assert.equal(nextNormalReopen.reset, true);
});

test("an active batch is preserved without creating a future restore", () => {
  const decision = decideSqlFileBatchDialogOpen(initialSqlFileBatchDialogSession(), true);

  assert.equal(decision.reset, false);
  assert.equal(decision.session.restoreOnNextOpen, false);
});
