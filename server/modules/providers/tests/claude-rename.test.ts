import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeRenameProvider } from '@/modules/providers/list/claude/claude-rename.provider.js';

type RenameDependencies = NonNullable<ConstructorParameters<typeof ClaudeRenameProvider>[0]>;

function createFakeDependencies() {
  const calls: { renamed: unknown[][]; restored: unknown[][] } = { renamed: [], restored: [] };
  const atime = new Date('2026-01-01T00:00:00Z');
  const mtime = new Date('2026-01-02T00:00:00Z');
  return {
    calls,
    atime,
    mtime,
    dependencies: {
      renameTranscript: (async (...args: unknown[]) => {
        calls.renamed.push(args);
      }) as unknown as RenameDependencies['renameTranscript'],
      readFileTimes: async () => ({ atime, mtime }),
      restoreFileTimes: async (...args: unknown[]) => {
        calls.restored.push(args);
      },
    },
  };
}

test('renameSession hands the title to the SDK scoped to the session project', async () => {
  const fake = createFakeDependencies();
  const provider = new ClaudeRenameProvider(fake.dependencies);

  await provider.renameSession({
    providerSessionId: 'session-1',
    projectPath: '/work/project',
    jsonlPath: '/claude/projects/-work-project/session-1.jsonl',
    title: 'Client / Planning',
  });

  assert.deepEqual(fake.calls.renamed, [['session-1', 'Client / Planning', { dir: '/work/project' }]]);
});

test('renameSession puts back the transcript times so a rename is not activity', async () => {
  const fake = createFakeDependencies();
  const provider = new ClaudeRenameProvider(fake.dependencies);
  const jsonlPath = '/claude/projects/-work-project/session-1.jsonl';

  await provider.renameSession({ providerSessionId: 'session-1', projectPath: null, jsonlPath, title: 'X' });

  assert.deepEqual(fake.calls.restored, [[jsonlPath, fake.atime, fake.mtime]]);
  assert.deepEqual(fake.calls.renamed, [['session-1', 'X', { dir: undefined }]]);
});

test('renameSession without an indexed transcript renames without touching file times', async () => {
  const fake = createFakeDependencies();
  const provider = new ClaudeRenameProvider(fake.dependencies);

  await provider.renameSession({ providerSessionId: 'session-1', projectPath: null, jsonlPath: null, title: 'X' });

  assert.equal(fake.calls.renamed.length, 1);
  assert.equal(fake.calls.restored.length, 0);
});

test('renameSession writes the same custom-title entry the CLI writes, keeping the file times', async () => {
  // The real SDK, against a throwaway Claude config directory.
  const configDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-rename-'));
  const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  try {
    const sessionId = '4f6c2b1e-8d3a-4c5b-9e7f-1a2b3c4d5e6f';
    const projectDirectory = path.join(configDirectory, 'projects', '-work-project');
    const jsonlPath = path.join(projectDirectory, `${sessionId}.jsonl`);
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(jsonlPath, `${JSON.stringify({
      type: 'user',
      sessionId,
      cwd: '/work/project',
      uuid: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d',
      message: { role: 'user', content: 'hello' },
    })}\n`, 'utf8');
    const oldTime = new Date('2026-01-02T03:04:05Z');
    await utimes(jsonlPath, oldTime, oldTime);

    await new ClaudeRenameProvider().renameSession({
      providerSessionId: sessionId,
      projectPath: null,
      jsonlPath,
      title: 'Client / Planning',
    });

    const lines = (await readFile(jsonlPath, 'utf8')).trim().split('\n');
    const lastEntry = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(lastEntry.type, 'custom-title');
    assert.equal(lastEntry.customTitle, 'Client / Planning');
    assert.equal(lastEntry.sessionId, sessionId);
    assert.equal((await stat(jsonlPath)).mtime.getTime(), oldTime.getTime());
  } finally {
    if (previousConfigDirectory === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
    }
    await rm(configDirectory, { recursive: true, force: true });
  }
});
