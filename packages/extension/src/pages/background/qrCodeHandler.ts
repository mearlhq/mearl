import { decodeQrCodeFromImage } from '../../shared/qrCodeDecoder';

export async function scanQrCodeFromImage(srcUrl: string, tabId: number) {
  try {
    let dataUrl: string;
    try {
      const response = await fetch(srcUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const base64 = arrayBufferToBase64(arrayBuffer);
      const mime = response.headers.get('content-type') || 'image/png';
      dataUrl = `data:${mime};base64,${base64}`;
    } catch {
      // CORS blocked — fallback: capture tab screenshot and crop to the image element's bounds
      const [screenshot, boundsResult] = await Promise.all([
        chrome.tabs.captureVisibleTab({ format: 'png' }),
        chrome.scripting.executeScript({
          target: { tabId },
          func: (src: string) => {
            const img = document.querySelector(`img[src="${CSS.escape(src)}"]`) as HTMLImageElement;
            if (!img) return null;
            const rect = img.getBoundingClientRect();
            return {
              x: rect.x * devicePixelRatio,
              y: rect.y * devicePixelRatio,
              w: rect.width * devicePixelRatio,
              h: rect.height * devicePixelRatio,
            };
          },
          args: [srcUrl],
        }),
      ]);
      const bounds = boundsResult?.[0]?.result as {
        x: number;
        y: number;
        w: number;
        h: number;
      } | null;
      if (bounds && bounds.w > 0 && bounds.h > 0) {
        const cropResult = await chrome.scripting.executeScript({
          target: { tabId },
          func: async (
            screenshotUrl: string,
            b: { x: number; y: number; w: number; h: number },
          ) => {
            const res = await fetch(screenshotUrl);
            const blob = await res.blob();
            const bmp = await createImageBitmap(blob, b.x, b.y, b.w, b.h);
            const canvas = new OffscreenCanvas(b.w, b.h);
            const ctx = canvas.getContext('2d')!;
            ctx.drawImage(bmp, 0, 0);
            bmp.close();
            const outBlob = await canvas.convertToBlob({ type: 'image/png' });
            const reader = new FileReader();
            return new Promise<string>(resolve => {
              reader.onload = () => resolve(reader.result as string);
              reader.readAsDataURL(outBlob);
            });
          },
          args: [screenshot, bounds],
        });
        dataUrl = (cropResult?.[0]?.result as string) || screenshot;
      } else {
        dataUrl = screenshot;
      }
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: decodeQrCodeFromImage,
      args: [dataUrl, true],
    });

    const data = results?.[0]?.result;
    if (data?.success) {
      const display = data.text!.length > 60 ? data.text!.slice(0, 60) + '...' : data.text!;
      showQrToast(tabId, chrome.i18n.getMessage('qrCopied', display));
    } else if (data?.error === 'not_found') {
      showQrToast(tabId, chrome.i18n.getMessage('qrNotFound'));
    } else {
      showQrToast(tabId, chrome.i18n.getMessage('qrFailed'));
    }
  } catch {
    showQrToast(tabId, chrome.i18n.getMessage('qrFailed'));
  }
}

export async function scanQrCodeFromElement(tabId: number) {
  try {
    let bounds: { x: number; y: number; w: number; h: number } | null = null;
    try {
      bounds = (await chrome.tabs.sendMessage(tabId, {
        action: 'getContextMenuTargetBounds',
      })) as { x: number; y: number; w: number; h: number } | null;
    } catch {
      // content script not injected (page not refreshed after install/update, or restricted page)
    }

    const screenshot = await chrome.tabs.captureVisibleTab({ format: 'png' });
    let dataUrl = screenshot;

    if (bounds && bounds.w > 0 && bounds.h > 0) {
      const cropResult = await chrome.scripting.executeScript({
        target: { tabId },
        func: async (screenshotUrl: string, b: { x: number; y: number; w: number; h: number }) => {
          const res = await fetch(screenshotUrl);
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob, b.x, b.y, b.w, b.h);
          const canvas = new OffscreenCanvas(b.w, b.h);
          const ctx = canvas.getContext('2d')!;
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          const outBlob = await canvas.convertToBlob({ type: 'image/png' });
          const reader = new FileReader();
          return new Promise<string>(resolve => {
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(outBlob);
          });
        },
        args: [screenshot, bounds],
      });
      dataUrl = (cropResult?.[0]?.result as string) || screenshot;
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: decodeQrCodeFromImage,
      args: [dataUrl, true],
    });

    const data = results?.[0]?.result;
    if (data?.success) {
      const display = data.text!.length > 60 ? data.text!.slice(0, 60) + '...' : data.text!;
      showQrToast(tabId, chrome.i18n.getMessage('qrCopied', display));
    } else if (data?.error === 'not_found') {
      showQrToast(tabId, chrome.i18n.getMessage('qrNotFound'));
    } else {
      showQrToast(tabId, chrome.i18n.getMessage('qrFailed'));
    }
  } catch {
    showQrToast(tabId, chrome.i18n.getMessage('qrFailed'));
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function showQrToast(tabId: number, message: string) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (msg: string) => {
        const existing = document.getElementById('__mtop_qr_toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.id = '__mtop_qr_toast';
        toast.textContent = msg;
        Object.assign(toast.style, {
          position: 'fixed',
          top: '16px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '10px 20px',
          borderRadius: '8px',
          background: 'rgba(0,0,0,0.8)',
          color: '#fff',
          fontSize: '14px',
          zIndex: '2147483647',
          fontFamily: 'system-ui, sans-serif',
          maxWidth: '80vw',
          wordBreak: 'break-all',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          transition: 'opacity 0.3s',
        });
        document.body.appendChild(toast);
        setTimeout(() => {
          toast.style.opacity = '0';
          setTimeout(() => toast.remove(), 300);
        }, 3000);
      },
      args: [message],
    })
    .catch(err => {
      console.warn('[QR] Toast inject failed:', err.message, '| Original message:', message);
    });
}
