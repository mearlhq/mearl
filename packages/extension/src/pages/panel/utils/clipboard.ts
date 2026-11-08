/**
 * 在 Chrome 扩展中复制文本到剪贴板
 * 优先使用现代 Clipboard API，失败时降级到 execCommand
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  // 方法1: 优先使用 Clipboard API (现代、推荐的方式)
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('Clipboard API failed:', err);
  }

  // 方法2: 降级到 document.execCommand (兼容旧浏览器)
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);

    if (successful) {
      return true;
    }
  } catch (err) {
    console.warn('execCommand copy failed:', err);
  }

  return false;
};

const svgToPngBlob = (svgMarkup: string, size: number): Promise<Blob> => {
  const svgBlob = new Blob([svgMarkup], { type: 'image/svg+xml' });
  const objectUrl = URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const image = new Image();

    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;

        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('Canvas 2D context is unavailable'));
          return;
        }

        context.imageSmoothingEnabled = false;
        context.fillStyle = '#FFFFFF';
        context.fillRect(0, 0, size, size);
        context.drawImage(image, 0, 0, size, size);
        canvas.toBlob(blob => {
          if (blob) {
            resolve(blob);
          } else {
            reject(new Error('Failed to encode PNG'));
          }
        }, 'image/png');
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load SVG image'));
    };
    image.src = objectUrl;
  });
};

/**
 * 将 SVG 图片及其文本内容作为同一个剪贴板条目写入。
 * 富文本应用可粘贴 PNG 图片，纯文本输入框可粘贴原始文本。
 */
export const copySvgImageToClipboard = async (
  svgMarkup: string,
  text: string,
  size = 600,
): Promise<boolean> => {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      return false;
    }

    const pngBlob = svgToPngBlob(svgMarkup, size);
    const clipboardItem = new ClipboardItem({
      'image/png': pngBlob,
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    await navigator.clipboard.write([clipboardItem]);
    return true;
  } catch (error) {
    console.warn('Clipboard image write failed:', error);
    return false;
  }
};

/**
 * 从剪贴板读取文本
 * 优先使用现代 Clipboard API，失败时降级到 execCommand paste
 *
 * @param onPaste - 当粘贴成功时的回调函数，接收粘贴的文本
 * @returns Promise<string | null> - 返回读取到的文本，失败返回 null
 */
export const readFromClipboard = async (
  onPaste?: (text: string) => void,
): Promise<string | null> => {
  // 方法1: 优先使用 Clipboard API
  try {
    if (navigator.clipboard && navigator.clipboard.readText) {
      const text = await navigator.clipboard.readText();
      if (text && onPaste) {
        onPaste(text);
      }
      return text;
    }
  } catch (err) {
    console.warn('Clipboard API readText failed:', err);
  }

  // 方法2: 降级到 execCommand paste
  // 需要配合 paste 事件监听使用
  try {
    const textArea = document.createElement('textarea');
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);

    return new Promise<string | null>(resolve => {
      const handlePaste = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData('text') || '';
        textArea.removeEventListener('paste', handlePaste);
        document.body.removeChild(textArea);

        if (text && onPaste) {
          onPaste(text);
        }
        resolve(text || null);
      };

      textArea.addEventListener('paste', handlePaste);
      textArea.focus();

      // 执行粘贴命令
      const successful = document.execCommand('paste');

      if (!successful) {
        textArea.removeEventListener('paste', handlePaste);
        document.body.removeChild(textArea);
        resolve(null);
      }

      // 设置超时，避免永久等待
      setTimeout(() => {
        if (document.body.contains(textArea)) {
          textArea.removeEventListener('paste', handlePaste);
          document.body.removeChild(textArea);
          resolve(null);
        }
      }, 1000);
    });
  } catch (err) {
    console.warn('execCommand paste failed:', err);
    return null;
  }
};

export interface ClipboardContent {
  text: string | null;
  image: Blob | null;
}

/** Read one clipboard snapshot, preserving an image when no useful text is available. */
export const readClipboardContent = async (): Promise<ClipboardContent> => {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      let text: string | null = null;
      let image: Blob | null = null;

      for (const item of items) {
        if (text === null && item.types.includes('text/plain')) {
          const value = await item.getType('text/plain').then(blob => blob.text());
          if (value.trim()) text = value;
        }
        if (image === null) {
          const imageType = item.types.find(type => type.startsWith('image/'));
          if (imageType) image = await item.getType(imageType);
        }
      }

      if (text !== null || image !== null) return { text, image };
    }
  } catch (error) {
    console.warn('Clipboard API read failed:', error);
  }

  return { text: await readFromClipboard(), image: null };
};
