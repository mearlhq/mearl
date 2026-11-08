import { useLayoutEffect, useState, ReactElement } from 'react';
import { CheckCircle, XCircle, Info, X } from 'lucide-react';
import type { ToastType, ToastAction } from '../utils/toast';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  duration: number;
  visible: boolean;
  action?: ToastAction;
}

const iconMap: Record<ToastType, ReactElement> = {
  success: <CheckCircle size={12} className="text-green-500 shrink-0" />,
  error: <XCircle size={12} className="text-red-500 shrink-0" />,
  info: <Info size={12} className="text-blue-500 shrink-0" />,
};

const ANIM_OUT = 200; // ms — exit animation duration

export const ToastContainer = () => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useLayoutEffect(() => {
    const handler = (e: Event) => {
      const { message, type, duration, action } = (e as CustomEvent).detail;
      const id = Date.now() + Math.random();
      // Insert as invisible, then flip to visible on next frame to trigger transition
      setToasts(prev => [...prev, { id, message, type, duration, visible: false, action }]);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setToasts(prev => prev.map(t => (t.id === id ? { ...t, visible: true } : t)));
        });
      });
      // Start exit animation before actual removal
      setTimeout(() => {
        setToasts(prev => prev.map(t => (t.id === id ? { ...t, visible: false } : t)));
        setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== id));
        }, ANIM_OUT);
      }, duration);
    };
    window.addEventListener('mearl-panel-toast', handler);
    return () => window.removeEventListener('mearl-panel-toast', handler);
  }, []);

  const dismiss = (id: number) => {
    setToasts(prev => prev.map(t => (t.id === id ? { ...t, visible: false } : t)));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, ANIM_OUT);
  };

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-9999 flex flex-col gap-2 pointer-events-none">
      {toasts.map(toast => (
        <div
          key={toast.id}
          style={{
            transition: `opacity ${ANIM_OUT}ms ease, transform ${ANIM_OUT}ms ease`,
            opacity: toast.visible ? 1 : 0,
            transform: toast.visible ? 'translateY(0)' : 'translateY(8px)',
          }}
          className="flex flex-col gap-1.5 pl-3.5 pr-3 py-2.5 bg-bg-primary border border-border rounded-lg shadow-xl text-xs text-text-primary pointer-events-auto max-w-72 min-w-40"
        >
          <div className="flex items-start gap-2.5">
            <span className="shrink-0 h-5 flex items-center">{iconMap[toast.type]}</span>
            <span className="flex-1 min-w-0 wrap-break-word leading-relaxed">{toast.message}</span>
            <button
              className="shrink-0 h-5 flex items-center text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => dismiss(toast.id)}
            >
              <X size={13} />
            </button>
          </div>
          {toast.action && (
            <div className="flex justify-end">
              <button
                className="h-6 flex items-center px-3 rounded bg-blue-600 text-white hover:bg-blue-700 font-medium whitespace-nowrap transition-colors"
                onClick={() => {
                  toast.action?.onClick();
                  dismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
