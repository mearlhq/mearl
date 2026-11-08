import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const settings = vi.hoisted(() => ({ value: {} as any }));
vi.mock('../../../utils/browserUiSettings', () => ({ useBrowserUiSettings: () => settings.value }));
vi.mock('../../../utils/i18n', () => ({ getCurrentLanguage: () => 'en' }));
import { EagleeyeTraceidLink } from '../EagleeyeTraceidLink';
beforeEach(() => { settings.value = { linkTemplates: { trace: { template: 'https://trace.example.test/#/query?id={traceId}&start={startTime}&end={endTime}', title: { en: 'View trace' } } } }; });
it('opens the configured destination synchronously from the existing click interaction', () => {
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(<EagleeyeTraceidLink traceid="owned&中文" timestampMs={10_000_000} />);
  fireEvent.click(screen.getByTitle('View trace'));
  expect(opened).toHaveBeenCalledWith('https://trace.example.test/#/query?id=owned%26%E4%B8%AD%E6%96%87&start=6400000&end=13600000', '_blank');
  opened.mockRestore();
});
it('keeps the raw trace ID when no package supplies its destination', () => {
  settings.value = {}; render(<EagleeyeTraceidLink traceid="owned" timestampMs={1} />);
  expect(screen.getByText('owned')).toBeInTheDocument(); expect(screen.queryByTitle('View trace')).toBeNull();
});

it('keeps malformed diagnostic values from throwing during render', () => {
  const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
  const view = render(<EagleeyeTraceidLink traceid={'bad\uD800'} timestampMs={1} />);
  fireEvent.click(screen.getByTitle('View trace'));
  expect(opened.mock.calls[0][0]).toContain('bad%EF%BF%BD');
  view.rerender(<EagleeyeTraceidLink traceid="owned" timestampMs={NaN} />);
  expect(screen.getByText('owned')).toBeInTheDocument(); expect(screen.queryByTitle('View trace')).toBeNull();
  opened.mockRestore();
});
