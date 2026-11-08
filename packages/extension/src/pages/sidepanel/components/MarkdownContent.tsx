import { Fragment, type ReactNode } from 'react';
import Prism from '../../panel/components/prismSetup';
import 'prismjs/components/prism-markup';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-css';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-jsx';
import 'prismjs/components/prism-tsx';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-markdown';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-python';
import { ChatVisualization, parseChatVisualization } from './ChatVisualization';

interface MarkdownContentProps {
  children: string;
  inverse?: boolean;
  visualizations?: boolean;
}

type TableAlignment = 'left' | 'center' | 'right';

const INLINE_PATTERN =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:https?:\/\/|mailto:)[^)\s]+\)|\*[^*\n]+\*)/g;

const CODE_HIGHLIGHT_LIMIT = 50_000;
const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  css: 'css',
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  json: 'json',
  json5: 'json',
  sh: 'bash',
  shell: 'bash',
  bash: 'bash',
  zsh: 'bash',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  py: 'python',
  python: 'python',
};

function highlightCode(code: string, languageHint: string) {
  if (!languageHint || code.length > CODE_HIGHLIGHT_LIMIT) return null;

  const language = PRISM_LANGUAGE_ALIASES[languageHint.toLowerCase()];
  const grammar = language ? Prism.languages[language] : undefined;
  if (!language || !grammar) return null;

  return {
    html: Prism.highlight(code, grammar, language),
    language,
  };
}

function inlineNodes(text: string, keyPrefix: string, inverse: boolean): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text.slice(lastIndex, index));

    const token = match[0];
    const key = `${keyPrefix}-${tokenIndex}`;
    tokenIndex += 1;

    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className={`rounded px-1 py-0.5 font-mono text-[0.92em] ${
            inverse ? 'bg-black/15 text-white' : 'bg-bg-primary text-text-primary'
          }`}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      nodes.push(
        link ? (
          <a
            key={key}
            href={link[2]}
            target="_blank"
            rel="noreferrer"
            className={`underline underline-offset-2 ${
              inverse
                ? 'text-white decoration-white/60 hover:decoration-white'
                : 'text-blue-600 decoration-blue-500/40 hover:decoration-blue-500 dark:text-blue-400'
            }`}
          >
            {link[1]}
          </a>
        ) : (
          token
        ),
      );
    } else {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    }
    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function inlineWithBreaks(text: string, keyPrefix: string, inverse: boolean): ReactNode[] {
  return text
    .split('\n')
    .flatMap((line, index) => [
      ...(index > 0 ? [<br key={`${keyPrefix}-break-${index}`} />] : []),
      <Fragment key={`${keyPrefix}-line-${index}`}>
        {inlineNodes(line, `${keyPrefix}-line-${index}`, inverse)}
      </Fragment>,
    ]);
}

function hasUnescapedTrailingPipe(value: string): boolean {
  if (!value.endsWith('|')) return false;

  let backslashCount = 0;
  for (let index = value.length - 2; index >= 0 && value[index] === '\\'; index -= 1) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 0;
}

function splitTableRow(line: string): string[] | null {
  let source = line.trim();
  const leadingPipe = source.startsWith('|');
  const trailingPipe = hasUnescapedTrailingPipe(source);
  if (leadingPipe) source = source.slice(1);
  if (trailingPipe) source = source.slice(0, -1);

  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  let inCode = false;
  let structuralPipes = leadingPipe || trailingPipe ? 1 : 0;

  for (const character of source) {
    if (escaped) {
      cell += character === '|' ? '|' : `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '`') {
      inCode = !inCode;
      cell += character;
      continue;
    }
    if (character === '|' && !inCode) {
      cells.push(cell.trim());
      cell = '';
      structuralPipes += 1;
      continue;
    }
    cell += character;
  }

  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return structuralPipes > 0 ? cells : null;
}

function parseTableAlignments(headerLine: string, delimiterLine: string): TableAlignment[] | null {
  const headerCells = splitTableRow(headerLine);
  const delimiterCells = splitTableRow(delimiterLine);
  if (
    !headerCells ||
    !delimiterCells ||
    headerCells.length === 0 ||
    headerCells.length !== delimiterCells.length
  ) {
    return null;
  }

  const alignments: TableAlignment[] = [];
  for (const cell of delimiterCells) {
    if (!/^:?-{3,}:?$/.test(cell)) return null;
    alignments.push(
      cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left',
    );
  }
  return alignments;
}

function normalizeTableRow(line: string, columnCount: number): string[] | null {
  const cells = splitTableRow(line);
  if (!cells) return null;
  if (cells.length < columnCount) {
    return [...cells, ...Array<string>(columnCount - cells.length).fill('')];
  }
  if (cells.length === columnCount) return cells;
  return [...cells.slice(0, columnCount - 1), cells.slice(columnCount - 1).join(' | ')];
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    index + 1 < lines.length && parseTableAlignments(lines[index]!, lines[index + 1]!) !== null
  );
}

function isBlockStart(lines: string[], index: number, visualizations: boolean): boolean {
  const line = lines[index]!;
  return (
    isTableStart(lines, index) ||
    (visualizations && parseChatVisualization(line) !== null) ||
    /^```/.test(line) ||
    /^#{1,3}\s+/.test(line) ||
    /^>\s?/.test(line) ||
    /^[-*+]\s+/.test(line) ||
    /^\d+[.)]\s+/.test(line) ||
    /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}

export function MarkdownContent({
  children,
  inverse = false,
  visualizations = false,
}: MarkdownContentProps) {
  const lines = children.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const key = `markdown-block-${blockIndex}`;
    blockIndex += 1;

    const visualization = visualizations ? parseChatVisualization(line) : null;
    if (visualization) {
      blocks.push(<ChatVisualization key={`${key}-${visualization.path}`} {...visualization} />);
      index += 1;
      continue;
    }

    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const codeText = code.join('\n');
      const highlighted = highlightCode(codeText, fence[1] ?? '');
      blocks.push(
        <pre
          key={key}
          className="prism-highlight my-2 max-w-full overflow-x-auto rounded-lg bg-bg-primary px-3 py-2 font-mono text-[11px] leading-5 text-text-primary"
        >
          {highlighted ? (
            <code
              className={`language-${highlighted.language}`}
              data-language={fence[1] || undefined}
              dangerouslySetInnerHTML={{ __html: highlighted.html }}
            />
          ) : (
            <code data-language={fence[1] || undefined}>{codeText}</code>
          )}
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1]!.length;
      const content = inlineNodes(heading[2]!, `${key}-heading`, inverse);
      const className = `font-semibold ${level === 1 ? 'text-sm' : 'text-xs'} ${
        blocks.length > 0 ? 'mt-2' : ''
      } mb-1`;
      blocks.push(
        level === 1 ? (
          <h1 key={key} className={className}>
            {content}
          </h1>
        ) : level === 2 ? (
          <h2 key={key} className={className}>
            {content}
          </h2>
        ) : (
          <h3 key={key} className={className}>
            {content}
          </h3>
        ),
      );
      index += 1;
      continue;
    }

    const tableAlignments =
      index + 1 < lines.length ? parseTableAlignments(line, lines[index + 1]!) : null;
    if (tableAlignments) {
      const headers = splitTableRow(line)!;
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.trim()) {
        const row = normalizeTableRow(lines[index]!, headers.length);
        if (!row) break;
        rows.push(row);
        index += 1;
      }

      const alignmentClass = (alignment: TableAlignment) =>
        alignment === 'center' ? 'text-center' : alignment === 'right' ? 'text-right' : 'text-left';
      const cellBorderClass = inverse
        ? 'border-r border-white/15 last:border-r-0'
        : 'border-r border-border last:border-r-0';
      blocks.push(
        <div
          key={key}
          className={`my-2 max-w-full overflow-x-auto rounded-lg border ${
            inverse ? 'border-white/25' : 'border-border'
          }`}
        >
          <table className="w-max min-w-full border-collapse text-[11px] leading-5">
            <thead className={inverse ? 'bg-white/10' : 'bg-bg-primary'}>
              <tr className={inverse ? 'border-b border-white/25' : 'border-b border-border'}>
                {headers.map((header, cellIndex) => (
                  <th
                    key={`${key}-header-${cellIndex}`}
                    scope="col"
                    className={`whitespace-nowrap px-2 py-1.5 align-top font-semibold ${cellBorderClass} ${alignmentClass(
                      tableAlignments[cellIndex]!,
                    )}`}
                  >
                    {inlineNodes(header, `${key}-header-${cellIndex}`, inverse)}
                  </th>
                ))}
              </tr>
            </thead>
            {rows.length > 0 && (
              <tbody className={inverse ? 'divide-y divide-white/15' : 'divide-y divide-border'}>
                {rows.map((row, rowIndex) => (
                  <tr key={`${key}-row-${rowIndex}`}>
                    {row.map((cell, cellIndex) => (
                      <td
                        key={`${key}-row-${rowIndex}-cell-${cellIndex}`}
                        className={`whitespace-nowrap px-2 py-1.5 align-top ${cellBorderClass} ${alignmentClass(
                          tableAlignments[cellIndex]!,
                        )}`}
                      >
                        {inlineNodes(cell, `${key}-row-${rowIndex}-cell-${cellIndex}`, inverse)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            )}
          </table>
        </div>,
      );
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index]!)) {
        quote.push(lines[index]!.replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={key}
          className={`my-1 border-l-2 pl-2 ${
            inverse ? 'border-white/40 text-white/85' : 'border-border text-text-secondary'
          }`}
        >
          {inlineWithBreaks(quote.join('\n'), `${key}-quote`, inverse)}
        </blockquote>,
      );
      continue;
    }

    const unordered = line.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(/^[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]!);
        index += 1;
      }
      blocks.push(
        <ul key={key} className="my-1 list-disc space-y-0.5 pl-5">
          {items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>
              {inlineNodes(item, `${key}-item-${itemIndex}`, inverse)}
            </li>
          ))}
        </ul>,
      );
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(/^\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(item[1]!);
        index += 1;
      }
      blocks.push(
        <ol key={key} className="my-1 list-decimal space-y-0.5 pl-5">
          {items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>
              {inlineNodes(item, `${key}-item-${itemIndex}`, inverse)}
            </li>
          ))}
        </ol>,
      );
      continue;
    }

    if (/^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(
        <hr key={key} className={inverse ? 'my-2 border-white/25' : 'my-2 border-border'} />,
      );
      index += 1;
      continue;
    }

    const paragraph = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !isBlockStart(lines, index, visualizations)) {
      paragraph.push(lines[index]!);
      index += 1;
    }
    blocks.push(
      <p key={key} className="my-1 first:mt-0 last:mb-0">
        {inlineWithBreaks(paragraph.join('\n'), `${key}-paragraph`, inverse)}
      </p>,
    );
  }

  return <div className="min-w-0 break-words [overflow-wrap:anywhere]">{blocks}</div>;
}
