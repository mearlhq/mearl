import { useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { parseProfileSource } from '@mearl/preset/bundles';
import { t } from '../../utils/i18n';
import { Button } from '../../../options/components/Button';
import { ModalContent, ModalHeader } from './Modal';

const wechatSource = 'mearlhq/profile-wechat';

export function ProfileInstallModal({
  initialSource,
  confirmation,
  onClose,
}: {
  initialSource?: string | null;
  confirmation?: string | null;
  onClose: () => void;
}) {
  const [source, setSource] = useState(initialSource ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [installed, setInstalled] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sourceRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.showModal();
    if (!confirmation) sourceRef.current?.focus();
    return () => dialog.close();
  }, [confirmation]);

  async function install(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setInstalled('');
    try {
      const { origin } = parseProfileSource(source);
      if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
        throw new Error(t('appProfileInstallPermissionDenied'));
      }
      const response = await chrome.runtime.sendMessage({
        action: 'browserCapabilityBundle',
        data: { operation: 'installProfile', source, ...(confirmation ? { confirmation } : {}) },
      });
      if (!response?.success) throw new Error(response?.error || t('appProfileInstallFailed'));
      setInstalled(
        response.data.profiles.map((profile: { label: string }) => profile.label).join(', '),
      );
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('appProfileInstallFailed'));
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    if (!busy) onClose();
  };
  function keepTabInDialog(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled)',
    );
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey ? document.activeElement === first : document.activeElement === last) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label={t('appProfileInstallTitle')}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-[26rem] max-h-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg bg-bg-primary text-text-primary shadow-2xl open:flex backdrop:bg-black/50"
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={keepTabInDialog}
    >
      <ModalHeader title={t('appProfileInstallTitle')} onClose={close} />
      <ModalContent>
        <div className="space-y-3">
          {!confirmation && (
            <div className="space-y-1.5">
              <h3 className="text-2xs font-medium text-text-secondary">
                {t('appProfileInstallOfficial')}
              </h3>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setSource(wechatSource);
                  setError('');
                  setInstalled('');
                }}
                className="flex w-full items-center justify-between gap-2 rounded border border-border bg-bg-primary px-2 py-1.5 text-left text-xs text-text-primary hover:bg-bg-hover focus-visible:outline focus-visible:outline-blue-500"
              >
                <span>{t('appProfileInstallWeChat')}</span>
                <span className="truncate text-2xs text-text-secondary">{wechatSource}</span>
              </button>
            </div>
          )}
          <p className="text-xs text-text-secondary">{t('appProfileInstallDescription')}</p>
          <form onSubmit={event => void install(event)} className="flex gap-2">
            <input
              ref={sourceRef}
              aria-label={t('appProfileInstallSource')}
              value={source}
              onChange={event => setSource(event.currentTarget.value)}
              placeholder="owner/repo"
              maxLength={2048}
              readOnly={Boolean(confirmation)}
              disabled={busy}
              className="min-w-0 flex-1 rounded border border-border bg-bg-primary px-2 text-xs text-text-primary focus-visible:outline focus-visible:outline-blue-500"
            />
            <Button
              type="submit"
              variant="primary"
              disabled={busy || !source.trim() || Boolean(confirmation && installed)}
            >
              {busy ? t('appProfileInstallPending') : t('appProfileInstallSubmit')}
            </Button>
          </form>
          {error && (
            <p role="alert" className="break-words text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
          {installed && (
            <p role="status" className="break-words text-xs text-text-primary">
              {t('appProfileInstallSuccess', installed)}
            </p>
          )}
        </div>
      </ModalContent>
    </dialog>,
    document.body,
  );
}
