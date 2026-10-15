import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project, SidebarProjectListProps } from '@/shared/types';

/**
 * The sidebar opens on the "Clientes" tab, the sessions grouped by client; the
 * upstream tabs stay one click away.
 */

const emptyResponse = () => Promise.resolve({ ok: true, json: async () => ({ data: { projects: [], sessions: [] } }) });

vi.mock('@/shared/api', () => ({
  api: {
    archivedProjects: emptyResponse,
    getArchivedSessions: emptyResponse,
    recentConversations: emptyResponse,
    migrateLegacyProjectStars: emptyResponse,
  },
}));

const { useSidebarController } = await import('@/modules/sidebar/hooks/useSidebarController');

const noop = () => {};
const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NO_PROJECTS: Project[] = [];
const NO_IDS: ReadonlySet<string> = new Set<string>();

test('the sidebar starts on the Clientes tab', () => {
  const { result } = renderHook(() =>
    useSidebarController({
      projects: NO_PROJECTS,
      selectedProject: null,
      selectedSession: null,
      activeSessions: NO_IDS,
      backgroundSessionIds: NO_IDS,
      isLoading: false,
      isMobile: false,
      t,
      onRefresh: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onSessionDelete: noop,
      onLoadMoreSessions: noop,
      onProjectDelete: noop,
      setCurrentProject: noop,
      setSidebarVisible: noop,
      sidebarVisible: true,
    }),
  );

  assert.equal(result.current.searchMode, 'clients');
});
