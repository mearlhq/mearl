let sharedColorPicker: HTMLInputElement | null = null;

const getColorPicker = (): HTMLInputElement => {
  if (sharedColorPicker?.ownerDocument === document) {
    if (!sharedColorPicker.isConnected) document.body.appendChild(sharedColorPicker);
    return sharedColorPicker;
  }

  const existingPicker = document.querySelector<HTMLInputElement>('[data-json-color-picker]');
  if (existingPicker) {
    sharedColorPicker = existingPicker;
    return existingPicker;
  }

  const picker = document.createElement('input');
  picker.type = 'color';
  picker.tabIndex = -1;
  picker.setAttribute('aria-hidden', 'true');
  picker.setAttribute('data-json-color-picker', '');
  picker.style.cssText =
    'position:fixed;margin:0;border:0;padding:0;box-sizing:border-box;appearance:none;opacity:0;pointer-events:none;z-index:2147483647;';
  document.body.appendChild(picker);
  sharedColorPicker = picker;
  return picker;
};

export const openColorPicker = (
  anchor: HTMLElement,
  value: string,
  onChange: (value: string) => void,
): void => {
  const picker = getColorPicker();
  const anchorRect = anchor.getBoundingClientRect();
  picker.style.left = `${anchorRect.left}px`;
  picker.style.top = `${anchorRect.top}px`;
  picker.style.width = `${Math.max(anchorRect.width, 1)}px`;
  picker.style.height = `${Math.max(anchorRect.height, 1)}px`;
  picker.value = value;
  picker.onchange = () => onChange(picker.value);
  // 原生取色面板会读取 input 的实时屏幕位置；同步布局后再打开，避免首次沿用旧坐标。
  picker.getBoundingClientRect();
  picker.blur();
  picker.click();
};
