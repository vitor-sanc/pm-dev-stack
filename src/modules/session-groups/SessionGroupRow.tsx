import { Pin } from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '@/shared/utils';
import type { GroupedSession, SessionWorkflowStatus } from '@/shared/types';
import SessionStatusMenu from '@/modules/session-groups/SessionStatusMenu';

type SessionGroupRowProps = {
  session: GroupedSession;
  isPinned: boolean;
  isSelected: boolean;
  onSelect: (projectId: string | null, sessionId: string, provider: string) => void;
  onStatusChange: (sessionId: string, status: SessionWorkflowStatus) => void;
  t: TFunction;
};

/** Used by SessionGroupSection for one conversation line: its title without the group prefix, and its status menu. */
export default function SessionGroupRow({ session, isPinned, isSelected, onSelect, onStatusChange, t }: SessionGroupRowProps) {
  return (
    <div
      data-testid="session-group-row"
      data-status={session.status}
      data-pinned={isPinned ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      className={cn(
        'group flex min-w-0 items-center rounded-lg transition-colors',
        isSelected ? 'bg-primary/10' : 'hover:bg-accent/60',
        isPinned && !isSelected && 'bg-amber-500/10',
        session.status === 'paused' && 'opacity-60',
      )}
    >
      <button
        type="button"
        title={session.title}
        onClick={() => onSelect(session.projectId, session.sessionId, session.provider)}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left"
      >
        {isPinned && <Pin className="h-3 w-3 flex-shrink-0 text-amber-600 dark:text-amber-400" />}
        <span className="truncate text-[13px] font-normal leading-4 text-foreground">{session.displayTitle}</span>
      </button>

      <div className="flex-shrink-0 pr-1 md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
        <SessionStatusMenu
          currentStatus={session.status}
          onStatusSelect={(status) => onStatusChange(session.sessionId, status)}
          t={t}
        />
      </div>
    </div>
  );
}
