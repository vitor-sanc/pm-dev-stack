import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import type { ServerEvent, SessionGroupsView } from '@/shared/types';

/**
 * The hook is the only place the Clients tab talks to the server. The tests
 * count GET requests, because every bug here is a request that should not have
 * been sent, or a response that should not have been applied.
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

let emit: (event: ServerEvent) => void = () => undefined;

const WEBSOCKET = {
  subscribe: (listener: (event: ServerEvent) => void) => {
    emit = listener;
    return () => {
      emit = () => undefined;
    };
  },
};

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => WEBSOCKET,
}));

const { useSessionGroups } = await import('@/modules/session-groups/hooks/useSessionGroups');

const DEBOUNCE_WINDOW_MS = 450;

const buildView = (label: string): SessionGroupsView => ({
  groups: [
    {
      key: `prefix:${label.toLowerCase()}`,
      kind: 'prefix',
      label,
      clientSlug: null,
      pinnedSessions: [],
      sessions: [],
      closedSessions: [],
      ignoredSessions: [],
    },
  ],
  pendingMarkerCount: 0,
});

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

const respondWithView = (label: string) => {
  groupsRequest.mockResolvedValue(envelopeResponse(buildView(label)));
};

const waitForDebounceWindow = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_WINDOW_MS));
  });

const renderGroups = async (initialProps: { includeIgnored: boolean; openSessionTitle: string | null }) => {
  const rendered = renderHook(
    (props: { includeIgnored: boolean; openSessionTitle: string | null }) =>
      useSessionGroups(props.includeIgnored, props.openSessionTitle),
    { initialProps },
  );
  await waitFor(() => {
    assert.ok(rendered.result.current.view);
  });
  return rendered;
};

const defaultProps = { includeIgnored: false, openSessionTitle: null };

beforeEach(() => {
  groupsRequest.mockReset();
  setStatusRequest.mockReset();
  emit = () => undefined;
});

test('loads the groups on mount', async () => {
  respondWithView('Acme');
  const { result } = await renderGroups(defaultProps);

  assert.equal(groupsRequest.mock.calls.length, 1);
  assert.deepEqual(groupsRequest.mock.calls[0], [false]);
  assert.equal(result.current.view?.groups[0].label, 'Acme');
  assert.equal(result.current.isLoading, false);
  assert.equal(result.current.error, null);
});

test('three session_upserted frames inside the debounce window send one request', async () => {
  respondWithView('Acme');
  await renderGroups(defaultProps);

  act(() => {
    emit({ kind: 'session_upserted' });
    emit({ kind: 'session_upserted' });
    emit({ kind: 'session_upserted' });
  });
  await waitForDebounceWindow();

  assert.equal(groupsRequest.mock.calls.length, 2);
});

test('a websocket reconnect refetches', async () => {
  respondWithView('Acme');
  await renderGroups(defaultProps);

  act(() => {
    emit({ kind: 'websocket_reconnected' });
  });
  await waitForDebounceWindow();

  assert.equal(groupsRequest.mock.calls.length, 2);
});

test('an unrelated frame does not refetch', async () => {
  respondWithView('Acme');
  await renderGroups(defaultProps);

  act(() => {
    emit({ kind: 'chat_subscribed' });
  });
  await waitForDebounceWindow();

  assert.equal(groupsRequest.mock.calls.length, 1);
});

test('a title change of the open session refetches once, and the same title does not', async () => {
  respondWithView('Acme');
  const { rerender } = await renderGroups({ includeIgnored: false, openSessionTitle: 'Gestao Projetos' });

  rerender({ includeIgnored: false, openSessionTitle: 'Gestao Projetos' });
  await waitForDebounceWindow();
  assert.equal(groupsRequest.mock.calls.length, 1, 'a rerender with the same title must not refetch');

  rerender({ includeIgnored: false, openSessionTitle: 'Gestão / Projetos' });
  await waitForDebounceWindow();
  assert.equal(groupsRequest.mock.calls.length, 2);
});

test('changing includeIgnored refetches at once with the new flag', async () => {
  respondWithView('Acme');
  const { rerender } = await renderGroups(defaultProps);

  rerender({ includeIgnored: true, openSessionTitle: null });

  await waitFor(() => {
    assert.equal(groupsRequest.mock.calls.length, 2);
  });
  assert.deepEqual(groupsRequest.mock.calls[1], [true]);
});

test('a response that arrives after a newer one does not overwrite the view', async () => {
  let releaseOldResponse: () => void = () => undefined;
  const oldResponseHeld = new Promise<void>((resolve) => {
    releaseOldResponse = resolve;
  });
  groupsRequest.mockImplementationOnce(async () => {
    await oldResponseHeld;
    return envelopeResponse(buildView('Old'));
  });
  groupsRequest.mockResolvedValue(envelopeResponse(buildView('New')));

  const rendered = renderHook(
    (props: { includeIgnored: boolean; openSessionTitle: string | null }) =>
      useSessionGroups(props.includeIgnored, props.openSessionTitle),
    { initialProps: defaultProps },
  );
  rendered.rerender({ includeIgnored: true, openSessionTitle: null });

  await waitFor(() => {
    assert.equal(rendered.result.current.view?.groups[0].label, 'New');
  });

  await act(async () => {
    releaseOldResponse();
    await oldResponseHeld;
    await Promise.resolve();
  });

  assert.equal(rendered.result.current.view?.groups[0].label, 'New');
});

test('a failed first load exposes the error and the retry recovers', async () => {
  groupsRequest.mockResolvedValueOnce(errorResponse(500, 'INTERNAL', 'Database is locked'));
  const rendered = renderHook(() => useSessionGroups(false, null));

  await waitFor(() => {
    assert.equal(rendered.result.current.error, 'Database is locked');
  });
  assert.equal(rendered.result.current.view, null);
  assert.equal(rendered.result.current.isLoading, false);

  respondWithView('Acme');
  act(() => {
    rendered.result.current.refetch();
  });

  await waitFor(() => {
    assert.equal(rendered.result.current.view?.groups[0].label, 'Acme');
  });
  assert.equal(rendered.result.current.error, null);
});

test('a failed refetch keeps the view that was already on screen', async () => {
  respondWithView('Acme');
  const { result } = await renderGroups(defaultProps);

  groupsRequest.mockResolvedValue(errorResponse(500, 'INTERNAL', 'Database is locked'));
  act(() => {
    emit({ kind: 'session_upserted' });
  });
  await waitForDebounceWindow();

  assert.equal(groupsRequest.mock.calls.length, 2);
  assert.equal(result.current.view?.groups[0].label, 'Acme');
});

test('setStatus sends the change and the echoed broadcast plus the explicit refetch make one GET', async () => {
  respondWithView('Acme');
  const { result } = await renderGroups(defaultProps);
  setStatusRequest.mockResolvedValue(envelopeResponse({ sessionId: 'session-1', status: 'paused', statusSetAt: null }));

  await act(async () => {
    emit({ kind: 'session_upserted' });
    await result.current.setStatus('session-1', 'paused');
  });
  await waitForDebounceWindow();

  assert.deepEqual(setStatusRequest.mock.calls, [['session-1', 'paused']]);
  assert.equal(groupsRequest.mock.calls.length, 2);
});

test('setStatus rejects with the server message and keeps the view on a 404', async () => {
  respondWithView('Acme');
  const { result } = await renderGroups(defaultProps);
  setStatusRequest.mockResolvedValue(errorResponse(404, 'SESSION_NOT_FOUND', 'Session not found'));

  let thrown: unknown = null;
  await act(async () => {
    try {
      await result.current.setStatus('missing-session', 'closed');
    } catch (error) {
      thrown = error;
    }
  });
  await waitForDebounceWindow();

  assert.ok(thrown instanceof Error);
  assert.equal(thrown.message, 'Session not found');
  assert.equal(result.current.view?.groups[0].label, 'Acme');
  assert.equal(groupsRequest.mock.calls.length, 1, 'a failed change must not trigger a refetch');
});
