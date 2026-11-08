import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ views: {} as Record<string, any>, props: null as any, epoch: 0, refresh: vi.fn(), identity: vi.fn() }));
vi.mock('../viewState', () => ({ useBrowserView: (slot = 'requestImport') => fixture.views[slot], refreshBrowserView: fixture.refresh }));
vi.mock('../BrowserView', () => ({ BrowserView: (props: any) => {
  fixture.props = props;
  return <button onClick={() => props.onAccepted(props.selected)}>{props.selected.revision}</button>;
} }));
vi.mock('../../../hooks/useCaptureIdentity', () => ({ useCaptureIdentity: () => ({ userInfo: null, loginRequired: false }), acceptCaptureIdentity: fixture.identity, captureIdentitySelection: () => fixture.epoch }));
vi.mock('../../../utils/i18n', () => ({ t: (key: string) => key }));
vi.mock('../../request-import/JsonImportModal', () => ({ JsonImportModal: () => <div>builtinJsonImport</div> }));
vi.mock('../../modal/Modal', () => ({ Modal: ({ isOpen, children }: any) => isOpen ? <div>{children}</div> : null, ModalHeader: ({ title }: any) => <h2>{title}</h2>, ModalContent: ({ children }: any) => <div>{children}</div> }));
import { RequestImportModal } from '../../request-import/RequestImportModal';
import { RequestCasesModal } from '../../request-cases/RequestCasesModal';
beforeEach(() => {
  vi.clearAllMocks(); fixture.props = null; fixture.epoch = 0;
  fixture.views = { requestImport: { loaded: true }, requestCases: { loaded: true } };
});
for (const slot of ['requestImport', 'requestCases'] as const) {
  it(`${slot} does not pin a missing implementation and can use a subsequently installed view`, () => {
    const props = { isOpen: true, onClose: vi.fn(), onImportMock: vi.fn(async () => ({ success: true })) };
    const content = () => slot === 'requestImport' ? <RequestImportModal {...props} /> : <RequestCasesModal {...props} />;
    const { rerender } = render(content());
    expect(screen.getByText(slot === 'requestImport' ? 'builtinJsonImport' : 'browserViewUnavailable')).toBeTruthy();
    expect(fixture.props).toBeNull();
    fixture.views[slot] = { loaded: true, selected: { bundleId: 'fixture', revision: 'accepted' } };
    rerender(content());
    if (slot === 'requestImport') {
      expect(screen.getByText('builtinJsonImport')).toBeTruthy();
      props.isOpen = false; rerender(content());
      props.isOpen = true; rerender(content());
    }
    fireEvent.click(screen.getByRole('button', { name: 'accepted' }));
    fixture.views[slot] = { loaded: true, selected: { bundleId: 'replacement', revision: 'next' } };
    rerender(content());
    expect(screen.getByRole('button', { name: 'accepted' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'next' })).toBeNull();
  });
}
it('keeps the request import callback and validates the returned data', async () => {
  fixture.views.requestImport.selected = { bundleId: 'fixture', revision: 'accepted' };
  const onImportMock = vi.fn(async () => ({ success: true }));
  render(<RequestImportModal isOpen onClose={() => {}} onImportMock={onImportMock} />);
  await act(async () => fixture.props.onCall('import', { apiName: 'fixture.api', responseData: { text: '中文' }, conditions: { key: 'value' } }));
  expect(onImportMock).toHaveBeenCalledWith({ apiName: 'fixture.api', responseData: { text: '中文' }, conditions: { key: 'value' } });
  await expect(fixture.props.onCall('import', { apiName: '', responseData: {} })).rejects.toThrow('Invalid import result');
});
it('shares the case view identity and preserves imported references', async () => {
  fixture.views.requestCases.selected = { bundleId: 'fixture', revision: 'accepted' };
  const onImportMock = vi.fn(async () => ({ success: true }));
  render(<RequestCasesModal isOpen onClose={() => {}} onImportMock={onImportMock} />);
  await fixture.props.onCall('identity', { userInfo: { subject: 'fixture', complete: false }, loginRequired: false });
  expect(fixture.identity).toHaveBeenCalledWith({ subject: 'fixture', complete: false }, false, 0);
  const mockConfig = { id: 'fixture', appname: 'App', caseId: 1 };
  await fixture.props.onCall('import', { apiName: 'fixture.api', responseData: 0, mockConfig });
  expect(onImportMock).toHaveBeenCalledWith({ apiName: 'fixture.api', responseData: 0, mockConfig });
  await expect(fixture.props.onCall('identity', { userInfo: [], loginRequired: false })).rejects.toThrow('Invalid user information');
});

it('pins the identity epoch through same-version configuration changes and renews it on the next open', async () => {
  fixture.views.requestCases.selected = { bundleId: 'fixture', revision: 'same' };
  const props = { isOpen: true, onClose: vi.fn() };
  const view = render(<RequestCasesModal {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'same' }));
  fixture.epoch = 1;
  view.rerender(<RequestCasesModal {...props} />);
  await fixture.props.onCall('identity', { userInfo: { subject: 'old', complete: true }, loginRequired: false });
  expect(fixture.identity).toHaveBeenLastCalledWith({ subject: 'old', complete: true }, false, 0);
  props.isOpen = false; view.rerender(<RequestCasesModal {...props} />);
  props.isOpen = true; view.rerender(<RequestCasesModal {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'same' }));
  await fixture.props.onCall('identity', { userInfo: { subject: 'new', complete: true }, loginRequired: false });
  expect(fixture.identity).toHaveBeenLastCalledWith({ subject: 'new', complete: true }, false, 1);
});
