export type ToastType = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export function showToast(
  message: string,
  type: ToastType = 'info',
  duration = 3000,
  action?: ToastAction,
) {
  window.dispatchEvent(
    new CustomEvent('mearl-panel-toast', {
      detail: { message, type, duration, action },
    }),
  );
}
