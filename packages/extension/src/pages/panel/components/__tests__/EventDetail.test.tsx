const point = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../utils/aplusSpm', () => ({ resolveAplusSpm: point.resolve }));
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RumEvent } from '../../types';
import { EventDetail } from '../EventDetail';

vi.mock('../../hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initialValue: unknown) => [initialValue, vi.fn(), true],
}));

const createEvent = (overrides: Partial<RumEvent>): RumEvent => ({
  id: 'event-1',
  source: 'rum',
  batchId: 1,
  batchTimestampMs: 1,
  batchTimestamp: '2026/08/26 12:00:00',
  event_type: 'view',
  timestamp: 1,
  _raw: {},
  _context: {
    requestUrl: '',
    app: {},
    user: {},
    session: {},
    view: {},
    properties: {},
    os: {},
    net: {},
  },
  ...overrides,
});

beforeEach(() => {
  point.resolve.mockReset().mockResolvedValue({ mainSpm: '', highlightSpm: '' });
  vi.mocked(chrome.runtime.sendMessage).mockReset();
  (chrome.devtools.network as any).onNavigated = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
});

describe('EventDetail', () => {
  it('普通 RUM 事件继续在事件字段中展示顶层 bizArgs', () => {
    const { container } = render(
      <EventDetail tabId={1} event={createEvent({ _raw: { bizArgs: { visible: true } } })} />,
    );

    expect(container).toHaveTextContent('bizArgs');
    expect(container).toHaveTextContent('visible');
  });

  it('保留非对象类型的 expdata exargs', () => {
    const { container } = render(
      <EventDetail
        tabId={1}
        event={createEvent({
          event_type: 'EXP',
          _raw: {
            expdata: [{ spm: '1.2.asset.show', exargs: 'raw-exargs' }],
          },
        })}
      />,
    );

    expect(container).toHaveTextContent('exargs');
    expect(container).toHaveTextContent('raw-exargs');
  });
});

it('uses the accepted decoded point immediately without reinterpreting raw fields', () => {
  const event = createEvent({
    source: 'aplus',
    event_type: 'CLK',
    point: { mainSpm: '1.2.card.button', highlightSpm: '1.2.card.button' },
  });
  const { container } = render(<EventDetail event={event} tabId={1} />);
  expect(container).toHaveTextContent('1.2.card.button');
  expect(point.resolve).not.toHaveBeenCalled();
  expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
    { action: 'highlightSpm', tabId: 1, spm: '1.2.card.button' },
    expect.any(Function),
  );
});

it('locates the main point and individual exposures in the embedded panel', () => {
  const sendMessage = vi.fn(
    (message: { spm: string }, callback: (response: { found: number }) => void) => {
      callback({ found: message.spm === '1.2.card.button' ? 1 : 2 });
    },
  );
  vi.stubGlobal('chrome', {
    ...chrome,
    devtools: undefined,
    runtime: { ...chrome.runtime, sendMessage },
  });
  try {
    const event = createEvent({
      source: 'aplus',
      event_type: 'EXP',
      point: { mainSpm: '1.2.card.button', highlightSpm: '1.2.card.button' },
      _raw: { expdata: [{ spm: '1.2.banner.show' }] },
    });
    const { rerender, getByText, queryAllByRole, getAllByRole } = render(
      <EventDetail event={event} tabId={null} />,
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(queryAllByRole('button', { name: 'aplusHighlightButtonTitle' })).toHaveLength(0);

    rerender(<EventDetail event={event} tabId={42} />);
    const [mainButton, exposureButton] = getAllByRole('button', {
      name: 'aplusHighlightButtonTitle',
    });
    expect(sendMessage).toHaveBeenLastCalledWith(
      { action: 'highlightSpm', tabId: 42, spm: '1.2.card.button' },
      expect.any(Function),
    );
    expect(mainButton).toHaveTextContent('1');

    fireEvent.click(exposureButton);
    expect(sendMessage).toHaveBeenLastCalledWith(
      { action: 'highlightSpm', tabId: 42, spm: '1.2.banner.show' },
      expect.any(Function),
    );
    expect(exposureButton).toHaveTextContent('2');

    fireEvent.click(getByText('1.2.card.button'));
    expect(sendMessage).toHaveBeenLastCalledWith(
      { action: 'highlightSpm', tabId: 42, spm: '1.2.card.button' },
      expect.any(Function),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
it('ignores a late legacy point lookup after a different event is selected', async () => {
  let finish!: (value: unknown) => void;
  point.resolve.mockReset().mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const legacy = createEvent({ id: 'legacy', source: 'aplus', event_type: 'CLK' });
  const current = createEvent({
    id: 'current',
    source: 'aplus',
    event_type: 'CLK',
    point: { mainSpm: '1.2.new.button', highlightSpm: '1.2.new.button' },
  });
  const { container, rerender } = render(<EventDetail event={legacy} tabId={1} />);
  rerender(<EventDetail event={current} tabId={1} />);
  await act(async () => finish({ mainSpm: '1.2.old.button', highlightSpm: '1.2.old.button' }));
  await waitFor(() => expect(container).toHaveTextContent('1.2.new.button'));
  expect(container).not.toHaveTextContent('1.2.old.button');
});

it('ignores a manual exposure highlight result after switching events', () => {
  const event = createEvent({
    source: 'aplus',
    event_type: 'EXP',
    point: { mainSpm: '', highlightSpm: '' },
    _raw: { expdata: [{ spm: '1.2.old.exposure' }] },
  });
  const { rerender, getByRole } = render(<EventDetail event={event} tabId={42} />);
  const locateButton = () => getByRole('button', { name: 'aplusHighlightButtonTitle' });
  fireEvent.click(locateButton());
  const [message, reply] = vi.mocked(chrome.runtime.sendMessage).mock.lastCall!;
  expect(message).toEqual({ action: 'highlightSpm', tabId: 42, spm: '1.2.old.exposure' });

  rerender(
    <EventDetail
      event={{ ...event, id: 'event-2', _raw: { expdata: [{ spm: '1.2.new.exposure' }] } }}
      tabId={42}
    />,
  );
  act(() => (reply as (response: { found: number }) => void)({ found: 3 }));
  expect(locateButton()).not.toHaveTextContent('3');
});
