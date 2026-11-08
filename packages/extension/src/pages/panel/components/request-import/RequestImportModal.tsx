import { useEffect, useMemo, useState } from 'react';
import type { SelectedBrowserView } from '@mearl/preset/bundles';
import { BrowserView } from '../browser-view/BrowserView';
import { useBrowserView, refreshBrowserView } from '../browser-view/viewState';
import { Modal, ModalContent, ModalHeader } from '../modal/Modal';
import { t } from '../../utils/i18n';
import { JsonImportModal } from './JsonImportModal';
import type { RequestImportModalProps } from './requestImportTypes';

export function RequestImportModal(props: RequestImportModalProps) {
  const view = useBrowserView();
  // The accepted UI keeps its drafts and matching runtime until this document closes.
  const [accepted, setAccepted] = useState<{ selected: SelectedBrowserView } | null>(null);
  const context = useMemo(
    () => ({
      isOpen: props.isOpen,
      requestImportEnabled: props.requestImportEnabled ?? false,
      requestApiNames: props.requestApiNames ?? [],
      canOpenAuxiliary: Boolean(props.onOpenRequestCases),
    }),
    [props.isOpen, props.requestImportEnabled, props.requestApiNames, props.onOpenRequestCases],
  );
  const selected = accepted ? accepted.selected : view.selected;
  const [builtinPinned, setBuiltinPinned] = useState(false);
  useEffect(() => {
    if (!props.isOpen) setBuiltinPinned(false);
    else if (view.loaded && !selected) setBuiltinPinned(true);
  }, [props.isOpen, view.loaded, selected]);
  if (builtinPinned || view.loaded && !selected) return <JsonImportModal {...props} />;
  if (!view.loaded)
    return (
      <Modal isOpen={props.isOpen} onClose={props.onClose}>
        <ModalHeader title={t('importData')} onClose={props.onClose} />
        <ModalContent>
          <span aria-busy={!view.loaded}>{view.loaded ? t('browserViewUnavailable') : t('loading')}</span>
        </ModalContent>
      </Modal>
    );
  if (!selected || (!props.isOpen && !accepted)) return null;
  return (
    <BrowserView
      selected={selected}
      isOpen={props.isOpen}
      context={context}
      onAccepted={value => setAccepted(previous => previous ?? { selected: value })}
      onRefresh={async () => {
        if (!accepted) await refreshBrowserView();
      }}
      onCall={async (method, input) => {
        if (method === 'close') return props.onClose();
        if (method === 'openAuxiliary') return props.onOpenRequestCases?.();
        if (method === 'import') {
          if (
            !input ||
            typeof input.apiName !== 'string' ||
            !input.apiName.trim() ||
            !Object.hasOwn(input, 'responseData') ||
            (input.conditions !== undefined &&
              (!input.conditions ||
                typeof input.conditions !== 'object' ||
                Array.isArray(input.conditions)))
          )
            throw new Error('Invalid import result');
          return props.onImportMock({
            apiName: input.apiName,
            responseData: input.responseData,
            ...(input.conditions === undefined ? {} : { conditions: input.conditions }),
          });
        }
        throw new Error('Unknown browser view callback');
      }}
    />
  );
}
