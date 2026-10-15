import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { TFunction } from 'i18next';

import { api, readApiJson } from '@/shared/api';
import type { GroupedSession, SessionGroupKind } from '@/shared/types';
import { Button, Dialog, DialogContent, DialogTitle, Input } from '@/shared/ui';

type ForkedSession = {
  sessionId: string;
  provider: string;
  sessionName: string;
};

type BranchSessionModalProps = {
  session: GroupedSession;
  groupKind: SessionGroupKind;
  onClose: () => void;
  onForked: (projectId: string | null, sessionId: string, provider: string) => void;
  t: TFunction;
};

const MANAGEMENT_TITLE_PREFIX = 'Gestão';

/** The branch lives in the same group as its source: management stays in Gestão, a client prefix is kept, a loose session stays loose. */
function buildBranchTitle(groupKind: SessionGroupKind, titlePrefix: string | null, theme: string): string {
  if (groupKind === 'management') {
    return `${MANAGEMENT_TITLE_PREFIX} / ${theme}`;
  }
  if (titlePrefix !== null) {
    return `${titlePrefix} / ${theme}`;
  }
  return theme;
}

/**
 * Used by SessionGroupsPanel to branch a session: asks what the branch is for, shows the session
 * name it will get, forks, and hands the new session to `onForked`. The panel mounts it only
 * while a source session is chosen, so the theme and the error start empty on every opening.
 */
export default function BranchSessionModal({ session, groupKind, onClose, onForked, t }: BranchSessionModalProps) {
  // What the branch is for, as typed; the final session name is built from it.
  const [theme, setTheme] = useState('');
  // True while the fork request runs; keeps the submit disabled so a double click creates one branch.
  const [isForking, setIsForking] = useState(false);
  // Message of the last refused fork; the dialog stays open so the user can try again.
  const [forkError, setForkError] = useState<string | null>(null);
  // The panel unmounts the modal on close; a response that lands after that must not touch state.
  const isUnmountedRef = useRef(false);

  useEffect(() => {
    isUnmountedRef.current = false;
    return () => {
      isUnmountedRef.current = true;
    };
  }, []);

  const trimmedTheme = theme.trim();
  const branchTitle = buildBranchTitle(groupKind, session.titlePrefix, trimmedTheme);
  const canSubmit = trimmedTheme !== '' && !isForking;
  const questionLabel = t('sessionGroups.branch.question', 'Pra que serve?');

  const submitFork = async () => {
    if (!canSubmit) {
      return;
    }

    setForkError(null);
    setIsForking(true);
    let forkedSession: ForkedSession;
    try {
      const payload = await readApiJson<{ data: ForkedSession }>(
        await api.forkSession(session.sessionId, { title: branchTitle }),
      );
      forkedSession = payload.data;
    } catch (error) {
      if (!isUnmountedRef.current) {
        const failureLabel = t('sessionGroups.branch.failed', 'Não foi possível criar a branch');
        setForkError(`${failureLabel}: ${error instanceof Error ? error.message : String(error)}`);
        setIsForking(false);
      }
      return;
    }

    // Outside the try: the fork exists now, so a failure past this point must not read as "not created".
    onForked(session.projectId, forkedSession.sessionId, forkedSession.provider);
    onClose();
  };

  // The dialog cannot be dismissed while the fork runs, so its result always lands where it was asked.
  const closeUnlessForking = () => {
    if (!isForking) {
      onClose();
    }
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submitFork();
    }
  };

  return (
    <Dialog open onOpenChange={(isDialogOpen) => !isDialogOpen && closeUnlessForking()}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-md">
        <DialogTitle>{t('sessionGroups.branch.title', 'Nova branch')}</DialogTitle>
        <div className="flex flex-col gap-4 p-5">
          <p className="text-base font-semibold text-foreground">{t('sessionGroups.branch.title', 'Nova branch')}</p>

          <Input
            autoFocus
            value={theme}
            placeholder={questionLabel}
            aria-label={questionLabel}
            onChange={(event) => setTheme(event.target.value)}
            onKeyDown={submitOnEnter}
          />

          {trimmedTheme !== '' && (
            <div>
              <p className="text-[11px] text-muted-foreground">{t('sessionGroups.branch.namePreview', 'Nome da sessão')}</p>
              <p className="break-words text-sm text-foreground">{branchTitle}</p>
            </div>
          )}

          {forkError !== null && (
            <p role="alert" className="text-sm text-destructive">
              {forkError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={isForking} onClick={closeUnlessForking}>
              {t('sessionGroups.branch.cancel', 'Cancelar')}
            </Button>
            <Button size="sm" disabled={!canSubmit} onClick={() => void submitFork()}>
              {t('sessionGroups.branch.create', 'Criar e abrir')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
