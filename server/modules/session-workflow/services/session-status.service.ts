import { getConnection, sessionsDb } from '@/modules/database/index.js';
import type {
  SessionWorkflowRecord,
  SessionWorkflowStatus,
  SessionWorkflowStatusChange,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const SESSION_WORKFLOW_STATUSES: readonly SessionWorkflowStatus[] = ['active', 'paused', 'closed', 'ignored'];

// The table lives here, not in schema.ts, to keep upstream hotspot files untouched.
// The sessions rebuild in migrations.ts runs with foreign keys off, so these rows survive it.
const SESSION_WORKFLOW_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS session_workflow (
    session_id TEXT PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('active','paused','closed','ignored')),
    status_set_at TEXT NOT NULL
  )
`;

type SessionWorkflowRow = {
  session_id: string;
  status: SessionWorkflowRecord['status'];
  status_set_at: string;
};

/** Used by the Session Workflow router to reject a status the table cannot store. */
export function isSessionWorkflowStatus(value: unknown): value is SessionWorkflowStatus {
  return SESSION_WORKFLOW_STATUSES.includes(value as SessionWorkflowStatus);
}

/** Used by the server entrypoint at startup. Safe to call more than once. */
export function initializeSessionWorkflowTable(): void {
  getConnection().exec(SESSION_WORKFLOW_TABLE_SQL);
}

/** Used by the Session Workflow composition to read every stored status in one query. */
export function listSessionWorkflowRecords(): Map<string, SessionWorkflowRecord> {
  const rows = getConnection()
    .prepare('SELECT session_id, status, status_set_at FROM session_workflow')
    .all() as SessionWorkflowRow[];

  const records = new Map<string, SessionWorkflowRecord>();
  for (const row of rows) {
    records.set(row.session_id, {
      sessionId: row.session_id,
      status: row.status,
      statusSetAt: row.status_set_at,
    });
  }
  return records;
}

/**
 * Used by the Session Workflow composition to apply a user status change.
 *
 * `active` deletes the row, because a session without a row is active. Any
 * other status replaces the row and stamps it with `now`.
 */
export function setSessionWorkflowStatus(
  sessionId: string,
  status: SessionWorkflowStatus,
  now: Date,
): SessionWorkflowStatusChange {
  if (!isSessionWorkflowStatus(status)) {
    throw new AppError(`Invalid session status "${String(status)}"`, {
      code: 'INVALID_SESSION_STATUS',
      statusCode: 400,
    });
  }

  if (!sessionsDb.getSessionById(sessionId)) {
    throw new AppError(`Session "${sessionId}" not found`, {
      code: 'SESSION_NOT_FOUND',
      statusCode: 404,
    });
  }

  const database = getConnection();
  if (status === 'active') {
    database.prepare('DELETE FROM session_workflow WHERE session_id = ?').run(sessionId);
    return { sessionId, status, statusSetAt: null };
  }

  const statusSetAt = now.toISOString();
  database
    .prepare(
      `INSERT INTO session_workflow (session_id, status, status_set_at)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET status = excluded.status, status_set_at = excluded.status_set_at`,
    )
    .run(sessionId, status, statusSetAt);
  return { sessionId, status, statusSetAt };
}

/**
 * Used by the session grouping service to compute what the sidebar shows.
 *
 * Pure and lazy: it never writes. A paused or closed session returns to
 * `active` when its last activity is newer than the moment the status was set.
 * An ignored session never returns. Missing or unparseable activity keeps the
 * stored status.
 */
export function resolveEffectiveSessionStatus(
  record: SessionWorkflowRecord | undefined,
  lastActivity: string | null,
): SessionWorkflowStatus {
  if (!record) {
    return 'active';
  }
  if (record.status === 'ignored') {
    return 'ignored';
  }

  const hasActivityAfterStatus = lastActivity !== null
    && Date.parse(lastActivity) > Date.parse(record.statusSetAt);
  return hasActivityAfterStatus ? 'active' : record.status;
}
