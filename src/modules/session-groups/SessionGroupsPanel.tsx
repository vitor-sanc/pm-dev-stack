import { useState } from 'react';
import { Users } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Button } from '@/shared/ui';
import { useSessionForkingProviders } from '@/shared/hooks/useProviderCapabilities';
import type {
  GroupedSession,
  LLMProvider,
  ProjectSession,
  SessionGroup,
  SessionGroupKind,
  SessionWorkflowStatus,
} from '@/shared/types';
import SessionGroupSection from '@/modules/session-groups/SessionGroupSection';
import BranchSessionModal from '@/modules/session-groups/modals/BranchSessionModal';
import MarkerMigrationModal from '@/modules/session-groups/modals/MarkerMigrationModal';
import { useSessionGroups } from '@/modules/session-groups/hooks/useSessionGroups';

const COLLAPSED_GROUPS_STORAGE_KEY = 'pmDevStack.sessionGroups.collapsed';
const SKELETON_ROW_WIDTHS_PERCENT = [72, 60, 66, 54, 70, 58, 64, 50];

type SessionGroupsPanelProps = {
  searchFilter: string;
  selectedSession: ProjectSession | null;
  isProjectListLoading: boolean;
  onConversationSelect: (projectId: string | null, sessionId: string, provider: string) => void;
  t: TFunction;
};

function readCollapsedGroupKeys(): string[] {
  try {
    const parsedValue: unknown = JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsedValue)) {
      return [];
    }
    return parsedValue.filter((groupKey): groupKey is string => typeof groupKey === 'string');
  } catch {
    // localStorage unavailable or holding junk: start with every group open
    return [];
  }
}

function writeCollapsedGroupKeys(groupKeys: string[]): void {
  try {
    localStorage.setItem(COLLAPSED_GROUPS_STORAGE_KEY, JSON.stringify(groupKeys));
  } catch {
    // The fold state then lives in memory only.
  }
}

function normalizeForSearch(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Keeps only the rows whose title contains the filter. A group left without rows is dropped,
 * except the Management section, which also hosts the deadlines entry.
 */
function filterGroups(groups: SessionGroup[], searchFilter: string): SessionGroup[] {
  const normalizedFilter = normalizeForSearch(searchFilter.trim());
  if (normalizedFilter === '') {
    return groups;
  }

  const filteredGroups: SessionGroup[] = [];
  for (const group of groups) {
    const matches = (session: { title: string }) => normalizeForSearch(session.title).includes(normalizedFilter);
    const filteredGroup: SessionGroup = {
      ...group,
      pinnedSessions: group.pinnedSessions.filter(matches),
      sessions: group.sessions.filter(matches),
      closedSessions: group.closedSessions.filter(matches),
      ignoredSessions: group.ignoredSessions.filter(matches),
    };
    const rowCount =
      filteredGroup.pinnedSessions.length
      + filteredGroup.sessions.length
      + filteredGroup.closedSessions.length
      + filteredGroup.ignoredSessions.length;
    if (rowCount > 0 || group.kind === 'management') {
      filteredGroups.push(filteredGroup);
    }
  }
  return filteredGroups;
}

function SessionGroupsSkeleton() {
  return (
    <div data-testid="session-groups-skeleton" aria-busy="true" className="space-y-1 px-1">
      {SKELETON_ROW_WIDTHS_PERCENT.map((widthPercent, rowIndex) => (
        <div key={rowIndex} className="flex items-center px-2 py-2.5">
          <div className="h-3 animate-pulse rounded bg-muted" style={{ width: `${widthPercent}%` }} />
        </div>
      ))}
    </div>
  );
}

/** Used by sidebar/SidebarContent as the body of the Clients tab: the server's session groups, foldable, with a status menu per session. */
export default function SessionGroupsPanel({
  searchFilter,
  selectedSession,
  isProjectListLoading,
  onConversationSelect,
  t,
}: SessionGroupsPanelProps) {
  // Whether ignored sessions are requested and listed; off by default because ignored work is out of sight on purpose.
  const [includeIgnored, setIncludeIgnored] = useState(false);
  // Keys of the folded groups, remembered across reloads so a long list stays the way the user trimmed it.
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<string[]>(readCollapsedGroupKeys);
  // Message of the last refused status change, shown above the list until the next attempt.
  const [statusChangeError, setStatusChangeError] = useState<string | null>(null);
  // Whether the one-time marker migration dialog is open; it loads its own preview on open.
  const [isMarkerMigrationOpen, setIsMarkerMigrationOpen] = useState(false);
  // The session being branched and the kind of its group (the title rule depends on it); null when no Branch dialog is open.
  const [branchSource, setBranchSource] = useState<{ session: GroupedSession; groupKind: SessionGroupKind } | null>(null);
  const forkableProviders = useSessionForkingProviders();
  const { view, isLoading, error, refetch, setStatus } = useSessionGroups(includeIgnored, selectedSession?.summary ?? null);

  const toggleGroupCollapsed = (groupKey: string) => {
    const nextCollapsedGroupKeys = collapsedGroupKeys.includes(groupKey)
      ? collapsedGroupKeys.filter((collapsedKey) => collapsedKey !== groupKey)
      : [...collapsedGroupKeys, groupKey];
    setCollapsedGroupKeys(nextCollapsedGroupKeys);
    writeCollapsedGroupKeys(nextCollapsedGroupKeys);
  };

  const changeSessionStatus = async (sessionId: string, status: SessionWorkflowStatus) => {
    setStatusChangeError(null);
    try {
      await setStatus(sessionId, status);
    } catch (changeError) {
      const failureLabel = t('sessionGroups.statusChangeFailed', 'Não foi possível mudar o status');
      setStatusChangeError(changeError instanceof Error ? `${failureLabel}: ${changeError.message}` : failureLabel);
    }
  };

  // No row is shown before the project list is loaded: a click on a session whose
  // project is not in the list yet would select the session with no project.
  const isWaitingForData = isProjectListLoading || (view === null && (error === null || isLoading));
  if (isWaitingForData) {
    return <SessionGroupsSkeleton />;
  }

  if (view === null) {
    return (
      <div className="px-4 py-10 text-center">
        <Users className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">{t('sessionGroups.loadFailed', 'Não foi possível carregar as sessões')}</p>
        <Button variant="ghost" size="sm" className="mt-2" onClick={refetch}>
          {t('sessionGroups.retry', 'Tentar de novo')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-1" data-testid="session-groups-list">
      <div className="flex items-center justify-between px-1">
        {view.pendingMarkerCount > 0 ? (
          <button
            type="button"
            onClick={() => setIsMarkerMigrationOpen(true)}
            className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {`${t('sessionGroups.migration.entry', 'Limpar marcadores')} (${view.pendingMarkerCount})`}
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={() => setIncludeIgnored((isIncluded) => !isIncluded)}
          className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        >
          {includeIgnored ? t('sessionGroups.hideIgnored', 'Ocultar ignoradas') : t('sessionGroups.showIgnored', 'Mostrar ignoradas')}
        </button>
      </div>

      {statusChangeError && (
        <p role="alert" className="px-2 text-[11px] text-destructive">
          {statusChangeError}
        </p>
      )}

      {error && (
        <p role="status" className="flex items-center gap-2 px-2 text-[11px] text-muted-foreground">
          {t('sessionGroups.refreshFailed', 'Lista possivelmente desatualizada')}
          <button type="button" onClick={refetch} className="underline hover:text-foreground">
            {t('sessionGroups.retry', 'Tentar de novo')}
          </button>
        </p>
      )}

      {filterGroups(view.groups, searchFilter).map((group) => (
        <SessionGroupSection
          key={group.key}
          group={group}
          selectedSessionId={selectedSession ? String(selectedSession.id) : null}
          isCollapsed={collapsedGroupKeys.includes(group.key)}
          onToggleCollapsed={() => toggleGroupCollapsed(group.key)}
          onSelect={onConversationSelect}
          onStatusChange={changeSessionStatus}
          canBranch={(provider) => forkableProviders.has(provider as LLMProvider)}
          onBranch={(session) => setBranchSource({ session, groupKind: group.kind })}
          t={t}
        />
      ))}

      {branchSource && (
        <BranchSessionModal
          session={branchSource.session}
          groupKind={branchSource.groupKind}
          onClose={() => setBranchSource(null)}
          onForked={onConversationSelect}
          t={t}
        />
      )}

      <MarkerMigrationModal
        isOpen={isMarkerMigrationOpen}
        onClose={() => setIsMarkerMigrationOpen(false)}
        onApplied={refetch}
        t={t}
      />
    </div>
  );
}
