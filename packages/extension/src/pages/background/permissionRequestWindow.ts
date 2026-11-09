export async function openPermissionRequestWindow(url: string, width: number, height: number) {
  const lastWindow = await chrome.windows
    .getLastFocused({ windowTypes: ['normal'] })
    .catch(() => undefined);
  const left =
    lastWindow?.left != null && lastWindow.width != null
      ? Math.round(lastWindow.left + (lastWindow.width - width) / 2)
      : undefined;
  const top =
    lastWindow?.top != null && lastWindow.height != null
      ? Math.round(lastWindow.top + (lastWindow.height - height) / 2)
      : undefined;

  return chrome.windows.create({
    url,
    type: 'popup',
    width,
    height,
    left,
    top,
    focused: true,
    state: 'normal',
  });
}
