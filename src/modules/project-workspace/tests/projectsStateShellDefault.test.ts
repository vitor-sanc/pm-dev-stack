import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { AppTab, Project } from '@/shared/types';

/**
 * Opening an existing session from the sidebar lands on the Shell tab, whatever
 * tab was open before. Starting a new session still opens Chat.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

const buildProject = (overrides: Partial<Project> = {}): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Acme workspace',
  isStarred: false,
  sessions: [],
  sessionMeta: { hasMore: false, total: 0 },
  ...overrides,
});

const globexProject = buildProject({
  projectId: 'project-2',
  path: '/other',
  fullPath: '/other',
  displayName: 'Globex workspace',
});

const respondWith = (projects: Project[]) => {
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => projects,
  });
};

// Two projects keep the auto-select effect (single project only) out of the way.
const renderLoadedProjectsState = async () => {
  respondWith([buildProject(), globexProject]);

  const { useProjectsState } = await import(
    '@/modules/project-workspace/hooks/useProjectsState'
  );

  const rendered = renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: () => () => undefined,
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );

  await waitFor(() => {
    assert.equal(rendered.result.current.projects.length, 2);
  });
  return rendered;
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

const tabsThatUsedToStay: AppTab[] = ['chat', 'files', 'git', 'tasks', 'browser'];

for (const previousTab of tabsThatUsedToStay) {
  test(`selecting a session from the ${previousTab} tab opens the Shell`, async () => {
    localStorage.setItem('activeTab', previousTab);
    const { result } = await renderLoadedProjectsState();
    assert.equal(result.current.activeTab, previousTab);

    act(() => {
      result.current.handleSessionSelect({ id: 'session-1', __projectId: 'project-1' });
    });

    assert.equal(result.current.activeTab, 'shell');
    assert.equal(localStorage.getItem('activeTab'), 'shell');
  });
}

test('selecting an old session with no project selected selects the project, the session and the Shell', async () => {
  const { result } = await renderLoadedProjectsState();
  const selectedBefore = result.current.selectedProject;
  assert.equal(selectedBefore, null);

  // The id is not in any loaded page of the project, as for a session that has
  // not been touched in weeks. Both calls happen in one act, the way the
  // sidebar's project-then-session click path does.
  act(() => {
    result.current.handleProjectSelect(globexProject);
    result.current.handleSessionSelect({ id: 'session-from-last-month', __projectId: 'project-2' });
  });

  assert.equal(result.current.selectedProject?.projectId, 'project-2');
  assert.equal(result.current.selectedSession?.id, 'session-from-last-month');
  assert.equal(result.current.activeTab, 'shell');
});

test('starting a new session still opens Chat', async () => {
  localStorage.setItem('activeTab', 'shell');
  const { result } = await renderLoadedProjectsState();
  assert.equal(result.current.activeTab, 'shell');

  act(() => {
    result.current.handleNewSession(buildProject());
  });

  assert.equal(result.current.activeTab, 'chat');
});
