import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { RetainedShellPty } from '@/shared/types.js';
import { getClaudeConfigDir } from '@/shared/utils.js';

const execFileAsync = promisify(execFile);

const SHELL_IDLE_SWEEP_INTERVAL_MS = 60_000;
const DEFAULT_SHELL_IDLE_TIMEOUT_HOURS = 4;
const PROCESS_LIST_TIMEOUT_MS = 10_000;
const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;

/**
 * What the Claude Code session registry says a claude process is doing.
 *
 * `unknown` stands for a status string this code does not know, and keeps the
 * Shell alive. `statusUpdatedAt` is epoch milliseconds, or `null` when the
 * registry entry has no usable timestamp.
 */
export type ShellActivitySignal = {
  status: 'busy' | 'idle' | 'waiting' | 'shell' | 'unknown';
  statusUpdatedAt: number | null;
};

type IdleShellDecisionInput = {
  ptys: RetainedShellPty[];
  signals: Map<string, ShellActivitySignal | null>;
  now: number;
  timeoutMs: number;
};

/** Capabilities one sweep pass needs from outside. Production wiring is in the module; tests pass fakes. */
export type ShellIdleSweepDependencies = {
  listRetainedShellPtys(): RetainedShellPty[];
  killRetainedShellPty(key: string, detachedAt: number): boolean;
  listProcessChildren(): Promise<Map<number, number[]>>;
  readRegistrySignal(pid: number): Promise<ShellActivitySignal | null>;
  now(): number;
  timeoutMs: number;
};

const REGISTRY_STATUSES = ['busy', 'idle', 'waiting', 'shell'] as const;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Used by the session-workflow composition to turn `SHELL_IDLE_TIMEOUT_HOURS`
 * into milliseconds. A missing or empty value means the default silently; any
 * other value that is not a positive finite number falls back to the default
 * with a warning, so a typo never makes Shells die at once.
 */
export function readShellIdleTimeoutMs(environment: NodeJS.ProcessEnv): number {
  const defaultTimeoutMs = DEFAULT_SHELL_IDLE_TIMEOUT_HOURS * MILLISECONDS_PER_HOUR;
  const configuredValue = environment.SHELL_IDLE_TIMEOUT_HOURS?.trim();
  if (!configuredValue) {
    return defaultTimeoutMs;
  }

  const hours = Number(configuredValue);
  const isUsableHours = Number.isFinite(hours) && hours > 0;
  if (!isUsableHours) {
    console.warn('[SessionWorkflow] InvalidShellIdleTimeout', { value: configuredValue });
    return defaultTimeoutMs;
  }
  return hours * MILLISECONDS_PER_HOUR;
}

/**
 * Used by the session-workflow composition to learn which process descends
 * from which, so the claude process behind a Shell PTY can be found. The map
 * goes from a parent pid to its child pids. Windows, a failing `ps` and a
 * `ps` that outlives its timeout all give an empty map, which makes the sweep
 * judge every PTY by its last output instead.
 */
export async function listProcessChildren(): Promise<Map<number, number[]>> {
  const childrenByPid = new Map<number, number[]>();
  if (process.platform === 'win32') {
    return childrenByPid;
  }

  let processTable: string;
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], {
      timeout: PROCESS_LIST_TIMEOUT_MS,
    });
    processTable = stdout;
  } catch (error) {
    console.warn('[SessionWorkflow] ProcessListFailed', { error: describeError(error) });
    return childrenByPid;
  }

  for (const line of processTable.split('\n')) {
    const [pidText, parentPidText] = line.trim().split(/\s+/);
    const pid = Number(pidText);
    const parentPid = Number(parentPidText);
    if (!Number.isInteger(pid) || !Number.isInteger(parentPid)) {
      continue;
    }
    const siblings = childrenByPid.get(parentPid) ?? [];
    siblings.push(pid);
    childrenByPid.set(parentPid, siblings);
  }
  return childrenByPid;
}

/**
 * Used by the session-workflow composition to read the Claude Code session
 * registry entry of one process (`<registryDirectory>/<pid>.json`). The
 * default directory is the one the claude inside a Shell PTY writes to, because
 * the PTY inherits the server environment. Returns `null` for a missing,
 * unreadable or malformed file and for an entry without a non-blank `status`
 * string. A read failure other than a missing file is logged, since it moves the
 * PTY to the output clock.
 */
export async function readRegistrySignal(
  pid: number,
  registryDirectory: string = path.join(getClaudeConfigDir(), 'sessions'),
): Promise<ShellActivitySignal | null> {
  let rawEntry: string;
  try {
    rawEntry = await fs.readFile(path.join(registryDirectory, `${pid}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[SessionWorkflow] RegistryReadFailed', {
        pid,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  let entry: unknown;
  try {
    entry = JSON.parse(rawEntry);
  } catch {
    return null;
  }

  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const { status, statusUpdatedAt } = entry as Record<string, unknown>;
  if (typeof status !== 'string' || status.trim() === '') {
    return null;
  }

  const knownStatus = REGISTRY_STATUSES.find((candidate) => candidate === status);
  return {
    status: knownStatus ?? 'unknown',
    statusUpdatedAt: typeof statusUpdatedAt === 'number' && Number.isFinite(statusUpdatedAt)
      ? statusUpdatedAt
      : null,
  };
}

/**
 * Used by the sweep to find what the claude behind a PTY is doing. It reads the
 * registry entry of the PTY's process and of every descendant. A `busy` entry
 * wins; otherwise the entry with the newest `statusUpdatedAt` (no timestamp
 * counts as oldest). Returns `null` when no process in the tree has an entry.
 */
export async function findShellActivitySignal(
  rootPid: number,
  childrenByPid: Map<number, number[]>,
  readSignal: (pid: number) => Promise<ShellActivitySignal | null>,
): Promise<ShellActivitySignal | null> {
  const visitedPids = new Set<number>();
  const pidsToVisit = [rootPid];
  let newestSignal: ShellActivitySignal | null = null;

  while (pidsToVisit.length > 0) {
    const pid = pidsToVisit.shift() as number;
    if (visitedPids.has(pid)) {
      continue;
    }
    visitedPids.add(pid);
    pidsToVisit.push(...(childrenByPid.get(pid) ?? []));

    const signal = await readSignal(pid);
    if (!signal) {
      continue;
    }
    if (signal.status === 'busy') {
      return signal;
    }
    const newestUpdatedAt = newestSignal?.statusUpdatedAt ?? -Infinity;
    const isNewerThanKnown = newestSignal === null || (signal.statusUpdatedAt ?? -Infinity) > newestUpdatedAt;
    if (isNewerThanKnown) {
      newestSignal = signal;
    }
  }
  return newestSignal;
}

/**
 * Used by the sweep, and exported for the tests: decides which detached PTYs
 * have been idle for `timeoutMs` and returns their keys.
 *
 * An attached PTY never dies. With a registry signal, only `idle` and
 * `waiting` start a clock, from the later of the detach and the status change;
 * `busy`, `shell` and `unknown` keep the PTY. Without a signal the clock starts
 * at the later of the detach and the last PTY output.
 */
export function decideIdleShellKills(input: IdleShellDecisionInput): string[] {
  const keysToKill: string[] = [];
  for (const pty of input.ptys) {
    if (pty.attached || pty.detachedAt === null) {
      continue;
    }

    const signal = input.signals.get(pty.key) ?? null;
    let idleSince: number;
    if (signal === null) {
      idleSince = Math.max(pty.detachedAt, pty.lastOutputAt);
    } else if (signal.status === 'idle' || signal.status === 'waiting') {
      idleSince = Math.max(pty.detachedAt, signal.statusUpdatedAt ?? pty.detachedAt);
    } else {
      continue;
    }

    const hasBeenIdleLongEnough = input.now - idleSince >= input.timeoutMs;
    if (hasBeenIdleLongEnough) {
      keysToKill.push(pty.key);
    }
  }
  return keysToKill;
}

/**
 * Used by `scheduleShellIdleSweep` and exported for the tests: one pass over
 * the retained PTYs. Returns the keys of the PTYs it actually killed. A kill
 * the websocket module refuses (the user came back meanwhile) is not returned.
 */
export async function sweepIdleShells(dependencies: ShellIdleSweepDependencies): Promise<string[]> {
  const ptys = dependencies.listRetainedShellPtys();
  const detachedPtysWithPid = ptys.filter((pty) => !pty.attached && pty.pid !== null);

  const signals = new Map<string, ShellActivitySignal | null>();
  if (detachedPtysWithPid.length > 0) {
    const childrenByPid = await dependencies.listProcessChildren();
    for (const pty of detachedPtysWithPid) {
      signals.set(
        pty.key,
        await findShellActivitySignal(pty.pid as number, childrenByPid, dependencies.readRegistrySignal),
      );
    }
  }

  const keysToKill = decideIdleShellKills({
    ptys,
    signals,
    now: dependencies.now(),
    timeoutMs: dependencies.timeoutMs,
  });

  const killedKeys: string[] = [];
  for (const key of keysToKill) {
    const pty = ptys.find((candidate) => candidate.key === key) as RetainedShellPty;
    const wasKilled = dependencies.killRetainedShellPty(key, pty.detachedAt as number);
    if (wasKilled) {
      killedKeys.push(key);
      console.log('[SessionWorkflow] IdleShellKilled', { key, pid: pty.pid, sessionId: pty.sessionId });
    }
  }
  return killedKeys;
}

/**
 * Used by the session-workflow composition to run `sweepIdleShells` once a
 * minute. A tick that finds the previous pass still running does nothing, and a
 * pass that throws is logged without stopping the schedule. The interval does
 * not keep the process alive. Returns the function that stops the schedule.
 */
export function scheduleShellIdleSweep(
  dependencies: ShellIdleSweepDependencies,
  intervalMs: number = SHELL_IDLE_SWEEP_INTERVAL_MS,
): () => void {
  let isSweepRunning = false;

  const interval = setInterval(() => {
    if (isSweepRunning) {
      return;
    }
    isSweepRunning = true;
    sweepIdleShells(dependencies)
      .catch((error: unknown) => {
        console.error('[SessionWorkflow] ShellIdleSweepFailed', { error: describeError(error) });
      })
      .finally(() => {
        isSweepRunning = false;
      });
  }, intervalMs);
  interval.unref();

  return () => clearInterval(interval);
}
