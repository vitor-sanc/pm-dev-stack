import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { createSessionWorkflowRouter } from '@/modules/session-workflow/session-workflow.routes.js';
import type {
  SessionGroupsView,
  SessionWorkflowServices,
  SessionWorkflowStatus,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const EMPTY_VIEW: SessionGroupsView = { groups: [], pendingMarkerCount: 0 };

function createFakeServices(overrides: Partial<SessionWorkflowServices> = {}): SessionWorkflowServices {
  return {
    getSessionGroups: () => {
      throw new Error('Unexpected getSessionGroups call');
    },
    setSessionStatus: async () => {
      throw new Error('Unexpected setSessionStatus call');
    },
    previewMarkerMigration: () => {
      throw new Error('Unexpected previewMarkerMigration call');
    },
    applyMarkerMigration: async () => {
      throw new Error('Unexpected applyMarkerMigration call');
    },
    ...overrides,
  };
}

async function withSessionWorkflowServer(
  services: SessionWorkflowServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/session-workflow', createSessionWorkflowRouter(services));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({ error: error.code });
      return;
    }

    res.status(500).json({ error: 'INTERNAL_ERROR' });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function putStatus(baseUrl: string, sessionId: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/session-workflow/sessions/${encodeURIComponent(sessionId)}/status`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('groups route returns the view inside the success envelope', async () => {
  const services = createFakeServices({ getSessionGroups: () => EMPTY_VIEW });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/session-workflow/groups`);
    const payload = await response.json() as { success: boolean; data: SessionGroupsView };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, EMPTY_VIEW);
  });
});

test('groups route forwards includeIgnored for 1 and true, and defaults to false', async () => {
  const cases: Array<[string, boolean]> = [
    ['?includeIgnored=1', true],
    ['?includeIgnored=true', true],
    ['?includeIgnored=0', false],
    ['?includeIgnored=yes', false],
    ['', false],
  ];

  for (const [query, expectedFlag] of cases) {
    const receivedFlags: boolean[] = [];
    const services = createFakeServices({
      getSessionGroups: (options) => {
        receivedFlags.push(options.includeIgnored);
        return EMPTY_VIEW;
      },
    });

    await withSessionWorkflowServer(services, async (baseUrl) => {
      await fetch(`${baseUrl}/api/session-workflow/groups${query}`);
    });

    assert.deepEqual(receivedFlags, [expectedFlag], `query "${query}" must give includeIgnored=${expectedFlag}`);
  }
});

test('status route calls the service with the session id and status', async () => {
  const calls: Array<[string, SessionWorkflowStatus]> = [];
  const services = createFakeServices({
    setSessionStatus: async (sessionId, status) => {
      calls.push([sessionId, status]);
      return { sessionId, status, statusSetAt: '2026-10-10T12:00:00.000Z' };
    },
  });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const response = await putStatus(baseUrl, 'session/one', { status: 'paused' });
    const payload = await response.json() as {
      success: boolean;
      data: { sessionId: string; status: string; statusSetAt: string | null };
    };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, {
      sessionId: 'session/one',
      status: 'paused',
      statusSetAt: '2026-10-10T12:00:00.000Z',
    });
  });

  assert.deepEqual(calls, [['session/one', 'paused']]);
});

test('status route rejects a status outside the vocabulary before calling the service', async () => {
  let serviceCalled = false;
  const services = createFakeServices({
    setSessionStatus: async () => {
      serviceCalled = true;
      throw new Error('service should not run for an invalid status');
    },
  });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const invalidBodies: unknown[] = [{ status: 'archived' }, { status: 42 }, {}, { status: null }];
    for (const body of invalidBodies) {
      const response = await putStatus(baseUrl, 'session-one', body);
      const payload = await response.json() as { error: string };

      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
      assert.equal(payload.error, 'INVALID_SESSION_STATUS');
    }
  });

  assert.equal(serviceCalled, false);
});

test('status route passes through a missing-session error from the service', async () => {
  const services = createFakeServices({
    setSessionStatus: async () => {
      throw new AppError('Session not found', { code: 'SESSION_NOT_FOUND', statusCode: 404 });
    },
  });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const response = await putStatus(baseUrl, 'missing', { status: 'closed' });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 404);
    assert.equal(payload.error, 'SESSION_NOT_FOUND');
  });
});

function postMarkerMigration(baseUrl: string, body: unknown): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/api/session-workflow/marker-migration`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('marker migration preview route returns the preview inside the success envelope', async () => {
  const preview = {
    items: [{
      sessionId: 'one',
      provider: 'claude',
      currentTitle: '✅ Acme / Tema',
      cleanTitle: 'Acme / Tema',
      proposedStatus: 'closed' as const,
    }],
  };
  const services = createFakeServices({ previewMarkerMigration: () => preview });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/session-workflow/marker-migration`);
    const payload = await response.json() as { success: boolean; data: typeof preview };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data, preview);
  });
});

test('marker migration apply route passes the confirmed ids to the service', async () => {
  const receivedIds: string[][] = [];
  const services = createFakeServices({
    applyMarkerMigration: async (sessionIds) => {
      receivedIds.push(sessionIds);
      return { applied: sessionIds, failed: [] };
    },
  });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const response = await postMarkerMigration(baseUrl, { sessionIds: ['one', 'two'] });
    const payload = await response.json() as { success: boolean; data: { applied: string[] } };

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.deepEqual(payload.data.applied, ['one', 'two']);
  });

  assert.deepEqual(receivedIds, [['one', 'two']]);
});

test('marker migration apply route accepts an empty id list', async () => {
  const receivedIds: string[][] = [];
  const services = createFakeServices({
    applyMarkerMigration: async (sessionIds) => {
      receivedIds.push(sessionIds);
      return { applied: [], failed: [] };
    },
  });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const response = await postMarkerMigration(baseUrl, { sessionIds: [] });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(receivedIds, [[]]);
});

test('marker migration apply route rejects a body without a list of non-empty strings before calling the service', async () => {
  let serviceCalled = false;
  const services = createFakeServices({
    applyMarkerMigration: async () => {
      serviceCalled = true;
      return { applied: [], failed: [] };
    },
  });

  await withSessionWorkflowServer(services, async (baseUrl) => {
    const invalidBodies: unknown[] = [{}, { sessionIds: 'one' }, { sessionIds: ['one', 2] }, { sessionIds: ['one', ' '] }, { sessionIds: null }];
    for (const body of invalidBodies) {
      const response = await postMarkerMigration(baseUrl, body);
      const payload = await response.json() as { error: string };

      assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
      assert.equal(payload.error, 'INVALID_REQUEST_BODY');
    }
  });

  assert.equal(serviceCalled, false);
});
