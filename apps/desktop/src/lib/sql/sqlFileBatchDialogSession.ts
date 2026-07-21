export interface SqlFileBatchDialogSession {
  restoreOnNextOpen: boolean;
}

export interface SqlFileBatchDialogOpenDecision {
  session: SqlFileBatchDialogSession;
  reset: boolean;
}

export function initialSqlFileBatchDialogSession(): SqlFileBatchDialogSession {
  return { restoreOnNextOpen: false };
}

export function markSqlFileBatchBackgroundRestore(session: SqlFileBatchDialogSession): SqlFileBatchDialogSession {
  return { ...session, restoreOnNextOpen: true };
}

export function decideSqlFileBatchDialogOpen(session: SqlFileBatchDialogSession, batchActive: boolean): SqlFileBatchDialogOpenDecision {
  if (session.restoreOnNextOpen) {
    return { session: { ...session, restoreOnNextOpen: false }, reset: false };
  }
  return { session, reset: !batchActive };
}
