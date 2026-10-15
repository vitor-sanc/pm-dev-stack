import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import type { GroupedSession, SessionGroup, SessionWorkflowStatus } from '@/shared/types';
import SessionGroupRow from '@/modules/session-groups/SessionGroupRow';

type SessionGroupSectionProps = {
  group: SessionGroup;
  selectedSessionId: string | null;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onSelect: (projectId: string | null, sessionId: string, provider: string) => void;
  onStatusChange: (sessionId: string, status: SessionWorkflowStatus) => void;
  canBranch: (provider: string) => boolean;
  onBranch: (session: GroupedSession) => void;
  t: TFunction;
};

function DeadlinesEntry({ t }: { t: TFunction }) {
  return (
    <Tooltip content={t('sessionGroups.deadlinesSoon', 'Disponível no M4')} position="right" className="w-full">
      {/* The button is inert, so the tooltip wrapper has to receive the hover. */}
      <button
        type="button"
        disabled
        className="pointer-events-none flex w-full items-center rounded-lg px-2 py-2 text-left text-[13px] font-normal text-muted-foreground opacity-70"
      >
        {t('sessionGroups.deadlines', '📅 Próximos prazos')}
      </button>
    </Tooltip>
  );
}

/** Used by SessionGroupsPanel for one group: a foldable header, its pinned rows, its rows, and the folded closed and ignored blocks. */
export default function SessionGroupSection({
  group,
  selectedSessionId,
  isCollapsed,
  onToggleCollapsed,
  onSelect,
  onStatusChange,
  canBranch,
  onBranch,
  t,
}: SessionGroupSectionProps) {
  // The closed block starts folded: finished work should not compete with live work for attention.
  const [isClosedBlockOpen, setIsClosedBlockOpen] = useState(false);
  const openRowCount = group.pinnedSessions.length + group.sessions.length;

  const renderRow = (session: GroupedSession, isPinned: boolean) => (
    <SessionGroupRow
      key={session.sessionId}
      session={session}
      isPinned={isPinned}
      isSelected={session.sessionId === selectedSessionId}
      onSelect={onSelect}
      onStatusChange={onStatusChange}
      onBranch={canBranch(session.provider) ? () => onBranch(session) : undefined}
      t={t}
    />
  );

  return (
    <section data-testid={`session-group:${group.key}`} data-group-key={group.key} className="space-y-0.5">
      <button
        type="button"
        data-testid={`session-group-header:${group.key}`}
        aria-expanded={!isCollapsed}
        onClick={onToggleCollapsed}
        className="flex w-full min-w-0 items-center gap-1 rounded-md px-1 py-1 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {isCollapsed ? <ChevronRight className="h-3 w-3 flex-shrink-0" /> : <ChevronDown className="h-3 w-3 flex-shrink-0" />}
        <span className="truncate">{group.label}</span>
        <span className="ml-auto text-[10px] tabular-nums text-muted-foreground/70">{openRowCount}</span>
      </button>

      {!isCollapsed && (
        <div className="space-y-0.5">
          {group.kind === 'management' && <DeadlinesEntry t={t} />}
          {group.pinnedSessions.map((session) => renderRow(session, true))}
          {group.sessions.map((session) => renderRow(session, false))}

          {group.closedSessions.length > 0 && (
            <>
              <button
                type="button"
                aria-expanded={isClosedBlockOpen}
                onClick={() => setIsClosedBlockOpen((isOpen) => !isOpen)}
                className="flex w-full items-center gap-1 rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {isClosedBlockOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                {`${t('sessionGroups.closed', 'Encerradas')} (${group.closedSessions.length})`}
              </button>
              {isClosedBlockOpen && group.closedSessions.map((session) => renderRow(session, false))}
            </>
          )}

          {group.ignoredSessions.length > 0 && (
            <>
              <p className="px-2 pt-1 text-[11px] text-muted-foreground">
                {`${t('sessionGroups.ignored', 'Ignoradas')} (${group.ignoredSessions.length})`}
              </p>
              {group.ignoredSessions.map((session) => renderRow(session, false))}
            </>
          )}
        </div>
      )}
    </section>
  );
}
