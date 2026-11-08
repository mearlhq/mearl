export function getChromiumMajorVersion(): number {
  return Number(navigator.userAgent.match(/\b(?:Chrome|Chromium)\/(\d+)/)?.[1]);
}

export function assertDeviceShellSupported(): void {
  if (getChromiumMajorVersion() < 125) {
    throw new Error('Device Shell requires Chrome 125 or newer');
  }
}

export function assertAppProfilePageRuntimeSupported(): void {
  if (getChromiumMajorVersion() < 125) {
    throw new Error('App profiles with a page runtime require Chrome 125 or newer');
  }
}
