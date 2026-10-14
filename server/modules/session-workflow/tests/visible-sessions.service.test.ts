import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, projectsDb, sessionsDb } from '@/modules/database/index.js';
import { listVisibleSessions } from '@/modules/session-workflow/services/visible-sessions.service.js';

const UNPAGED_SESSION_COUNT = 130;

async function withIsolatedDatabase(runTest: (projectDirectory: string) => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'visible-sessions-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
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

test('every non-archived session comes back in one unpaged list, newest first', async () => {
  await withIsolatedDatabase((projectDirectory) => {
    for (let sessionNumber = 0; sessionNumber < UNPAGED_SESSION_COUNT; sessionNumber += 1) {
      const minute = String(sessionNumber % 60).padStart(2, '0');
      const hour = String(Math.floor(sessionNumber / 60)).padStart(2, '0');
      const updatedAt = `2026-10-01T${hour}:${minute}:00.000Z`;
      sessionsDb.createSession(`session-${sessionNumber}`, 'claude', projectDirectory, `Acme / Item ${sessionNumber}`, updatedAt, updatedAt);
    }

    const visibleSessions = listVisibleSessions();

    assert.equal(visibleSessions.length, UNPAGED_SESSION_COUNT);
    assert.equal(visibleSessions[0].sessionId, `session-${UNPAGED_SESSION_COUNT - 1}`);
    assert.equal(visibleSessions[0].lastActivity, '2026-10-01T02:09:00.000Z');
  });
});

test('archived sessions and sessions of archived projects are left out', async () => {
  await withIsolatedDatabase(async (projectDirectory) => {
    const archivedProjectDirectory = path.join(projectDirectory, 'archived-project');
    sessionsDb.createSession('kept', 'claude', projectDirectory, 'Acme / Kept');
    sessionsDb.createSession('archived', 'claude', projectDirectory, 'Acme / Archived');
    sessionsDb.createSession('in-archived-project', 'claude', archivedProjectDirectory, 'Acme / Hidden');
    sessionsDb.updateSessionIsArchived('archived', true);
    const archivedProject = projectsDb.getProjectPath(archivedProjectDirectory);
    assert.ok(archivedProject, 'the project of the third session must exist');
    projectsDb.updateProjectIsArchivedById(archivedProject.project_id, true);

    const visibleSessions = listVisibleSessions();

    assert.deepEqual(visibleSessions.map((session) => session.sessionId), ['kept']);
  });
});

test('the title is the custom name, or the session id when the name is empty', async () => {
  await withIsolatedDatabase((projectDirectory) => {
    sessionsDb.createSession('named', 'claude', projectDirectory, '  Acme / Named  ');
    sessionsDb.createSession('blank', 'claude', projectDirectory, '   ');
    sessionsDb.createSession('unnamed', 'claude', projectDirectory);

    const titlesById = new Map(listVisibleSessions().map((session) => [session.sessionId, session.title]));

    assert.equal(titlesById.get('named'), 'Acme / Named');
    assert.equal(titlesById.get('blank'), 'blank');
    assert.equal(titlesById.get('unnamed'), 'unnamed');
  });
});

test('each session carries its project id, provider and fork source', async () => {
  await withIsolatedDatabase((projectDirectory) => {
    sessionsDb.createSession('origin', 'claude', projectDirectory, 'Acme / Origin');
    sessionsDb.createForkedSession({
      sessionId: 'fork',
      provider: 'claude',
      projectPath: projectDirectory,
      customName: 'Acme / Fork',
      providerSessionId: 'fork-provider-id',
      jsonlPath: path.join(projectDirectory, 'fork.jsonl'),
      forkedFromSessionId: 'origin',
      model: null,
      effort: null,
    });
    const project = projectsDb.getProjectPath(projectDirectory);

    const sessionsById = new Map(listVisibleSessions().map((session) => [session.sessionId, session]));

    assert.ok(project, 'the project must exist');
    assert.equal(sessionsById.get('origin')?.projectId, project.project_id);
    assert.equal(sessionsById.get('origin')?.provider, 'claude');
    assert.equal(sessionsById.get('origin')?.forkedFromSessionId, null);
    assert.equal(sessionsById.get('fork')?.forkedFromSessionId, 'origin');
  });
});

test('an empty database yields an empty list', async () => {
  await withIsolatedDatabase(() => {
    assert.deepEqual(listVisibleSessions(), []);
  });
});
