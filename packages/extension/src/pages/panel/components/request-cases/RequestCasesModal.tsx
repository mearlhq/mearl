import { useEffect, useMemo, useState } from 'react';
import type { MockConfigRef } from '../../../../shared/types';
import { acceptCaptureIdentity, captureIdentitySelection, useCaptureIdentity } from '../../hooks/useCaptureIdentity';
import { BrowserView } from '../browser-view/BrowserView';
import { useBrowserView, refreshBrowserView } from '../browser-view/viewState';
import type { SelectedBrowserView } from '@mearl/preset/bundles';
import { Modal, ModalContent, ModalHeader } from '../modal/Modal';
import { t } from '../../utils/i18n';

export interface RequestCasesModalProps {
  isOpen: boolean;
  onClose(): void;
  cachedAppList?: any[];
  onAppListFetched?(appList: any[]): void;
  onImportMock?(override: { apiName: string; responseData: any; mockConfig?: MockConfigRef }): Promise<{ success: boolean }>;
}

export function RequestCasesModal(props: RequestCasesModalProps) {
  const view = useBrowserView('requestCases');
  const account = useCaptureIdentity({ source: 'full', lazy: true });
  const [accepted, setAccepted] = useState<{ selected: SelectedBrowserView; identitySelection: number } | null>(null);
  const identitySelection = useMemo(() => captureIdentitySelection(), [props.isOpen, view.selected?.bundleId, view.selected?.revision]);
  const currentSelection = captureIdentitySelection();
  useEffect(() => {
    if (!props.isOpen && accepted && accepted.identitySelection !== currentSelection) setAccepted(null);
  }, [props.isOpen, accepted, currentSelection]);
  const context = useMemo(
    () => ({
      isOpen: props.isOpen,
      cachedAppList: props.cachedAppList ?? [],
      canImport: Boolean(props.onImportMock),
      identity: { userInfo: account.userInfo, loginRequired: account.loginRequired },
    }),
    [
      props.isOpen,
      props.cachedAppList,
      props.onImportMock,
      account.userInfo,
      account.loginRequired,
    ],
  );
  const selected = accepted ? accepted.selected : view.selected;
  if (!view.loaded || !selected)
    return (
      <Modal isOpen={props.isOpen} onClose={props.onClose}>
        <ModalHeader title={t('requestCasesTitle')} onClose={props.onClose} />
        <ModalContent>
          <span aria-busy={!view.loaded}>{view.loaded ? t('browserViewUnavailable') : t('loading')}</span>
        </ModalContent>
      </Modal>
    );
  if (!props.isOpen && !accepted) return null;
  return (
    <BrowserView
      selected={selected}
      isOpen={props.isOpen}
      context={context}
      onAccepted={value => setAccepted(previous => previous ?? { selected: value, identitySelection })}
      onRefresh={async () => {
        if (!accepted) await refreshBrowserView();
      }}
      onCall={async (method, input) => {
        if (method === 'close') return props.onClose();
        if (method === 'appList') {
          if (
            !Array.isArray(input.apps) ||
            input.apps.some(
              (app: any) =>
                !app || typeof app.appkey !== 'string' || typeof app.appname !== 'string',
            )
          )
            throw new Error('Invalid application list');
          props.onAppListFetched?.(input.apps);
          return null;
        }
        if (method === 'identity') {
          if (selected.bundleId !== view.selected?.bundleId || selected.revision !== view.selected?.revision) throw new Error('The identity provider changed');
          if (
            typeof input.loginRequired !== 'boolean' ||
            (input.userInfo !== null &&
              (!input.userInfo ||
                typeof input.userInfo !== 'object' ||
                Array.isArray(input.userInfo)))
          )
            throw new Error('Invalid user information');
          acceptCaptureIdentity(input.userInfo, input.loginRequired, accepted?.identitySelection ?? identitySelection);
          return null;
        }
        if (method === 'import') {
          const mock = input.mockConfig;
          if (
            typeof input.apiName !== 'string' ||
            !input.apiName.trim() ||
            !Object.hasOwn(input, 'responseData') ||
            (mock !== undefined &&
              (!mock ||
                typeof mock.id !== 'string' ||
                typeof mock.appname !== 'string' ||
                typeof mock.caseId !== 'number' ||
                !Number.isFinite(mock.caseId)))
          )
            throw new Error('Invalid import result');
          return (
            props.onImportMock?.({
              apiName: input.apiName,
              responseData: input.responseData,
              ...(mock === undefined ? {} : { mockConfig: mock }),
            }) ?? { success: false }
          );
        }
        throw new Error('Unknown browser view callback');
      }}
    />
  );
}
