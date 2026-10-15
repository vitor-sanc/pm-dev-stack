import { useCallback, useEffect, useRef, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { SessionGroupsView, SessionWorkflowStatus } from '@/shared/types';

// Websocket frames, status changes and renames arrive in bursts. One GET covers a burst.
const REFETCH_DEBOUNCE_MS = 300;

type SessionGroupsState = {
  view: SessionGroupsView | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  setStatus: (sessionId: string, status: SessionWorkflowStatus) => Promise<void>;
};

/**
 * Used by SessionGroupsPanel as its only link to the server: loads the session groups, keeps them fresh
 * from websocket frames and from a rename of the open session, and changes a session's status.
 *
 * `openSessionTitle` exists because a rename sends no websocket frame; a changed title is the signal to refetch.
 */
export function useSessionGroups(includeIgnored: boolean, openSessionTitle: string | null): SessionGroupsState {
  const { subscribe } = useWebSocket();
  // The latest successful response; kept on screen while a refetch runs or fails.
  const [view, setView] = useState<SessionGroupsView | null>(null);
  // True while any request is in flight; the panel shows a skeleton only when there is no view yet.
  const [isLoading, setIsLoading] = useState(true);
  // Message of the last failed fetch; with a view on screen the panel keeps it and flags it as stale.
  const [error, setError] = useState<string | null>(null);
  const includeIgnoredRef = useRef(includeIgnored);
  const requestSequenceRef = useRef(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousOpenSessionTitleRef = useRef(openSessionTitle);
  // A status change that resolves after unmount must not arm a new refetch.
  const isUnmountedRef = useRef(false);

  const fetchView = useCallback(async () => {
    const requestSequence = ++requestSequenceRef.current;
    setIsLoading(true);

    try {
      const payload = await readApiJson<{ data: SessionGroupsView }>(
        await api.sessionWorkflow.groups(includeIgnoredRef.current),
      );
      if (requestSequence !== requestSequenceRef.current) {
        return;
      }
      setView(payload.data);
      setError(null);
    } catch (fetchError) {
      if (requestSequence !== requestSequenceRef.current) {
        return;
      }
      console.error('[SessionGroups] RefreshFailed', fetchError);
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    }

    setIsLoading(false);
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (isUnmountedRef.current) {
      return;
    }
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      void fetchView();
    }, REFETCH_DEBOUNCE_MS);
  }, [fetchView]);

  useEffect(() => {
    includeIgnoredRef.current = includeIgnored;
    void fetchView();
  }, [includeIgnored, fetchView]);

  useEffect(
    () =>
      subscribe((event) => {
        if (event.kind === 'session_upserted' || event.kind === 'websocket_reconnected') {
          scheduleRefetch();
        }
      }),
    [subscribe, scheduleRefetch],
  );

  useEffect(() => {
    if (previousOpenSessionTitleRef.current === openSessionTitle) {
      return;
    }
    previousOpenSessionTitleRef.current = openSessionTitle;
    scheduleRefetch();
  }, [openSessionTitle, scheduleRefetch]);

  // A response that lands after unmount must not be applied, and a pending timer must not fire.
  // The flag is reset on mount because StrictMode unmounts and remounts once in development.
  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
      requestSequenceRef.current += 1;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const setStatus = useCallback(
    async (sessionId: string, status: SessionWorkflowStatus) => {
      await readApiJson<{ data: unknown }>(await api.sessionWorkflow.setStatus(sessionId, status));
      scheduleRefetch();
    },
    [scheduleRefetch],
  );

  return { view, isLoading, error, refetch: scheduleRefetch, setStatus };
}
