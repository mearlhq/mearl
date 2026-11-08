import { i18nMessage, safeSendMessage } from './chromeSafe';

export const ACCOUNT_AUTO_LOGIN_ACTION = 'accountAutoLogin';
export const ACCOUNT_AUTO_LOGIN_AVAILABILITY_ACTION = 'accountAutoLoginAvailable';
const COUNTDOWN_SECONDS = 3;
const LABEL_ATTRIBUTE = 'data-mearl-account-auto-login-label';
const BRAND_ATTRIBUTE = 'data-mearl-account-auto-login-brand';

type AutoLoginButtonPhase = 'countdown' | 'logging-in';

function isEditableInput(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const input = target.closest('input');
  if (!input) return false;
  return !['button', 'checkbox', 'file', 'hidden', 'radio', 'reset', 'submit'].includes(input.type);
}

function countdownLabel(seconds: number): string {
  return i18nMessage('accountAutoLoginCountdown', String(seconds)) || `Auto login in ${seconds}s`;
}

function loggingInLabel(): string {
  return i18nMessage('accountAutoLoginPending') || 'Logging in...';
}

export function installAccountAutoLoginCountdown(
  href: string,
  pageDocument: Document = document,
): () => void {
  let selector = '';

  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let countdownButton: HTMLElement | null = null;
  let originalButtonLabel = '';
  let originalButtonPosition = '';
  let remainingSeconds = COUNTDOWN_SECONDS;
  let phase: AutoLoginButtonPhase = 'countdown';
  let cancelled = false;

  const observer = new MutationObserver(() => syncCountdownTarget());

  const getButtonLabel = (button: HTMLElement) => {
    if (button instanceof HTMLInputElement) return button.value;
    const clone = button.cloneNode(true) as HTMLElement;
    clone.querySelector(`[${BRAND_ATTRIBUTE}]`)?.remove();
    return clone.textContent ?? '';
  };

  const setButtonLabel = (button: HTMLElement, label: string) => {
    if (button instanceof HTMLInputElement) {
      button.value = label;
      return;
    }

    button.textContent = '';
    const labelElement = pageDocument.createElement('span');
    labelElement.setAttribute(LABEL_ATTRIBUTE, '');
    labelElement.textContent = label;

    const brandElement = pageDocument.createElement('span');
    brandElement.setAttribute(BRAND_ATTRIBUTE, '');
    brandElement.textContent = 'Mearl';
    brandElement.style.cssText = [
      'position:absolute',
      'right:4px',
      'bottom:4px',
      'padding:1px 3px',
      'border:1px solid rgba(255,255,255,0.45)',
      'border-radius:3px',
      'background:rgba(0,0,0,0.12)',
      'color:rgba(255,255,255,0.9)',
      'font-size:9px',
      'font-weight:500',
      'line-height:1',
      'letter-spacing:0.04em',
      'transform:rotate(-10deg)',
      'transform-origin:center',
      'pointer-events:none',
    ].join(';');

    if (getComputedStyle(button).position === 'static') button.style.position = 'relative';
    button.append(labelElement, brandElement);
  };

  const hasRenderedLabel = (button: HTMLElement, label: string) => {
    if (button instanceof HTMLInputElement) return button.value === label;
    return (
      button.querySelector(`[${LABEL_ATTRIBUTE}]`)?.textContent === label &&
      button.querySelector(`[${BRAND_ATTRIBUTE}]`)?.textContent === 'Mearl'
    );
  };

  const clearButtonState = () => {
    countdownButton = null;
    originalButtonLabel = '';
    originalButtonPosition = '';
  };

  const restoreButton = () => {
    if (countdownButton) {
      if (countdownButton instanceof HTMLInputElement) {
        countdownButton.value = originalButtonLabel;
      } else {
        countdownButton.textContent = originalButtonLabel;
        countdownButton.style.position = originalButtonPosition;
      }
    }
    clearButtonState();
  };

  const cleanup = (restore = true) => {
    if (countdownTimer !== undefined) clearInterval(countdownTimer);
    countdownTimer = undefined;
    observer.disconnect();
    pageDocument.removeEventListener('pointerdown', handlePointerDown, true);
    if (restore) {
      restoreButton();
    } else {
      clearButtonState();
    }
  };

  const cancel = () => {
    cancelled = true;
    cleanup();
  };

  function handlePointerDown(event: Event) {
    if (isEditableInput(event.target)) cancel();
  }

  function currentLabel() {
    return phase === 'logging-in' ? loggingInLabel() : countdownLabel(remainingSeconds);
  }

  function attachButton(button: HTMLElement) {
    restoreButton();
    countdownButton = button;
    originalButtonLabel = getButtonLabel(button);
    originalButtonPosition = button.style.position;
    setButtonLabel(button, currentLabel());
  }

  function syncCountdownTarget() {
    if (cancelled) return;
    const button = pageDocument.querySelector<HTMLElement>(selector);
    if (!button) return;
    if (button === countdownButton) {
      const label = currentLabel();
      if (!hasRenderedLabel(button, label)) {
        originalButtonLabel = getButtonLabel(button);
        setButtonLabel(button, label);
      }
      return;
    }

    if (phase === 'logging-in') {
      attachButton(button);
      return;
    }
    if (countdownTimer === undefined) {
      startCountdown(button);
      return;
    }
    attachButton(button);
  }

  function startCountdown(button?: HTMLElement) {
    if (cancelled || countdownTimer !== undefined) return;
    const target = button ?? pageDocument.querySelector<HTMLElement>(selector);
    if (!target) return;

    attachButton(target);
    countdownTimer = setInterval(() => {
      remainingSeconds -= 1;
      if (remainingSeconds > 0) {
        if (countdownButton) setButtonLabel(countdownButton, currentLabel());
        return;
      }
      if (countdownTimer !== undefined) clearInterval(countdownTimer);
      countdownTimer = undefined;
      phase = 'logging-in';
      pageDocument.removeEventListener('pointerdown', handlePointerDown, true);
      if (countdownButton) setButtonLabel(countdownButton, currentLabel());
      void safeSendMessage<{ success?: boolean }>({ action: ACCOUNT_AUTO_LOGIN_ACTION }).then(
        response => cleanup(response?.success !== true),
      );
    }, 1000);
  }

  pageDocument.addEventListener('pointerdown', handlePointerDown, true);
  void safeSendMessage<{ available?: boolean; selector?: string }>({
    action: ACCOUNT_AUTO_LOGIN_AVAILABILITY_ACTION,
  }).then(response => {
    if (cancelled) return;
    if (response?.available !== true || typeof response.selector !== 'string' || !response.selector) {
      cleanup();
      return;
    }
    selector = response.selector;
    try { pageDocument.querySelector(selector); } catch { cleanup(); return; }
    observer.observe(pageDocument, { childList: true, subtree: true });
    startCountdown();
  });

  return cancel;
}
