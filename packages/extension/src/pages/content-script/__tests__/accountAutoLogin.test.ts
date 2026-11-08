import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAccountAutoLoginCountdown } from '../accountAutoLogin';

describe('Accounts automatic login page detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(chrome.runtime, 'id', {
      configurable: true,
      value: 'test-extension-id',
    });
    vi.mocked(chrome.runtime.sendMessage)
      .mockReset()
      .mockImplementation(async message => {
        const action = (message as { action?: string })?.action;
        if (action === 'accountAutoLoginAvailable') return { available: true, selector: '.login-button' };
        if (action === 'accountAutoLogin') return { success: true };
        return undefined;
      });
    chrome.i18n = {
      getMessage: vi.fn((key, substitutions) =>
        key === 'accountAutoLoginPending' ? '登录中...' : `${String(substitutions)}s 后自动登录`,
      ),
    } as unknown as typeof chrome.i18n;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a three-second countdown and then requests automatic login', async () => {
    const href =
      'https://example.test/login?tpl_redirect_url=https%3A%2F%2Fexample.com';
    const button = document.createElement('button');
    button.className = 'login-button';
    button.textContent = '登录';
    document.body.appendChild(button);

    installAccountAutoLoginCountdown(href);
    await vi.advanceTimersByTimeAsync(0);

    expect(button.querySelector('[data-mearl-account-auto-login-label]')).toHaveTextContent(
      /^3s 后自动登录$/,
    );
    const brand = button.querySelector<HTMLElement>('[data-mearl-account-auto-login-brand]');
    expect(brand).toHaveTextContent('Mearl');
    expect(brand?.style.transform).toBe('rotate(-10deg)');
    await vi.advanceTimersByTimeAsync(1000);
    expect(button.querySelector('[data-mearl-account-auto-login-label]')).toHaveTextContent(
      /^2s 后自动登录$/,
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'accountAutoLogin' });
    expect(button.querySelector('[data-mearl-account-auto-login-label]')).toHaveTextContent(
      /^登录中\.\.\.$/,
    );
  });

  it('keeps the remaining countdown when the page replaces the login button', async () => {
    const firstButton = document.createElement('button');
    firstButton.className = 'login-button';
    firstButton.textContent = '本机号码一键登录';
    document.body.appendChild(firstButton);

    installAccountAutoLoginCountdown('https://example.test/');
    await vi.advanceTimersByTimeAsync(1000);
    expect(firstButton).toHaveTextContent('2s 后自动登录');

    const nextButton = document.createElement('button');
    nextButton.className = 'login-button';
    nextButton.textContent = '获取验证码';
    firstButton.replaceWith(nextButton);
    await vi.advanceTimersByTimeAsync(0);

    expect(nextButton.querySelector('[data-mearl-account-auto-login-label]')).toHaveTextContent(
      /^2s 后自动登录$/,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ action: 'accountAutoLogin' });
    expect(nextButton.querySelector('[data-mearl-account-auto-login-label]')).toHaveTextContent(
      /^登录中\.\.\.$/,
    );
  });

  it('restores the current button label when automatic login fails', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(async message => {
      const action = (message as { action?: string })?.action;
      return action === 'accountAutoLoginAvailable' ? { available: true, selector: '.login-button' } : { success: false };
    });
    const button = document.createElement('button');
    button.className = 'login-button';
    button.textContent = '登录';
    document.body.appendChild(button);

    installAccountAutoLoginCountdown('https://example.test/');
    await vi.advanceTimersByTimeAsync(3000);

    expect(button).toHaveTextContent(/^登录$/);
  });

  it('leaves page controls unchanged when the installed service rejects the page', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ available: false });
    document.body.innerHTML = '<button class="login">Login</button>';
    installAccountAutoLoginCountdown('https://example.test/');
    await vi.advanceTimersByTimeAsync(3000);
    expect(document.querySelector('button')).toHaveTextContent('Login');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledOnce();
  });

  it('cancels automatic login when the user clicks an input', async () => {
    const input = document.createElement('input');
    const button = document.createElement('button');
    button.className = 'login-button';
    button.textContent = '登录';
    document.body.append(input, button);

    installAccountAutoLoginCountdown('https://example.test/');
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(3000);

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ action: 'accountAutoLogin' });
    expect(button).toHaveTextContent('登录');
  });

  it('does not show a countdown without an account matching unb', async () => {
    vi.mocked(chrome.runtime.sendMessage).mockResolvedValue({ available: false });
    const button = document.createElement('button');
    button.className = 'login-button';
    button.textContent = '登录';
    document.body.appendChild(button);

    installAccountAutoLoginCountdown('https://example.test/');
    await vi.advanceTimersByTimeAsync(3000);

    expect(button).toHaveTextContent('登录');
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'accountAutoLoginAvailable',
    });
  });

  it('also cancels before the asynchronously rendered login button appears', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    installAccountAutoLoginCountdown('https://example.test/');

    input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    const button = document.createElement('button');
    button.className = 'login-button';
    button.textContent = '登录';
    document.body.appendChild(button);
    await vi.advanceTimersByTimeAsync(3000);

    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith({ action: 'accountAutoLogin' });
    expect(button).toHaveTextContent('登录');
  });
});
