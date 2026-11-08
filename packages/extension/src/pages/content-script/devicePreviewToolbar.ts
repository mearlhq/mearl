import type { QuickDevicePresetName } from '../../shared/quickAppProfile';
import type { QuickDeviceToolbarOperation, QuickDeviceToolbarSelection, QuickDeviceToolbarState } from '../../shared/quickDeviceToolbar';
import { i18nMessage, safeSendMessage } from './chromeSafe';

const ACTION = 'quickDeviceToolbar';
const icons = {
  orientation: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M9 22h6"/>',
  shell: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M11 18h2"/>',
  phoneFrame: '<rect width="10" height="14" x="3" y="8" rx="2"/><path d="M5 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-2.4M8 18h.01"/>',
} as const;

export const devicePreviewToolbarStyle = `
  .device-toolbar { position: absolute; transform: translate(-50%, -100%); display: flex; width: max-content;
    align-items: center; gap: 6px; box-sizing: border-box; padding: 4px; border-radius: 8px;
    border: 1px solid light-dark(#dce1e8, #383e48); pointer-events: auto;
    background: light-dark(#fff, #22262d); color: light-dark(#19212d, #ecedf2);
    font: 12px system-ui, sans-serif; box-shadow: 0 2px 8px #070a1314; }
  .device-toolbar.compact { flex-direction: column; gap: 4px; }
  .device-selectors { min-width: 0; max-width: 100%; display: flex; gap: 4px; }
  .device-toolbar select, .device-toolbar button { min-width: 0; height: 26px; border: 0;
    border-radius: 4px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
  .device-select { position: relative; display: grid; width: 96px; min-width: 0; }
  .device-select-preset { width: 142px; }
  .device-select::after { content: ''; position: absolute; top: 50%; inset-inline-end: 8px;
    width: 5px; height: 5px; transform: translateY(-70%) rotate(45deg);
    border: solid light-dark(#526171, #adb7c7); border-width: 0 1px 1px 0; pointer-events: none; }
  .device-toolbar select { appearance: none; box-sizing: border-box; width: 100%;
    padding-inline: 6px 20px; text-overflow: ellipsis; }
  @media (forced-colors: active) {
    .device-toolbar select { appearance: auto; padding-inline-end: 6px; }
    .device-select::after { display: none; }
  }
  .device-actions { flex: none; display: flex; gap: 2px; }
  .device-toolbar button { display: grid; place-items: center; width: 26px; padding: 0; }
  .device-toolbar :is(button, select):hover:enabled { background-color: light-dark(#eef1f5, #30353e); }
  .device-toolbar button[aria-pressed="true"] { color: light-dark(#2359d2, #96b5ff); }
  .device-toolbar :disabled { opacity: .45; cursor: default; }
  .device-toolbar :focus { outline: none; }
  .device-toolbar :focus-visible { background-color: light-dark(#e7ebf1, #353b46); }
  .device-toolbar[hidden], .device-toolbar [hidden] { display: none; }
  .device-toolbar output { position: absolute; top: calc(100% + 4px); z-index: 1; inset-inline: 0;
    padding: 4px 6px; border-radius: 4px; text-align: center; white-space: normal;
    color: light-dark(#a52c32, #ff9698); background: light-dark(#fff, #22262d); }
`;

export function createDevicePreviewToolbar(initial?: QuickDeviceToolbarSelection) {
  const element = document.createElement('div');
  element.className = 'device-toolbar';
  element.id = 'device-preview-toolbar';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', i18nMessage('deviceSimulation'));

  const app = document.createElement('select');
  app.setAttribute('aria-label', i18nMessage('deviceSimulationApp'));
  const preset = document.createElement('select');
  preset.setAttribute('aria-label', i18nMessage('deviceSimulationMobileDevice'));
  const selectors = document.createElement('div');
  selectors.className = 'device-selectors';
  const wrapSelect = (select: HTMLSelectElement) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'device-select';
    wrapper.append(select);
    selectors.append(wrapper);
    return wrapper;
  };
  wrapSelect(app);
  wrapSelect(preset).classList.add('device-select-preset');
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
    button.addEventListener('click', event => { if (event.isTrusted) void apply({ type }); });
    return button;
  };
  const orientation = icon('orientation', i18nMessage('deviceSimulationEnableLandscape'));
  const shell = icon('shell', i18nMessage('deviceSimulationShell'));
  const phoneFrame = icon('phoneFrame', i18nMessage('deviceSimulationPhoneFrame'));
  const collapseButton = iconButton('<path d="m9 6 6 6-6 6"/>', i18nMessage('devicePreviewToolbarCollapse'));
  shell.setAttribute('aria-pressed', 'true');
  phoneFrame.setAttribute('aria-pressed', 'true');
  const controls = [app, preset, orientation, shell, phoneFrame];
  const setDisabled = () => {
    for (const control of controls) control.disabled = pending || !state;
    if (!state?.profile && !state?.profiles.length) app.disabled = true;
  };
  const option = (label: string, value: string) => {
    const element = document.createElement('option');
    element.textContent = label;
    element.value = value;
    return element;
  };
  const render = (next: QuickDeviceToolbarState) => {
    state = next;
    const options = next.profiles.map(({ id, label }) => option(label, id));
    if (next.profile && !next.profiles.some(({ id }) => id === next.profile)) {
      options.push(option(next.profile, next.profile));
    }
    app.replaceChildren(option(i18nMessage('deviceSimulationNoApp'), ''), ...options);
    app.value = next.profile ?? '';
    preset.replaceChildren(
      ...next.presets.map(({ id, label }) => option(label, id)),
      option(i18nMessage('deviceSimulationDisable'), ''),
    );
    preset.value = next.preset;
    const landscape = next.orientation === 'landscape';
    const label = landscape ? i18nMessage('deviceSimulationDisableLandscape') : i18nMessage('deviceSimulationEnableLandscape');
    orientation.title = label;
    orientation.setAttribute('aria-label', label);
    orientation.setAttribute('aria-pressed', String(landscape));
    setDisabled();
  };
  if (typeof initial?.preset?.id === 'string' && typeof initial.preset.label === 'string') {
    const profile = typeof initial.profile?.id === 'string' && typeof initial.profile.label === 'string'
      ? initial.profile : null;
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
    const response = await safeSendMessage<{ success: boolean; state?: QuickDeviceToolbarState }>({ action: ACTION });
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
      app.value = state?.profile ?? '';
      preset.value = state?.preset ?? '';
      error.textContent = i18nMessage('deviceSimulationChangeFailed');
      error.hidden = false;
      void refresh();
    }
  }

  app.addEventListener('change', event => { if (event.isTrusted) void apply({ type: 'app', profile: app.value || null }); });
  preset.addEventListener('change', event => {
    if (event.isTrusted) void apply({ type: 'preset', preset: (preset.value || null) as QuickDevicePresetName | null });
  });
  void refresh();
  return { element, collapseButton, refresh };
}
