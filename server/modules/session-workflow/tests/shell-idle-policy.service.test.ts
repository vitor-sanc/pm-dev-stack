import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import {
  decideIdleShellKills,
  findShellActivitySignal,
  listProcessChildren,
  readRegistrySignal,
  readShellIdleTimeoutMs,
  scheduleShellIdleSweep,
  sweepIdleShells,
  type ShellActivitySignal,
  type ShellIdleSweepDependencies,
} from '@/modules/session-workflow/services/shell-idle-policy.service.js';
import type { RetainedShellPty } from '@/shared/types.js';

const HOUR_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 4 * HOUR_MS;
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function createPty(key: string, overrides: Partial<RetainedShellPty> = {}): RetainedShellPty {
  return {
    key,
    pid: 100,
    sessionId: `session-${key}`,
    projectPath: '/work/acme',
    attached: false,
    detachedAt: NOW - 10 * HOUR_MS,
    lastOutputAt: NOW - 10 * HOUR_MS,
    ...overrides,
  };
}

function createSignal(
  status: ShellActivitySignal['status'],
  hoursAgo: number | null,
): ShellActivitySignal {
  return { status, statusUpdatedAt: hoursAgo === null ? null : NOW - hoursAgo * HOUR_MS };
}

function decide(pty: RetainedShellPty, signal: ShellActivitySignal | null): string[] {
  return decideIdleShellKills({
    ptys: [pty],
    signals: new Map([[pty.key, signal]]),
    now: NOW,
    timeoutMs: TIMEOUT_MS,
  });
}

async function withRegistryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shell-idle-registry-'));
  try {
    await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function createDeferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) {
    await Promise.resolve();
  }
}

test('a detached pty whose claude has been idle or waiting past the timeout is killed', () => {
  assert.deepEqual(decide(createPty('a'), createSignal('idle', 4.02)), ['a']);
  assert.deepEqual(decide(createPty('a'), createSignal('waiting', 4.02)), ['a']);
  assert.deepEqual(decide(createPty('a'), createSignal('idle', 3.98)), []);
});

test('an attached pty, a busy claude, a plain shell and an unknown status stay alive', () => {
  assert.deepEqual(
    decide(createPty('a', { attached: true, detachedAt: null }), createSignal('idle', 10)),
    [],
  );
  assert.deepEqual(
    decide(createPty('a', { attached: true }), createSignal('idle', 10)),
    [],
    'attached wins even with a stale detachedAt',
  );
  assert.deepEqual(decide(createPty('a'), createSignal('busy', 10)), []);
  assert.deepEqual(decide(createPty('a'), createSignal('shell', 10)), []);
  assert.deepEqual(decide(createPty('a'), createSignal('unknown', 10)), []);
});

test('the idle clock starts at the later of the detach and the status change', () => {
  const detachedOneHourAgo = createPty('a', { detachedAt: NOW - 1 * HOUR_MS });
  assert.deepEqual(decide(detachedOneHourAgo, createSignal('idle', 10)), []);

  const statusWithoutTimestamp = createPty('a', { detachedAt: NOW - 3 * HOUR_MS });
  assert.deepEqual(decide(statusWithoutTimestamp, createSignal('idle', null)), []);
  const detachedLongAgo = createPty('a', { detachedAt: NOW - 5 * HOUR_MS });
  assert.deepEqual(decide(detachedLongAgo, createSignal('idle', null)), ['a']);
});

test('without a registry signal the clock is the last output of the pty', () => {
  const recentOutput = createPty('a', { lastOutputAt: NOW - 1 * HOUR_MS });
  assert.deepEqual(decide(recentOutput, null), []);

  const silentPty = createPty('a', { lastOutputAt: NOW - 4.02 * HOUR_MS });
  assert.deepEqual(decide(silentPty, null), ['a']);

  const outputBeforeDetach = createPty('a', {
    detachedAt: NOW - 1 * HOUR_MS,
    lastOutputAt: NOW - 10 * HOUR_MS,
  });
  assert.deepEqual(decide(outputBeforeDetach, null), [], 'the detach moment counts as activity');
});

test('a pty missing from the signal map is judged like one without a signal', () => {
  const silentPty = createPty('a', { lastOutputAt: NOW - 5 * HOUR_MS });
  const killedKeys = decideIdleShellKills({ ptys: [silentPty], signals: new Map(), now: NOW, timeoutMs: TIMEOUT_MS });
  assert.deepEqual(killedKeys, ['a']);
});

test('sweepIdleShells kills with the listed key and detachedAt and returns only confirmed kills', async () => {
  const killedPty = createPty('killed', { pid: 11, detachedAt: NOW - 9 * HOUR_MS });
  const racedPty = createPty('raced', { pid: 12, detachedAt: NOW - 8 * HOUR_MS });
  const killCalls: Array<[string, number]> = [];
  const log = mock.method(console, 'log', () => undefined);
  try {
    const killedKeys = await sweepIdleShells({
      listRetainedShellPtys: () => [killedPty, racedPty],
      killRetainedShellPty: (key, detachedAt) => {
        killCalls.push([key, detachedAt]);
        return key === 'killed';
      },
      listProcessChildren: async () => new Map(),
      readRegistrySignal: async () => createSignal('idle', 9),
      now: () => NOW,
      timeoutMs: TIMEOUT_MS,
    });

    assert.deepEqual(killedKeys, ['killed']);
    assert.deepEqual(killCalls, [
      ['killed', NOW - 9 * HOUR_MS],
      ['raced', NOW - 8 * HOUR_MS],
    ]);
    const logged = log.mock.calls.map((call) => String(call.arguments[0]));
    assert.equal(logged.filter((line) => line.includes('IdleShellKilled')).length, 1);
    assert.deepEqual(log.mock.calls[0].arguments[1], { key: 'killed', pid: 11, sessionId: 'session-killed' });
  } finally {
    log.mock.restore();
  }
});

test('sweepIdleShells lists processes once, and not at all when nothing can be judged', async () => {
  let processListings = 0;
  const baseDependencies: ShellIdleSweepDependencies = {
    listRetainedShellPtys: () => [],
    killRetainedShellPty: () => true,
    listProcessChildren: async () => {
      processListings += 1;
      return new Map();
    },
    readRegistrySignal: async () => null,
    now: () => NOW,
    timeoutMs: TIMEOUT_MS,
  };

  const attachedOnly = [createPty('a', { attached: true, detachedAt: null })];
  await sweepIdleShells({ ...baseDependencies, listRetainedShellPtys: () => attachedOnly });
  const withoutPid = [createPty('a', { pid: null, lastOutputAt: NOW })];
  await sweepIdleShells({ ...baseDependencies, listRetainedShellPtys: () => withoutPid });
  assert.equal(processListings, 0);

  const two = [createPty('a', { lastOutputAt: NOW }), createPty('b', { pid: 200, lastOutputAt: NOW })];
  await sweepIdleShells({ ...baseDependencies, listRetainedShellPtys: () => two });
  assert.equal(processListings, 1);
});

test('readShellIdleTimeoutMs defaults to four hours and warns about a bad value', () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    assert.equal(readShellIdleTimeoutMs({}), TIMEOUT_MS);
    assert.equal(readShellIdleTimeoutMs({ SHELL_IDLE_TIMEOUT_HOURS: '' }), TIMEOUT_MS);
    assert.equal(readShellIdleTimeoutMs({ SHELL_IDLE_TIMEOUT_HOURS: '   ' }), TIMEOUT_MS);
    assert.equal(warn.mock.callCount(), 0, 'absent or empty is not an error');

    assert.equal(readShellIdleTimeoutMs({ SHELL_IDLE_TIMEOUT_HOURS: '0.5' }), 30 * 60 * 1000);
    assert.equal(readShellIdleTimeoutMs({ SHELL_IDLE_TIMEOUT_HOURS: '2' }), 2 * HOUR_MS);
    assert.equal(warn.mock.callCount(), 0);

    for (const value of ['abc', '0', '-1', 'Infinity']) {
      assert.equal(readShellIdleTimeoutMs({ SHELL_IDLE_TIMEOUT_HOURS: value }), TIMEOUT_MS, value);
    }
    assert.equal(warn.mock.callCount(), 4);
    assert.match(String(warn.mock.calls[0].arguments[0]), /InvalidShellIdleTimeout/);
    assert.deepEqual(warn.mock.calls[0].arguments[1], { value: 'abc' });
  } finally {
    warn.mock.restore();
  }
});

test('readRegistrySignal reads status and timestamp from the pid file', async () => {
  await withRegistryDirectory(async (directory) => {
    await fs.writeFile(
      path.join(directory, '10.json'),
      JSON.stringify({ pid: 10, status: 'idle', statusUpdatedAt: 1_700_000_000_000 }),
    );
    await fs.writeFile(path.join(directory, '11.json'), JSON.stringify({ pid: 11, status: 'waiting' }));
    await fs.writeFile(path.join(directory, '12.json'), JSON.stringify({ pid: 12, status: 'busy', statusUpdatedAt: 5 }));
    await fs.writeFile(path.join(directory, '13.json'), JSON.stringify({ pid: 13, status: 'shell', statusUpdatedAt: '5' }));
    await fs.writeFile(path.join(directory, '14.json'), JSON.stringify({ pid: 14, status: 'thinking' }));

    assert.deepEqual(await readRegistrySignal(10, directory), { status: 'idle', statusUpdatedAt: 1_700_000_000_000 });
    assert.deepEqual(await readRegistrySignal(11, directory), { status: 'waiting', statusUpdatedAt: null });
    assert.deepEqual(await readRegistrySignal(12, directory), { status: 'busy', statusUpdatedAt: 5 });
    assert.deepEqual(await readRegistrySignal(13, directory), { status: 'shell', statusUpdatedAt: null });
    assert.deepEqual(await readRegistrySignal(14, directory), { status: 'unknown', statusUpdatedAt: null });
  });
});

test('readRegistrySignal answers null for a missing, unreadable or malformed pid file', async () => {
  await withRegistryDirectory(async (directory) => {
    await fs.writeFile(path.join(directory, '20.json'), '{"pid": 20, "status": "id');
    await fs.writeFile(path.join(directory, '21.json'), '');
    await fs.writeFile(path.join(directory, '22.json'), JSON.stringify({ pid: 22 }));
    await fs.writeFile(path.join(directory, '23.json'), JSON.stringify(['idle']));
    await fs.writeFile(path.join(directory, '24.json'), JSON.stringify({ pid: 24, status: 7 }));
    await fs.writeFile(path.join(directory, '25.json'), 'null');
    await fs.mkdir(path.join(directory, '26.json'));
    await fs.writeFile(path.join(directory, '28.json'), JSON.stringify({ pid: 28, status: '  ' }));

    for (const pid of [20, 21, 22, 23, 24, 25, 26, 27, 28]) {
      assert.equal(await readRegistrySignal(pid, directory), null, `pid ${pid}`);
    }
  });
});

test('readRegistrySignal reads the sessions folder of the Claude config directory by default', async () => {
  await withRegistryDirectory(async (configDirectory) => {
    await fs.mkdir(path.join(configDirectory, 'sessions'));
    await fs.writeFile(
      path.join(configDirectory, 'sessions', '30.json'),
      JSON.stringify({ pid: 30, status: 'idle', statusUpdatedAt: 9 }),
    );
    const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDirectory;
    try {
      assert.deepEqual(await readRegistrySignal(30), { status: 'idle', statusUpdatedAt: 9 });
    } finally {
      if (previousConfigDirectory === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
      }
    }
  });
});

test('findShellActivitySignal walks the process tree and prefers busy, then the newest status', async () => {
  const signals = new Map<number, ShellActivitySignal>([
    [2, createSignal('idle', 6)],
    [3, createSignal('idle', 2)],
    [4, createSignal('busy', 9)],
  ]);
  const readSignal = async (pid: number) => signals.get(pid) ?? null;

  const withBusyChild = new Map([[1, [2, 3]], [3, [4]]]);
  assert.deepEqual(await findShellActivitySignal(1, withBusyChild, readSignal), createSignal('busy', 9));

  const withoutBusyChild = new Map([[1, [2, 3]]]);
  assert.deepEqual(await findShellActivitySignal(1, withoutBusyChild, readSignal), createSignal('idle', 2));

  assert.equal(await findShellActivitySignal(9, new Map(), readSignal), null);
});

test('findShellActivitySignal counts a missing timestamp as the oldest and reads the root too', async () => {
  const signals = new Map<number, ShellActivitySignal>([
    [1, createSignal('waiting', null)],
    [2, createSignal('idle', 5)],
  ]);
  const readSignal = async (pid: number) => signals.get(pid) ?? null;

  assert.deepEqual(await findShellActivitySignal(1, new Map([[1, [2]]]), readSignal), createSignal('idle', 5));
  assert.deepEqual(await findShellActivitySignal(1, new Map(), readSignal), createSignal('waiting', null));
});

test('findShellActivitySignal survives a cycle in the process map', async () => {
  const readSignal = async (pid: number) => (pid === 2 ? createSignal('idle', 1) : null);
  const cyclicMap = new Map([[1, [2]], [2, [3]], [3, [1, 2]]]);

  assert.deepEqual(await findShellActivitySignal(1, cyclicMap, readSignal), createSignal('idle', 1));
});

test('without a process listing only the root pid is read and the output clock decides', async () => {
  const readPids: number[] = [];
  const silentPty = createPty('a', { pid: 300, lastOutputAt: NOW - 5 * HOUR_MS });
  const killedKeys = await sweepIdleShells({
    listRetainedShellPtys: () => [silentPty],
    killRetainedShellPty: () => true,
    listProcessChildren: async () => new Map(),
    readRegistrySignal: async (pid) => {
      readPids.push(pid);
      return null;
    },
    now: () => NOW,
    timeoutMs: TIMEOUT_MS,
  });

  assert.deepEqual(readPids, [300]);
  assert.deepEqual(killedKeys, ['a']);
});

test('listProcessChildren lists this process under its parent', async (context) => {
  if (spawnSync('ps', ['-p', String(process.pid)]).error) {
    context.skip('ps is not available here');
    return;
  }

  const childrenByPid = await listProcessChildren();

  assert.ok(childrenByPid.get(process.ppid)?.includes(process.pid));
});

test('a busy descendant keeps a detached pty alive', async () => {
  const detachedPty = createPty('a', { pid: 400 });
  const signals = new Map<number, ShellActivitySignal>([
    [401, createSignal('idle', 9)],
    [402, createSignal('busy', 9)],
  ]);
  const killedKeys = await sweepIdleShells({
    listRetainedShellPtys: () => [detachedPty],
    killRetainedShellPty: () => true,
    listProcessChildren: async () => new Map([[400, [401]], [401, [402]]]),
    readRegistrySignal: async (pid) => signals.get(pid) ?? null,
    now: () => NOW,
    timeoutMs: TIMEOUT_MS,
  });

  assert.deepEqual(killedKeys, []);
});

function createSweepDependencies(
  listRetainedShellPtys: ShellIdleSweepDependencies['listRetainedShellPtys'],
): ShellIdleSweepDependencies {
  return {
    listRetainedShellPtys,
    killRetainedShellPty: () => true,
    listProcessChildren: async () => new Map(),
    readRegistrySignal: async () => null,
    now: () => NOW,
    timeoutMs: TIMEOUT_MS,
  };
}

test('the scheduled sweep skips a tick while a pass is still running', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    const gate = createDeferred();
    let passesStarted = 0;
    const stop = scheduleShellIdleSweep(
      {
        ...createSweepDependencies(() => [createPty('a', { lastOutputAt: NOW })]),
        listProcessChildren: async () => {
          passesStarted += 1;
          await gate.promise;
          return new Map();
        },
      },
      1_000,
    );

    mock.timers.tick(1_000);
    await flushPromises();
    mock.timers.tick(1_000);
    mock.timers.tick(1_000);
    await flushPromises();
    assert.equal(passesStarted, 1, 'ticks during a pass do not start another');

    gate.resolve();
    await flushPromises();
    mock.timers.tick(1_000);
    await flushPromises();
    assert.equal(passesStarted, 2, 'the next tick after the pass runs normally');
    stop();
  } finally {
    mock.timers.reset();
  }
});

test('stopping the scheduled sweep ends the interval', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  try {
    let passesStarted = 0;
    const stop = scheduleShellIdleSweep(
      createSweepDependencies(() => {
        passesStarted += 1;
        return [];
      }),
      1_000,
    );

    mock.timers.tick(1_000);
    await flushPromises();
    stop();
    mock.timers.tick(5_000);
    await flushPromises();

    assert.equal(passesStarted, 1);
  } finally {
    mock.timers.reset();
  }
});

test('a pass that throws is logged and the next tick runs normally', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const logError = mock.method(console, 'error', () => undefined);
  try {
    let passesStarted = 0;
    const stop = scheduleShellIdleSweep(
      createSweepDependencies(() => {
        passesStarted += 1;
        if (passesStarted === 1) {
          throw new Error('listing exploded');
        }
        return [];
      }),
      1_000,
    );

    mock.timers.tick(1_000);
    await flushPromises();
    mock.timers.tick(1_000);
    await flushPromises();

    assert.equal(passesStarted, 2);
    assert.equal(logError.mock.callCount(), 1);
    assert.match(String(logError.mock.calls[0].arguments[0]), /ShellIdleSweepFailed/);
    assert.deepEqual(logError.mock.calls[0].arguments[1], { error: 'listing exploded' });
    stop();
  } finally {
    logError.mock.restore();
    mock.timers.reset();
  }
});
