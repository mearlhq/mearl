import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
const view = vi.hoisted(() => ({ selected: undefined as any }));
vi.mock('../../browser-view/viewState', () => ({ useBrowserView: () => ({ loaded: true, selected: view.selected }), refreshBrowserView: vi.fn() }));
vi.mock('../../browser-view/BrowserView', () => ({ BrowserView: ({ isOpen }: { isOpen: boolean }) => isOpen ? <div>dynamicImport</div> : null }));
vi.mock('../../../utils/toast', () => ({ showToast: vi.fn() }));
vi.mock('../../../utils/i18n', () => ({ t: (key: string) => key }));
vi.mock('../../CodeEditor', () => ({ CodeEditor: ({ code, onChange, placeholder }: any) => <textarea aria-label={placeholder} value={code} onChange={event => onChange(event.target.value)} /> }));
import { JsonImportModal } from '../JsonImportModal';
import { RequestImportModal } from '../RequestImportModal';
function fill(value: unknown) { fireEvent.change(screen.getByLabelText('jsonInputPlaceholder'), { target: { value: JSON.stringify(value) } }); }
it('imports an api response without any installed capability or Native Host', async () => {
  const onImportMock = vi.fn(async () => ({ success: true })), onClose = vi.fn();
  render(<JsonImportModal isOpen onClose={onClose} onImportMock={onImportMock} />);
  fill({ api: 'api.example', data: { value: 1 } });
  fireEvent.click(screen.getByRole('button', { name: 'importData' }));
  await waitFor(() => expect(screen.getByLabelText('jsonInputPlaceholder')).toHaveValue(''));
  expect(onClose).not.toHaveBeenCalled();
  expect(onImportMock).toHaveBeenCalledWith({ apiName: 'api.example', responseData: { api: 'api.example', data: { value: 1 } } });
});
it('validates all api names before dispatching and preserves invalid JSON', async () => {
  const onImportMock = vi.fn(); render(<JsonImportModal isOpen onClose={() => {}} onImportMock={onImportMock} />);
  const input = screen.getByLabelText('jsonInputPlaceholder');
  fireEvent.change(input, { target: { value: '{invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'importData' }));
  expect(screen.getByText('jsonInvalidJson')).toBeVisible(); expect(input).toHaveValue('{invalid');
  fill([{api:'api.first'}, {value:2}]);
  fireEvent.change(screen.getByPlaceholderText('jsonApiPlaceholder'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'importData' }));
  expect(await screen.findByText('jsonApiRequired')).toBeVisible(); expect(onImportMock).not.toHaveBeenCalled();
});
it('retains only failed and unprocessed entries for retry', async () => {
  const onImportMock = vi.fn().mockResolvedValueOnce({success:true}).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({success:true});
  const onClose=vi.fn(); render(<JsonImportModal isOpen onClose={onClose} onImportMock={onImportMock} />);
  fill([{api:'api.first',data:1},{api:'api.second',data:2}]);
  fireEvent.click(screen.getByRole('button', { name: 'importData' }));
  await screen.findByText('requestImportFailed');
  expect(JSON.parse((screen.getByLabelText('jsonInputPlaceholder') as HTMLTextAreaElement).value)).toEqual([{api:'api.second',data:2}]);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'importData' }));
  await waitFor(()=>expect(screen.getByLabelText('jsonInputPlaceholder')).toHaveValue(''));
  expect(onClose).not.toHaveBeenCalled();
  expect(onImportMock.mock.calls.map(([entry])=>entry.apiName)).toEqual(['api.first','api.second','api.second']);
});
it('passes object conditions and rejects array conditions before importing', async () => {
  const onImportMock=vi.fn(async()=>({success:true})); render(<JsonImportModal isOpen onClose={()=>{}} onImportMock={onImportMock} />);
  fill({api:'api.example',data:{}}); fireEvent.click(screen.getByTitle('mockConditions'));
  fireEvent.change(screen.getByLabelText('conditionsPlaceholder'),{target:{value:'[]'}});
  fireEvent.click(screen.getByRole('button',{name:'importData'})); expect(onImportMock).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('conditionsPlaceholder'),{target:{value:'{"id":"42"}'}});
  fireEvent.click(screen.getByRole('button',{name:'importData'}));
  await waitFor(()=>expect(onImportMock).toHaveBeenCalledWith({apiName:'api.example',responseData:{api:'api.example',data:{}},conditions:{id:'42'}}));
});

it.each(['draft', 'pending'])('retains the built-in %s when a dynamic view is installed', async phase => {
  view.selected = undefined;
  let finish!: (value: unknown) => void;
  const onImportMock = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const props = { isOpen: true, onClose: vi.fn(), onImportMock };
  const { rerender } = render(<RequestImportModal {...props} />);
  fill({ api: 'api.example', data: { value: 1 } });
  if (phase === 'pending') fireEvent.click(screen.getByRole('button', { name: 'importData' }));
  view.selected = { bundleId: 'fixture', revision: 'new' };
  rerender(<RequestImportModal {...props} />);
  expect(screen.queryByText('dynamicImport')).toBeNull();
  expect(screen.getByLabelText('jsonInputPlaceholder')).toHaveValue(JSON.stringify({ api: 'api.example', data: { value: 1 } }));
  if (phase === 'pending') {
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish({ success: true }));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('dynamicImport')).toBeNull();
  }
  rerender(<RequestImportModal {...props} isOpen={false} />);
  rerender(<RequestImportModal {...props} isOpen />);
  expect(screen.getByText('dynamicImport')).toBeVisible();
});
