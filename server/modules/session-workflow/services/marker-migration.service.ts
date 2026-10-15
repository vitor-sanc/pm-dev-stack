import type {
  MarkerMigrationItem,
  MarkerMigrationResult,
  SessionWorkflowRecord,
  SessionWorkflowStatus,
  VisibleSession,
} from '@/shared/types.js';

/** Capabilities the migration needs from outside. Production wiring is in the module; tests pass fakes. */
export type MarkerMigrationDependencies = {
  listVisibleSessions(): VisibleSession[];
  listStatuses(): Map<string, SessionWorkflowRecord>;
  renameSession(sessionId: string, title: string): Promise<unknown>;
  setStatus(sessionId: string, status: SessionWorkflowStatus, now: Date): unknown;
  broadcastSessions(sessionIds: string[]): Promise<void>;
  now(): Date;
};

const CHECK_MARK_PATTERN = /✅️?/g;
const IGNORE_MARKER_PATTERN = /<ignore>/gi;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildMarkerMigrationItem(session: VisibleSession): MarkerMigrationItem | null {
  // `search` ignores the `g` flag and `lastIndex`, so the shared patterns stay stateless.
  const hasIgnoreMarker = session.title.search(IGNORE_MARKER_PATTERN) !== -1;
  const hasCheckMark = session.title.search(CHECK_MARK_PATTERN) !== -1;
  if (!hasIgnoreMarker && !hasCheckMark) {
    return null;
  }

  const withoutMarkers = session.title.replace(IGNORE_MARKER_PATTERN, ' ').replace(CHECK_MARK_PATTERN, ' ');
  const collapsedTitle = withoutMarkers.replace(/\s+/g, ' ').trim();
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    currentTitle: session.title,
    cleanTitle: collapsedTitle === '' ? null : collapsedTitle,
    proposedStatus: hasIgnoreMarker ? 'ignored' : 'closed',
  };
}

/**
 * Used by the Session Workflow composition (preview, apply) and the session grouping
 * (pending count) to list what the marker migration would change. Pure.
 *
 * A check mark title proposes `closed`, an `<ignore>` title proposes `ignored`
 * (it wins when both are present). A title made only of markers has no clean
 * title; once its status is stored there is nothing left to do, so it is left out.
 * A cleanable title stays listed even with its status stored, so a rename that
 * failed after the status was written is retried.
 */
export function findMarkerMigrationItems(
  sessions: VisibleSession[],
  statuses: Map<string, SessionWorkflowRecord>,
): MarkerMigrationItem[] {
  const items: MarkerMigrationItem[] = [];
  for (const session of sessions) {
    const item = buildMarkerMigrationItem(session);
    if (item === null) {
      continue;
    }

    const isAlreadyDone = item.cleanTitle === null && statuses.get(session.sessionId)?.status === item.proposedStatus;
    if (!isAlreadyDone) {
      items.push(item);
    }
  }
  return items;
}

async function migrateMarkerItem(
  item: MarkerMigrationItem,
  dependencies: MarkerMigrationDependencies,
): Promise<void> {
  // The rename goes first: it does not move the session's activity time, so a
  // status stamped afterwards is never older than the activity and the session
  // does not reactivate itself.
  if (item.cleanTitle !== null) {
    await dependencies.renameSession(item.sessionId, item.cleanTitle);
  }
  dependencies.setStatus(item.sessionId, item.proposedStatus, dependencies.now());
}

/**
 * Used by the Session Workflow composition to apply the migration the user previewed.
 *
 * The items are recomputed from the stored data, never taken from the caller,
 * and only the ones whose id was confirmed are applied. Items run one at a time and a
 * failure is reported for its item. A failed rename leaves the item pending for a new
 * attempt; a status write that fails after the rename cannot be retried here, since the
 * marker is already gone, so the status is then set from the row's status menu.
 */
export async function applyMarkerMigration(
  confirmedSessionIds: string[],
  dependencies: MarkerMigrationDependencies,
): Promise<MarkerMigrationResult> {
  const confirmedIds = new Set(confirmedSessionIds);
  const pendingItems = findMarkerMigrationItems(dependencies.listVisibleSessions(), dependencies.listStatuses());

  const result: MarkerMigrationResult = { applied: [], failed: [] };
  for (const item of pendingItems) {
    if (!confirmedIds.has(item.sessionId)) {
      continue;
    }

    try {
      await migrateMarkerItem(item, dependencies);
      result.applied.push(item.sessionId);
    } catch (error) {
      result.failed.push({ sessionId: item.sessionId, message: describeError(error) });
    }
  }

  if (result.applied.length > 0) {
    // The statuses are stored by now. A failed announcement only delays other
    // browser tabs, so it is logged and the result stays the same.
    try {
      await dependencies.broadcastSessions(result.applied);
    } catch (error) {
      console.error('[SessionWorkflow] MarkerMigrationBroadcastFailed', {
        sessionIds: result.applied,
        error: describeError(error),
      });
    }
  }
  return result;
}
