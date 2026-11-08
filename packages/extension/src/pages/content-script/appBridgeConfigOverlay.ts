import type { AppProfileSetting } from '@mearl/browser-core';
import { i18nMessage, safeSendMessage } from './chromeSafe';

interface BridgeActions {
  responses?: Record<string, unknown>;
  behaviors?: Record<string, string>;
  noop: string[];
}

const t = (key: string, substitutions?: string): string => i18nMessage(key, substitutions) || key;

interface ShowBridgeConfigMessage {
  source: 'mearl-app-bridge';
  type: 'showBridgeConfig';
  profile: string;
  actions?: BridgeActions;
  language?: string;
  settings?: AppProfileSetting[];
  settingsUi?: 'runtime';
}

interface Choice<T extends string> {
  value: T;
  label: string;
}

interface ChoiceControl<T extends string> {
  root: HTMLElement;
  setValue(value: T | null): void;
}

function createChoiceControl<T extends string>(
  ariaLabel: string,
  choices: Choice<T>[],
  current: T | null,
  onChange: (value: T) => void,
): ChoiceControl<T> {
  const root = document.createElement('div');
  root.className = 'choices';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', ariaLabel);
  const buttons = new Map<T, HTMLButtonElement>();

  for (const choice of choices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = choice.label;
    button.dataset.value = choice.value;
    button.addEventListener('click', () => onChange(choice.value));
    root.appendChild(button);
    buttons.set(choice.value, button);
  }

  const setValue = (value: T | null) => {
    for (const [choice, button] of buttons) {
      button.setAttribute('aria-pressed', String(choice === value));
    }
  };
  setValue(current);
  return { root, setValue };
}

function createMethodCard(title: string, method: string, control: HTMLElement): HTMLElement {
  const card = document.createElement('section');
  card.className = 'method-card';
  const heading = document.createElement('div');
  heading.className = 'method-heading';
  const label = document.createElement('span');
  label.textContent = title;
  heading.append(label);
  if (method) {
    const code = document.createElement('code');
    code.textContent = method;
    heading.append(code);
  }
  card.append(heading, control);
  return card;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pageVisibilityChanged(hidden: boolean): void {
  window.postMessage(
    {
      source: 'mearl-content',
      type: 'APP_BRIDGE_SIMULATOR_VISIBILITY',
      hidden,
    },
    '*',
  );
}

/** 模拟态底部操作条的页面内配置面板。扩展 UI 使用 Shadow DOM，不受业务样式影响。 */
export function installAppBridgeConfigOverlay(listenForRuntime = true) {
  if (window !== window.top) return;

  let overlay: HTMLElement | null = null;
  let closeOverlay: (() => void) | null = null;

  const showOverlay = (
    profile: string,
    actions?: BridgeActions,
    language?: string,
    settings?: AppProfileSetting[],
    settingsUi?: string,
    variants?: Choice<string>[],
  ) => {
    if (overlay || !document.body || settingsUi === 'runtime') return;

    const host = document.createElement('div');
    host.setAttribute('data-mearl-app-bridge-config', profile);
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host{all:initial;color-scheme:light;--text-primary:#2c2c2c;--text-secondary:#6e6e6e;--bg-primary:#fff;--border:#e1e4e8;--notice-bg:rgba(255,255,255,.78);--notice-border:rgba(225,228,232,.92);--blue:oklch(54.6% .245 262.881);--blue-hover:oklch(48.8% .243 264.376);--blue-border-hover:oklch(70.7% .165 254.624);--accent:#2a57c9;--overlay-space-top:max(24px,env(safe-area-inset-top,0px));--overlay-space-bottom:max(24px,env(safe-area-inset-bottom,0px))}
      *{box-sizing:border-box}
      button,input{font:inherit}
      #backdrop{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:var(--overlay-space-top) 12px var(--overlay-space-bottom);background:rgba(15,23,42,.32);-webkit-backdrop-filter:blur(18px) saturate(115%);backdrop-filter:blur(18px) saturate(115%);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;-webkit-font-smoothing:antialiased}
      #sheet{width:min(100%,720px);height:min(100%,860px);min-height:0;display:flex;flex-direction:column;overflow:hidden;border:0;background:transparent;color:var(--text-primary);box-shadow:none;animation:present 180ms ease-out}
      main{min-height:0;flex:1;overflow:auto;padding:16px;background:transparent;scrollbar-width:thin;scrollbar-color:#d1d5db transparent}
      h1{margin:0 0 14px;color:var(--text-primary);font-size:24px;font-weight:650;line-height:32px;letter-spacing:-.01em}
      #notice{margin:0 0 12px;padding:10px 12px;border:1px solid var(--notice-border);border-radius:6px;background:var(--notice-bg);color:var(--text-secondary);font-size:12px;line-height:18px}
      #content{display:grid;gap:12px}
      .method-card{display:grid;gap:11px;padding:14px;border:1px solid var(--border);border-radius:6px;background:var(--notice-bg)}
      .method-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--text-secondary);font-size:12px;line-height:18px}
      .method-heading code{color:var(--accent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
      .choices{display:inline-flex;flex-wrap:wrap;justify-self:end;gap:8px}
      .choices button{appearance:none;min-height:30px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);padding:6px 12px;font-size:12px;line-height:16px;cursor:pointer;transition:background-color 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1),color 150ms cubic-bezier(.4,0,.2,1)}
      .choices button:hover{border-color:var(--blue-border-hover)}
      .choices button[aria-pressed="true"]{border-color:var(--blue);background:var(--blue);color:#fff}
      .choices button[aria-pressed="true"]:hover{border-color:var(--blue-hover);background:var(--blue-hover)}
      .unread-control{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
      .unread-control .choices{justify-self:auto}
      .language-card .choices{justify-self:stretch;justify-content:flex-start}
      .language-hint{margin:0;color:var(--text-secondary);font-size:11px;line-height:16px}
      .count{display:flex;align-items:center;gap:6px;color:var(--text-secondary);font-size:12px}
      .count input{width:52px;height:30px;border:1px solid var(--border);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);padding:4px;text-align:center;font-size:12px;outline:none}
      .count input:hover{border-color:var(--blue-border-hover)}
      .count input:focus{border-color:var(--blue);box-shadow:0 0 0 1px var(--blue)}
      .count input:disabled{cursor:not-allowed;opacity:.5}
      #status{margin:12px 2px 0;color:var(--text-secondary);font-size:12px;line-height:18px;text-align:right}
      #status:empty{display:none}
      .empty{padding:28px 18px;border:1px dashed var(--notice-border);border-radius:4px;background:var(--notice-bg);color:var(--text-secondary);font-size:13px;line-height:20px;text-align:center}
      footer{display:flex;align-items:center;justify-content:center;flex:none;padding:10px 16px 14px;background:transparent}
      #close{appearance:none;width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--border);border-radius:50%;background:var(--bg-primary);color:var(--text-primary);box-shadow:0 4px 14px rgba(15,23,42,.12);cursor:pointer;transition:transform 150ms cubic-bezier(.4,0,.2,1),border-color 150ms cubic-bezier(.4,0,.2,1)}
      #close:hover{transform:scale(1.04);border-color:var(--blue-border-hover)}
      #close:active{transform:scale(.96)}
      #close:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
      #close svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
      @keyframes present{from{transform:scale(.96);opacity:0}to{transform:scale(1);opacity:1}}
      @media(max-width:480px){#backdrop{padding-left:10px;padding-right:10px}main{padding:14px}.method-card{padding:12px}footer{padding-bottom:12px}}
      @media(prefers-reduced-motion:reduce){#sheet{animation:none}.choices button,#close{transition:none}}
      @media(prefers-color-scheme:dark){:host{color-scheme:dark;--text-primary:#e4e4e7;--text-secondary:#a1a1aa;--bg-primary:#0f0f0f;--border:#30363d;--notice-bg:rgba(15,15,15,.78);--notice-border:rgba(48,54,61,.92);--accent:#58a6ff}#backdrop{background:rgba(0,0,0,.52)}#close{box-shadow:0 4px 14px rgba(0,0,0,.35)}main{scrollbar-color:#3b3b3b transparent}}
    </style><div id="backdrop"><section id="sheet" role="dialog" aria-modal="true" aria-labelledby="title"><main><h1 id="title"></h1><p id="notice"></p><div id="content"></div><div id="status" role="status" aria-live="polite"></div></main><footer><button id="close" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></footer></section></div>`;

    const backdrop = shadow.getElementById('backdrop') as HTMLElement;
    const title = shadow.getElementById('title')!;
    const close = shadow.getElementById('close') as HTMLButtonElement;
    const notice = shadow.getElementById('notice')!;
    const content = shadow.getElementById('content')!;
    const status = shadow.getElementById('status')!;
    title.textContent = t('appBridgeConfig');
    notice.textContent = variants?.length ? t('appBridgeWebPageEnvironmentReload') : t('appBridgePagePaused');
    close.setAttribute('aria-label', t('appBridgeCloseConfig'));
    content.textContent = '';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeOverlay?.();
    };
    closeOverlay = () => {
      if (!overlay) return;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      overlay = null;
      closeOverlay = null;
      pageVisibilityChanged(false);
    };
    close.addEventListener('click', () => closeOverlay?.());
    backdrop.addEventListener('click', event => {
      const target = event.target;
      if (
        target instanceof Element &&
        !target.closest('#title,#notice,.method-card,.empty,#status,#close')
      ) {
        closeOverlay?.();
      }
    });
    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(host);
    overlay = host;
    pageVisibilityChanged(true);

    if (variants && variants.length > 1) {
      const label = t('appBridgeWebPageEnvironment');
      let pending = false;
      const picker = createChoiceControl(label, variants, profile, async value => {
        if (pending || value === profile) return;
        pending = true;
        status.textContent = t('settingsSaving');
        try {
          const result = await safeSendMessage<{ success?: boolean }>({
            action: 'appBridgeProfileVariants',
            profile,
            next: value,
          });
          if (!result?.success) throw new Error('App profile switch failed');
          if (overlay === host) closeOverlay?.();
        } catch {
          status.textContent = t('settingsSaveFailed');
        } finally {
          pending = false;
        }
      });
      content.append(createMethodCard(label, '', picker.root));
    }

    if (settings?.length) {
      let queue = Promise.resolve();
      for (const setting of settings) {
        const target = setting.target;
        const response = 'method' in target ? actions?.responses?.[target.method] : undefined;
        let current =
          'option' in target
            ? language
            : target.field && isRecord(response)
              ? response[target.field]
              : response;
        const persist = (value: unknown) => {
          status.textContent = t('settingsSaving');
          queue = queue
            .catch(() => undefined)
            .then(async () => {
              const result = await safeSendMessage<{
                success?: boolean;
                responses?: Record<string, unknown>;
              }>({
                action: 'appBridgeSetSetting',
                profile,
                settingId: setting.id,
                value,
              });
              if (!result?.success) throw new Error('Setting update failed');
              current = value;
              if (result.responses)
                window.postMessage(
                  {
                    source: 'mearl-content',
                    type: 'APP_BRIDGE_RUNTIME_RESPONSES',
                    profile,
                    responses: result.responses,
                  },
                  '*',
                );
              status.textContent = '';
            })
            .catch(() => {
              status.textContent = t('settingsSaveFailed');
            });
        };
        let control: HTMLElement;
        if (setting.type === 'select' || setting.type === 'boolean') {
          const choices =
            setting.type === 'boolean'
              ? [
                  { value: 'true', label: t('appBridgeEnabled') },
                  { value: 'false', label: t('appBridgeDisabled') },
                ]
              : (setting.choices ?? []);
          const selected = current === undefined ? null : String(current);
          const picker = createChoiceControl(setting.label, choices, selected, value => {
            const next = setting.type === 'boolean' ? value === 'true' : value;
            persist(next);
            void queue.then(() => picker.setValue(current === undefined ? null : String(current)));
          });
          control = picker.root;
        } else {
          const input = document.createElement('input');
          input.type = setting.type === 'number' ? 'number' : 'text';
          input.value =
            current === undefined
              ? ''
              : setting.type === 'json'
                ? JSON.stringify(current)
                : String(current);
          input.setAttribute('aria-label', setting.label);
          if (setting.minimum !== undefined) input.min = String(setting.minimum);
          if (setting.maximum !== undefined) input.max = String(setting.maximum);
          input.addEventListener('change', () => {
            try {
              persist(
                setting.type === 'number'
                  ? Number(input.value)
                  : setting.type === 'json'
                    ? JSON.parse(input.value)
                    : input.value,
              );
            } catch {
              status.textContent = t('settingsSaveFailed');
            }
          });
          control = input;
        }
        content.append(
          createMethodCard(
            setting.label,
            'method' in target ? target.method : target.option,
            control,
          ),
        );
      }
      return;
    }

    if (!content.childElementCount) {
      content.className = 'empty';
      content.textContent = t('appBridgeNoCuratedOptions');
    }
  };

  if (listenForRuntime) window.addEventListener('message', event => {
    if (event.source !== window) return;
    const message = event.data as ShowBridgeConfigMessage | null;
    if (
      !message ||
      message.source !== 'mearl-app-bridge' ||
      message.type !== 'showBridgeConfig' ||
      typeof message.profile !== 'string' ||
      message.profile.length === 0
    ) {
      return;
    }
    showOverlay(
      message.profile,
      message.actions,
      message.language,
      message.settings,
      message.settingsUi,
    );
  });
  return async () => {
    if (overlay) return;
    const result = await safeSendMessage<{
      success?: boolean;
      profile?: string;
      variants?: Choice<string>[];
      actions?: BridgeActions;
      language?: string;
      settings?: AppProfileSetting[];
    }>({ action: 'appBridgeProfileVariants' });
    if (result?.success && result.profile)
      showOverlay(result.profile, result.actions, result.language, result.settings, undefined, result.variants);
  };
}
