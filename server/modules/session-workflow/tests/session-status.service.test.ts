import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import {
  initializeSessionWorkflowTable,
  listSessionWorkflowRecords,
  resolveEffectiveSessionStatus,
  setSessionWorkflowStatus,
} from '@/modules/session-workflow/services/session-status.service.js';
import type { SessionWorkflowRecord } from '@/shared/types.js';

const SESSION_ID = 'acme-session';
const STATUS_SET_AT = '2026-10-10T12:00:00.000Z';
const NEWER_ACTIVITY = '2026-10-11T12:00:00.000Z';
const OLDER_ACTIVITY = '2026-10-09T12:00:00.000Z';

async function withIsolatedDatabase(runTest: (projectDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-workflow-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  initializeSessionWorkflowTable();

  try {
    sessionsDb.createAppSession(SESSION_ID, 'claude', tempDirectory, 'Acme / Relatorios');
    await runTest(tempDirectory);
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

function createRecord(status: SessionWorkflowRecord['status']): SessionWorkflowRecord {
  return { sessionId: SESSION_ID, status, statusSetAt: STATUS_SET_AT };
}

test('pausing a session stores a row with the moment it was set', async () => {
  await withIsolatedDatabase(() => {
    const now = new Date('2026-10-10T12:00:00.000Z');

    const change = setSessionWorkflowStatus(SESSION_ID, 'paused', now);

    assert.deepEqual(change, { sessionId: SESSION_ID, status: 'paused', statusSetAt: STATUS_SET_AT });
    assert.deepEqual(listSessionWorkflowRecords().get(SESSION_ID), createRecord('paused'));
  });
});

test('marking a session active deletes its row', async () => {
  await withIsolatedDatabase(() => {
    setSessionWorkflowStatus(SESSION_ID, 'closed', new Date(STATUS_SET_AT));

    const change = setSessionWorkflowStatus(SESSION_ID, 'active', new Date(STATUS_SET_AT));

    assert.deepEqual(change, { sessionId: SESSION_ID, status: 'active', statusSetAt: null });
    assert.equal(listSessionWorkflowRecords().size, 0);
  });
});

test('changing the status of a stored session replaces the row', async () => {
  await withIsolatedDatabase(() => {
    setSessionWorkflowStatus(SESSION_ID, 'paused', new Date(STATUS_SET_AT));
    setSessionWorkflowStatus(SESSION_ID, 'ignored', new Date(NEWER_ACTIVITY));

    const records = listSessionWorkflowRecords();

    assert.equal(records.size, 1);
    assert.deepEqual(records.get(SESSION_ID), {
      sessionId: SESSION_ID,
      status: 'ignored',
      statusSetAt: NEWER_ACTIVITY,
    });
  });
});

test('a session that does not exist is rejected with SESSION_NOT_FOUND', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => setSessionWorkflowStatus('missing-session', 'paused', new Date(STATUS_SET_AT)),
      (error: { code?: string; statusCode?: number }) => error.code === 'SESSION_NOT_FOUND' && error.statusCode === 404,
    );
    assert.equal(listSessionWorkflowRecords().size, 0);
  });
});

test('a status outside the vocabulary is rejected with INVALID_SESSION_STATUS', async () => {
  await withIsolatedDatabase(() => {
    assert.throws(
      () => setSessionWorkflowStatus(SESSION_ID, 'archived' as never, new Date(STATUS_SET_AT)),
      (error: { code?: string; statusCode?: number }) => error.code === 'INVALID_SESSION_STATUS' && error.statusCode === 400,
    );
    assert.equal(listSessionWorkflowRecords().size, 0);
  });
});

test('deleting the session removes its workflow row', async () => {
  await withIsolatedDatabase(() => {
    setSessionWorkflowStatus(SESSION_ID, 'closed', new Date(STATUS_SET_AT));

    sessionsDb.deleteSessionById(SESSION_ID);

    assert.equal(listSessionWorkflowRecords().size, 0);
  });
});

test('initializing the table twice keeps the stored rows', async () => {
  await withIsolatedDatabase(() => {
    setSessionWorkflowStatus(SESSION_ID, 'paused', new Date(STATUS_SET_AT));

    initializeSessionWorkflowTable();
    initializeSessionWorkflowTable();

    assert.deepEqual(listSessionWorkflowRecords().get(SESSION_ID), createRecord('paused'));
  });
});

test('the table rejects a status outside the vocabulary even when written directly', async () => {
  await withIsolatedDatabase(() => {
    const insertInvalidRow = () => getConnection()
      .prepare('INSERT INTO session_workflow (session_id, status, status_set_at) VALUES (?, ?, ?)')
      .run(SESSION_ID, 'archived', STATUS_SET_AT);

    assert.throws(insertInvalidRow, /CHECK constraint failed/);
  });
});

test('paused and closed sessions become active again when newer activity exists', () => {
  const cases: Array<[SessionWorkflowRecord['status']]> = [['paused'], ['closed']];

  for (const [status] of cases) {
    const effectiveStatus = resolveEffectiveSessionStatus(createRecord(status), NEWER_ACTIVITY);

    assert.equal(effectiveStatus, 'active', `${status} with newer activity must reactivate`);
  }
});

test('an ignored session stays ignored even with newer activity', () => {
  const effectiveStatus = resolveEffectiveSessionStatus(createRecord('ignored'), NEWER_ACTIVITY);

  assert.equal(effectiveStatus, 'ignored');
});

test('a paused or closed session with older activity keeps its stored status', () => {
  assert.equal(resolveEffectiveSessionStatus(createRecord('paused'), OLDER_ACTIVITY), 'paused');
  assert.equal(resolveEffectiveSessionStatus(createRecord('closed'), OLDER_ACTIVITY), 'closed');
});

test('activity at the exact moment the status was set does not reactivate', () => {
  assert.equal(resolveEffectiveSessionStatus(createRecord('closed'), STATUS_SET_AT), 'closed');
});

test('a session without a row is active', () => {
  assert.equal(resolveEffectiveSessionStatus(undefined, OLDER_ACTIVITY), 'active');
  assert.equal(resolveEffectiveSessionStatus(undefined, null), 'active');
});

test('a null or unparseable last activity keeps the stored status', () => {
  assert.equal(resolveEffectiveSessionStatus(createRecord('closed'), null), 'closed');
  assert.equal(resolveEffectiveSessionStatus(createRecord('paused'), 'not-a-date'), 'paused');
});
