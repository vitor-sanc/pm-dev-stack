import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { beforeEach, test, vi } from 'vitest';

import MarkerMigrationModal from '@/modules/session-groups/modals/MarkerMigrationModal';

/**
 * The marker migration modal previews what would change and applies only after
 * the user confirms. The tests drive it through the mocked API and read the DOM
 * the way a user would. Nothing here reaches a real server or a real transcript.
 */

const previewRequest = vi.fn();
const applyRequest = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: {
    sessionWorkflow: {
      markerMigrationPreview: () => previewRequest(),
      applyMarkerMigration: (sessionIds: string[]) => applyRequest(sessionIds),
    },
  },
}));

const t = ((key: string, fallbackOrOptions?: unknown) =>
  typeof fallbackOrOptions === 'string' ? fallbackOrOptions : key) as unknown as TFunction;

const closedItem = {
  sessionId: 'session-one',
  provider: 'claude',
  currentTitle: '✅ Acme / Tema',
  cleanTitle: 'Acme / Tema',
  proposedStatus: 'closed',
};

const ignoredItem = {
  sessionId: 'session-two',
  provider: 'claude',
  currentTitle: '<ignore>',
  cleanTitle: null,
  proposedStatus: 'ignored',
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

const renderModal = async (overrides: { isOpen?: boolean } = {}) => {
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<MarkerMigrationModal isOpen={overrides.isOpen ?? true} onClose={onClose} onApplied={onApplied} t={t} />);
  return { onClose, onApplied };
};

const clickApply = () => fireEvent.click(screen.getByRole('button', { name: 'Aplicar' }));

beforeEach(() => {
  previewRequest.mockReset();
  applyRequest.mockReset();
  previewRequest.mockResolvedValue(envelopeResponse({ items: [closedItem, ignoredItem] }));
});

test('opening the modal fetches the preview once and lists current title, clean title and proposed status', async () => {
  await renderModal();

  await screen.findByText('✅ Acme / Tema');
  assert.ok(screen.getByText('Acme / Tema'));
  assert.ok(screen.getByText('(título mantido)'));
  assert.ok(screen.getByText('Encerrada'));
  assert.ok(screen.getByText('Ignorada'));
  assert.equal(previewRequest.mock.calls.length, 1);
});

test('a closed modal makes no request', async () => {
  await renderModal({ isOpen: false });

  assert.equal(previewRequest.mock.calls.length, 0);
  assert.equal(screen.queryByRole('dialog') === null, true);
});

test('apply posts the ids of the preview, reports the result and calls onApplied', async () => {
  applyRequest.mockResolvedValue(envelopeResponse({ applied: ['session-one', 'session-two'], failed: [] }));
  const { onApplied } = await renderModal();
  await screen.findByText('✅ Acme / Tema');

  clickApply();

  await screen.findByText('Aplicadas: 2');
  assert.deepEqual(applyRequest.mock.calls, [[['session-one', 'session-two']]]);
  assert.equal(onApplied.mock.calls.length, 1);
  assert.ok(screen.getByRole('button', { name: 'Fechar' }));
  assert.equal(screen.queryByRole('button', { name: 'Aplicar' }) === null, true);
});

test('a double click on apply sends one request', async () => {
  let resolveApply: (value: unknown) => void = () => undefined;
  applyRequest.mockImplementation(() => new Promise((resolve) => { resolveApply = resolve; }));
  await renderModal();
  await screen.findByText('✅ Acme / Tema');

  clickApply();
  clickApply();
  resolveApply(envelopeResponse({ applied: ['session-one', 'session-two'], failed: [] }));

  await screen.findByText('Aplicadas: 2');
  assert.equal(applyRequest.mock.calls.length, 1);
});

test('cancel closes the modal and never posts', async () => {
  const { onClose, onApplied } = await renderModal();
  await screen.findByText('✅ Acme / Tema');

  fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

  assert.equal(onClose.mock.calls.length, 1);
  assert.equal(onApplied.mock.calls.length, 0);
  assert.equal(applyRequest.mock.calls.length, 0);
});

test('Escape closes the modal and never posts', async () => {
  const { onClose } = await renderModal();
  await screen.findByText('✅ Acme / Tema');

  fireEvent.keyDown(document, { key: 'Escape' });

  assert.equal(onClose.mock.calls.length, 1);
  assert.equal(applyRequest.mock.calls.length, 0);
});

test('items the server could not apply are listed with the reason', async () => {
  applyRequest.mockResolvedValue(envelopeResponse({
    applied: ['session-two'],
    failed: [{ sessionId: 'session-one', message: 'Session "session-one" was not found.' }],
  }));
  await renderModal();
  await screen.findByText('✅ Acme / Tema');

  clickApply();

  await screen.findByText('Aplicadas: 1');
  assert.ok(screen.getByText('Não aplicadas: 1'));
  assert.ok(screen.getByText(/Session "session-one" was not found\./));
});

test('a refused apply shows the server message and keeps the modal open for another try', async () => {
  applyRequest.mockResolvedValueOnce(errorResponse(500, 'INTERNAL', 'Database is locked'));
  const { onApplied } = await renderModal();
  await screen.findByText('✅ Acme / Tema');

  clickApply();

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Não foi possível aplicar: Database is locked/);
  assert.equal(onApplied.mock.calls.length, 0);
  assert.equal((screen.getByRole('button', { name: 'Aplicar' }) as HTMLButtonElement).disabled, false);
});

test('a failed preview shows the message and retries on demand', async () => {
  previewRequest.mockResolvedValueOnce(errorResponse(500, 'INTERNAL', 'Database is locked'));
  await renderModal();

  const alert = await screen.findByRole('alert');
  assert.match(alert.textContent ?? '', /Não foi possível carregar a prévia: Database is locked/);
  assert.equal((screen.getByRole('button', { name: 'Aplicar' }) as HTMLButtonElement).disabled, true);

  fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));

  await screen.findByText('✅ Acme / Tema');
  assert.equal(previewRequest.mock.calls.length, 2);
});

test('an empty preview says so and disables apply', async () => {
  previewRequest.mockResolvedValue(envelopeResponse({ items: [] }));
  await renderModal();

  await screen.findByText('Nenhum título com marcador');
  assert.equal((screen.getByRole('button', { name: 'Aplicar' }) as HTMLButtonElement).disabled, true);
  // A boolean, not the element: node:assert would format a jsdom node on every retry.
  await waitFor(() => {
    assert.equal(screen.queryByText('Carregando prévia…') === null, true);
  });
});
