import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import type { GroupedSession, SessionGroupKind } from '@/shared/types';
import BranchSessionModal from '@/modules/session-groups/modals/BranchSessionModal';

/**
 * The Branch modal asks what the branch is for, shows the session name it will
 * get, and forks through the mocked API. No real fork is ever created here.
 */

const forkRequest = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    forkSession: (sessionId: string, body: { title?: string }) => forkRequest(sessionId, body),
  },
}));

const t = ((key: string, fallbackOrOptions?: unknown) =>
  typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key) as unknown as TFunction;

const buildSession = (overrides: Partial<GroupedSession> = {}): GroupedSession => ({
  sessionId: 'session-source',
  provider: 'claude',
  projectId: 'project-acme',
  title: 'Acme / Relatórios',
  displayTitle: 'Relatórios',
  titlePrefix: 'Acme',
  lastActivity: null,
  status: 'active',
  forkedFromSessionId: null,
  forkedFromTitle: null,
  ...overrides,
});

const envelopeResponse = (status: number, data: unknown) => ({
  ok: true,
  status,
  json: async () => ({ success: true, data }),
});

const errorResponse = (status: number, code: string, message: string) => ({
  ok: false,
  status,
  json: async () => ({ success: false, error: { code, message, details: null } }),
});

const renderModal = (session: GroupedSession = buildSession(), groupKind: SessionGroupKind = 'prefix') => {
  const onClose = vi.fn();
  const onForked = vi.fn();
  render(<BranchSessionModal session={session} groupKind={groupKind} onClose={onClose} onForked={onForked} t={t} />);
  return { onClose, onForked };
};

const typeTheme = (theme: string) =>
  fireEvent.change(screen.getByPlaceholderText('Pra que serve?'), { target: { value: theme } });

const createButton = () => screen.getByRole('button', { name: 'Criar e abrir' }) as HTMLButtonElement;

beforeEach(() => {
  forkRequest.mockReset();
  forkRequest.mockResolvedValue(
    envelopeResponse(201, { sessionId: 'session-fork', provider: 'claude', sessionName: 'Acme / Tema' }),
  );
});

test('a management section session names the branch "Gestão / <tema>"', () => {
  renderModal(buildSession({ title: 'Gestão / Projetos', titlePrefix: 'Gestao' }), 'management');

  typeTheme('Tema');

  assert.ok(screen.getByText('Gestão / Tema'));
});

test('a client group session names the branch "<prefixo> / <tema>"', () => {
  renderModal();

  typeTheme('Tema');

  assert.ok(screen.getByText('Acme / Tema'));
});

test('a pinned client management session names the branch with the client prefix', () => {
  renderModal(buildSession({ title: 'Acme / Gestão', displayTitle: 'Gestão' }), 'prefix');

  typeTheme('Tema');

  assert.ok(screen.getByText('Acme / Tema'));
});

test('a loose session names the branch with the theme alone', () => {
  renderModal(buildSession({ title: 'Sem barra', titlePrefix: null }), 'loose');

  typeTheme('Tema');

  assert.ok(screen.getByText('Tema'));
});

test('a theme of only spaces disables the submit and sends nothing on Enter', () => {
  renderModal();

  typeTheme('   ');
  fireEvent.keyDown(screen.getByPlaceholderText('Pra que serve?'), { key: 'Enter' });

  assert.equal(createButton().disabled, true);
  assert.equal(forkRequest.mock.calls.length, 0);
});

test('submitting forks with the trimmed full title, then opens the fork and closes', async () => {
  const { onClose, onForked } = renderModal();
  typeTheme('  Tema  ');

  fireEvent.click(createButton());

  await vi.waitFor(() => {
    assert.equal(onClose.mock.calls.length, 1);
  });
  assert.deepEqual(forkRequest.mock.calls, [['session-source', { title: 'Acme / Tema' }]]);
  assert.deepEqual(onForked.mock.calls, [['project-acme', 'session-fork', 'claude']]);
});

test('Enter in the theme field submits', async () => {
  const { onForked } = renderModal();
  typeTheme('Tema');

  fireEvent.keyDown(screen.getByPlaceholderText('Pra que serve?'), { key: 'Enter' });

  await vi.waitFor(() => {
    assert.equal(onForked.mock.calls.length, 1);
  });
});

test('a refused fork shows the server message, keeps the modal open and selects nothing', async () => {
  forkRequest.mockResolvedValue(errorResponse(409, 'FORK_SOURCE_NOT_READY', 'The session has not run yet'));
  const { onClose, onForked } = renderModal();
  typeTheme('Tema');

  fireEvent.click(createButton());

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Não foi possível criar a branch: The session has not run yet/);
  assert.equal(onForked.mock.calls.length, 0);
  assert.equal(onClose.mock.calls.length, 0);
  assert.equal(createButton().disabled, false);
});

test('a double click sends one request', async () => {
  let resolveFork: (value: unknown) => void = () => undefined;
  forkRequest.mockImplementation(() => new Promise((resolve) => { resolveFork = resolve; }));
  const { onForked } = renderModal();
  typeTheme('Tema');

  fireEvent.click(createButton());
  fireEvent.click(createButton());
  resolveFork(envelopeResponse(201, { sessionId: 'session-fork', provider: 'claude', sessionName: 'Acme / Tema' }));

  await vi.waitFor(() => {
    assert.equal(onForked.mock.calls.length, 1);
  });
  assert.equal(forkRequest.mock.calls.length, 1);
});

test('Cancel closes without a request', () => {
  const { onClose } = renderModal();

  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

  assert.equal(onClose.mock.calls.length, 1);
  assert.equal(forkRequest.mock.calls.length, 0);
});

test('while the fork runs the dialog cannot be cancelled or dismissed', async () => {
  forkRequest.mockReturnValue(new Promise(() => undefined));
  const { onClose } = renderModal();
  typeTheme('Tema');

  fireEvent.click(createButton());
  const cancelButton = screen.getByRole('button', { name: 'Cancelar' }) as HTMLButtonElement;
  await waitFor(() => {
    assert.equal(cancelButton.disabled, true);
  });
  fireEvent.keyDown(screen.getByPlaceholderText('Pra que serve?'), { key: 'Escape' });

  assert.equal(onClose.mock.calls.length, 0);
});
