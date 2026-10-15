import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSessionGroupsView,
  findClientManagementSessions,
  type BuildSessionGroupsInput,
} from '@/modules/session-workflow/services/session-grouping.service.js';
import type {
  SessionGroup,
  SessionWorkflowRecord,
  VisibleSession,
} from '@/shared/types.js';

const STATUS_SET_AT = '2026-10-01T00:00:00.000Z';

function createSession(
  sessionId: string,
  title: string,
  lastActivity: string | null,
  overrides: Partial<VisibleSession> = {},
): VisibleSession {
  return {
    sessionId,
    provider: 'claude',
    projectId: null,
    title,
    lastActivity,
    forkedFromSessionId: null,
    ...overrides,
  };
}

function createStatuses(
  entries: Array<[string, SessionWorkflowRecord['status']]>,
): Map<string, SessionWorkflowRecord> {
  const statuses = new Map<string, SessionWorkflowRecord>();
  for (const [sessionId, status] of entries) {
    statuses.set(sessionId, { sessionId, status, statusSetAt: STATUS_SET_AT });
  }
  return statuses;
}

function buildView(
  sessions: VisibleSession[],
  overrides: Partial<BuildSessionGroupsInput> = {},
) {
  return buildSessionGroupsView({
    sessions,
    statuses: new Map(),
    resolveClientSlug: () => null,
    includeIgnored: false,
    ...overrides,
  });
}

function findGroup(groups: SessionGroup[], key: string): SessionGroup {
  const group = groups.find((candidate) => candidate.key === key);
  assert.ok(group, `group "${key}" must exist, found: ${groups.map((candidate) => candidate.key).join(', ')}`);
  return group;
}

function listIds(sessions: Array<{ sessionId: string }>): string[] {
  return sessions.map((session) => session.sessionId);
}

test('titles that differ only by case and accents share one group labelled by the newest session', () => {
  const view = buildView([
    createSession('old', 'ACME / Relatórios', '2026-10-01T10:00:00.000Z'),
    createSession('new', 'Acme / Tema', '2026-10-02T10:00:00.000Z'),
  ]);

  const group = findGroup(view.groups, 'prefix:acme');
  assert.equal(group.kind, 'prefix');
  assert.equal(group.label, 'Acme');
  assert.deepEqual(listIds(group.sessions), ['new', 'old']);
  assert.deepEqual(group.sessions.map((session) => session.displayTitle), ['Tema', 'Relatórios']);
  assert.deepEqual(group.sessions.map((session) => session.titlePrefix), ['Acme', 'ACME']);
});

test('groups are alphabetical in pt-BR, management first and loose last', () => {
  const view = buildView([
    createSession('globex', 'Globex / Tema', '2026-10-02T10:00:00.000Z'),
    createSession('loose', 'Sem barra', '2026-10-05T10:00:00.000Z'),
    createSession('acme', 'Acme / Tema', '2026-10-01T10:00:00.000Z'),
    createSession('accent', 'Álamo / Tema', '2026-10-01T10:00:00.000Z'),
    createSession('management', 'Gestão / Prazos', '2026-10-03T10:00:00.000Z'),
  ]);

  assert.deepEqual(
    view.groups.map((group) => group.key),
    ['management', 'prefix:acme', 'prefix:alamo', 'prefix:globex', 'loose'],
  );
  assert.equal(findGroup(view.groups, 'loose').label, 'Avulsas');
  assert.equal(findGroup(view.groups, 'loose').kind, 'loose');
});

test('the management section takes both spellings and exists even when empty', () => {
  const populated = buildView([
    createSession('first', 'Gestão / X', '2026-10-01T10:00:00.000Z'),
    createSession('second', 'gestao / Y', '2026-10-02T10:00:00.000Z'),
    createSession('acme', 'Acme / Tema', '2026-10-03T10:00:00.000Z'),
  ]);
  const empty = buildView([createSession('acme', 'Acme / Tema', '2026-10-03T10:00:00.000Z')]);

  const management = findGroup(populated.groups, 'management');
  assert.equal(populated.groups[0].key, 'management');
  assert.equal(management.kind, 'management');
  assert.deepEqual(listIds(management.sessions), ['second', 'first']);
  assert.deepEqual(management.sessions.map((session) => session.displayTitle), ['Y', 'X']);
  assert.equal(empty.groups[0].key, 'management');
  assert.deepEqual(empty.groups[0].sessions, []);
});

test('a client management session is pinned in its group, not listed with the others', () => {
  const view = buildView([
    createSession('pinned-one', 'Acme / Gestão', '2026-10-01T10:00:00.000Z'),
    createSession('pinned-two', 'ACME / gestao', '2026-10-03T10:00:00.000Z'),
    createSession('regular', 'Acme / Tema', '2026-10-02T10:00:00.000Z'),
  ]);

  const group = findGroup(view.groups, 'prefix:acme');
  assert.deepEqual(listIds(group.pinnedSessions), ['pinned-two', 'pinned-one']);
  assert.deepEqual(listIds(group.sessions), ['regular']);
});

test('a paused management session stays pinned', () => {
  const view = buildView(
    [createSession('pinned', 'Acme / Gestão', '2026-09-01T10:00:00.000Z')],
    { statuses: createStatuses([['pinned', 'paused']]) },
  );

  const group = findGroup(view.groups, 'prefix:acme');
  assert.deepEqual(listIds(group.pinnedSessions), ['pinned']);
  assert.equal(group.pinnedSessions[0].status, 'paused');
});

test('a closed management session goes to the closed bucket, not pinned', () => {
  const view = buildView(
    [createSession('shut', 'Acme / Gestão', '2026-09-01T10:00:00.000Z')],
    { statuses: createStatuses([['shut', 'closed']]) },
  );

  const group = findGroup(view.groups, 'prefix:acme');
  assert.deepEqual(group.pinnedSessions, []);
  assert.deepEqual(listIds(group.closedSessions), ['shut']);
});

test('closed sessions get their own bucket and paused ones stay in the main list', () => {
  const view = buildView(
    [
      createSession('open', 'Acme / A', '2026-09-03T10:00:00.000Z'),
      createSession('paused', 'Acme / B', '2026-09-02T10:00:00.000Z'),
      createSession('closed', 'Acme / C', '2026-09-04T10:00:00.000Z'),
    ],
    { statuses: createStatuses([['paused', 'paused'], ['closed', 'closed']]) },
  );

  const group = findGroup(view.groups, 'prefix:acme');
  assert.deepEqual(listIds(group.sessions), ['open', 'paused']);
  assert.equal(group.sessions[1].status, 'paused');
  assert.deepEqual(listIds(group.closedSessions), ['closed']);
  assert.equal(group.closedSessions[0].status, 'closed');
});

test('a closed session with newer activity is active again and returns to the main list', () => {
  const view = buildView(
    [createSession('woken', 'Acme / A', '2026-10-05T10:00:00.000Z')],
    { statuses: createStatuses([['woken', 'closed']]) },
  );

  const group = findGroup(view.groups, 'prefix:acme');
  assert.deepEqual(listIds(group.sessions), ['woken']);
  assert.equal(group.sessions[0].status, 'active');
  assert.deepEqual(group.closedSessions, []);
});

test('ignored sessions are dropped unless the caller asks for them', () => {
  const sessions = [
    createSession('visible', 'Acme / A', '2026-10-02T10:00:00.000Z'),
    createSession('hidden', 'Acme / B', '2026-10-03T10:00:00.000Z'),
  ];
  const statuses = createStatuses([['hidden', 'ignored']]);

  const withoutIgnored = buildView(sessions, { statuses });
  const withIgnored = buildView(sessions, { statuses, includeIgnored: true });

  const plainGroup = findGroup(withoutIgnored.groups, 'prefix:acme');
  assert.deepEqual(listIds(plainGroup.sessions), ['visible']);
  assert.deepEqual(plainGroup.ignoredSessions, []);
  const ignoredGroup = findGroup(withIgnored.groups, 'prefix:acme');
  assert.deepEqual(listIds(ignoredGroup.ignoredSessions), ['hidden']);
  assert.equal(ignoredGroup.ignoredSessions[0].status, 'ignored');
});

test('a group with only ignored sessions disappears unless ignored sessions are requested', () => {
  const sessions = [createSession('hidden', 'Globex / A', '2026-10-03T10:00:00.000Z')];
  const statuses = createStatuses([['hidden', 'ignored']]);

  const withoutIgnored = buildView(sessions, { statuses });
  const withIgnored = buildView(sessions, { statuses, includeIgnored: true });

  assert.deepEqual(withoutIgnored.groups.map((group) => group.key), ['management']);
  assert.deepEqual(withIgnored.groups.map((group) => group.key), ['management', 'prefix:globex']);
});

test('a fork shows the title of the session it was branched from', () => {
  const view = buildView([
    createSession('origin', 'Acme / Tema', '2026-10-01T10:00:00.000Z'),
    createSession('fork', 'Acme / Tema v2', '2026-10-02T10:00:00.000Z', { forkedFromSessionId: 'origin' }),
    createSession('orphan', 'Acme / Outro', '2026-10-03T10:00:00.000Z', { forkedFromSessionId: 'gone' }),
  ]);

  const group = findGroup(view.groups, 'prefix:acme');
  const byId = new Map(group.sessions.map((session) => [session.sessionId, session]));
  assert.equal(byId.get('fork')?.forkedFromTitle, 'Acme / Tema');
  assert.equal(byId.get('fork')?.forkedFromSessionId, 'origin');
  assert.equal(byId.get('origin')?.forkedFromTitle, null);
  assert.equal(byId.get('orphan')?.forkedFromTitle, null);
  assert.equal(byId.get('orphan')?.forkedFromSessionId, 'gone');
});

test('the group takes its client slug from the resolver and defaults to null', () => {
  const sessions = [createSession('one', 'Acme / A', '2026-10-01T10:00:00.000Z')];

  const unresolved = buildView(sessions);
  const resolved = buildView(sessions, {
    resolveClientSlug: (prefix) => (prefix === 'Acme' ? 'acme' : null),
  });

  assert.equal(findGroup(unresolved.groups, 'prefix:acme').clientSlug, null);
  assert.equal(findGroup(resolved.groups, 'prefix:acme').clientSlug, 'acme');
});

test('a title with two separators splits at the first one', () => {
  const view = buildView([createSession('one', 'Acme / Tema / Parte 2', '2026-10-01T10:00:00.000Z')]);

  const group = findGroup(view.groups, 'prefix:acme');
  assert.equal(group.sessions[0].displayTitle, 'Tema / Parte 2');
});

test('titles without a spaced slash, or with an empty prefix, are loose', () => {
  const view = buildView([
    createSession('no-spaces', 'Acme/Tema', '2026-10-04T10:00:00.000Z'),
    createSession('symbol-only', '— / x', '2026-10-03T10:00:00.000Z'),
    createSession('id-title', 'abc-123', '2026-10-02T10:00:00.000Z'),
    createSession('no-slash', 'Sem barra', '2026-10-01T10:00:00.000Z'),
  ]);

  const loose = findGroup(view.groups, 'loose');
  assert.deepEqual(listIds(loose.sessions), ['no-spaces', 'symbol-only', 'id-title', 'no-slash']);
  assert.deepEqual(loose.sessions.map((session) => session.displayTitle), ['Acme/Tema', '— / x', 'abc-123', 'Sem barra']);
  assert.equal(loose.sessions[0].titlePrefix, null);
  assert.equal(view.groups.length, 2);
});

test('a session without activity sorts after the ones with activity', () => {
  const view = buildView([
    createSession('undated', 'Acme / A', null),
    createSession('dated', 'Acme / B', '2026-10-01T10:00:00.000Z'),
  ]);

  assert.deepEqual(listIds(findGroup(view.groups, 'prefix:acme').sessions), ['dated', 'undated']);
});

test('no sessions at all still yields the management section', () => {
  const view = buildView([]);

  assert.deepEqual(view.groups.map((group) => group.key), ['management']);
  assert.equal(view.pendingMarkerCount, 0);
});

test('findClientManagementSessions returns the client management sessions, newest first', () => {
  const sessions = [
    createSession('old', 'Acme / Gestão', '2026-10-01T10:00:00.000Z'),
    createSession('new', 'ACME / gestao', '2026-10-03T10:00:00.000Z'),
    createSession('other-client', 'Globex / Gestão', '2026-10-04T10:00:00.000Z'),
    createSession('regular', 'Acme / Tema', '2026-10-05T10:00:00.000Z'),
    createSession('loose', 'Gestão', '2026-10-06T10:00:00.000Z'),
  ];
  const resolveClientSlug = (prefix: string) => (prefix.toLowerCase() === 'acme' ? 'acme' : null);

  const found = findClientManagementSessions(sessions, 'acme', resolveClientSlug);

  assert.deepEqual(listIds(found), ['new', 'old']);
});

test('findClientManagementSessions finds nothing when no prefix resolves to the slug', () => {
  const sessions = [createSession('old', 'Acme / Gestão', '2026-10-01T10:00:00.000Z')];

  assert.deepEqual(findClientManagementSessions(sessions, 'acme', () => null), []);
});

test('pendingMarkerCount counts titles with a marker, also for ignored sessions hidden by the filter', () => {
  const sessions = [
    createSession('closed-marker', '✅ Acme / A', '2026-10-01T10:00:00.000Z'),
    createSession('ignored-marker', 'Acme / B <ignore>', '2026-10-01T09:00:00.000Z'),
    createSession('plain', 'Acme / C', '2026-10-01T08:00:00.000Z'),
  ];
  const statuses = createStatuses([['ignored-marker', 'ignored']]);

  const hiddenView = buildView(sessions, { statuses, includeIgnored: false });
  const shownView = buildView(sessions, { statuses, includeIgnored: true });

  assert.equal(hiddenView.pendingMarkerCount, 2);
  assert.equal(shownView.pendingMarkerCount, 2);
});
