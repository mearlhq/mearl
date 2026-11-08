import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountBadge } from '../AccountBadge';

const accountMocks = vi.hoisted(() => ({
  fetchAccountIdentity: vi.fn(),
  fetchAccountQr: vi.fn(),
  borrow: vi.fn(),
  ticket: vi.fn(),
  setLoginOpen: vi.fn(async () => {}),
  loginSnapshot: { open: false, definition: undefined as undefined | { url: string; title: { en: string } } },
  requestAccounts: vi.fn(),
  retryAccounts: vi.fn(),
  accountsError: '',
  labelCache: new Map<string, string>(),
  settings: { logins: { accounts: { url: 'https://accounts.example.test/' } } },
  openWindow: vi.fn(),
}));

vi.mock('../../../hooks/useAccounts', () => ({
  useAccounts: () => ({
    accounts: accountMocks.accountsError ? [] : [
      {
        id: 1,
        loginId: 'test-account',
        principalId: 10001,
        site: 'CN',
      },
    ],
    initialized: true,
    loading: false,
    error: accountMocks.accountsError,
    requestAccounts: accountMocks.requestAccounts,
    retryAccounts: accountMocks.retryAccounts,
  }),
}));

vi.mock('../../LoginModal', () => ({ LoginModal: ({ isOpen, url, onClose }: { isOpen: boolean; url: string; onClose: () => void }) => isOpen ? <div data-testid="accepted-login" data-url={url}><button onClick={onClose}>close-login</button></div> : null }));

vi.mock('../../../utils/i18n', () => ({
  t: (key: string, value?: string) => key === 'accountLogin' && value ? `${key}: ${value}` : key,
}));

vi.mock('../../../utils/accounts', () => ({
  borrowAccount: accountMocks.borrow,
  fetchAccountSso: accountMocks.ticket,
  fetchAccountIdentity: accountMocks.fetchAccountIdentity,
  readAccountLabelCache: (scope: string) => accountMocks.labelCache.get(scope) ?? '',
  writeAccountLabelCache: (scope: string, label: string) => accountMocks.labelCache.set(scope, label),
  fetchAccountQr: accountMocks.fetchAccountQr,
  isAccountLoginError: (error: string) => error === 'ACCOUNT_LOGIN_REQUIRED',
  withAccountAutoLogin: async (request: () => Promise<unknown>) => ({ result: await request() }),
  redirectAccountLoginPage: vi.fn(),
}));

vi.mock('../../../utils/browserUiLogin', () => ({ useBrowserUiLogin: () => accountMocks.loginSnapshot, setBrowserUiLoginOpen: accountMocks.setLoginOpen }));
vi.mock('../../../utils/browserUiSettings', () => ({ useBrowserUiSettings: () => accountMocks.settings, getBrowserUiSettingsCacheScope: (settings: unknown) => JSON.stringify(settings) }));

vi.mock('../../../utils/qrCode', () => ({
  generateQrCodeSvgMarkup: () => '<svg viewBox="0 0 21 21"></svg>',
}));

describe('AccountBadge', () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    accountMocks.labelCache.clear();
    chrome.cookies = { onChanged: { addListener: vi.fn(), removeListener: vi.fn() } } as any;
    accountMocks.setLoginOpen.mockClear();
    accountMocks.retryAccounts.mockClear();
    accountMocks.requestAccounts.mockClear();
    accountMocks.borrow.mockReset().mockResolvedValue({ success: true, data: { id: 2, principalId: 123, site: 'test', loginId: 'borrowed', provider: { bundleId: 'accounts', revision: 'one' } } });
    accountMocks.ticket.mockReset().mockResolvedValue({ success: true, data: 'https://accounts.example.test/ticket' });
    accountMocks.loginSnapshot = { open: false, definition: undefined };
    accountMocks.accountsError = '';
    vi.spyOn(window, 'open').mockImplementation(accountMocks.openWindow);
    accountMocks.openWindow.mockReset();
    accountMocks.fetchAccountIdentity.mockReset().mockResolvedValue({ value: '10001', watch: [{ name: 'session-id', domain: 'example.test' }] });
    accountMocks.fetchAccountQr.mockReset().mockResolvedValue({
      success: true,
      data: { url: 'https://account.example/mobile', alternateUrl: 'https://account.example/mobile/harmony' },
    });
  });

  it('keeps quick borrow, accepted-provider SSO and list refresh in the same toolbar flow', async () => {
    const frames: HTMLIFrameElement[] = [];
    const appendChild = document.body.appendChild.bind(document.body);
    const append = vi.spyOn(document.body, 'appendChild').mockImplementation(node => {
      const result = appendChild(node);
      if (node instanceof HTMLIFrameElement) {
        frames.push(node);
        fireEvent.load(node);
      }
      return result;
    });
    try {
      render(<AccountBadge />);
      const input = screen.getByPlaceholderText('accountSearchPlaceholder');
      fireEvent.change(input, { target: { value: 'borrowed' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(accountMocks.borrow).toHaveBeenCalledWith('borrowed'));
      await waitFor(() => expect(accountMocks.ticket).toHaveBeenCalledWith(123, 'test', { bundleId: 'accounts', revision: 'one' }));
      await waitFor(() => expect(accountMocks.retryAccounts).toHaveBeenCalled());
      expect(frames).toHaveLength(1);
      expect(frames[0].src).toBe('https://accounts.example.test/ticket');
    } finally {
      append.mockRestore();
    }
  });
  it('shows a freshly verified cached label while list normalization is still unavailable', async () => {
    accountMocks.accountsError = 'pending';
    accountMocks.fetchAccountIdentity.mockResolvedValue({ value: '10001', watch: [], loginId: 'cached-account' });
    render(<AccountBadge showRequestCountToggle={false} />);
    await screen.findByText('cached-account');
    expect(accountMocks.requestAccounts).not.toHaveBeenCalled();
  });

  it('renders the local display cache immediately and clears it only after a verified empty identity', async () => {
    accountMocks.accountsError = 'pending';
    accountMocks.labelCache.set(JSON.stringify(accountMocks.settings), 'cached-account');
    let finish!: (identity: unknown) => void;
    accountMocks.fetchAccountIdentity.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<AccountBadge showRequestCountToggle={false} />);
    expect(screen.getByTitle('cached-account')).toHaveTextContent('cached-account');
    expect(screen.queryByTitle('accountCurrentAccount')).toBeNull();
    expect(accountMocks.fetchAccountIdentity).toHaveBeenCalledExactlyOnceWith();
    await act(async () => { finish({ value: '', watch: [] }); });
    expect(screen.getByTitle('account').textContent).toBe('');
    expect(accountMocks.labelCache.get(JSON.stringify(accountMocks.settings))).toBe('');
  });

  it.each(['empty identity', 'ACCOUNT_LOGIN_REQUIRED'])('does not flash the expired name on the next popup after %s', async result => {
    accountMocks.accountsError = 'pending';
    const scope = JSON.stringify(accountMocks.settings);
    accountMocks.labelCache.set(scope, 'expired-account');
    if (result === 'empty identity') accountMocks.fetchAccountIdentity.mockResolvedValue({ value: '', watch: [] });
    else accountMocks.fetchAccountIdentity.mockRejectedValue(new Error(result));
    const first = render(<AccountBadge showRequestCountToggle={false} />);
    await waitFor(() => expect(screen.getByTitle('account').textContent).toBe(''));
    expect(accountMocks.labelCache.get(scope)).toBe('');
    first.unmount();
    accountMocks.fetchAccountIdentity.mockImplementation(() => new Promise(() => {}));
    render(<AccountBadge showRequestCountToggle={false} />);
    expect(screen.queryByText('expired-account')).toBeNull();
    expect(screen.getByTitle('account').textContent).toBe('');
  });

  it('retains the cached label after a transient identity failure', async () => {
    accountMocks.labelCache.set(JSON.stringify(accountMocks.settings), 'cached-account');
    accountMocks.fetchAccountIdentity.mockRejectedValue(new Error('Disconnected'));
    render(<AccountBadge showRequestCountToggle={false} />);
    await act(async () => {});
    expect(screen.getByTitle('cached-account')).toHaveTextContent('cached-account');
  });

  it('uses the display cache while verification is pending and ignores a cache that arrives after verification', async () => {
    accountMocks.accountsError = 'pending';
    let finishFresh!: (identity: unknown) => void;
    let finishCache!: (identity: unknown) => void;
    accountMocks.fetchAccountIdentity.mockImplementation(options => new Promise(resolve => {
      if (options?.cachedOnly) finishCache = resolve; else finishFresh = resolve;
    }));
    const first = render(<AccountBadge showRequestCountToggle={false} />);
    await act(async () => { finishCache({ value: '', watch: [], loginId: 'cached-account' }); });
    expect(screen.getByTitle('cached-account')).toHaveTextContent('cached-account');
    expect(screen.queryByTitle('accountCurrentAccount')).toBeNull();
    await act(async () => { finishFresh({ value: 'new', watch: [], loginId: 'new-account' }); });
    expect(screen.getByTitle('new-account')).toHaveTextContent('new-account');
    await waitFor(() => expect(accountMocks.labelCache.get(JSON.stringify(accountMocks.settings))).toBe('new-account'));
    first.unmount();
    render(<AccountBadge showRequestCountToggle={false} />);
    await act(async () => { finishFresh({ value: 'new', watch: [], loginId: 'new-account' }); finishCache({ value: '', watch: [], loginId: 'cached-account' }); });
    expect(screen.getByTitle('new-account')).toHaveTextContent('new-account');
  });

  it('drops the local display cache when the selected settings change', async () => {
    accountMocks.labelCache.set(JSON.stringify(accountMocks.settings), 'cached-account');
    accountMocks.fetchAccountIdentity.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<AccountBadge showRequestCountToggle={false} />);
    expect(screen.getByTitle('cached-account')).toHaveTextContent('cached-account');
    const previous = accountMocks.settings;
    accountMocks.settings = { logins: { accounts: { url: 'https://next.example.test/' } } };
    rerender(<AccountBadge showRequestCountToggle={false} />);
    expect(screen.queryByText('cached-account')).toBeNull();
    accountMocks.settings = previous;
  });

  it('keeps the current name visible while a watched Cookie change is being checked', async () => {
    render(<AccountBadge showRequestCountToggle={false} />);
    await screen.findByTitle('test-account');
    let finish!: (identity: unknown) => void;
    accountMocks.fetchAccountIdentity.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const cookieListener = vi.mocked(chrome.cookies.onChanged.addListener).mock.calls.at(-1)![0];
    act(() => cookieListener({ cookie: { name: 'session-id', domain: '.example.test' }, removed: false } as chrome.cookies.CookieChangeInfo));
    expect(screen.getByTitle('test-account')).toHaveTextContent('test-account');
    await act(async () => { finish({ value: 'next', watch: [], loginId: 'next-account' }); });
    expect(screen.getByTitle('next-account')).toHaveTextContent('next-account');
  });

  it('refreshes identity on preset changes and ignores the previous provider’s delayed response', async () => {
    let resolveOld!: (value: unknown) => void;
    accountMocks.fetchAccountIdentity.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    const { rerender } = render(<AccountBadge />);
    accountMocks.settings = { logins: { accounts: { url: 'https://next.example.test/' } } };
    accountMocks.fetchAccountIdentity.mockResolvedValue({ value: '10001', watch: [{ name: 'next', domain: 'next.example.test' }] });
    rerender(<AccountBadge />);
    await waitFor(() => expect(screen.getByTitle('accountCurrentAccount')).toBeInTheDocument());
    await act(async () => { resolveOld({ value: 'old', watch: [] }); });
    expect(screen.getByTitle('accountCurrentAccount')).toBeInTheDocument();
    expect(accountMocks.fetchAccountIdentity.mock.calls.filter(([options]) => !options?.cachedOnly)).toHaveLength(2);
    accountMocks.settings = { logins: { accounts: { url: 'https://accounts.example.test/' } } };
  });

  it('opens the configured portal synchronously from the original toolbar button', () => {
    render(<AccountBadge />);
    fireEvent.click(screen.getByTitle('accountOpenPortal'));
    expect(accountMocks.openWindow).toHaveBeenCalledExactlyOnceWith('https://accounts.example.test/', '_blank');
  });

  it('uses the named login lease and releases it on unmount', async () => {
    accountMocks.accountsError = 'ACCOUNT_LOGIN_REQUIRED';
    const { unmount } = render(<AccountBadge />);
    fireEvent.click(screen.getByRole('button', { name: 'accountLogin: accounts.example.test' }));
    await waitFor(() => expect(accountMocks.setLoginOpen).toHaveBeenCalledWith('accounts', true));
    unmount();
    expect(accountMocks.setLoginOpen).toHaveBeenLastCalledWith('accounts', false);
  });

  it('uses current preset text after a previous login closes', () => {
    accountMocks.accountsError = 'ACCOUNT_LOGIN_REQUIRED';
    accountMocks.loginSnapshot = { open: false, definition: { url: 'https://previous.example.test/', title: { en: 'Previous' } } };
    render(<AccountBadge />);
    expect(screen.getByRole('button', { name: 'accountLogin: accounts.example.test' })).toBeInTheDocument();
    expect(screen.queryByText('accountLogin: previous.example.test')).toBeNull();
  });

  it('renders the accepted login URL and retains close-and-refresh behavior', async () => {
    accountMocks.loginSnapshot = { open: true, definition: { url: 'https://accepted.example.test/', title: { en: 'Account' } } };
    render(<AccountBadge />);
    expect(screen.getByTestId('accepted-login')).toHaveAttribute('data-url', 'https://accepted.example.test/');
    fireEvent.click(screen.getByRole('button', { name: 'close-login' }));
    await waitFor(() => expect(accountMocks.setLoginOpen).toHaveBeenCalledWith('accounts', false));
    expect(accountMocks.retryAccounts).toHaveBeenCalled();
    expect(accountMocks.fetchAccountIdentity.mock.calls.filter(([options]) => !options?.cachedOnly)).toHaveLength(2);
  });

  it('marks the account matching the current provider identity', async () => {
    render(<AccountBadge />);

    expect(await screen.findByTitle('accountCurrentAccount')).toBeInTheDocument();
    expect(accountMocks.fetchAccountIdentity).toHaveBeenCalled();
  });

  it('keeps the account entry visible while resolving the current identity', async () => {
    let resolveUserId!: (identity: {value: string; watch: []}) => void;
    accountMocks.fetchAccountIdentity.mockImplementation(
      options => options?.cachedOnly ? Promise.resolve({ value: '', watch: [] }) : new Promise<{value: string; watch: []}>(resolve => (resolveUserId = resolve)),
    );

    render(<AccountBadge showRequestCountToggle={false} />);

    const pendingBadge = screen.getByTitle('account');
    expect(pendingBadge.textContent).toBe('');
    expect(pendingBadge.parentElement).not.toHaveClass('invisible');

    await act(async () => resolveUserId({ value: '10001', watch: [] }));

    expect(screen.getByTitle('test-account')).toHaveTextContent('test-account');
    expect(screen.getByTitle('test-account').parentElement).not.toHaveClass('invisible');
  });

  it('shows only the icon when there is no matching current account', async () => {
    accountMocks.fetchAccountIdentity.mockResolvedValue({ value: 'another-user', watch: [] });

    render(<AccountBadge showRequestCountToggle={false} />);

    const badge = await screen.findByTitle('account');
    await waitFor(() => expect(badge.parentElement).not.toHaveClass('invisible'));
    expect(badge.textContent).toBe('');
  });

  it('keeps the account dropdown visible while its QR code is open', async () => {
    render(<AccountBadge />);

    const searchInput = screen.getByPlaceholderText('accountSearchPlaceholder');
    const dropdown = searchInput.parentElement?.parentElement?.parentElement;
    expect(dropdown).toHaveClass('invisible');

    fireEvent.click(screen.getByTitle('accountMobileSsoQr'));

    await screen.findByRole('img', { name: 'QR Code' });
    await waitFor(() => {
      expect(dropdown).toHaveClass('visible', 'pointer-events-auto');
      expect(dropdown).not.toHaveClass('invisible');
    });
    fireEvent.mouseEnter(dropdown!.parentElement!);
    fireEvent.click(screen.getByTitle('accountMobileSsoQr'));
    expect(dropdown).toHaveClass('visible', 'pointer-events-auto');
  });

  it('loads the selected provider when settings change while the account menu is open', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<AccountBadge />);
    await act(async () => { await Promise.resolve(); });
    const dropdown = screen.getByPlaceholderText('accountSearchPlaceholder').parentElement!.parentElement!.parentElement!;
    fireEvent.mouseEnter(dropdown.parentElement!);
    act(() => vi.advanceTimersByTime(200));
    expect(dropdown).toHaveClass('visible');
    accountMocks.requestAccounts.mockClear();
    accountMocks.settings = { logins: { accounts: { url: 'https://next.example.test/' } } };
    rerender(<AccountBadge />);
    await act(async () => { await Promise.resolve(); });
    expect(accountMocks.requestAccounts).toHaveBeenCalled();
    expect(dropdown).toHaveClass('visible');
    accountMocks.settings = { logins: { accounts: { url: 'https://accounts.example.test/' } } };
  });

  it('delays hover opening by 200ms and keeps the panel open when the pointer enters during close delay', async () => {
    vi.useFakeTimers();
    render(<AccountBadge />);
    await act(async () => {
      await Promise.resolve();
    });
    const dropdown =
      screen.getByPlaceholderText('accountSearchPlaceholder').parentElement!.parentElement!
        .parentElement!;
    const trigger = dropdown.parentElement!;
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(199));
    expect(dropdown).toHaveClass('invisible', 'pointer-events-none');
    act(() => vi.advanceTimersByTime(1));
    expect(dropdown).toHaveClass('visible', 'pointer-events-auto');
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(100));
    expect(dropdown).toHaveClass('visible');
    fireEvent.mouseEnter(dropdown);
    act(() => vi.advanceTimersByTime(100));
    expect(dropdown).toHaveClass('visible');
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(dropdown).toHaveClass('invisible', 'pointer-events-none');
  });

  it('cancels opening when the pointer passes quickly and clears timers on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = render(<AccountBadge />);
    await act(async () => {
      await Promise.resolve();
    });
    const dropdown =
      screen.getByPlaceholderText('accountSearchPlaceholder').parentElement!.parentElement!
        .parentElement!;
    const trigger = dropdown.parentElement!;
    fireEvent.mouseEnter(trigger);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(200));
    expect(dropdown).toHaveClass('invisible');
    fireEvent.mouseEnter(trigger);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
