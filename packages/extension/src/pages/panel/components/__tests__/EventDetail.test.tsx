const point = vi.hoisted(() => ({ resolve: vi.fn(), highlight: vi.fn() }));
vi.mock('../../utils/aplusSpm', () => ({ resolveAplusSpm: point.resolve }));
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RumEvent } from '../../types';
import { EventDetail } from '../EventDetail';

vi.mock('../../hooks/useLocalStorage', () => ({
  useLocalStorage: (_key: string, initialValue: unknown) => [initialValue, vi.fn(), true],
}));

vi.mock('../../utils/spmHighlight', () => ({
  highlightSpmInPage: point.highlight,
  inspectSpmInElements: vi.fn(),
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
  point.highlight.mockClear();
  (chrome.devtools.network as any).onNavigated = {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  };
});


describe('EventDetail', () => {
  it('普通 RUM 事件继续在事件字段中展示顶层 bizArgs', () => {
    const { container } = render(
      <EventDetail event={createEvent({ _raw: { bizArgs: { visible: true } } })} />,
    );

    expect(container).toHaveTextContent('bizArgs');
    expect(container).toHaveTextContent('visible');
  });

  it('保留非对象类型的 expdata exargs', () => {
    const { container } = render(
      <EventDetail
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
  const event = createEvent({ source: 'aplus', event_type: 'CLK', point: { mainSpm: '1.2.card.button', highlightSpm: '1.2.card.button' } });
  const { container } = render(<EventDetail event={event} />);
  expect(container).toHaveTextContent('1.2.card.button');
  expect(point.resolve).not.toHaveBeenCalled();
  expect(point.highlight).toHaveBeenCalledWith('1.2.card.button', expect.any(Function));
});

it('renders a decoded point outside DevTools without trying to highlight the page', () => {
  vi.stubGlobal('chrome', { ...chrome, devtools: undefined });
  try {
    const event = createEvent({
      source: 'aplus',
      event_type: 'CLK',
      point: { mainSpm: '1.2.card.button', highlightSpm: '1.2.card.button' },
    });
    const { container, queryByTitle } = render(<EventDetail event={event} />);
    expect(container).toHaveTextContent('1.2.card.button');
    expect(point.highlight).not.toHaveBeenCalled();
    expect(queryByTitle('aplusHighlightButtonTitle')).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }
});
it('ignores a late legacy point lookup after a different event is selected', async () => {
  let finish!: (value: unknown) => void;
  point.resolve.mockReset().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const legacy = createEvent({ id: 'legacy', source: 'aplus', event_type: 'CLK' });
  const current = createEvent({ id: 'current', source: 'aplus', event_type: 'CLK', point: { mainSpm: '1.2.new.button', highlightSpm: '1.2.new.button' } });
  const { container, rerender } = render(<EventDetail event={legacy} />);
  rerender(<EventDetail event={current} />);
  await act(async () => finish({ mainSpm: '1.2.old.button', highlightSpm: '1.2.old.button' }));
  await waitFor(() => expect(container).toHaveTextContent('1.2.new.button'));
  expect(container).not.toHaveTextContent('1.2.old.button');
});
