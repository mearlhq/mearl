/**
 * 通用的"向页面元素输入文本"逻辑，供 extension（chrome.scripting / chrome.debugger）
 * 与 native-host（CDP Runtime.evaluate）共享。
 *
 * ⚠️ 重要约束：本函数会被 .toString() 序列化后注入到目标页面执行，因此：
 *   1. 不能引用任何外部作用域的变量或 import
 *   2. 不能使用 async / generator / 装饰器 / enum / 私有字段（#x）等会引入 TS helper 的语法
 *   3. 所有依赖必须通过参数显式传入
 *
 * 支持三类目标：
 *   - <input>
 *   - <textarea>
 *   - contenteditable 元素（ChatGPT / Notion / Lark / Gemini 等富文本输入）
 *
 * 对于 <input>/<textarea>，使用 prototype 上的原生 setter 写值，并按
 *   beforeinput → input → change 顺序派发事件，兼容 React/Vue/Preact 受控组件
 *   以及 Slate/Lexical/antd 等监听 beforeinput 的框架。
 *
 * 对于 contenteditable，优先 execCommand('insertText')（最兼容富文本框架的写法），
 *   失败时降级到 textContent 直接拼接，并补发 beforeinput / input 事件。
 *   不派发 change（contenteditable 标准里没有 change）。
 */
export function typeIntoElement(
  el: Element | null,
  inputValue: string,
  shouldClear: boolean,
): { typed: boolean; tag: string; error?: string } {
  if (!el) return { typed: false, tag: '', error: 'Element is null' };
  if (!el.isConnected) {
    return { typed: false, tag: '', error: 'Element is detached from the document' };
  }

  const tagName = el.tagName ? el.tagName.toLowerCase() : '';
  const isInput = el instanceof HTMLInputElement;
  const isTextArea = el instanceof HTMLTextAreaElement;
  const isFormField = isInput || isTextArea;
  const htmlEl = el as HTMLElement;
  const isEditable =
    !isFormField && (htmlEl.isContentEditable || el.getAttribute('contenteditable') === 'true');

  if (!isFormField && !isEditable) {
    return {
      typed: false,
      tag: tagName,
      error: 'Element <' + tagName + '> is neither an input/textarea nor contenteditable',
    };
  }

  if (isFormField) {
    const f = el as HTMLInputElement | HTMLTextAreaElement;
    if (f.disabled) return { typed: false, tag: tagName, error: 'Element is disabled' };
    if ((f as HTMLInputElement).readOnly)
      return { typed: false, tag: tagName, error: 'Element is readOnly' };
  }

  htmlEl.scrollIntoView({ block: 'center', behavior: 'instant' });
  htmlEl.focus();

  // ── 1. <input> / <textarea> ────────────────────────────────────────────
  if (isFormField) {
    const f = el as HTMLInputElement | HTMLTextAreaElement;
    // 必须按目标元素的具体类型挑 prototype，HTMLInputElement 的 setter
    // 对 HTMLTextAreaElement 调用会抛 TypeError，反之亦然。
    const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const setVal = (v: string) => {
      if (nativeSetter) nativeSetter.call(f, v);
      else f.value = v;
    };

    if (shouldClear && f.value !== '') {
      setVal('');
      f.dispatchEvent(new Event('input', { bubbles: true }));
    }

    setVal(inputValue);
    f.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: inputValue,
        inputType: 'insertText',
      }),
    );
    f.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: inputValue, inputType: 'insertText' }),
    );
    f.dispatchEvent(new Event('change', { bubbles: true }));

    return { typed: true, tag: tagName };
  }

  // ── 2. contenteditable ────────────────────────────────────────────────
  const selection = window.getSelection();

  if (shouldClear) {
    // 全选当前内容，再触发 delete，让框架内部状态同步
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(htmlEl);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    let cleared: boolean;
    try {
      cleared = document.execCommand('delete');
    } catch {
      cleared = false;
    }
    if (!cleared) htmlEl.textContent = '';
  } else if (selection) {
    // 把光标放到末尾，避免 insertText 插到开头
    const range = document.createRange();
    range.selectNodeContents(htmlEl);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  htmlEl.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      data: inputValue,
      inputType: 'insertText',
    }),
  );

  let inserted: boolean;
  try {
    inserted = document.execCommand('insertText', false, inputValue);
  } catch {
    inserted = false;
  }
  if (!inserted) htmlEl.textContent = (htmlEl.textContent ?? '') + inputValue;

  htmlEl.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: inputValue, inputType: 'insertText' }),
  );

  return { typed: true, tag: tagName };
}
