import type { QuickDevicePresetName } from '../../shared/quickAppProfile';
import type {
  QuickDeviceToolbarLabels,
  QuickDeviceToolbarOperation,
  QuickDeviceToolbarSelection,
  QuickDeviceToolbarState,
} from '../../shared/quickDeviceToolbar';
import { i18nMessage, safeSendMessage } from './chromeSafe';

const ACTION = 'quickDeviceToolbar';
const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 300;
const DEVICE_MENU_WIDTH = 312;
const icons = {
  orientation: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M9 22h6"/>',
  shell: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  phoneFrame:
    '<rect width="10" height="14" x="3" y="8" rx="2"/><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4M8 18h.01"/>',
} as const;

export const devicePreviewToolbarStyle = `
  .device-toolbar { position: absolute; transform: translate(-50%, -100%); display: flex; width: max-content;
    --selector-bg: light-dark(#fff, #0f0f0f); --selector-border: light-dark(#e1e4e8, #30363d);
    --selector-secondary: light-dark(#6e6e6e, #a1a1aa); --selector-hover: light-dark(#f0f1f3, #262626);
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
    padding: 4px; border: 1px solid var(--selector-border); border-radius: 4px;
    overflow: auto; overscroll-behavior: contain; pointer-events: auto;
    background: var(--selector-bg); color: inherit; box-shadow: 0 4px 12px #070a1326; }
  .device-select-groups { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
  .device-select-group:first-child { border-inline-end: 1px solid var(--selector-border); padding-inline-end: 4px; }
  .device-select-group + .device-select-group { padding-inline-start: 4px; }
  .device-select-adaptive { margin-bottom: 4px; padding-bottom: 4px; border-bottom: 1px solid var(--selector-border); }
  .device-select-footer { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--selector-border); }
  .device-toolbar .device-select-menu button { display: block; width: 100%; min-height: 23px;
    padding: 4px 6px; text-align: start; overflow-wrap: anywhere; color: var(--selector-secondary); }
  .device-toolbar .device-select-menu button:hover:enabled { background: var(--selector-hover); color: inherit; }
  .device-toolbar .device-select-menu button[aria-checked="true"] {
    background: light-dark(#eff6ff, oklch(28.2% .091 267.935 / 50%)); color: light-dark(#2359d2, #96b5ff); }
  .device-actions { flex: none; display: flex; gap: 2px; }
  .device-actions button { display: grid; place-items: center; width: 26px; padding: 0; }
  .device-toolbar .device-actions button:hover:enabled, .device-toolbar .device-select-trigger:hover:enabled {
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
  getLabel: () => string,
  minMenuWidth: number,
  onChange: (value: string) => void,
  getEmptyLabel?: () => string,
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
  trigger.popoverTargetElement = menu;
  wrapper.append(trigger, menu);

  let options: HTMLButtonElement[] = [];
  let selected: HTMLButtonElement | undefined;
  let previewWidth = 0;
  let previewHeight = 0;
  let alignEnd = false;
  const isOpen = () => menu.matches(':popover-open');
  const setValue = (value: string) => {
    const label = getLabel();
    menu.setAttribute('aria-label', label);
    selected?.setAttribute('aria-checked', 'false');
    selected = options.find(option => option.value === value);
    selected?.setAttribute('aria-checked', 'true');
    text.textContent = selected
      ? value === '' && getEmptyLabel
        ? getEmptyLabel()
        : selected.textContent
      : '';
    trigger.setAttribute('aria-label', text.textContent ? `${label} · ${text.textContent}` : label);
  };
  const positionMenu = () => {
    const { left, right, top, bottom, width } = trigger.getBoundingClientRect();
    const menuWidth = Math.max(
      0,
      Math.min(Math.max(width, minMenuWidth), previewWidth - 2 * MENU_GAP),
    );
    const above = top - 2 * MENU_GAP;
    const below = previewHeight - bottom - 2 * MENU_GAP;
    const openAbove = below < MENU_MAX_HEIGHT && above > below;
    const start = alignEnd ? right - menuWidth : left;
    menu.style.left = `${Math.max(MENU_GAP, Math.min(start, previewWidth - menuWidth - MENU_GAP))}px`;
    menu.style.width = `${menuWidth}px`;
    menu.style.maxHeight = `${Math.max(0, Math.min(MENU_MAX_HEIGHT, openAbove ? above : below))}px`;
    menu.style.top = `${openAbove ? top - MENU_GAP : bottom + MENU_GAP}px`;
    menu.style.translate = openAbove ? '0 -100%' : '';
  };
  const close = () => {
    if (isOpen()) menu.hidePopover();
  };
  const updateLayout = (width: number, height: number) => {
    previewWidth = width;
    previewHeight = height;
    if (!isOpen()) return;
    if (trigger.getClientRects().length) positionMenu();
    else close();
  };
  const render = (
    items: Array<{ id: string; label: string }>,
    value: string,
    groups?: QuickDeviceToolbarState['presetGroups'],
  ) => {
    close();
    alignEnd = Boolean(groups);
    const createOption = (item: { id: string; label: string }) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.value = item.id;
      option.textContent = item.label;
      option.setAttribute('role', 'menuitemradio');
      option.setAttribute('aria-checked', 'false');
      option.addEventListener('click', event => {
        if (!event.isTrusted || !isOpen() || trigger.disabled) return;
        trigger.focus({ preventScroll: true });
        close();
        if (option === selected) return;
        setValue(item.id);
        onChange(item.id);
      });
      return option;
    };
    if (groups) {
      const columns = document.createElement('div');
      columns.className = 'device-select-groups';
      for (const { adaptive, fixed } of groups) {
        const column = document.createElement('div');
        column.className = 'device-select-group';
        if (adaptive) {
          const adaptiveRow = document.createElement('div');
          adaptiveRow.className = 'device-select-adaptive';
          adaptiveRow.append(createOption(adaptive));
          column.append(adaptiveRow);
        }
        column.append(...fixed.map(createOption));
        columns.append(column);
      }
      const footer = document.createElement('div');
      footer.className = 'device-select-footer';
      footer.append(...items.map(createOption));
      menu.replaceChildren(columns, footer);
    } else {
      menu.replaceChildren(...items.map(createOption));
    }
    options = [...menu.querySelectorAll('button')];
    setValue(value);
  };

  menu.addEventListener('beforetoggle', event => {
    const open = event.newState === 'open';
    trigger.setAttribute('aria-expanded', String(open));
    if (open) positionMenu();
  });
  menu.addEventListener('toggle', () => {
    if (isOpen()) (selected ?? options[0])?.focus();
  });
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape' && isOpen()) {
      close();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!isOpen()) trigger.click();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
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
        trigger.focus({ preventScroll: true });
        close();
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

export function createDevicePreviewToolbar(
  initial?: QuickDeviceToolbarSelection,
  onExpandLabelChange?: (label: string) => void,
) {
  let labels = initial?.labels;
  const message = (key: keyof QuickDeviceToolbarLabels) => labels?.[key] ?? i18nMessage(key);
  const element = document.createElement('div');
  element.className = 'device-toolbar';
  element.id = 'device-preview-toolbar';
  element.setAttribute('role', 'group');

  const app = createToolbarSelect(
    'device-preview-app',
    () => message('deviceSimulationApp'),
    112,
    value => {
      void apply({ type: 'app', profile: value || null });
    },
    () => message('deviceSimulationNoApp'),
  );
  const preset = createToolbarSelect(
    'device-preview-preset',
    () => message('deviceSimulationMobileDevice'),
    DEVICE_MENU_WIDTH,
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

  const iconButton = (icon: string) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.innerHTML = `<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24"
      fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
      stroke-linejoin="round">${icon}</svg>`;
    actions.append(button);
    return button;
  };
  const icon = (type: keyof typeof icons) => {
    const button = iconButton(icons[type]);
    button.addEventListener('click', event => {
      if (event.isTrusted) void apply({ type });
    });
    return button;
  };
  const orientation = icon('orientation');
  const shell = icon('shell');
  const phoneFrame = icon('phoneFrame');
  const collapseButton = iconButton('<path d="m9 6 6 6-6 6"/>');
  shell.setAttribute('aria-pressed', 'true');
  phoneFrame.setAttribute('aria-pressed', 'true');
  const controls = [app.trigger, preset.trigger, orientation, shell, phoneFrame];
  const setDisabled = () => {
    for (const control of controls) control.disabled = pending || !state;
    if (!state?.profile && !state?.profiles.length) app.trigger.disabled = true;
  };
  const updateLabels = (landscape: boolean) => {
    const labelButton = (button: HTMLButtonElement, key: keyof QuickDeviceToolbarLabels) => {
      const label = message(key);
      button.title = label;
      button.setAttribute('aria-label', label);
    };
    element.setAttribute('aria-label', message('deviceSimulation'));
    labelButton(
      orientation,
      landscape ? 'deviceSimulationDisableLandscape' : 'deviceSimulationEnableLandscape',
    );
    labelButton(shell, 'deviceSimulationShell');
    labelButton(phoneFrame, 'deviceSimulationPhoneFrame');
    labelButton(collapseButton, 'devicePreviewToolbarCollapse');
    onExpandLabelChange?.(message('devicePreviewToolbar'));
    if (!error.hidden) error.textContent = message('deviceSimulationChangeFailed');
  };
  const render = (next: QuickDeviceToolbarState) => {
    state = next;
    labels = next.labels;
    const disableSimulation = { id: '', label: message('deviceSimulationDisable') };
    const profiles = [...next.profiles];
    if (next.profile && !next.profiles.some(({ id }) => id === next.profile)) {
      profiles.push({ id: next.profile, label: next.profile });
    }
    app.render([...profiles, disableSimulation], next.profile ?? '');
    preset.render([disableSimulation], next.preset, next.presetGroups);
    const landscape = next.orientation === 'landscape';
    updateLabels(landscape);
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
      presetGroups: [{ fixed: [initial.preset] }],
      orientation: initial.orientation,
      labels: initial.labels,
    });
  } else {
    updateLabels(false);
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
      error.textContent = message('deviceSimulationChangeFailed');
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
