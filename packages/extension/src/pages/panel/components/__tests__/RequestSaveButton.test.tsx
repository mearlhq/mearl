import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RequestSaveButton } from '../RequestSaveButton';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../utils/toast', () => ({ showToast: toast }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});
const labels = {
  create: 'Create',
  update: 'Update',
  search: 'Search suites',
  empty: 'Empty',
  failed: 'Failed',
};
const choice = { id: 7, label: 'Suite', value: { id: 7, application: 'demo' } };
const reference = { id: 'saved' };

it('keeps the portal, input focus, debounced search and outside-click close in the host document', async () => {
  const loadChoices = vi.fn().mockResolvedValue({ success: true, data: [choice] });
  const { container } = render(
    <RequestSaveButton
      labels={labels}
      loadChoices={loadChoices}
      save={vi.fn()}
      onReferenceChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTitle('Create'));
  const input = screen.getByPlaceholderText('Search suites');
  expect(container.contains(input)).toBe(false);
  await screen.findByText('Suite');
  await waitFor(() => expect(document.activeElement).toBe(input));
  vi.useFakeTimers();
  fireEvent.change(input, { target: { value: '中文' } });
  await act(async () => {
    vi.advanceTimersByTime(299);
  });
  expect(loadChoices).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(loadChoices).toHaveBeenLastCalledWith('中文');
  fireEvent.mouseDown(document.body);
  expect(screen.queryByPlaceholderText('Search suites')).toBeNull();
});
it('persists a new reference and directly updates it without reopening the selector', async () => {
  const onReferenceChange = vi.fn();
  const save = vi.fn().mockResolvedValue({ success: true, reference });
  render(
    <RequestSaveButton
      labels={labels}
      loadChoices={async () => ({ success: true, data: [choice] })}
      save={save}
      onReferenceChange={onReferenceChange}
    />,
  );
  fireEvent.click(screen.getByTitle('Create'));
  fireEvent.click(await screen.findByText('Suite'));
  await waitFor(() => expect(onReferenceChange).toHaveBeenCalledExactlyOnceWith(reference));
  expect(save).toHaveBeenLastCalledWith(choice.value, undefined);
  fireEvent.click(screen.getByTitle('Update'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenLastCalledWith(undefined, reference);
  expect(screen.queryByPlaceholderText('Search suites')).toBeNull();
});
it('one-shot saves call completion and keep the create button', async () => {
  const changed = vi.fn(),
    complete = vi.fn();
  render(
    <RequestSaveButton
      labels={labels}
      persistConfig={false}
      loadChoices={async () => ({ success: true, data: [choice] })}
      save={async () => ({ success: true, reference })}
      onReferenceChange={changed}
      onSaveComplete={complete}
    />,
  );
  fireEvent.click(screen.getByTitle('Create'));
  fireEvent.click(await screen.findByText('Suite'));
  await waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  expect(changed).not.toHaveBeenCalled();
  expect(screen.getByTitle('Create')).toBeTruthy();
});
it('disables pending saves, retains the reference after failure and retries the same input', async () => {
  let finish!: (value: { success: boolean; error: string }) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ success: true });
  render(
    <RequestSaveButton
      reference={reference}
      labels={labels}
      loadChoices={vi.fn()}
      save={save}
      onReferenceChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByTitle('Update'));
  expect((screen.getByTitle('Update') as HTMLButtonElement).disabled).toBe(true);
  await act(async () => {
    finish({ success: false, error: 'Owned failure' });
  });
  expect(toast).toHaveBeenCalledWith('Owned failure', 'error');
  fireEvent.click(screen.getByTitle('Update'));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save).toHaveBeenLastCalledWith(undefined, reference);
});
