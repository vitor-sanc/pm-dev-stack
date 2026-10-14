import { projectsDb, sessionsDb } from '@/modules/database/index.js';
import type { VisibleSession } from '@/shared/types.js';

// SQLite treats a negative LIMIT as "no limit".
const ALL_ROWS_LIMIT = -1;

/**
 * Used by the Session Workflow composition to read every non-archived session
 * in one unpaged query, newest first. Sessions of archived projects are left out.
 */
export function listVisibleSessions(): VisibleSession[] {
  const page = sessionsDb.getRecentSessionsPage(ALL_ROWS_LIMIT, 0);
  const projectIdByPath = new Map<string, string | null>();

  return page.sessions.map((session) => {
    const projectPath = session.project_path?.trim() ? session.project_path : null;
    let projectId: string | null = null;

    if (projectPath) {
      if (!projectIdByPath.has(projectPath)) {
        projectIdByPath.set(projectPath, projectsDb.getProjectPath(projectPath)?.project_id ?? null);
      }
      projectId = projectIdByPath.get(projectPath) ?? null;
    }

    return {
      sessionId: session.session_id,
      provider: session.provider,
      projectId,
      title: session.custom_name?.trim() || session.session_id,
      lastActivity: session.updated_at ?? session.created_at ?? null,
      forkedFromSessionId: session.forked_from_session_id,
    };
  });
}
