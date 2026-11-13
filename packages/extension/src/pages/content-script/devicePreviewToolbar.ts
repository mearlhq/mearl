import type { QuickDevicePresetName } from '../../shared/quickAppProfile';
import type {
  QuickDeviceToolbarOperation,
  QuickDeviceToolbarSelection,
  QuickDeviceToolbarState,
} from '../../shared/quickDeviceToolbar';
import { i18nMessage, safeSendMessage } from './chromeSafe';

const ACTION = 'quickDeviceToolbar';
const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 300;
const icons = {
  orientation: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M9 22h6"/>',
  shell: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  phoneFrame:
    '<rect width="10" height="14" x="3" y="8" rx="2"/><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4M8 18h.01"/>',
} as const;

export const devicePreviewToolbarStyle = `
  .device-toolbar { position: absolute; transform: translate(-50%, -100%); display: flex; width: max-content;
    align-items: center; gap: 6px; box-sizing: border-box; padding: 4px; border-radius: 8px;
    border: 1px solid light-dark(#dce1e8, #383e48); pointer-events: auto;
    background: light-dark(#fff, #22262d); color: light-dark(#19212d, #ecedf2);
    font: 12px system-ui, sans-serif; box-shadow: 0 2px 8px #070a1314; }
  .device-toolbar.compact { flex-direction: column; gap: 4px; }
  .device-selectors { min-width: 0; max-width: 100%; display: flex; gap: 4px; }
  .device-toolbar button { min-width: 0; min-height: 26px; border: 0;
    border-radius: 4px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .device-select { display: grid; width: 96px; min-width: 0; }
  .device-select-preset { width: 142px; }
  .device-toolbar .device-select-trigger { display: flex; align-items: center; justify-content: space-between;
    gap: 6px; padding-inline: 6px 8px; text-align: start; }
  .device-select-trigger span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .device-select-trigger::after { content: ''; flex: none; width: 5px; height: 5px;
    transform: translateY(-2px) rotate(45deg); border: solid currentColor; border-width: 0 1px 1px 0; }
  .device-select-menu { position: fixed; inset: auto; margin: 0; box-sizing: border-box;
    padding: 4px; border: 1px solid light-dark(#dce1e8, #383e48); border-radius: 4px;
    overflow: auto; overscroll-behavior: contain; pointer-events: auto;
    background: light-dark(#fff, #22262d); color: inherit; box-shadow: 0 4px 12px #070a1326; }
  .device-toolbar .device-select-menu button { display: block; width: 100%; padding: 3px 6px;
    text-align: start; overflow-wrap: anywhere; }
  .device-toolbar .device-select-menu button[aria-checked="true"] {
    background: light-dark(#eff6ff, #17264a); color: light-dark(#2359d2, #96b5ff); font-weight: 600; }
  .device-actions { flex: none; display: flex; gap: 2px; }
  .device-actions button { display: grid; place-items: center; width: 26px; padding: 0; }
  .device-toolbar button:hover:enabled, .device-select-trigger[aria-expanded="true"] {
    background-color: light-dark(#eef1f5, #30353e); }
  .device-toolbar button[aria-pressed="true"] { color: light-dark(#2359d2, #96b5ff); }
  .device-toolbar :disabled { opacity: .45; cursor: default; }
  .device-toolbar :focus-visible { outline: 1px solid currentColor; outline-offset: -1px; }
  @media (forced-colors: active) {
    .device-toolbar .device-select-menu button[aria-checked="true"] { color: Highlight; }
  }
  .device-toolbar[hidden], .device-toolbar [hidden] { display: none; }
  .device-toolbar output { position: absolute; top: calc(100% + 4px); z-index: 1; inset-inline: 0;
    padding: 4px 6px; border-radius: 4px; text-align: center; white-space: normal;
    color: light-dark(#a52c32, #ff9698); background: light-dark(#fff, #22262d); }
`;

function createToolbarSelect(
  id: string,
  label: string,
  minMenuWidth: number,
  onChange: (value: string) => void,
  emptyLabel?: string,
) {
  const wrapper = document.createElement('div');
  wrapper.className = 'device-select';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'device-select-trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', id);
  const text = document.createElement('span');
  trigger.append(text);
  const menu = document.createElement('div');
  menu.id = id;
  menu.className = 'device-select-menu';
  menu.popover = 'auto';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', label);
  trigger.popoverTargetElement = menu;
  wrapper.append(trigger, menu);

  let options: HTMLButtonElement[] = [];
  let selected: HTMLButtonElement | undefined;
  let previewWidth = 0;
  let previewHeight = 0;
  const setValue = (value: string) => {
    selected?.setAttribute('aria-checked', 'false');
    selected = options.find(option => option.value === value);
    selected?.setAttribute('aria-checked', 'true');
    text.textContent = selected
      ? value === '' && emptyLabel
        ? emptyLabel
        : selected.textContent
      : '';
    trigger.setAttribute('aria-label', text.textContent ? `${label} · ${text.textContent}` : label);
  };
  const positionMenu = () => {
    const { left, top, bottom, width } = trigger.getBoundingClientRect();
    const menuWidth = Math.max(
      0,
      Math.min(Math.max(width, minMenuWidth), previewWidth - 2 * MENU_GAP),
    );
    const above = top - 2 * MENU_GAP;
    const below = previewHeight - bottom - 2 * MENU_GAP;
    const openAbove = below < MENU_MAX_HEIGHT && above > below;
    menu.style.left = `${Math.max(MENU_GAP, Math.min(left, previewWidth - menuWidth - MENU_GAP))}px`;
    menu.style.width = `${menuWidth}px`;
    menu.style.maxHeight = `${Math.max(0, Math.min(MENU_MAX_HEIGHT, openAbove ? above : below))}px`;
    menu.style.top = `${openAbove ? top - MENU_GAP : bottom + MENU_GAP}px`;
    menu.style.translate = openAbove ? '0 -100%' : '';
  };
  const close = () => {
    if (!menu.matches(':popover-open')) return;
    menu.hidePopover();
  };
  const updateLayout = (width: number, height: number) => {
    previewWidth = width;
    previewHeight = height;
    if (!menu.matches(':popover-open')) return;
    if (trigger.getClientRects().length) positionMenu();
    else close();
  };
  const render = (items: Array<{ id: string; label: string }>, value: string) => {
    close();
    options = items.map(item => {
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.value = item.id;
      option.textContent = item.label;
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', 'false');
      option.addEventListener('click', event => {
        if (!event.isTrusted || !menu.matches(':popover-open') || trigger.disabled) return;
        close();
        trigger.focus({ preventScroll: true });
        if (option === selected) return;
        setValue(item.id);
        onChange(item.id);
      });
      return option;
    });
    menu.replaceChildren(...options);
    setValue(value);
  };

  menu.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(open));
    if (open) positionMenu();
  });
  menu.addEventListener('toggle', () => {
    if (menu.matches(':popover-open')) (selected ?? options[0])?.focus();
  });
  trigger.addEventListener('keydown', event => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    if (!menu.matches(':popover-open')) trigger.click();
  });
  menu.addEventListener('keydown', event => {
    const index = options.indexOf(event.target as HTMLButtonElement);
    switch (event.key) {
      case 'ArrowDown':
        options[(index + 1) % options.length]?.focus();
        break;
      case 'ArrowUp':
        options[(index - 1 + options.length) % options.length]?.focus();
        break;
      case 'Home':
        options[0]?.focus();
        break;
      case 'End':
        options.at(-1)?.focus();
        break;
      case 'Escape':
      case 'Tab':
        close();
        trigger.focus({ preventScroll: true });
        if (event.key === 'Tab') return;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  });
  setValue('');
  return { wrapper, trigger, render, setValue, updateLayout };
}

export function createDevicePreviewToolbar(initial?: QuickDeviceToolbarSelection) {
  const element = document.createElement('div');
  element.className = 'device-toolbar';
  element.id = 'device-preview-toolbar';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', i18nMessage('deviceSimulation'));

  const app = createToolbarSelect(
    'device-preview-app',
    i18nMessage('deviceSimulationApp'),
    112,
    value => {
      void apply({ type: 'app', profile: value || null });
    },
    i18nMessage('deviceSimulationNoApp'),
  );
  const preset = createToolbarSelect(
    'device-preview-preset',
    i18nMessage('deviceSimulationMobileDevice'),
    142,
    value => {
      void apply({ type: 'preset', preset: (value || null) as QuickDevicePresetName | null });
    },
  );
  const selectors = document.createElement('div');
  selectors.className = 'device-selectors';
  preset.wrapper.classList.add('device-select-preset');
  selectors.append(app.wrapper, preset.wrapper);
  const actions = document.createElement('div');
  actions.className = 'device-actions';
  const error = document.createElement('output');
  error.hidden = true;
  element.append(selectors, actions, error);

  let state: QuickDeviceToolbarState | undefined;
  let revision = 0;
  let pending = false;

  const iconButton = (icon: string, label: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round">${icon}</svg>`;
    actions.append(button);
    return button;
  };
  const icon = (type: keyof typeof icons, label: string) => {
    const button = iconButton(icons[type], label);
    button.addEventListener('click', event => {
      if (event.isTrusted) void apply({ type });
    });
    return button;
  };
  const orientation = icon('orientation', i18nMessage('deviceSimulationEnableLandscape'));
  const shell = icon('shell', i18nMessage('deviceSimulationShell'));
  const phoneFrame = icon('phoneFrame', i18nMessage('deviceSimulationPhoneFrame'));
  const collapseButton = iconButton(
    '<path d="m9 6 6 6-6 6"/>',
    i18nMessage('devicePreviewToolbarCollapse'),
  );
  shell.setAttribute('aria-pressed', 'true');
  phoneFrame.setAttribute('aria-pressed', 'true');
  const controls = [app.trigger, preset.trigger, orientation, shell, phoneFrame];
  const setDisabled = () => {
    for (const control of controls) control.disabled = pending || !state;
    if (!state?.profile && !state?.profiles.length) app.trigger.disabled = true;
  };
  const render = (next: QuickDeviceToolbarState) => {
    state = next;
    const profiles = [
      { id: '', label: i18nMessage('deviceSimulationDisableApp') },
      ...next.profiles,
    ];
    if (next.profile && !next.profiles.some(({ id }) => id === next.profile)) {
      profiles.push({ id: next.profile, label: next.profile });
    }
    app.render(profiles, next.profile ?? '');
    preset.render(
      [{ id: '', label: i18nMessage('deviceSimulationDisable') }, ...next.presets],
      next.preset,
    );
    const landscape = next.orientation === 'landscape';
    const label = landscape
      ? i18nMessage('deviceSimulationDisableLandscape')
      : i18nMessage('deviceSimulationEnableLandscape');
    orientation.title = label;
    orientation.setAttribute('aria-label', label);
    orientation.setAttribute('aria-pressed', String(landscape));
    setDisabled();
  };
  if (typeof initial?.preset?.id === 'string' && typeof initial.preset.label === 'string') {
    const profile =
      typeof initial.profile?.id === 'string' && typeof initial.profile.label === 'string'
        ? initial.profile
        : null;
    render({
      profile: profile?.id ?? null,
      profiles: profile ? [profile] : [],
      preset: initial.preset.id,
      presets: [initial.preset],
      orientation: initial.orientation,
    });
  } else {
    setDisabled();
  }

  const refresh = async () => {
    const request = ++revision;
    const response = await safeSendMessage<{ success: boolean; state?: QuickDeviceToolbarState }>({
      action: ACTION,
    });
    if (request === revision && response?.state) render(response.state);
  };

  async function apply(operation: QuickDeviceToolbarOperation) {
    if (pending) return;
    revision += 1;
    pending = true;
    error.hidden = true;
    setDisabled();
    const response = await safeSendMessage<{ success: boolean }>({ action: ACTION, operation });
    pending = false;
    setDisabled();
    if (!element.isConnected) return;
    if (!response?.success) {
      app.setValue(state?.profile ?? '');
      preset.setValue(state?.preset ?? '');
      error.textContent = i18nMessage('deviceSimulationChangeFailed');
      error.hidden = false;
      void refresh();
    }
  }

  void refresh();
  const updateLayout = (width: number, height: number) => {
    app.updateLayout(width, height);
    preset.updateLayout(width, height);
  };
  return { element, collapseButton, refresh, updateLayout };
}
