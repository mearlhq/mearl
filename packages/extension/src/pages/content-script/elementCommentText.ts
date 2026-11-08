// 元素文本编辑辅助：评论弹窗允许直接改写元素的可见文字并实时预览。
// 仅当元素是文本类表单控件，或不含子元素（改 textContent 不会破坏 DOM 结构）时才允许写入。

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'number']);

export function canEditElementText(target: Element): boolean {
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type);
  if (target instanceof HTMLTextAreaElement) return true;
  return target.childElementCount === 0;
}

export function readElementText(target: Element): string {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value;
  }
  return target.textContent || '';
}

export function writeElementText(target: Element, text: string): void {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    target.value = text;
    return;
  }
  target.textContent = text;
}
