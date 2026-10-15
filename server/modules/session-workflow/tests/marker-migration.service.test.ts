import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyMarkerMigration,
  findMarkerMigrationItems,
  type MarkerMigrationDependencies,
} from '@/modules/session-workflow/services/marker-migration.service.js';
import type {
  SessionWorkflowRecord,
  SessionWorkflowStatus,
  VisibleSession,
} from '@/shared/types.js';

const NOW = new Date('2026-10-10T12:00:00.000Z');
const STATUS_SET_AT = '2026-10-01T00:00:00.000Z';

function createSession(sessionId: string, title: string): VisibleSession {
  return {
    sessionId,
    provider: 'claude',
    projectId: null,
    title,
    lastActivity: '2026-10-01T00:00:00.000Z',
    forkedFromSessionId: null,
  };
}

function createStatuses(
  entries: Array<[string, SessionWorkflowRecord['status']]> = [],
): Map<string, SessionWorkflowRecord> {
  const statuses = new Map<string, SessionWorkflowRecord>();
  for (const [sessionId, status] of entries) {
    statuses.set(sessionId, { sessionId, status, statusSetAt: STATUS_SET_AT });
  }
  return statuses;
}

type FakeWorld = {
  dependencies: MarkerMigrationDependencies;
  sessions: VisibleSession[];
  statuses: Map<string, SessionWorkflowRecord>;
  calls: string[];
  broadcasts: string[][];
};

/** Fakes that behave like the real stack: rename edits the listed title, setStatus stores a record. */
function createFakeWorld(
  initialSessions: VisibleSession[],
  initialStatuses: Map<string, SessionWorkflowRecord> = createStatuses(),
  overrides: Partial<MarkerMigrationDependencies> = {},
): FakeWorld {
  const world: FakeWorld = {
    sessions: initialSessions,
    statuses: initialStatuses,
    calls: [],
    broadcasts: [],
    dependencies: undefined as unknown as MarkerMigrationDependencies,
  };

  world.dependencies = {
    listVisibleSessions: () => world.sessions,
    listStatuses: () => world.statuses,
    renameSession: async (sessionId, title) => {
      world.calls.push(`rename:${sessionId}:${title}`);
      world.sessions = world.sessions.map((session) => (
        session.sessionId === sessionId ? { ...session, title } : session
      ));
    },
    setStatus: (sessionId, status: SessionWorkflowStatus, now) => {
      world.calls.push(`status:${sessionId}:${status}`);
      if (status !== 'active') {
        world.statuses.set(sessionId, { sessionId, status, statusSetAt: now.toISOString() });
      }
    },
    broadcastSessions: async (sessionIds) => {
      world.broadcasts.push(sessionIds);
    },
    now: () => NOW,
    ...overrides,
  };
  return world;
}

test('a check mark title becomes closed with the clean title', () => {
  const items = findMarkerMigrationItems([createSession('one', '✅ Acme / Tema')], createStatuses());

  assert.deepEqual(items, [{
    sessionId: 'one',
    provider: 'claude',
    currentTitle: '✅ Acme / Tema',
    cleanTitle: 'Acme / Tema',
    proposedStatus: 'closed',
  }]);
});

test('an ignore marker becomes ignored with the clean title', () => {
  const items = findMarkerMigrationItems([createSession('one', 'Acme / Tema <ignore>')], createStatuses());

  assert.equal(items[0].proposedStatus, 'ignored');
  assert.equal(items[0].cleanTitle, 'Acme / Tema');
});

test('the ignore marker wins when a title carries both markers', () => {
  const items = findMarkerMigrationItems([createSession('one', '<IGNORE> ✅ x')], createStatuses());

  assert.equal(items[0].proposedStatus, 'ignored');
  assert.equal(items[0].cleanTitle, 'x');
});

test('the check mark with a variation selector is removed and spaces collapse', () => {
  const items = findMarkerMigrationItems([createSession('one', 'Acme  ✅️  /   Tema ')], createStatuses());

  assert.equal(items[0].cleanTitle, 'Acme / Tema');
});

test('the ignore marker matches in mixed case', () => {
  const items = findMarkerMigrationItems([createSession('one', 'Acme / Tema <Ignore>')], createStatuses());

  assert.equal(items[0].proposedStatus, 'ignored');
  assert.equal(items[0].cleanTitle, 'Acme / Tema');
});

test('a title without a marker never appears and the session order is kept', () => {
  const items = findMarkerMigrationItems(
    [createSession('first', '✅ Acme / A'), createSession('plain', 'Acme / B'), createSession('last', 'Globex / C <ignore>')],
    createStatuses(),
  );

  assert.deepEqual(items.map((item) => item.sessionId), ['first', 'last']);
});

test('a title made only of a marker has no clean title and keeps the title', () => {
  const items = findMarkerMigrationItems([createSession('one', '✅')], createStatuses());

  assert.equal(items[0].cleanTitle, null);
  assert.equal(items[0].proposedStatus, 'closed');
});

test('a marker-only title whose stored status is already the proposed one has nothing left to do', () => {
  const items = findMarkerMigrationItems(
    [createSession('one', '✅'), createSession('two', '<ignore>')],
    createStatuses([['one', 'closed'], ['two', 'paused']]),
  );

  assert.deepEqual(items.map((item) => item.sessionId), ['two']);
});

test('a cleanable title stays listed even when the proposed status is already stored', () => {
  const items = findMarkerMigrationItems([createSession('one', '✅ Acme / Tema')], createStatuses([['one', 'closed']]));

  assert.deepEqual(items.map((item) => item.sessionId), ['one']);
});

test('apply renames before it sets the status and reads the clock after the rename', async () => {
  const world = createFakeWorld([createSession('one', '✅ Acme / Tema')], createStatuses(), {
    now: () => {
      world.calls.push('now');
      return NOW;
    },
  });

  const result = await applyMarkerMigration(['one'], world.dependencies);

  assert.deepEqual(world.calls, ['rename:one:Acme / Tema', 'now', 'status:one:closed']);
  assert.deepEqual(result, { applied: ['one'], failed: [] });
  assert.equal(world.statuses.get('one')?.statusSetAt, NOW.toISOString());
});

test('apply is idempotent: the preview is empty afterwards and a second apply does nothing', async () => {
  const world = createFakeWorld([
    createSession('one', '✅ Acme / Tema'),
    createSession('two', 'Acme / Velho <ignore>'),
    createSession('three', '✅'),
  ]);

  const firstResult = await applyMarkerMigration(['one', 'two', 'three'], world.dependencies);
  const previewAfterApply = findMarkerMigrationItems(world.sessions, world.statuses);
  const secondResult = await applyMarkerMigration(['one', 'two', 'three'], world.dependencies);

  assert.deepEqual(firstResult.applied, ['one', 'two', 'three']);
  assert.deepEqual(previewAfterApply, []);
  assert.deepEqual(secondResult, { applied: [], failed: [] });
  assert.equal(world.broadcasts.length, 1);
});

test('apply touches only the confirmed ids, and a confirmed id that is no longer pending is ignored', async () => {
  const world = createFakeWorld([createSession('a', '✅ Acme / A'), createSession('b', '✅ Acme / B')]);

  const result = await applyMarkerMigration(['a', 'gone'], world.dependencies);

  assert.deepEqual(result, { applied: ['a'], failed: [] });
  assert.deepEqual(world.calls, ['rename:a:Acme / A', 'status:a:closed']);
});

test('apply redoes the rename when the status is stored but the marker is still in the title', async () => {
  const world = createFakeWorld([createSession('one', '✅ Acme / Tema')], createStatuses([['one', 'closed']]));

  const result = await applyMarkerMigration(['one'], world.dependencies);

  assert.deepEqual(result.applied, ['one']);
  assert.deepEqual(world.calls, ['rename:one:Acme / Tema', 'status:one:closed']);
});

test('a marker-only title gets the status without a rename', async () => {
  const world = createFakeWorld([createSession('one', '✅')]);

  const result = await applyMarkerMigration(['one'], world.dependencies);

  assert.deepEqual(result.applied, ['one']);
  assert.deepEqual(world.calls, ['status:one:closed']);
});

test('a failed rename is reported, stores no status and does not stop the other items', async () => {
  const world = createFakeWorld([createSession('bad', '✅ Acme / Ruim'), createSession('good', '✅ Acme / Bom')]);
  const renameThatFailsForBad = world.dependencies.renameSession;
  world.dependencies.renameSession = async (sessionId, title) => {
    if (sessionId === 'bad') {
      throw new Error('Session "bad" was not found.');
    }
    await renameThatFailsForBad(sessionId, title);
  };

  const result = await applyMarkerMigration(['bad', 'good'], world.dependencies);

  assert.deepEqual(result.applied, ['good']);
  assert.deepEqual(result.failed, [{ sessionId: 'bad', message: 'Session "bad" was not found.' }]);
  assert.equal(world.statuses.has('bad'), false);
  assert.deepEqual(world.broadcasts, [['good']]);
});

test('a failed status write is reported for its item', async () => {
  const world = createFakeWorld([createSession('one', '✅ Acme / Tema')], createStatuses(), {
    setStatus: () => {
      throw new Error('database is locked');
    },
  });

  const result = await applyMarkerMigration(['one'], world.dependencies);

  assert.deepEqual(result, { applied: [], failed: [{ sessionId: 'one', message: 'database is locked' }] });
});

test('a failed broadcast is logged and the result stays the same', async () => {
  const world = createFakeWorld([createSession('one', '✅ Acme / Tema')], createStatuses(), {
    broadcastSessions: async () => {
      throw new Error('socket exploded');
    },
  });
  const loggedErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...loggedArguments: unknown[]) => { loggedErrors.push(loggedArguments); };

  try {
    const result = await applyMarkerMigration(['one'], world.dependencies);

    assert.deepEqual(result, { applied: ['one'], failed: [] });
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(loggedErrors[0]?.[0], '[SessionWorkflow] MarkerMigrationBroadcastFailed');
});

test('nothing pending applies nothing and announces nothing', async () => {
  const world = createFakeWorld([createSession('one', 'Acme / Tema')]);

  const result = await applyMarkerMigration(['one'], world.dependencies);

  assert.deepEqual(result, { applied: [], failed: [] });
  assert.deepEqual(world.calls, []);
  assert.deepEqual(world.broadcasts, []);
});
