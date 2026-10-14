import express from 'express';

import { isSessionWorkflowStatus } from '@/modules/session-workflow/services/session-status.service.js';
import type { SessionWorkflowServices } from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

function readSessionId(paramValue: unknown): string {
  if (typeof paramValue !== 'string' || !paramValue.trim()) {
    throw new AppError('sessionId is required', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }
  return paramValue;
}

function readIncludeIgnored(queryValue: unknown): boolean {
  return queryValue === '1' || queryValue === 'true';
}

/**
 * Builds the Session Workflow HTTP router around an injected service API.
 *
 * Routes only parse transport input. Status storage, grouping and
 * broadcasting stay in the services.
 */
export function createSessionWorkflowRouter(services: SessionWorkflowServices): express.Router {
  const router = express.Router();

  router.get(
    '/groups',
    asyncHandler(async (req, res) => {
      const view = services.getSessionGroups({ includeIgnored: readIncludeIgnored(req.query.includeIgnored) });
      res.json(createApiSuccessResponse(view));
    }),
  );

  router.put(
    '/sessions/:sessionId/status',
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isSessionWorkflowStatus(body.status)) {
        throw new AppError('status must be one of active, paused, closed, ignored', {
          code: 'INVALID_SESSION_STATUS',
          statusCode: 400,
        });
      }

      const change = await services.setSessionStatus(readSessionId(req.params.sessionId), body.status);
      res.json(createApiSuccessResponse(change));
    }),
  );

  return router;
}
