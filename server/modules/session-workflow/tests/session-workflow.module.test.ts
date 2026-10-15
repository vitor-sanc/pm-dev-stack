import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { createSessionWorkflowServices } from '@/modules/session-workflow/session-workflow.module.js';
import { initializeSessionWorkflowTable } from '@/modules/session-workflow/services/session-status.service.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');

async function withComposedServices(
  broadcast: (sessionId: string) => Promise<void>,
  runTest: (services: ReturnType<typeof createSessionWorkflowServices>, projectDirectory: string) => Promise<void>,
  markerMigrationFakes: {
    renameSession?: (sessionId: string, title: string) => Promise<unknown>;
    broadcastSessions?: (sessionIds: string[]) => Promise<void>;
  } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-workflow-module-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  initializeSessionWorkflowTable();

  try {
    const services = createSessionWorkflowServices({
      broadcastSessionUpserted: broadcast,
      now: () => NOW,
      resolveClientSlug: () => null,
      renameSession: markerMigrationFakes.renameSession ?? (async () => undefined),
      broadcastSessions: markerMigrationFakes.broadcastSessions ?? (async () => undefined),
    });
    await runTest(services, tempDirectory);
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

test('setting a status stores it, then announces the session to other tabs', async () => {
  const announced: string[] = [];

  await withComposedServices(async (sessionId) => { announced.push(sessionId); }, async (services, projectDirectory) => {
    sessionsDb.createAppSession('acme-one', 'claude', projectDirectory, 'Acme / Tema');

    const change = await services.setSessionStatus('acme-one', 'paused');

    assert.deepEqual(change, { sessionId: 'acme-one', status: 'paused', statusSetAt: NOW.toISOString() });
    assert.deepEqual(announced, ['acme-one']);
  });
});

test('a failed announcement does not fail a status change that was already stored', async () => {
  await withComposedServices(async () => { throw new Error('socket exploded'); }, async (services, projectDirectory) => {
    sessionsDb.createAppSession('acme-one', 'claude', projectDirectory, 'Acme / Tema');

    const change = await services.setSessionStatus('acme-one', 'closed');

    assert.equal(change.status, 'closed');
  });
});

test('a missing session is rejected and nothing is announced', async () => {
  const announced: string[] = [];

  await withComposedServices(async (sessionId) => { announced.push(sessionId); }, async (services) => {
    await assert.rejects(
      () => services.setSessionStatus('missing', 'paused'),
      (error: { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
    assert.deepEqual(announced, []);
  });
});

test('the groups view applies stored statuses and the reactivation rule', async () => {
  await withComposedServices(async () => undefined, async (services, projectDirectory) => {
    sessionsDb.createSession('shut', 'claude', projectDirectory, 'Acme / Antigo', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    sessionsDb.createSession('woken', 'claude', projectDirectory, 'Acme / Retomado', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    await services.setSessionStatus('shut', 'closed');
    await services.setSessionStatus('woken', 'closed');
    // Newer activity than the moment the status was set (NOW).
    sessionsDb.createSession('woken', 'claude', projectDirectory, 'Acme / Retomado', undefined, '2026-10-11T00:00:00.000Z');

    const view = services.getSessionGroups({ includeIgnored: false });

    const acme = view.groups.find((group) => group.key === 'prefix:acme');
    assert.ok(acme, 'the Acme group must exist');
    assert.deepEqual(acme.sessions.map((session) => session.sessionId), ['woken']);
    assert.deepEqual(acme.closedSessions.map((session) => session.sessionId), ['shut']);
  });
});

test('a title with a marker is counted as pending and listed in the preview', async () => {
  await withComposedServices(async () => undefined, async (services, projectDirectory) => {
    sessionsDb.createSession('marked', 'claude', projectDirectory, '✅ Acme / Tema', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    sessionsDb.createSession('plain', 'claude', projectDirectory, 'Acme / Outro', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

    const view = services.getSessionGroups({ includeIgnored: false });
    const preview = services.previewMarkerMigration();

    assert.equal(view.pendingMarkerCount, 1);
    assert.deepEqual(preview.items.map((item) => item.sessionId), ['marked']);
  });
});

test('applying the marker migration renames, stores the status, announces the ids and does not reactivate the session', async () => {
  const announced: string[][] = [];
  const renameAndStore = async (sessionId: string, title: string) => {
    sessionsDb.updateSessionCustomName(sessionId, title);
  };

  await withComposedServices(async () => undefined, async (services, projectDirectory) => {
    sessionsDb.createSession('marked', 'claude', projectDirectory, '✅ Acme / Tema', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');

    const result = await services.applyMarkerMigration(['marked']);
    const view = services.getSessionGroups({ includeIgnored: false });

    assert.deepEqual(result, { applied: ['marked'], failed: [] });
    assert.deepEqual(announced, [['marked']]);
    assert.equal(view.pendingMarkerCount, 0);
    const acme = view.groups.find((group) => group.key === 'prefix:acme');
    assert.ok(acme, 'the Acme group must exist');
    assert.deepEqual(acme.sessions, []);
    assert.deepEqual(acme.closedSessions.map((session) => session.title), ['Acme / Tema']);
  }, {
    renameSession: renameAndStore,
    broadcastSessions: async (sessionIds) => { announced.push(sessionIds); },
  });
});
