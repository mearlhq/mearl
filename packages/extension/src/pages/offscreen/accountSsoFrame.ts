const SSO_LOAD_TIMEOUT_MS = 15_000;

export function consumeAccountSsoTicket(
  ssoUrl: string,
  pageDocument: Document = document,
  timeoutMs = SSO_LOAD_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise(resolve => {
    const iframe = pageDocument.createElement('iframe');
    iframe.src = ssoUrl;
    iframe.style.cssText =
      'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;';
    iframe.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-forms');

    let settled = false;
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      iframe.remove();
      resolve(success);
    };
    const timeoutId = setTimeout(() => finish(false), timeoutMs);
    iframe.addEventListener('load', () => finish(true), { once: true });
    iframe.addEventListener('error', () => finish(false), { once: true });
    pageDocument.body.appendChild(iframe);
  });
}
