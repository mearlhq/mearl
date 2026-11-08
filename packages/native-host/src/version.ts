declare const __NATIVE_HOST_VERSION__: string;

export const NATIVE_HOST_VERSION: string =
  typeof __NATIVE_HOST_VERSION__ !== 'undefined' ? __NATIVE_HOST_VERSION__ : 'unknown';
