import { useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { api, readApiJson } from '@/shared/api';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/ui';

type MarkerMigrationItem = {
  sessionId: string;
  provider: string;
  currentTitle: string;
  cleanTitle: string | null;
  proposedStatus: 'closed' | 'ignored';
};

type MarkerMigrationResult = {
  applied: string[];
  failed: Array<{ sessionId: string; message: string }>;
};

type MarkerMigrationModalProps = {
  isOpen: boolean;
  onClose: () => void;
  onApplied: () => void;
  t: TFunction;
};

type MarkerMigrationBodyProps = Omit<MarkerMigrationModalProps, 'isOpen'>;

const PROPOSED_STATUS_DEFAULT_LABELS: Record<MarkerMigrationItem['proposedStatus'], string> = {
  closed: 'Encerrada',
  ignored: 'Ignorada',
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function MarkerMigrationBody({ onClose, onApplied, t }: MarkerMigrationBodyProps) {
  // The dry-run answer: what an apply would change. `null` until it loads, so the dialog can show "loading".
  const [previewItems, setPreviewItems] = useState<MarkerMigrationItem[] | null>(null);
  // Message of the last failed preview request; the user can retry from it.
  const [loadError, setLoadError] = useState<string | null>(null);
  // True while the apply request runs; keeps the button disabled so a double click sends one request.
  const [isApplying, setIsApplying] = useState(false);
  // Message of the last refused apply; the dialog stays open so the user can try again.
  const [applyError, setApplyError] = useState<string | null>(null);
  // What the server did after a successful apply; replaces the list and turns the main button into "Fechar".
  const [result, setResult] = useState<MarkerMigrationResult | null>(null);
  // Counts the preview requests; "Tentar de novo" bumps it to run the load effect again.
  const [previewAttempt, setPreviewAttempt] = useState(0);
  // A response that lands after the dialog closed must not touch state.
  const isUnmountedRef = useRef(false);

  useEffect(() => {
    isUnmountedRef.current = false;
    api.sessionWorkflow.markerMigrationPreview()
      .then((response) => readApiJson<{ data: { items: MarkerMigrationItem[] } }>(response))
      .then((payload) => {
        if (!isUnmountedRef.current) {
          setPreviewItems(payload.data.items);
        }
      })
      .catch((error: unknown) => {
        if (!isUnmountedRef.current) {
          setLoadError(describeError(error));
        }
      });
    return () => {
      isUnmountedRef.current = true;
    };
  }, [previewAttempt]);

  const retryPreview = () => {
    setLoadError(null);
    setPreviewAttempt((attempt) => attempt + 1);
  };

  const applyMigration = async () => {
    if (previewItems === null) {
      return;
    }

    setApplyError(null);
    setIsApplying(true);
    try {
      const payload = await readApiJson<{ data: MarkerMigrationResult }>(
        await api.sessionWorkflow.applyMarkerMigration(previewItems.map((item) => item.sessionId)),
      );
      onApplied();
      if (!isUnmountedRef.current) {
        setResult(payload.data);
      }
    } catch (error) {
      if (!isUnmountedRef.current) {
        const failureLabel = t('sessionGroups.migration.applyFailed', 'Não foi possível aplicar');
        setApplyError(`${failureLabel}: ${describeError(error)}`);
      }
    }
    if (!isUnmountedRef.current) {
      setIsApplying(false);
    }
  };

  const titleOfSession = (sessionId: string) =>
    previewItems?.find((item) => item.sessionId === sessionId)?.currentTitle ?? sessionId;

  const hasItems = previewItems !== null && previewItems.length > 0;

  return (
    <div className="flex flex-col gap-4 p-5">
      <div>
        <p className="text-base font-semibold text-foreground">
          {t('sessionGroups.migration.title', 'Limpar marcadores dos títulos')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('sessionGroups.migration.description', 'O marcador sai do título e vira status. Nada muda até você aplicar.')}
        </p>
      </div>

      {previewItems === null && loadError === null && (
        <p className="text-sm text-muted-foreground">{t('sessionGroups.migration.loading', 'Carregando prévia…')}</p>
      )}

      {loadError !== null && (
        <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
          {`${t('sessionGroups.migration.loadFailed', 'Não foi possível carregar a prévia')}: ${loadError}`}
          <Button variant="ghost" size="sm" onClick={retryPreview}>
            {t('sessionGroups.retry', 'Tentar de novo')}
          </Button>
        </div>
      )}

      {previewItems !== null && previewItems.length === 0 && result === null && (
        <p className="text-sm text-muted-foreground">{t('sessionGroups.migration.empty', 'Nenhum título com marcador')}</p>
      )}

      {hasItems && result === null && (
        <ul className="max-h-72 space-y-2 overflow-y-auto text-sm" data-testid="marker-migration-items">
          {previewItems.map((item) => (
            <li key={item.sessionId} className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2">
              <span className="break-words text-muted-foreground">{item.currentTitle}</span>
              <span className="break-words text-foreground">
                {'→ '}
                <span>{item.cleanTitle ?? t('sessionGroups.migration.titleKept', '(título mantido)')}</span>
              </span>
              <span className="text-[11px] text-muted-foreground">
                {t(`sessionGroups.status.${item.proposedStatus}`, PROPOSED_STATUS_DEFAULT_LABELS[item.proposedStatus])}
              </span>
            </li>
          ))}
        </ul>
      )}

      {applyError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {applyError}
        </p>
      )}

      {result !== null && (
        <div className="space-y-2 text-sm">
          <p className="text-foreground">{`${t('sessionGroups.migration.applied', 'Aplicadas')}: ${result.applied.length}`}</p>
          {result.failed.length > 0 && (
            <>
              <p className="text-destructive">{`${t('sessionGroups.migration.failed', 'Não aplicadas')}: ${result.failed.length}`}</p>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                {result.failed.map((failure) => (
                  <li key={failure.sessionId}>{`${titleOfSession(failure.sessionId)}: ${failure.message}`}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="flex justify-end gap-2">
        {result === null ? (
          <>
            <Button variant="outline" size="sm" onClick={onClose}>
              {t('sessionGroups.migration.cancel', 'Cancelar')}
            </Button>
            <Button size="sm" disabled={!hasItems || isApplying} onClick={() => void applyMigration()}>
              {t('sessionGroups.migration.apply', 'Aplicar')}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onClose}>
            {t('sessionGroups.migration.close', 'Fechar')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Used by SessionGroupsPanel to preview the one-time marker migration and apply it after the
 * user confirms. `onApplied` runs after a successful apply so the panel refreshes its groups.
 */
export default function MarkerMigrationModal({ isOpen, onClose, onApplied, t }: MarkerMigrationModalProps) {
  return (
    <Dialog open={isOpen} onOpenChange={(isDialogOpen) => !isDialogOpen && onClose()}>
      <DialogContent className="w-[calc(100vw-1rem)] max-w-lg">
        <DialogTitle>{t('sessionGroups.migration.title', 'Limpar marcadores dos títulos')}</DialogTitle>
        <MarkerMigrationBody onClose={onClose} onApplied={onApplied} t={t} />
      </DialogContent>
    </Dialog>
  );
}
