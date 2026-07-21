import assert from "node:assert/strict";
import { test } from "vitest";
import { decideSqlFileBatchDialogClose, decideSqlFileBatchDialogOpen, initialSqlFileBatchDialogSession, markSqlFileBatchBackgroundRestore } from "../../apps/desktop/src/lib/sql/sqlFileBatchDialogSession.ts";

test("active desktop update:open close restores completed hidden results exactly once", () => {
  const closedSession = decideSqlFileBatchDialogClose(initialSqlFileBatchDialogSession(), true, true);
  assert.equal(closedSession.restoreOnNextOpen, true);

  const completedWhileHidden = decideSqlFileBatchDialogOpen(closedSession, false);
  assert.equal(completedWhileHidden.reset, false);
  assert.equal(completedWhileHidden.session.restoreOnNextOpen, false);

  const reviewedThenClosed = decideSqlFileBatchDialogOpen(completedWhileHidden.session, false);
  assert.equal(reviewedThenClosed.reset, true);
});

test("Web update:open close does not create a desktop restore marker", () => {
  const closedSession = decideSqlFileBatchDialogClose(initialSqlFileBatchDialogSession(), false, true);

  assert.equal(closedSession.restoreOnNextOpen, false);
});

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
