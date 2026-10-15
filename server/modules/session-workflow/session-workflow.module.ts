import { sessionsService } from '@/modules/providers/index.js';
import {
  broadcastSessionUpserted,
  broadcastSessionUpsertedBatch,
  killRetainedShellPty,
  listRetainedShellPtys,
} from '@/modules/websocket/index.js';
import {
  applyMarkerMigration,
  findMarkerMigrationItems,
} from '@/modules/session-workflow/services/marker-migration.service.js';
import { buildSessionGroupsView } from '@/modules/session-workflow/services/session-grouping.service.js';
import {
  listSessionWorkflowRecords,
  setSessionWorkflowStatus,
} from '@/modules/session-workflow/services/session-status.service.js';
import {
  listProcessChildren,
  readRegistrySignal,
  readShellIdleTimeoutMs,
  scheduleShellIdleSweep,
} from '@/modules/session-workflow/services/shell-idle-policy.service.js';
import { listVisibleSessions } from '@/modules/session-workflow/services/visible-sessions.service.js';
import { createSessionWorkflowRouter } from '@/modules/session-workflow/session-workflow.routes.js';
import type { SessionWorkflowServices } from '@/shared/types.js';

/** Capabilities the composition needs from outside. Production wiring is below; tests pass fakes. */
type SessionWorkflowCompositionDependencies = {
  broadcastSessionUpserted(sessionId: string): Promise<void>;
  now(): Date;
  resolveClientSlug(prefix: string): string | null;
  renameSession(sessionId: string, title: string): Promise<unknown>;
  broadcastSessions(sessionIds: string[]): Promise<void>;
};

/**
 * Composes the Session Workflow services from storage, the session reader and
 * the grouping rules. Exported for the module tests.
 */
export function createSessionWorkflowServices(
  dependencies: SessionWorkflowCompositionDependencies,
): SessionWorkflowServices {
  return {
    getSessionGroups: ({ includeIgnored }) => buildSessionGroupsView({
      sessions: listVisibleSessions(),
      statuses: listSessionWorkflowRecords(),
      resolveClientSlug: dependencies.resolveClientSlug,
      includeIgnored,
    }),
    async setSessionStatus(sessionId, status) {
      const change = setSessionWorkflowStatus(sessionId, status, dependencies.now());

      // The status is stored by now. A failed announcement only delays other
      // browser tabs, so it is logged and the change still succeeds.
      try {
        await dependencies.broadcastSessionUpserted(sessionId);
      } catch (error) {
        console.error('[SessionWorkflow] StatusBroadcastFailed', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return change;
    },
    previewMarkerMigration: () => ({
      items: findMarkerMigrationItems(listVisibleSessions(), listSessionWorkflowRecords()),
    }),
    applyMarkerMigration: (sessionIds) => applyMarkerMigration(sessionIds, {
      listVisibleSessions,
      listStatuses: listSessionWorkflowRecords,
      renameSession: dependencies.renameSession,
      setStatus: setSessionWorkflowStatus,
      broadcastSessions: dependencies.broadcastSessions,
      now: dependencies.now,
    }),
  };
}

/**
 * Session Workflow router mounted by the server entrypoint at `/api/session-workflow`.
 *
 * The client index arrives with a later epic, so no prefix resolves to a client yet.
 */
export const sessionWorkflowRoutes = createSessionWorkflowRouter(createSessionWorkflowServices({
  broadcastSessionUpserted,
  now: () => new Date(),
  resolveClientSlug: () => null,
  renameSession: (sessionId, title) => sessionsService.renameSessionById(sessionId, title),
  broadcastSessions: broadcastSessionUpsertedBatch,
}));

/**
 * Starts the once-a-minute sweep that ends detached Shell PTYs whose claude
 * has been idle for `SHELL_IDLE_TIMEOUT_HOURS`. The server entrypoint calls it
 * when the HTTP server starts listening. Returns the function that stops it.
 * The timeout is read here, at call time, so the environment file is loaded.
 */
export function startShellIdleSweep(): () => void {
  return scheduleShellIdleSweep({
    listRetainedShellPtys,
    killRetainedShellPty,
    listProcessChildren,
    readRegistrySignal,
    now: Date.now,
    timeoutMs: readShellIdleTimeoutMs(process.env),
  });
}
