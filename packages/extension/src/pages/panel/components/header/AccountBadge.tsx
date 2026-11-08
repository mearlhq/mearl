import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, ShieldCheck, QrCode, Copy, Check, UserRound } from 'lucide-react';
import { t } from '../../utils/i18n';
import { showToast } from '../../utils/toast';
import { copyToClipboard } from '../../utils/clipboard';
import { useAccounts } from '../../hooks/useAccounts';
import { clsx } from 'clsx';
import {
  fetchAccountSso,
  fetchAccountIdentity,
  readAccountLabelCache,
  writeAccountLabelCache,
  fetchAccountQr,
  isAccountLoginError,
  borrowAccount,
  withAccountAutoLogin,
  redirectAccountLoginPage,
  type BrowserAccountItem,
} from '../../utils/accounts';
import { useDelayedHover } from '../../../../shared/hooks/useDelayedHover';
import { QRCodePopup } from '../QRCodePopup';
import { LoginModal } from '../LoginModal';
import { getBrowserUiSettingsCacheScope, useBrowserUiSettings } from '../../utils/browserUiSettings';
import { setBrowserUiLoginOpen, useBrowserUiLogin } from '../../utils/browserUiLogin';

interface AccountBadgeProps {
  count?: number;
  showRequestCountToggle?: boolean;
  /**
   * 下拉面板对齐方式
   * - default：右边缘与徽章对齐（panel 模式）
   * - far-right：相对窗口右侧贴边展示（popup / 侧边栏）
   */
  dropdownAlign?: 'default' | 'far-right';
  /** 账号图标尺寸：默认 14（与面板工具栏其他按钮一致），popup 传 12 与真机抓包一致 */
  iconSize?: number;
  className?: string;
}

export const AccountBadge: FC<AccountBadgeProps> = ({
  count = 0,
  showRequestCountToggle = true,
  dropdownAlign = 'default',
  iconSize = 14,
  className,
}) => {
  const { accounts, loading, error, requestAccounts, retryAccounts } =
    useAccounts();

  const login = useBrowserUiLogin('accounts');
  const settings = useBrowserUiSettings();
  const cacheScope = getBrowserUiSettingsCacheScope(settings);
  const loginUrl = login.open ? login.definition?.url : settings.logins?.accounts?.url;
  const loginTitle = t('accountLogin', loginUrl ? new URL(loginUrl).hostname : 'Accounts');
  const [ssoStatus, setSsoStatus] = useState<'idle' | 'loading'>('idle');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [identityWatch, setIdentityWatch] = useState<Array<{name: string; domain: string}>>([]);
  const [accountIdentity, setAccountIdentity] = useState('');
  const [cachedLoginId, setCachedLoginId] = useState(() => readAccountLabelCache(cacheScope));
  const [showCount, setShowCount] = useState<boolean>(false);
  const {
    open: dropdownOpen,
    setOpen: setDropdownOpen,
    scheduleOpen,
    scheduleClose: handleMouseLeave,
    cancelClose: clearCloseTimer,
  } = useDelayedHover();
  const [searchInput, setSearchInput] = useState<string>('');
  const [quickBorrowStatus, setQuickBorrowStatus] = useState<'idle' | 'loading'>('idle');
  const [mobileSsoQrUrl, setMobileSsoQrUrl] = useState<string>('');
  const [alternateQrUrl, setAlternateQrUrl] = useState<string>();
  const [loadingQrAccountId, setLoadingQrAccountId] = useState<string | null>(null);
  const [showQrForAccountId, setShowQrForAccountId] = useState<string | null>(null);
  const [copiedAccountId, setCopiedAccountId] = useState<number | null>(null);
  const qrButtonRef = useRef<HTMLButtonElement | null>(null);
  const canToggleCount = showRequestCountToggle;

  const identityRead = useRef(0);
  const verifiedIdentityRead = useRef(0);
  const refreshAccountIdentity = async () => {
    const read = ++identityRead.current;
    try {
      const identity = await fetchAccountIdentity();
      if (read !== identityRead.current) return '';
      verifiedIdentityRead.current = read;
      const nextUserId = identity.value;
      setIdentityWatch(previous => JSON.stringify(previous) === JSON.stringify(identity.watch) ? previous : identity.watch);
      setAccountIdentity(nextUserId);
      const label = nextUserId ? identity.loginId ?? accounts.find(account => String(account.principalId ?? '') === nextUserId)?.loginId ?? '' : '';
      setCachedLoginId(label);
      writeAccountLabelCache(cacheScope, label);
      return nextUserId;
    } catch (error) {
      if (read === identityRead.current && isAccountLoginError(error instanceof Error ? error.message : String(error))) {
        verifiedIdentityRead.current = read;
        setAccountIdentity('');
        setCachedLoginId('');
        writeAccountLabelCache(cacheScope, '');
      }
      return '';
    }
  };

  const openLoginModal = async () => {
    try { await setBrowserUiLoginOpen('accounts', true); }
    catch (error) { showToast(error instanceof Error ? error.message : String(error), 'error'); }
  };

  const closeLoginModal = () => {
    void setBrowserUiLoginOpen('accounts', false).catch(() => {});
    retryAccounts();
    void refreshAccountIdentity();
  };

  useEffect(() => {
    setAccountIdentity('');
    const initialLabel = readAccountLabelCache(cacheScope);
    setCachedLoginId(initialLabel ?? '');
    setIdentityWatch([]);
    void refreshAccountIdentity();
    const read = identityRead.current;
    if (!initialLabel) void fetchAccountIdentity({ cachedOnly: true }).then(identity => {
      if (read === identityRead.current && read !== verifiedIdentityRead.current) {
        setCachedLoginId(identity.loginId ?? '');
        writeAccountLabelCache(cacheScope, identity.loginId ?? '');
      }
    }).catch(() => {});
    return () => { identityRead.current++; };
  }, [settings]);
  useEffect(() => {
    const cookieChanges = chrome.cookies?.onChanged;
    if (!cookieChanges) return;
    const handleCookieChange = (changeInfo: chrome.cookies.CookieChangeInfo) => {
      if (
        identityWatch.some(scope => changeInfo.cookie.name === scope.name && (changeInfo.cookie.domain.replace(/^\./, '') === scope.domain || changeInfo.cookie.domain.endsWith('.' + scope.domain)))
      ) {
        void refreshAccountIdentity();
      }
    };
    cookieChanges.addListener(handleCookieChange);
    return () => cookieChanges.removeListener(handleCookieChange);
  }, [identityWatch]);

  useEffect(() => {
    return () => {
      if (iframeRef.current) iframeRef.current.remove();
      void setBrowserUiLoginOpen('accounts', false).catch(() => {});
    };
  }, []);

  useEffect(() => { if (dropdownOpen) void requestAccounts(); }, [dropdownOpen, requestAccounts, settings]);

  const handleMouseEnter = () => {
    void requestAccounts();
    if (showQrForAccountId) {
      setDropdownOpen(true);
    } else {
      scheduleOpen();
    }
  };

  const performSsoLogin = async (principalId: string | number, site: string, provider?: BrowserAccountItem['provider']) => {
    setSsoStatus('loading');
    const { result } = await withAccountAutoLogin(() => fetchAccountSso(principalId, site, provider));
    if (!result.success || !result.data) {
      setSsoStatus('idle');
      if (isAccountLoginError(result.error)) {
        void openLoginModal();
      }
      return;
    }

    const iframe = document.createElement('iframe');
    iframe.src = result.data;
    iframe.style.cssText =
      'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');
    iframeRef.current = iframe;

    iframe.addEventListener(
      'load',
      () => {
        iframe.remove();
        iframeRef.current = null;
        refreshAccountIdentity().then(() => setSsoStatus('idle'));
        // 登录成功后由已安装的身份能力判断是否回到业务页面
        redirectAccountLoginPage();
      },
      { once: true },
    );

    document.body.appendChild(iframe);
  };

  const handleAccountSelect = async (accountId: string) => {
    const account = accounts.find(a => String(a.id) === accountId);
    if (!account || !account.site) return;
    await performSsoLogin(account.principalId ?? account.id, account.site, account.provider);
  };

  // 区分点击与长按/划词：拖动选中文本或长按后松开不算点击，避免复制内容时误触登录
  const accountPressRef = useRef<{ x: number; y: number; time: number } | null>(null);

  const handleAccountMouseDown = (e: React.MouseEvent) => {
    accountPressRef.current = { x: e.clientX, y: e.clientY, time: Date.now() };
  };

  const handleAccountClick = (e: React.MouseEvent, accountId: string) => {
    const press = accountPressRef.current;
    accountPressRef.current = null;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (press) {
      const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5;
      const longPressed = Date.now() - press.time > 500;
      if (moved || longPressed) return;
    }
    void handleAccountSelect(accountId);
  };

  const handleQuickBorrow = async () => {
    const query = searchInput.trim();
    if (!query || quickBorrowStatus === 'loading') return;
    setQuickBorrowStatus('loading');
    try {
      const { result: searchResult } = await withAccountAutoLogin(() =>
        borrowAccount(query),
      );
      if (!searchResult.success || !searchResult.data) {
        const msg = searchResult.error ?? '';
        if (isAccountLoginError(msg)) {
          void openLoginModal();
          return;
        }
        if (!searchResult.silent) {
          showToast(msg || t('requestCasesFailed'), 'error');
          return;
        }
        return;
      }
      const account = searchResult.data;
      if (account.principalId && account.site) await performSsoLogin(account.principalId, account.site, account.provider);
      await retryAccounts();
    } finally {
      setQuickBorrowStatus('idle');
    }
  };

  const handleFetchMobileSsoQr = async (account: BrowserAccountItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!account.principalId || !account.site || loadingQrAccountId) return;

    // 如果已经展示该账号的二维码，则关闭
    if (showQrForAccountId === String(account.id)) {
      setShowQrForAccountId(null);
      return;
    }

    setLoadingQrAccountId(String(account.id));
    setShowQrForAccountId(null);
    try {
      const { result } = await withAccountAutoLogin(() =>
        fetchAccountQr(account.principalId!, account.site!, account.provider),
      );
      if (result.success && result.data) {
        setMobileSsoQrUrl(result.data.url);
        setAlternateQrUrl(result.data.alternateUrl);
        setShowQrForAccountId(String(account.id));
      } else if (isAccountLoginError(result.error)) {
        void openLoginModal();
      } else {
        showToast(result.error || t('accountQrCodeFailed'), 'error');
      }
    } finally {
      setLoadingQrAccountId(null);
    }
  };

  // 点击外部关闭二维码
  useEffect(() => {
    if (!showQrForAccountId) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.qr-code-popup') && !target.closest('.qr-code-button')) {
        setShowQrForAccountId(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => document.removeEventListener('click', handleClickOutside);
  }, [showQrForAccountId]);

  const noDataText = loading ? t('requestCasesLoading') : t('requestCasesNoData');
  const countLabel = `${count} ${t('requests')}`;
  const currentAccount = useMemo(
    () => accountIdentity ? accounts.find(account => String(account.principalId ?? '') === accountIdentity) : undefined,
    [accounts, accountIdentity],
  );
  const currentLoginId = currentAccount?.loginId ?? cachedLoginId;
  useEffect(() => {
    if (identityRead.current === verifiedIdentityRead.current) writeAccountLabelCache(cacheScope, currentLoginId);
  }, [cacheScope, currentLoginId, accountIdentity, settings]);

  const badgeLabel = canToggleCount
    ? showCount || !currentLoginId
      ? countLabel
      : currentLoginId
    : currentLoginId;

  return (
    <>
      {login.definition && <LoginModal
        isOpen={login.open}
        onClose={closeLoginModal}
        url={login.definition.url}
        title={loginTitle}
      />}
      <div
        className="relative shrink-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <span
          className={clsx(
            `relative flex items-center justify-center gap-1 px-1.5 py-0.5 rounded text-xs cursor-pointer transition-colors select-none bg-bg-secondary hover:bg-bg-hover @[640px]:w-28 ${
              ssoStatus === 'loading'
                ? 'text-transparent'
                : 'text-text-secondary hover:text-text-primary'
            }`,
            className,
          )}
          onClick={() => ssoStatus === 'idle' && canToggleCount && setShowCount(v => !v)}
          title={
            ssoStatus === 'idle' && canToggleCount
              ? showCount || !currentLoginId
                ? t('accountShowNickname')
                : t('accountShowCount')
              : badgeLabel || t('account')
          }
        >
          <UserRound size={iconSize} className="shrink-0" />
          <span className="hidden min-w-0 truncate @[640px]:inline">{badgeLabel}</span>
          {ssoStatus === 'loading' && (
            <span className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Loader2 size={12} className="animate-spin text-blue-500" />
            </span>
          )}
        </span>

        {ssoStatus === 'idle' && (
          <div
            onMouseEnter={clearCloseTimer}
            className={clsx(
              'absolute top-full pt-1 z-50 w-72',
              dropdownOpen || showQrForAccountId
                ? 'visible pointer-events-auto'
                : 'invisible pointer-events-none',
              // far-right：往右推一些贴近窗口右侧（popup / 侧边栏）
              dropdownAlign === 'far-right' ? '-right-20' : 'right-0',
            )}
          >
            <div className="w-full bg-bg-primary border border-border rounded shadow-lg">
              {/* Toolbar */}
              <div className="flex items-center gap-1 p-1.5 border-b border-border">
                <input
                  className="flex-1 min-w-0 bg-bg-secondary text-text-primary text-2xs px-2 py-1 rounded border border-border outline-none focus:border-blue-500 transition-colors"
                  placeholder={t('accountSearchPlaceholder')}
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleQuickBorrow()}
                  onClick={e => e.stopPropagation()}
                />
                <button
                  className="flex items-center justify-center px-1.5 py-1 rounded bg-blue-500 text-white text-2xs hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    handleQuickBorrow();
                  }}
                  disabled={quickBorrowStatus === 'loading' || !searchInput.trim()}
                  title={t('accountQuickBorrow')}
                >
                  {quickBorrowStatus === 'loading' ? (
                    <Loader2 size={10} className="animate-spin" />
                  ) : (
                    t('accountQuickBorrow')
                  )}
                </button>
                <button
                  className="p-1 rounded text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                  title={t('accountOpenPortal')}
                  onClick={e => {
                    e.stopPropagation();
                    const url = settings.logins?.accounts?.url;
                    if (url) window.open(url, '_blank');
                  }}
                >
                  <ShieldCheck size={14} />
                </button>
              </div>

              {/* Account list */}
              <div className="max-h-64 overflow-y-auto">
                {accounts.length === 0 ? (
                  <div className="px-2 py-4 text-center text-2xs text-text-secondary">
                    {error ? (
                      isAccountLoginError(error) ? (
                        <>
                          <div>{t('accountLoginRequired')}</div>
                          <button
                            className="mt-1 text-blue-500 hover:underline cursor-pointer"
                            onClick={e => {
                              e.stopPropagation();
                              void openLoginModal();
                            }}
                          >
                            {loginTitle}
                          </button>
                        </>
                      ) : (
                        <>
                          <div>{t('accountsLoadFailed', error)}</div>
                          <button
                            className="mt-1 text-blue-500 hover:underline cursor-pointer"
                            onClick={e => {
                              e.stopPropagation();
                              retryAccounts();
                            }}
                          >
                            {t('retry')}
                          </button>
                        </>
                      )
                    ) : (
                      noDataText
                    )}
                  </div>
                ) : (
                  accounts.map(account => (
                    <div
                      key={account.id}
                      onMouseDown={handleAccountMouseDown}
                      onClick={e => handleAccountClick(e, String(account.id))}
                      className="flex items-center px-2 py-1.5 text-2xs cursor-pointer transition-colors hover:bg-bg-hover text-text-primary"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium flex items-center gap-1">
                          <span className="truncate">{account.loginId}</span>
                          <span
                            className="inline-flex items-center shrink-0 hover:text-text-primary cursor-pointer transition-colors"
                            title={t('copy')}
                            onClick={async e => {
                              e.stopPropagation();
                              const success = await copyToClipboard(account.loginId);
                              if (success) {
                                setCopiedAccountId(account.id);
                                setTimeout(() => setCopiedAccountId(null), 2000);
                              }
                            }}
                          >
                            {copiedAccountId === account.id ? (
                              <Check size={9} className="text-green-500" />
                            ) : (
                              <Copy size={9} className="opacity-50" />
                            )}
                          </span>
                        </div>
                        <div className="text-3xs opacity-75 flex items-center gap-0.5">
                          {[account.site, account.ownerName].filter(Boolean).join(' · ')}
                          {account.principalId != null && (
                            <>
                              {(account.site || account.ownerName) && ' · '}
                              <span className="font-mono">{account.principalId}</span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {String(account.principalId ?? '') === accountIdentity && (
                          <span
                            className="relative w-1.5 h-1.5 shrink-0"
                            title={t('accountCurrentAccount')}
                          >
                            <span className="absolute inset-0 rounded-full bg-green-500 animate-ping opacity-75" />
                            <span className="relative block w-1.5 h-1.5 rounded-full bg-green-500" />
                          </span>
                        )}
                        {account.principalId && account.site && (
                          <>
                            <button
                              ref={
                                showQrForAccountId === String(account.id) ? qrButtonRef : undefined
                              }
                              className="qr-code-button p-1 rounded text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
                              title={t('accountMobileSsoQr')}
                              onClick={e => handleFetchMobileSsoQr(account, e)}
                              disabled={loadingQrAccountId === String(account.id)}
                            >
                              {loadingQrAccountId === String(account.id) ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <QrCode size={12} />
                              )}
                            </button>
                            {showQrForAccountId === String(account.id) && mobileSsoQrUrl && (
                              <QRCodePopup
                                url={mobileSsoQrUrl}
                                harmonyUrl={alternateQrUrl}
                                targetRef={qrButtonRef}
                                onClose={() => setShowQrForAccountId(null)}
                              />
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
};
