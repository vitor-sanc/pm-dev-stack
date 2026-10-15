import { CircleCheck, EyeOff, MoreHorizontal, Pause, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { ActionMenu } from '@/shared/ui';
import type { SessionWorkflowStatus } from '@/shared/types';

type StatusOption = {
  status: SessionWorkflowStatus;
  defaultLabel: string;
  icon: LucideIcon;
};

const STATUS_OPTIONS: StatusOption[] = [
  { status: 'active', defaultLabel: 'Ativa', icon: Play },
  { status: 'paused', defaultLabel: 'Pausada', icon: Pause },
  { status: 'closed', defaultLabel: 'Encerrada', icon: CircleCheck },
  { status: 'ignored', defaultLabel: 'Ignorada', icon: EyeOff },
];

type SessionStatusMenuProps = {
  currentStatus: SessionWorkflowStatus;
  onStatusSelect: (status: SessionWorkflowStatus) => void;
  t: TFunction;
};

/** Used by SessionGroupRow for the "…" menu that moves a session between Ativa, Pausada, Encerrada and Ignorada. */
export default function SessionStatusMenu({ currentStatus, onStatusSelect, t }: SessionStatusMenuProps) {
  const menuLabel = t('sessionGroups.statusMenu', 'Status');

  return (
    <ActionMenu
      label={menuLabel}
      ariaLabel={menuLabel}
      icon={MoreHorizontal}
      iconOnly
      portal
      variant="ghost"
      size="sm"
      triggerClassName="h-6 w-6 rounded-md p-0 text-muted-foreground hover:bg-transparent hover:text-foreground [&_svg]:size-3.5"
      items={STATUS_OPTIONS.map((option) => ({
        key: option.status,
        label: t(`sessionGroups.status.${option.status}`, option.defaultLabel),
        icon: option.icon,
        // The current status is the state, not an action.
        disabled: option.status === currentStatus,
        onSelect: () => onStatusSelect(option.status),
      }))}
    />
  );
}
