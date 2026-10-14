import { broadcastSessionUpserted } from '@/modules/websocket/index.js';
import { buildSessionGroupsView } from '@/modules/session-workflow/services/session-grouping.service.js';
import {
  listSessionWorkflowRecords,
  setSessionWorkflowStatus,
} from '@/modules/session-workflow/services/session-status.service.js';
import { listVisibleSessions } from '@/modules/session-workflow/services/visible-sessions.service.js';
import { createSessionWorkflowRouter } from '@/modules/session-workflow/session-workflow.routes.js';
import type { SessionWorkflowServices } from '@/shared/types.js';

/** Capabilities the composition needs from outside. Production wiring is below; tests pass fakes. */
type SessionWorkflowCompositionDependencies = {
  broadcastSessionUpserted(sessionId: string): Promise<void>;
  now(): Date;
  resolveClientSlug(prefix: string): string | null;
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
}));
