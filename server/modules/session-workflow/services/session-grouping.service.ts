import { findMarkerMigrationItems } from '@/modules/session-workflow/services/marker-migration.service.js';
import { resolveEffectiveSessionStatus } from '@/modules/session-workflow/services/session-status.service.js';
import type {
  GroupedSession,
  SessionGroup,
  SessionGroupKind,
  SessionGroupsView,
  SessionWorkflowRecord,
  SessionWorkflowStatus,
  VisibleSession,
} from '@/shared/types.js';

/** Input of `buildSessionGroupsView`. Used by the Session Workflow composition and its tests. */
export type BuildSessionGroupsInput = {
  sessions: VisibleSession[];
  statuses: Map<string, SessionWorkflowRecord>;
  resolveClientSlug: (prefix: string) => string | null;
  includeIgnored: boolean;
};

type TitleParts = { prefix: string; rest: string };

const TITLE_SEPARATOR = ' / ';
const MANAGEMENT_KEY = 'gestao';
const MANAGEMENT_GROUP_KEY = 'management';
const MANAGEMENT_GROUP_LABEL = 'Gestão';
const LOOSE_GROUP_KEY = 'loose';
const LOOSE_GROUP_LABEL = 'Avulsas';
const GROUP_LABEL_LOCALE = 'pt-BR';

function normalizeTitleKey(value: string): string {
  const withoutAccents = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return withoutAccents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function splitTitle(title: string): TitleParts | null {
  const separatorIndex = title.indexOf(TITLE_SEPARATOR);
  if (separatorIndex === -1) {
    return null;
  }

  const prefix = title.slice(0, separatorIndex);
  if (normalizeTitleKey(prefix) === '') {
    return null;
  }
  return { prefix, rest: title.slice(separatorIndex + TITLE_SEPARATOR.length) };
}

function readActivityTime(session: VisibleSession): number {
  const parsedTime = session.lastActivity === null ? Number.NaN : Date.parse(session.lastActivity);
  return Number.isNaN(parsedTime) ? Number.NEGATIVE_INFINITY : parsedTime;
}

function sortNewestFirst(sessions: VisibleSession[]): VisibleSession[] {
  return [...sessions].sort((left, right) => {
    const leftTime = readActivityTime(left);
    const rightTime = readActivityTime(right);
    if (leftTime === rightTime) {
      return 0;
    }
    return leftTime > rightTime ? -1 : 1;
  });
}

function createEmptyGroup(key: string, kind: SessionGroupKind, label: string): SessionGroup {
  return {
    key,
    kind,
    label,
    clientSlug: null,
    pinnedSessions: [],
    sessions: [],
    closedSessions: [],
    ignoredSessions: [],
  };
}

function isManagementRest(parts: TitleParts): boolean {
  return normalizeTitleKey(parts.rest) === MANAGEMENT_KEY;
}

function buildGroupedSession(
  session: VisibleSession,
  parts: TitleParts | null,
  status: SessionWorkflowStatus,
  titlesById: Map<string, string>,
): GroupedSession {
  const trimmedRest = parts?.rest.trim() ?? '';
  const displayTitle = parts !== null && trimmedRest !== '' ? trimmedRest : session.title;
  const forkedFromTitle = session.forkedFromSessionId === null
    ? null
    : titlesById.get(session.forkedFromSessionId) ?? null;

  return {
    sessionId: session.sessionId,
    provider: session.provider,
    projectId: session.projectId,
    title: session.title,
    displayTitle,
    titlePrefix: parts?.prefix ?? null,
    lastActivity: session.lastActivity,
    status,
    forkedFromSessionId: session.forkedFromSessionId,
    forkedFromTitle,
  };
}

/** Returns the bucket for a status, or null when the session is dropped. */
function pickBucket(
  group: SessionGroup,
  status: SessionWorkflowStatus,
  includeIgnored: boolean,
): GroupedSession[] | null {
  if (status === 'closed') {
    return group.closedSessions;
  }
  if (status === 'ignored') {
    return includeIgnored ? group.ignoredSessions : null;
  }
  return group.sessions;
}

function compareGroupLabels(left: SessionGroup, right: SessionGroup): number {
  return left.label.localeCompare(right.label, GROUP_LABEL_LOCALE, { sensitivity: 'base' });
}

/**
 * Used by the Session Workflow composition to arrange every visible session
 * into sidebar groups. Pure: statuses and the client resolver come in as input.
 *
 * Order of groups: Management first (present even when empty), client prefix
 * groups alphabetically, then loose sessions when there are any. A group with
 * no visible session is omitted.
 */
export function buildSessionGroupsView(input: BuildSessionGroupsInput): SessionGroupsView {
  const titlesById = new Map<string, string>();
  for (const session of input.sessions) {
    titlesById.set(session.sessionId, session.title);
  }

  const managementGroup = createEmptyGroup(MANAGEMENT_GROUP_KEY, 'management', MANAGEMENT_GROUP_LABEL);
  const looseGroup = createEmptyGroup(LOOSE_GROUP_KEY, 'loose', LOOSE_GROUP_LABEL);
  const prefixGroups = new Map<string, SessionGroup>();

  // Newest first, so each bucket stays ordered and the first session placed in a
  // prefix group is its most recent: its raw prefix becomes the group label.
  for (const session of sortNewestFirst(input.sessions)) {
    const parts = splitTitle(session.title);
    const status = resolveEffectiveSessionStatus(input.statuses.get(session.sessionId), session.lastActivity);

    let group = looseGroup;
    if (parts !== null && normalizeTitleKey(parts.prefix) === MANAGEMENT_KEY) {
      group = managementGroup;
    } else if (parts !== null) {
      const groupKey = `prefix:${normalizeTitleKey(parts.prefix)}`;
      group = prefixGroups.get(groupKey) ?? createEmptyGroup(groupKey, 'prefix', parts.prefix);
      group.clientSlug ??= input.resolveClientSlug(parts.prefix);
    }

    const groupedSession = buildGroupedSession(session, parts, status, titlesById);
    const isPinned = group.kind === 'prefix'
      && parts !== null
      && isManagementRest(parts)
      && (status === 'active' || status === 'paused');
    const bucket = isPinned ? group.pinnedSessions : pickBucket(group, status, input.includeIgnored);
    if (bucket === null) {
      continue;
    }

    bucket.push(groupedSession);
    if (group.kind === 'prefix') {
      prefixGroups.set(group.key, group);
    }
  }

  const orderedPrefixGroups = [...prefixGroups.values()].sort(compareGroupLabels);
  const hasLooseSessions = looseGroup.sessions.length + looseGroup.closedSessions.length
    + looseGroup.ignoredSessions.length > 0;
  const groups = [managementGroup, ...orderedPrefixGroups];
  if (hasLooseSessions) {
    groups.push(looseGroup);
  }

  return { groups, pendingMarkerCount: findMarkerMigrationItems(input.sessions, input.statuses).length };
}

/**
 * Used by the management-session launcher to find the existing management
 * sessions of one client, newest first. It applies the same prefix and
 * "Gestão" rules as the grouping, so the detection lives in one place.
 */
export function findClientManagementSessions(
  sessions: VisibleSession[],
  slug: string,
  resolveClientSlug: (prefix: string) => string | null,
): VisibleSession[] {
  const managementSessions = sessions.filter((session) => {
    const parts = splitTitle(session.title);
    return parts !== null
      && normalizeTitleKey(parts.prefix) !== MANAGEMENT_KEY
      && isManagementRest(parts)
      && resolveClientSlug(parts.prefix) === slug;
  });
  return sortNewestFirst(managementSessions);
}
