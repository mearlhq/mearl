import { KeyboardEvent } from 'react';

const INDENT = '  '; // 2 spaces

/** 将文本光标处的 offset 映射到所在行的起始 offset */
function lineStart(text: string, offset: number): number {
  const idx = text.lastIndexOf('\n', offset - 1);
  return idx === -1 ? 0 : idx + 1;
}

/** 处理 JSON textarea 的常用编辑快捷键，返回 [newText, newSelStart, newSelEnd] 或 null（不处理） */
export function handleJsonKeyDown(
  e: KeyboardEvent<HTMLTextAreaElement>,
  text: string,
  selStart: number,
  selEnd: number,
): [string, number, number] | null {
  // Tab → 缩进 / Shift+Tab → 反缩进
  if (e.key === 'Tab') {
    e.preventDefault();
    const hasSelection = selStart !== selEnd;

    if (!hasSelection) {
      // 无选区：在光标处插入 2 空格
      if (!e.shiftKey) {
        const next = text.slice(0, selStart) + INDENT + text.slice(selEnd);
        const pos = selStart + INDENT.length;
        return [next, pos, pos];
      }
      // Shift+Tab 无选区：删除光标前最多 2 个空格
      const before = text.slice(0, selStart);
      const trimmed = before.endsWith(INDENT)
        ? before.slice(0, -INDENT.length)
        : before.endsWith(' ')
          ? before.slice(0, -1)
          : null;
      if (trimmed !== null) {
        const next = trimmed + text.slice(selStart);
        const pos = trimmed.length;
        return [next, pos, pos];
      }
      return null;
    }

    // 有选区：对每一行做缩进 / 反缩进
    const lStart = lineStart(text, selStart);
    const selectedText = text.slice(lStart, selEnd);
    const lines = selectedText.split('\n');

    if (!e.shiftKey) {
      const indented = lines.map(l => INDENT + l).join('\n');
      const next = text.slice(0, lStart) + indented + text.slice(selEnd);
      return [next, selStart + INDENT.length, selEnd + INDENT.length * lines.length];
    } else {
      let removed = 0;
      const dedented = lines
        .map((l, i) => {
          if (l.startsWith(INDENT)) {
            if (i === 0) removed += INDENT.length;
            return l.slice(INDENT.length);
          }
          if (l.startsWith(' ')) {
            if (i === 0) removed += 1;
            return l.slice(1);
          }
          return l;
        })
        .join('\n');
      const totalRemoved = selectedText.length - dedented.length;
      const next = text.slice(0, lStart) + dedented + text.slice(selEnd);
      return [next, Math.max(lStart, selStart - removed), selEnd - totalRemoved];
    }
  }

  // Enter → 自动缩进（对齐当前行，{ [ 后额外加一级；若紧跟 } ] 则将其移到上一级新行）
  if (e.key === 'Enter') {
    e.preventDefault();
    const before = text.slice(0, selStart);
    const lStart = lineStart(before, before.length);
    const currentLine = before.slice(lStart);
    const currentIndent = currentLine.match(/^(\s*)/)?.[1] ?? '';
    const lastChar = before.trimEnd().slice(-1);
    const extraIndent = lastChar === '{' || lastChar === '[' ? INDENT : '';
    const after = text.slice(selEnd);
    // 光标后只有行内空白（无换行），紧接着是 } 或 ]
    const inlineWs = after.match(/^[^\S\n]*/)?.[0] ?? '';
    const charAfter = after[inlineWs.length];
    if (extraIndent && (charAfter === '}' || charAfter === ']')) {
      const insert = '\n' + currentIndent + extraIndent;
      const closingInsert = '\n' + currentIndent;
      const next = before + insert + closingInsert + after.slice(inlineWs.length);
      const pos = selStart + insert.length;
      return [next, pos, pos];
    }
    const insert = '\n' + currentIndent + extraIndent;
    const next = before + insert + after;
    const pos = selStart + insert.length;
    return [next, pos, pos];
  }

  return null;
}
