import { RequestSaveButton } from './RequestSaveButton';
import type { MockConfigRef } from '../../../shared/types';
import { t } from '../utils/i18n';
import { storageGetSafely } from '../utils/safeChrome';
import { getBrowserViewState, refreshBrowserView } from './browser-view/viewState';
import { browserViewPreferenceKey } from '../../../shared/browserViewPreferences';
import { useBrowserRequestUi } from '../hooks/useBrowserRequestUi';
import { BROWSER_REQUEST_UI_ACTION } from '../../../shared/browserRequestUi';
import { captureIdentitySelection, useCaptureIdentity, withCaptureAutoLogin } from '../hooks/useCaptureIdentity';

export interface SaveTestCaseButtonProps {
  apiName: string;
  mockBody: any;
  mockConfig?: MockConfigRef;
  onMockConfigChange(config: MockConfigRef): void;
  sceneComment?: string;
  persistConfig?: boolean;
  onSaveComplete?(): void;
}

export function SaveTestCaseButton({ apiName, mockBody, mockConfig, onMockConfigChange, sceneComment, persistConfig = true, onSaveComplete }: SaveTestCaseButtonProps) {
  const ui = useBrowserRequestUi();
  const { userInfo: cachedUserInfo, openLoginWindow, fetchUserInfo } = useCaptureIdentity({ source: 'full', lazy: true });
  const operation = async (input: Record<string, unknown>, selected = ui) => {
    if (!selected.selected || !selected.definition?.save) throw new Error('CAPABILITY_NOT_INSTALLED');
    const result = await chrome.runtime.sendMessage({ action: BROWSER_REQUEST_UI_ACTION, data: { operation: 'save', revision: selected.selected.revision, input } });
    if (!result?.success) throw new Error(result?.error || t('saveFailed'));
    return result.data;
  };
  if (!ui.selected || !ui.definition?.save) return null;
  return <RequestSaveButton<{ suite: unknown; provider: typeof ui }, MockConfigRef> reference={mockConfig} onReferenceChange={onMockConfigChange} persistConfig={persistConfig} onSaveComplete={onSaveComplete}
    labels={{ create: t('saveToRequestCases'), update: t('updateTestCase'), search: t('requestCasesTransferSearchPlaceholder'), empty: t('requestCasesNoData'), failed: t('saveFailed') }}
    loadChoices={async search => {
      const provider = ui;
      if (!getBrowserViewState('requestCases').loaded) await refreshBrowserView();
      const cases = getBrowserViewState('requestCases').selected;
      const appKey = cases?.bundleId === provider.selected?.bundleId && cases?.revision === provider.selected?.revision && cases?.definition.preferences?.appKey && (cases.definition.preferences.appKey.area ?? 'local') === 'local' ? browserViewPreferenceKey(cases, 'appKey') : undefined;
      const selectedAppKey = appKey ? (await storageGetSafely<string>([appKey]))?.[appKey] : undefined;
      const result = await operation({ operation: 'list', appKey: selectedAppKey, search }, provider);
      return result.success && result.data ? { ...result, data: result.data.map((choice: any) => ({ ...choice, value: { suite: choice.value, provider } })) } : result;
    }}
    save={async (choice, reference) => {
      const selection = captureIdentitySelection();
      let info = cachedUserInfo;
      if (!info?.complete) {
        const result = await fetchUserInfo();
        if (selection !== captureIdentitySelection()) throw new Error('Capture identity provider changed');
        if (!result.success || !result.data) { await openLoginWindow(); throw new Error(t('captureLoginRequired')); }
        info = result.data;
      }
      return withCaptureAutoLogin(() => operation({ operation: 'save', apiName, mockBody, sceneComment, reference, suite: choice?.suite, creator: info.displayName || 'unknown' }, choice?.provider ?? ui));
    }} />;
}
