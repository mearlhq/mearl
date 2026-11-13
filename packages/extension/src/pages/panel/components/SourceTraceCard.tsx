import { FC, MouseEvent as ReactMouseEvent, useEffect, useRef, useState } from 'react';
import {
  X,
  ExternalLink,
  Crosshair,
  MapPin,
  AlertCircle,
  Copy,
  Check,
  Sparkles,
  FolderCog,
} from 'lucide-react';
import { clsx } from 'clsx';
import { t } from '../utils/i18n';
import {
  buildEditorUrl,
  formatFieldPath,
  formatLocation,
  getEditorScheme,
  setEditorScheme,
  getProjectRoot,
  setProjectRoot,
  isAbsolutePath,
  resolveAbsoluteFile,
  type EditorScheme,
} from '../utils/sourceLocator';
import { sendMessageSafely } from '../utils/safeChrome';
import { showToast } from '../utils/toast';
import { copyToClipboard } from '../utils/clipboard';
import { buildAgentPrompt } from '../utils/tracePrompt';
import type { TraceResult, FieldMatch, MatchConfidence } from '../hooks/useSourceTracer';

const CONFIDENCE_DOT_CLASS: Record<MatchConfidence, string> = {
  high: 'bg-green-500',
  medium: 'bg-yellow-500',
  low: 'bg-gray-400',
};

interface SourceTraceCardProps {
  tabId: number | null;
  result: TraceResult | null;
  onClose: () => void;
  onJumpToField: (match: FieldMatch) => void;
  onMockAll: (matches: FieldMatch[]) => Promise<number>;
}

function previewValue(v: unknown): string {
  if (typeof v === 'string') {
    if (v.length > 40) return `"${v.slice(0, 40)}…"`;
    return `"${v}"`;
  }
  return String(v);
}

export const SourceTraceCard: FC<SourceTraceCardProps> = ({
  tabId,
  result,
  onClose,
  onJumpToField,
  onMockAll,
}) => {
  const [editorScheme, setEditorSchemeState] = useState<EditorScheme>(() => getEditorScheme());
  const [projectRoot, setProjectRootState] = useState<string>(() => getProjectRoot());
  const [showRootInput, setShowRootInput] = useState(false);
  const [sourceCopied, setSourceCopied] = useState(false);
  const [highlightCounts, setHighlightCounts] = useState<Record<string, number>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [promptCopied, setPromptCopied] = useState(false);
  const [mocking, setMocking] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // 切换到新结果时清空已查询的计数；同时把卡片复位到默认右下角，避免新内容停在上一次拖动位置
  useEffect(() => {
    setHighlightCounts({});
    setPosition(null);
  }, [result]);

  const handleMockAll = async () => {
    if (!result || !result.ok || mocking || result.matches.length === 0) return;
    setMocking(true);
    try {
      const count = await onMockAll(result.matches);
      if (count > 0) {
        showToast(t('traceMockApplied').replace('{n}', String(count)), 'success', 2400);
        // 命中列表里的 request 引用在 mock 后会失效（路径已变成 marker 字符串），
        // 留着卡片再点跳转会落到错误的字段，直接关掉追溯面板
        onClose();
      } else {
        showToast(t('traceMockFailed'), 'error', 1800);
      }
    } catch {
      showToast(t('traceMockFailed'), 'error', 1800);
    } finally {
      setMocking(false);
    }
  };

  const handleHeaderMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    // 点到按钮/下拉/链接等交互元素时不触发拖拽
    if ((e.target as HTMLElement).closest('button, select, a, input, textarea')) return;
    const card = cardRef.current;
    if (!card) return;
    e.preventDefault();
    const rect = card.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = rect.left;
    const startTop = rect.top;
    const width = rect.width;
    const height = rect.height;

    const handleMove = (ev: MouseEvent) => {
      const maxLeft = Math.max(0, window.innerWidth - width);
      const maxTop = Math.max(0, window.innerHeight - height);
      const nextLeft = Math.min(maxLeft, Math.max(0, startLeft + (ev.clientX - startX)));
      const nextTop = Math.min(maxTop, Math.max(0, startTop + (ev.clientY - startY)));
      setPosition({ left: nextLeft, top: nextTop });
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  };

  if (!result) return null;

  const handleSchemeChange = (s: EditorScheme) => {
    setEditorScheme(s);
    setEditorSchemeState(s);
  };

  const handleRootChange = (root: string) => {
    setProjectRoot(root);
    setProjectRootState(getProjectRoot());
  };

  // DevTools 面板本身是 iframe，Chrome 会拦截 iframe 内发起的自定义协议（vscode://）导航，
  // 必须在顶层上下文触发 —— 用 window.open 新开顶层标签页去 handle 协议，避免把面板导航走。
  const handleOpenSource = (e: ReactMouseEvent) => {
    e.preventDefault();
    if (!result?.sourceLocation) return;
    const url = buildEditorUrl(result.sourceLocation, editorScheme, projectRoot);
    window.open(url, '_blank');
  };

  const handleCopySource = async () => {
    if (!result?.sourceLocation) return;
    const loc = result.sourceLocation;
    const file = resolveAbsoluteFile(loc.fileName, projectRoot);
    const text = `${file}:${loc.lineNumber}${loc.columnNumber ? `:${loc.columnNumber}` : ''}`;
    if (await copyToClipboard(text)) {
      setSourceCopied(true);
      setTimeout(() => setSourceCopied(false), 1500);
    }
  };

  const handleCopyPrompt = async () => {
    if (!result) return;
    const text = buildAgentPrompt(result);
    const ok = await copyToClipboard(text);
    if (ok) {
      setPromptCopied(true);
      showToast(t('tracePromptCopied'), 'success', 1800);
      setTimeout(() => setPromptCopied(false), 1500);
    } else {
      showToast(t('copyFailed'), 'error', 1500);
    }
  };

  const handleCopyPath = async (match: FieldMatch) => {
    const text = formatFieldPath(match.path);
    const ok = await copyToClipboard(text);
    if (ok) {
      const key = `${match.request.id}:${match.path.join('.')}`;
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(prev => (prev === key ? null : prev)), 1200);
    } else {
      showToast(t('copyFailed'), 'error', 1500);
    }
  };

  const handleHighlightOnPage = (match: FieldMatch) => {
    if (tabId === null) return;
    const key = `${match.request.id}:${match.path.join('.')}`;
    void sendMessageSafely<{ count?: number }>({
      action: 'traceHighlightField',
      tabId,
      value: match.value,
      ...(typeof result.frameId === 'number' ? { frameId: result.frameId } : {}),
    })
      .then(res => {
        const count = res?.count ?? 0;
        setHighlightCounts(prev => ({ ...prev, [key]: count }));
      })
      .catch(() => {
        showToast(t('traceHighlightFailed'), 'error', 2000);
      });
  };

  const renderError = (reason?: string) => {
    const msg =
      reason === 'no_react_fiber'
        ? t('traceErrorNoFiber')
        : reason === 'element_not_found'
          ? t('traceErrorNotFound')
          : t('traceErrorGeneric');
    return (
      <div className="flex items-start gap-2 text-xs text-text-secondary p-3">
        <AlertCircle size={14} className="text-yellow-500 shrink-0 mt-0.5" />
        <span>{msg}</span>
      </div>
    );
  };

  return (
    <div
      ref={cardRef}
      className={clsx(
        'fixed z-50 w-95 max-w-[calc(100vw-1.5rem)] max-h-[60vh] overflow-hidden flex flex-col',
        'bg-bg-primary border border-border rounded-md shadow-lg text-text-primary',
        position === null && 'bottom-3 right-3',
      )}
      style={position ? { left: position.left, top: position.top } : undefined}
      role="dialog"
    >
      <div
        onMouseDown={handleHeaderMouseDown}
        className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-3 py-1.5 border-b border-border bg-toolbar cursor-move select-none"
      >
        <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap">
          <MapPin size={12} className="text-blue-500" />
          <span>{t('sourceTrace')}</span>
        </div>
        <div className="ml-auto flex items-center gap-1 whitespace-nowrap">
          {result.ok && (
            <button
              onClick={handleCopyPrompt}
              className={clsx(
                'p-1 rounded transition-colors',
                promptCopied
                  ? 'text-green-500'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-blue-500',
              )}
              title={t('traceCopyPrompt')}
            >
              {promptCopied ? <Check size={13} /> : <Sparkles size={13} />}
            </button>
          )}
          {result.ok && result.matches.length > 0 && (
            <button
              onClick={handleMockAll}
              disabled={mocking}
              className={clsx(
                'px-1.5 py-0.5 rounded text-2xs font-medium transition-colors',
                'text-text-secondary hover:bg-bg-hover hover:text-purple-500',
                mocking && 'opacity-50 cursor-not-allowed',
              )}
              title={t('traceMockAll')}
            >
              {t('traceMockBtn')}
            </button>
          )}
          <select
            value={editorScheme}
            onChange={e => handleSchemeChange(e.target.value as EditorScheme)}
            className="text-2xs bg-bg-secondary border border-border rounded px-1 py-0.5 outline-none"
            title={t('traceEditor')}
          >
            <option value="vscode">VS Code</option>
            <option value="cursor">Cursor</option>
            <option value="webstorm">WebStorm</option>
          </select>
          <button
            onClick={() => setShowRootInput(v => !v)}
            className={clsx(
              'p-1 rounded transition-colors',
              showRootInput || projectRoot
                ? 'text-blue-500'
                : 'text-text-secondary hover:bg-bg-hover hover:text-blue-500',
            )}
            title={t('traceProjectRoot')}
          >
            <FolderCog size={13} />
          </button>
          <button
            onClick={onClose}
            className="p-0.5 rounded hover:bg-bg-hover text-text-secondary"
            title={t('close')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {showRootInput && (
        <div className="px-3 py-2 border-b border-border bg-bg-secondary/50 space-y-1">
          <label className="text-2xs text-text-secondary">{t('traceProjectRootHint')}</label>
          <input
            type="text"
            value={projectRoot}
            onChange={e => handleRootChange(e.target.value)}
            placeholder="/Users/you/code/your-project"
            className="w-full text-2xs bg-bg-primary border border-border rounded px-1.5 py-1 outline-none focus:border-blue-500"
            spellCheck={false}
          />
        </div>
      )}

      {!result.ok ? (
        renderError(result.reason)
      ) : (
        <div className="flex flex-col overflow-y-auto">
          <div className="px-3 py-2 border-b border-border space-y-1 text-xs">
            <div className="flex gap-1 items-center">
              <span className="text-text-secondary w-14 shrink-0">{t('traceElement')}</span>
              <code className="text-text-primary truncate" title={result.elementInfo.selector}>
                &lt;{result.elementInfo.tag}&gt;
                {result.elementInfo.text && (
                  <span className="text-text-secondary"> "{result.elementInfo.text}"</span>
                )}
              </code>
            </div>
            <div className="flex gap-1 items-center">
              <span className="text-text-secondary w-14 shrink-0">{t('traceComponent')}</span>
              <code className="text-text-primary">
                {result.componentName ? `<${result.componentName}>` : '—'}
              </code>
            </div>
            <div className="flex gap-1 items-center">
              <span className="text-text-secondary w-14 shrink-0">{t('traceSource')}</span>
              {result.sourceLocation ? (
                // 相对路径且未配置项目根目录时，vscode://file 打不开 —— 显示纯文本 + 引导设置根目录
                !isAbsolutePath(result.sourceLocation.fileName) && !projectRoot ? (
                  <span
                    className="truncate inline-flex items-center gap-1"
                    title={`${result.sourceLocation.fileName}:${result.sourceLocation.lineNumber}`}
                  >
                    <code className="text-text-primary truncate">
                      {formatLocation(result.sourceLocation)}
                    </code>
                    <button
                      onClick={() => setShowRootInput(true)}
                      className="text-2xs text-blue-500 hover:underline shrink-0"
                    >
                      {t('traceSetRoot')}
                    </button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 min-w-0">
                    <a
                      href={buildEditorUrl(result.sourceLocation, editorScheme, projectRoot)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={handleOpenSource}
                      className="text-blue-500 hover:underline truncate inline-flex items-center gap-0.5"
                      title={`${resolveAbsoluteFile(result.sourceLocation.fileName, projectRoot)}:${result.sourceLocation.lineNumber}`}
                    >
                      <span className="truncate">{formatLocation(result.sourceLocation)}</span>
                      <ExternalLink size={10} className="shrink-0" />
                    </a>
                    <button
                      onClick={handleCopySource}
                      className="text-text-secondary hover:text-blue-500 shrink-0"
                      title={t('traceCopyPath')}
                    >
                      {sourceCopied ? <Check size={11} /> : <Copy size={11} />}
                    </button>
                  </span>
                )
              ) : (
                <span className="text-text-secondary text-2xs">
                  {result.reason === 'rax_no_source' ? t('traceRaxNoSource') : t('traceNoSource')}
                </span>
              )}
            </div>
          </div>

          {result.reason === 'no_react_fiber_degraded' && (
            <div className="px-3 py-1.5 text-2xs text-yellow-600 dark:text-yellow-400 bg-yellow-500/5 border-b border-border flex items-start gap-1.5">
              <AlertCircle size={11} className="shrink-0 mt-0.5" />
              <span>{t('traceDegraded')}</span>
            </div>
          )}
          <div className="px-3 py-1.5 text-2xs text-text-secondary border-b border-border">
            {result.matches.length > 0
              ? t('traceMatchCount').replace('{n}', String(result.matches.length))
              : t('traceNoMatch')}
          </div>

          <div className="overflow-y-auto">
            {result.matches.map((m, i) => {
              const key = `${m.request.id}:${m.path.join('.')}`;
              const highlightCount = highlightCounts[key];
              const hasQueried = highlightCount !== undefined;
              return (
                <div
                  key={key + i}
                  role="button"
                  tabIndex={0}
                  onClick={() => onJumpToField(m)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onJumpToField(m);
                    }
                  }}
                  className={clsx(
                    'px-3 py-2 border-b border-border last:border-b-0 cursor-pointer outline-none',
                    'hover:bg-bg-hover focus-visible:bg-bg-hover transition-colors',
                    m.confidence === 'low' && 'opacity-70',
                  )}
                  title={t('traceJumpField')}
                >
                  <div className="flex items-center justify-between gap-1 mb-0.5">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={clsx(
                          'inline-block w-1.5 h-1.5 rounded-full shrink-0',
                          CONFIDENCE_DOT_CLASS[m.confidence],
                        )}
                      />
                      <code className="text-2xs text-text-secondary truncate" title={m.apiName}>
                        {m.apiName}
                      </code>
                    </div>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        handleHighlightOnPage(m);
                      }}
                      className={clsx(
                        'shrink-0 p-0.5 rounded hover:bg-bg-secondary inline-flex items-center gap-0.5',
                        hasQueried
                          ? highlightCount === 0
                            ? 'text-text-secondary hover:text-yellow-500'
                            : 'text-yellow-500'
                          : 'text-text-secondary hover:text-yellow-500',
                      )}
                      title={t('traceHighlightOnPage')}
                    >
                      <Crosshair size={12} />
                      {hasQueried && (
                        <span className="text-2xs font-medium leading-none tabular-nums">
                          {highlightCount === 0 ? '?' : highlightCount}
                        </span>
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-1 text-xs min-w-0">
                    <code
                      className="text-text-primary truncate min-w-0 flex-1"
                      title={formatFieldPath(m.path)}
                      style={{
                        direction: 'rtl',
                        textAlign: 'left',
                        unicodeBidi: 'plaintext',
                      }}
                    >
                      {formatFieldPath(m.path)}
                    </code>
                    <span className="text-text-secondary shrink-0">→</span>
                    <code
                      className="text-green-600 dark:text-green-400 truncate shrink-0 max-w-20"
                      title={String(m.value)}
                    >
                      {previewValue(m.value)}
                    </code>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        handleCopyPath(m);
                      }}
                      className="shrink-0 p-0.5 rounded hover:bg-bg-secondary text-text-secondary hover:text-blue-500"
                      title={t('traceCopyPath')}
                    >
                      {copiedKey === key ? (
                        <Check size={11} className="text-green-500" />
                      ) : (
                        <Copy size={11} />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
