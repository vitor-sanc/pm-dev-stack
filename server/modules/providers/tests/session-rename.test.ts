import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import type { IProviderRename } from '@/shared/interfaces.js';

const SESSION_ID = 'rename-target';

type RenameCall = Parameters<IProviderRename['renameSession']>[0];

async function withRenamableClaude(
  runTest: (context: { calls: RenameCall[]; directory: string }) => Promise<void>,
  options: { failWith?: Error } = {},
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'session-rename-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();

  const calls: RenameCall[] = [];
  const claude = providerRegistry.resolveProvider('claude') as { rename?: IProviderRename };
  const realRename = claude.rename;
  const replacement: IProviderRename = {
    renameSession: async (input) => {
      calls.push(input);
      if (options.failWith) {
        throw options.failWith;
      }
    },
  };

  Object.defineProperty(claude, 'rename', { value: replacement, configurable: true, writable: true });

  try {
    await runTest({ calls, directory });
  } finally {
    Object.defineProperty(claude, 'rename', { value: realRename, configurable: true, writable: true });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

function seedSession(directory: string): string {
  const now = new Date().toISOString();
  const jsonlPath = path.join(directory, 'native-session.jsonl');
  sessionsDb.createSession(SESSION_ID, 'claude', directory, 'Old title', now, now, jsonlPath);
  sessionsDb.assignProviderSessionId(SESSION_ID, 'native-session');
  return jsonlPath;
}

test('a rename is stored in the app and written to the provider transcript', async () => {
  await withRenamableClaude(async ({ calls, directory }) => {
    const jsonlPath = seedSession(directory);

    const result = await sessionsService.renameSessionById(SESSION_ID, 'Client / Planning');

    assert.deepEqual(result, { sessionId: SESSION_ID, summary: 'Client / Planning' });
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'Client / Planning');
    assert.deepEqual(calls, [{
      providerSessionId: 'native-session',
      projectPath: sessionsDb.getSessionById(SESSION_ID)?.project_path ?? null,
      jsonlPath,
      title: 'Client / Planning',
    }]);
  });
});

test('a failed transcript write keeps the rename the user already sees', async () => {
  await withRenamableClaude(async ({ calls, directory }) => {
    seedSession(directory);

    const result = await sessionsService.renameSessionById(SESSION_ID, 'Client / Planning');

    assert.equal(calls.length, 1);
    assert.deepEqual(result, { sessionId: SESSION_ID, summary: 'Client / Planning' });
    assert.equal(sessionsDb.getSessionById(SESSION_ID)?.custom_name, 'Client / Planning');
  }, { failWith: new Error('transcript is read-only') });
});

test('a session that never ran is renamed in the app only', async () => {
  await withRenamableClaude(async ({ calls, directory }) => {
    // An app-created session that has never run has no provider id and no transcript.
    sessionsDb.createAppSession('never-ran', 'claude', directory, 'Never ran');

    await sessionsService.renameSessionById('never-ran', 'Client / Draft');

    assert.equal(calls.length, 0);
    assert.equal(sessionsDb.getSessionById('never-ran')?.custom_name, 'Client / Draft');
  });
});

test('renaming a session that does not exist is a 404', async () => {
  await withRenamableClaude(async () => {
    await assert.rejects(
      () => sessionsService.renameSessionById('no-such-session', 'Anything'),
      (error: Error & { code?: string }) => error.code === 'SESSION_NOT_FOUND',
    );
  });
});
