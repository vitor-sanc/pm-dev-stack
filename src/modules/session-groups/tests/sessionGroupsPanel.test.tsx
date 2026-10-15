import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { GroupedSession, ProjectSession, ServerEvent, SessionGroup, SessionGroupsView } from '@/shared/types';
import SessionGroupsPanel from '@/modules/session-groups/SessionGroupsPanel';

/**
 * The Clients tab renders what the server's grouping endpoint returns, in the
 * order it returns it. The tests drive the panel through the mocked API and
 * websocket, and read the DOM the way a user would.
 */

const groupsRequest = vi.fn();
const setStatusRequest = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    sessionWorkflow: {
      groups: (includeIgnored: boolean) => groupsRequest(includeIgnored),
      setStatus: (sessionId: string, status: string) => setStatusRequest(sessionId, status),
    },
  },
}));

const WEBSOCKET = {
  subscribe: (_listener: (event: ServerEvent) => void) => () => undefined,
};

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => WEBSOCKET,
}));

const COLLAPSED_STORAGE_KEY = 'pmDevStack.sessionGroups.collapsed';

const t = ((key: string, fallbackOrOptions?: unknown) =>
  typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key) as unknown as TFunction;

const buildSession = (title: string, overrides: Partial<GroupedSession> = {}): GroupedSession => {
  const separatorIndex = title.indexOf(' / ');
  const hasPrefix = separatorIndex > 0;
  return {
    sessionId: `session-${title}`,
    provider: 'claude',
    projectId: 'project-acme',
    title,
    displayTitle: hasPrefix ? title.slice(separatorIndex + 3) : title,
    titlePrefix: hasPrefix ? title.slice(0, separatorIndex) : null,
    lastActivity: null,
    status: 'active',
    forkedFromSessionId: null,
    forkedFromTitle: null,
    ...overrides,
  };
};

const buildGroup = (key: string, label: string, overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  key,
  kind: key === 'management' ? 'management' : key === 'loose' ? 'loose' : 'prefix',
  label,
  clientSlug: null,
  pinnedSessions: [],
  sessions: [],
  closedSessions: [],
  ignoredSessions: [],
  ...overrides,
});

const managementGroup = buildGroup('management', 'Gestão', {
  sessions: [buildSession('Gestão / Projetos')],
});

const acmeGroup = buildGroup('prefix:acme', 'Acme', {
  pinnedSessions: [buildSession('Acme / Gestão')],
  sessions: [
    buildSession('Acme / Relatórios'),
    buildSession('Acme / Tema', { status: 'paused' }),
  ],
  closedSessions: [buildSession('Acme / Antigo', { status: 'closed' })],
});

const globexGroup = buildGroup('prefix:globex', 'Globex', {
  sessions: [buildSession('Globex / Tema')],
});

const looseGroup = buildGroup('loose', 'Avulsas', {
  sessions: [buildSession('Sem barra', { projectId: null })],
});

const baseView: SessionGroupsView = {
  groups: [managementGroup, acmeGroup, globexGroup, looseGroup],
  pendingMarkerCount: 0,
};

const viewWithIgnored: SessionGroupsView = {
  ...baseView,
  groups: [
    managementGroup,
    { ...acmeGroup, ignoredSessions: [buildSession('Acme / Velho', { status: 'ignored' })] },
    globexGroup,
    looseGroup,
  ],
};

const envelopeResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ success: true, data }),
});

const errorResponse = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ success: false, error: { code, message, details: null } }),
});

type PanelProps = {
  searchFilter: string;
  selectedSession: ProjectSession | null;
  isProjectListLoading: boolean;
  onConversationSelect: (projectId: string | null, sessionId: string, provider: string) => void;
};

const buildPanel = (props: PanelProps) => <SessionGroupsPanel {...props} t={t} />;

const defaultPanelProps = (overrides: Partial<PanelProps> = {}): PanelProps => ({
  searchFilter: '',
  selectedSession: null,
  isProjectListLoading: false,
  onConversationSelect: vi.fn(),
  ...overrides,
});

const renderPanel = async (overrides: Partial<PanelProps> = {}) => {
  const props = defaultPanelProps(overrides);
  const rendered = render(buildPanel(props));
  await screen.findAllByTestId(/^session-group:/);
  return { ...rendered, props };
};

const groupKeysOnScreen = () =>
  screen.getAllByTestId(/^session-group:/).map((element) => element.getAttribute('data-group-key'));

const rowOf = (title: string) => {
  const row = screen.getByTitle(title).closest('[data-testid="session-group-row"]');
  assert.ok(row, `no row rendered for "${title}"`);
  return row as HTMLElement;
};

beforeEach(() => {
  localStorage.clear();
  groupsRequest.mockReset();
  setStatusRequest.mockReset();
  groupsRequest.mockImplementation(async (includeIgnored: boolean) =>
    envelopeResponse(includeIgnored ? viewWithIgnored : baseView),
  );
});

test('the Management section comes first and carries the disabled deadlines entry', async () => {
  await renderPanel();

  assert.deepEqual(groupKeysOnScreen(), ['management', 'prefix:acme', 'prefix:globex', 'loose']);
  const deadlines = screen.getByRole('button', { name: '📅 Próximos prazos' });
  assert.equal((deadlines as HTMLButtonElement).disabled, true);
});

test('the Management section and the deadlines entry stay when the section has no sessions', async () => {
  groupsRequest.mockResolvedValue(
    envelopeResponse({ groups: [buildGroup('management', 'Gestão'), acmeGroup], pendingMarkerCount: 0 }),
  );
  await renderPanel();

  assert.deepEqual(groupKeysOnScreen(), ['management', 'prefix:acme']);
  assert.ok(screen.getByRole('button', { name: '📅 Próximos prazos' }));
});

test('pinned, paused and closed sessions are marked as the server placed them', async () => {
  await renderPanel();

  assert.equal(rowOf('Acme / Gestão').getAttribute('data-pinned'), 'true');
  assert.equal(rowOf('Acme / Relatórios').getAttribute('data-pinned'), null);
  assert.equal(rowOf('Acme / Tema').getAttribute('data-status'), 'paused');

  // The closed block is folded until it is opened.
  assert.equal(screen.queryByTitle('Acme / Antigo'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Encerradas (1)' }));
  assert.equal(rowOf('Acme / Antigo').getAttribute('data-status'), 'closed');
});

test('the loose group is rendered last, in the server order', async () => {
  await renderPanel();

  const keys = groupKeysOnScreen();
  assert.equal(keys[keys.length - 1], 'loose');
  assert.ok(screen.getByText('Avulsas'));
});

test('the status menu sends the new status and the panel fetches the groups once more', async () => {
  const { props } = await renderPanel();
  setStatusRequest.mockResolvedValue(
    envelopeResponse({ sessionId: 'session-Acme / Relatórios', status: 'paused', statusSetAt: null }),
  );
  assert.equal(groupsRequest.mock.calls.length, 1);

  fireEvent.click(within(rowOf('Acme / Relatórios')).getByRole('button', { name: 'Status' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Pausada' }));

  await waitFor(() => {
    assert.equal(groupsRequest.mock.calls.length, 2);
  });
  assert.deepEqual(setStatusRequest.mock.calls, [['session-Acme / Relatórios', 'paused']]);
  assert.equal(
    (props.onConversationSelect as ReturnType<typeof vi.fn>).mock.calls.length,
    0,
    'choosing a status must not open the session',
  );
});

test('Show ignored fetches with the flag and lists the ignored sessions', async () => {
  await renderPanel();
  assert.equal(screen.queryByTitle('Acme / Velho'), null);

  fireEvent.click(screen.getByRole('button', { name: 'Mostrar ignoradas' }));

  await waitFor(() => {
    assert.ok(screen.getByTitle('Acme / Velho'));
  });
  assert.deepEqual(groupsRequest.mock.calls[groupsRequest.mock.calls.length - 1], [true]);
  assert.ok(screen.getByRole('button', { name: 'Ocultar ignoradas' }));
});

test('a collapsed group stays collapsed after the panel is mounted again', async () => {
  const first = await renderPanel();
  assert.ok(screen.getByTitle('Acme / Relatórios'));

  fireEvent.click(screen.getByTestId('session-group-header:prefix:acme'));

  assert.equal(screen.queryByTitle('Acme / Relatórios'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? 'null'), ['prefix:acme']);

  first.unmount();
  await renderPanel();

  assert.equal(screen.queryByTitle('Acme / Relatórios'), null);
  assert.ok(screen.getByTitle('Globex / Tema'));
});

test('clicking a row opens the session with its project, id and provider', async () => {
  const { props } = await renderPanel({ selectedSession: { id: 'session-Acme / Relatórios' } });

  fireEvent.click(screen.getByTitle('Acme / Relatórios'));

  assert.deepEqual((props.onConversationSelect as ReturnType<typeof vi.fn>).mock.calls, [
    ['project-acme', 'session-Acme / Relatórios', 'claude'],
  ]);
  assert.equal(rowOf('Acme / Relatórios').getAttribute('data-selected'), 'true');
  assert.equal(rowOf('Globex / Tema').getAttribute('data-selected'), null);
});

test('a session without a project is passed on with a null project id', async () => {
  const { props } = await renderPanel();

  fireEvent.click(screen.getByTitle('Sem barra'));

  assert.deepEqual((props.onConversationSelect as ReturnType<typeof vi.fn>).mock.calls, [
    [null, 'session-Sem barra', 'claude'],
  ]);
});

test('while the project list loads the panel shows a skeleton and no clickable row', async () => {
  const props = defaultPanelProps({ isProjectListLoading: true });
  const { rerender } = render(buildPanel(props));

  await waitFor(() => {
    assert.equal(groupsRequest.mock.calls.length, 1);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(screen.getByTestId('session-groups-skeleton'));
  assert.equal(screen.queryAllByTestId('session-group-row').length, 0);

  rerender(buildPanel({ ...props, isProjectListLoading: false }));

  await waitFor(() => {
    assert.ok(screen.getByTitle('Acme / Relatórios'));
  });
  assert.equal(screen.queryByTestId('session-groups-skeleton'), null);
});

test('a failed load shows a message and a retry button that fetches again', async () => {
  groupsRequest.mockResolvedValueOnce(errorResponse(500, 'INTERNAL', 'Database is locked'));
  render(buildPanel(defaultPanelProps()));

  await screen.findByText('Não foi possível carregar as sessões');
  assert.equal(screen.queryAllByTestId('session-group-row').length, 0);

  fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

  await waitFor(() => {
    assert.ok(screen.getByTitle('Acme / Relatórios'));
  });
  assert.equal(groupsRequest.mock.calls.length, 2);
});

test('a status change refused by the server shows its message and keeps the list', async () => {
  await renderPanel();
  setStatusRequest.mockResolvedValue(errorResponse(404, 'SESSION_NOT_FOUND', 'Session not found'));

  fireEvent.click(within(rowOf('Globex / Tema')).getByRole('button', { name: 'Status' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Encerrada' }));

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Session not found/);
  assert.ok(screen.getByTitle('Globex / Tema'));
});

test('a failed refresh keeps the list on screen, flags it as stale and logs the error', async () => {
  await renderPanel();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  groupsRequest.mockResolvedValueOnce(errorResponse(500, 'INTERNAL', 'Database is locked'));

  fireEvent.click(screen.getByRole('button', { name: 'Mostrar ignoradas' }));

  await screen.findByText('Lista possivelmente desatualizada');
  assert.ok(screen.getByTitle('Acme / Relatórios'));
  assert.equal(consoleError.mock.calls[0]?.[0], '[SessionGroups] RefreshFailed');

  fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

  // A boolean, not the element: node:assert would format a jsdom node on every retry.
  await waitFor(() => {
    assert.equal(screen.queryByText('Lista possivelmente desatualizada') === null, true);
  });
});

test('the panel renders and collapses in memory when localStorage throws', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage denied');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage denied');
  });

  await renderPanel();
  assert.ok(screen.getByTitle('Acme / Relatórios'));

  fireEvent.click(screen.getByTestId('session-group-header:prefix:acme'));

  assert.equal(screen.queryByTitle('Acme / Relatórios'), null);
});

test('the search filter ignores accents and case, drops empty groups and keeps the Management section', async () => {
  await renderPanel({ searchFilter: 'gestao' });

  assert.ok(screen.getByTitle('Gestão / Projetos'));
  assert.ok(screen.getByTitle('Acme / Gestão'));
  assert.equal(screen.queryByTitle('Acme / Relatórios'), null);
  assert.deepEqual(groupKeysOnScreen(), ['management', 'prefix:acme']);
});

test('a filter that matches nothing leaves only the Management section', async () => {
  await renderPanel({ searchFilter: 'zzz' });

  assert.deepEqual(groupKeysOnScreen(), ['management']);
  assert.ok(screen.getByRole('button', { name: '📅 Próximos prazos' }));
});

test('a title with an empty remainder is shown whole', async () => {
  groupsRequest.mockResolvedValue(
    envelopeResponse({
      groups: [
        managementGroup,
        buildGroup('prefix:acme', 'Acme', {
          sessions: [buildSession('Acme / ', { displayTitle: 'Acme / ', titlePrefix: 'Acme' })],
        }),
      ],
      pendingMarkerCount: 0,
    }),
  );
  await renderPanel();

  assert.ok(screen.getByText('Acme /'));
});
