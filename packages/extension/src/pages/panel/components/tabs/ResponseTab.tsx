import { FC, useMemo, useState, useEffect, useRef, lazy, Suspense } from 'react';
import { CapturedRequest, PinnedField } from '../../types';
import { MockConfigRef } from '../../../../shared/types';
import { t } from '../../utils/i18n';
import { CopyButton } from '../CopyButton';
import { DetailSection } from '../detail/DetailSection';
import { JsonViewer } from '../detail/JsonViewer';
import { PinnedFieldsDisplay } from '../detail/PinnedFieldsDisplay';
import { BodySizeDisplay } from '../detail/SizeDisplay';
import { EditableNumber } from '../EditableNumber';
import { formatJson, detectCodeLanguage } from '../../utils/helpers';
import { SaveTestCaseButton } from '../SaveTestCaseButton';
import { TranslateErrorModal } from '../TranslateErrorModal';
import { useTranslate } from '../../hooks/useTranslate';
import { useLocalStorageBoolean } from '../../hooks/useLocalStorage';
import { clsx } from 'clsx';

const CodeEditor = lazy(() => import('../CodeEditor').then(m => ({ default: m.CodeEditor })));

// --- 代码格式化工具 ---

function formatHtml(html: string): string {
  const voidTags = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i;
  let indent = 0;
  const lines: string[] = [];
  // 预处理：将 <script> 内的 JSON/JS 数据格式化
  const preprocessed = html
    .replace(/\r\n|\r/g, '\n')
    .replace(/<script([^>]*)>([\s\S]*?)<\/script>/gi, (_, attrs, content) => {
      const trimmed = content.trim();
      if (!trimmed) return `<script${attrs}></script>`;
      let formatted = trimmed;
      const varMatch = /^((?:window\.[\w.]*\w|(?:var|let|const)\s+\w+)\s*=\s*)([[{][\s\S]*)$/.exec(
        trimmed,
      );
      if (varMatch) {
        const jsonStr = varMatch[2].replace(/;\s*$/, '');
        try {
          formatted = varMatch[1] + JSON.stringify(JSON.parse(jsonStr), null, 2) + ';';
        } catch {}
      } else if (/^[[{]/.test(trimmed)) {
        try {
          formatted = JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch {}
      }
      return `<script${attrs}>\n${formatted}\n</script>`;
    });
  // 将 HTML 按标签边界切分
  const parts = preprocessed.split(/(<[^>]+>)/);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (/^<\//.test(trimmed)) {
      indent = Math.max(0, indent - 1);
      lines.push('  '.repeat(indent) + trimmed);
    } else if (/^<!/.test(trimmed)) {
      lines.push('  '.repeat(indent) + trimmed);
    } else if (/^</.test(trimmed)) {
      lines.push('  '.repeat(indent) + trimmed);
      const tagName = (trimmed.match(/^<([\w-]+)/) ?? [])[1] ?? '';
      if (!voidTags.test(tagName) && !trimmed.endsWith('/>')) indent++;
    } else {
      // 多行文本内容（如 script 内格式化后的 JSON）按行分别缩进
      for (const cl of trimmed.split('\n')) {
        lines.push('  '.repeat(indent) + cl);
      }
    }
  }
  return lines.join('\n');
}

function formatCss(css: string): string {
  return css
    .replace(/\s*\{\s*/g, ' {\n  ')
    .replace(/;\s*/g, ';\n  ')
    .replace(/\s*\}\s*/g, '\n}\n')
    .replace(/\n[ \t]+\n/g, '\n')
    .trim();
}

type CodeLang = 'html' | 'css' | 'js' | 'text';

function formatCode(content: string, lang: CodeLang): string {
  try {
    if (lang === 'html') return formatHtml(content);
    if (lang === 'css') return formatCss(content);
  } catch {
    // 格式化失败则返回原始内容
  }
  return content;
}

const LANG_LABEL: Record<CodeLang, string> = { html: 'HTML', css: 'CSS', js: 'JS', text: 'TEXT' };
const LANG_COLOR: Record<CodeLang, string> = {
  html: 'bg-indigo-500/20 text-indigo-700 dark:text-indigo-400',
  css: 'bg-sky-500/20 text-sky-700 dark:text-sky-400',
  js: 'bg-yellow-500/20 text-yellow-700 dark:text-yellow-400',
  text: 'bg-gray-500/20 text-gray-600 dark:text-gray-400',
};

// --- HTML 内嵌 JSON 提取 ---

interface HtmlJsonBlock {
  id: string;
  label: string;
  json: any;
  originalJson: string;
}

function applyPathChange(obj: any, path: string[], value: any): any {
  if (path.length === 0) return value;
  const [head, ...tail] = path;
  if (Array.isArray(obj)) {
    const arr = [...obj];
    arr[parseInt(head, 10)] = applyPathChange(arr[parseInt(head, 10)], tail, value);
    return arr;
  }
  return { ...(obj ?? {}), [head]: applyPathChange((obj ?? {})[head], tail, value) };
}

function extractJsonFromHtml(html: string): HtmlJsonBlock[] {
  const blocks: HtmlJsonBlock[] = [];
  const scriptRegex = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  let idx = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = match[1] ?? '';
    const content = (match[2] ?? '').trim();
    if (!content) continue;
    const isJsonType = /type\s*=\s*["'](application|text)\/json["']/i.test(attrs);
    const idAttr = (/id\s*=\s*["']([^"']+)["']/i.exec(attrs) ?? [])[1];
    if (isJsonType || /^[[{]/.test(content)) {
      try {
        const parsed = JSON.parse(content);
        const label = idAttr ? `#${idAttr}` : isJsonType ? 'application/json' : 'JSON';
        blocks.push({ id: `json-${idx++}`, label, json: parsed, originalJson: content });
        continue;
      } catch {}
    }
    const m = /^(?:window\.(\w[\w.]*)|(?:var|let|const)\s+(\w+))\s*=\s*([[{][\s\S]*)/.exec(content);
    if (m) {
      const varName = (m[1] ?? m[2] ?? 'data') as string;
      const jsonStr = (m[3] ?? '').replace(/;\s*$/, '');
      try {
        const parsed = JSON.parse(jsonStr);
        blocks.push({ id: `json-${idx++}`, label: varName, json: parsed, originalJson: jsonStr });
      } catch {}
    }
  }
  return blocks;
}

interface ResponseTabProps {
  request: CapturedRequest;
  parsedResponseData: any;
  collapsedSections: Record<string, boolean>;
  toggleSection: (id: string) => void;
  pinnedFields: PinnedField[];
  onUnpinField: (path: string, apiName: string, type: 'request' | 'response') => void;
  onPinField: (path: string[], value: any, type: 'request' | 'response') => void;
  onReorderPinnedFields?: (
    fromIndex: number,
    toIndex: number,
    apiName: string,
    type: 'request' | 'response',
  ) => void;
  modificationEnabled: boolean;
  expandedPaths: Record<string, boolean>;
  onToggleExpand: (paths: Record<string, boolean>) => void;
  onValueChange: (path: string[], newValue: any) => void;
  onValueChangeForField: (fieldPath: string) => (path: string[], newValue: any) => void;
  onRemoveOverride: () => void;
  onOpenModal: (data: {
    title: string;
    type: 'request' | 'response';
    pathPrefix: string;
    data: any;
  }) => void;
  onDurationChange?: (duration: number | undefined) => void;
  onMockConfigChange?: (config: MockConfigRef) => void;
  onSceneCommentChange?: (comment: string) => void;
  onSetRedirect?: (sourceUrl: string, redirectUrl: string | null) => void;
  requestCasesEnabled?: boolean;
}

export const ResponseTab: FC<ResponseTabProps> = ({
  request,
  parsedResponseData,
  collapsedSections,
  toggleSection,
  pinnedFields,
  onUnpinField,
  onPinField,
  onReorderPinnedFields,
  modificationEnabled,
  expandedPaths,
  onToggleExpand,
  onValueChange,
  onValueChangeForField,
  onRemoveOverride,
  onOpenModal,
  onDurationChange,
  onMockConfigChange,
  onSceneCommentChange,
  onSetRedirect,
  requestCasesEnabled = false,
}) => {
  const [redirectInput, setRedirectInput] = useState('');
  const [codeEditValue, setCodeEditValue] = useState<string | null>(null);
  const [jsonViewMode, toggleJsonViewMode] = useLocalStorageBoolean('requests-doc-jsonview', false);
  const [selectedJsonBlockIdx, setSelectedJsonBlockIdx] = useState(0);
  const [currentBlockState, setCurrentBlockState] = useState<{ json: any; jsonStr: string } | null>(
    null,
  );

  // 切换请求时重置本地编辑状态
  useEffect(() => {
    setRedirectInput('');
    setCodeEditValue(null);
    setSelectedJsonBlockIdx(0);
    setCurrentBlockState(null);
  }, [request.id]);

  // 使用翻译 hook
  const {
    isTranslating,
    translateProgress,
    translateSuccess,
    showErrorModal,
    errorType,
    errorMessage,
    handleTranslate: translate,
    closeErrorModal,
  } = useTranslate({
    onSuccess: translatedData => {
      onValueChange([], translatedData);
    },
  });

  // 计算响应时长显示值：优先使用 responseOverride.duration，其次使用 duration
  const durationValue = useMemo(() => {
    if (request.responseOverride?.duration !== undefined) {
      return request.responseOverride.duration;
    }
    return request.duration;
  }, [request.responseOverride?.duration, request.duration]);

  // 翻译处理函数
  const handleTranslate = async (targetLang: 'en' | 'zh-TW') => {
    const dataToTranslate = request.responseOverride?.modifiedData || parsedResponseData;
    await translate(dataToTranslate, targetLang);
  };

  // 本地维护场景名称输入，避免中文输入法 composition 被外部 state 更新打断
  const [localSceneComment, setLocalSceneComment] = useState(
    request.responseOverride?.sceneComment ?? '',
  );
  const isComposingRef = useRef(false);

  // 外部 sceneComment 变化时同步到本地（仅在非输入状态下同步，避免覆盖正在输入的内容）
  useEffect(() => {
    if (!isComposingRef.current) {
      setLocalSceneComment(request.responseOverride?.sceneComment ?? '');
    }
  }, [request.responseOverride?.sceneComment]);

  // HTML 内嵌 JSON 提取
  const lang = useMemo(
    () => detectCodeLanguage(request.resourceType, request.responseHeaders),
    [request.resourceType, request.responseHeaders],
  );

  // 格式化后的代码内容（formatHtml/formatCss 开销大，只在数据变化时执行一次）
  const formattedContent = useMemo(() => {
    if (!lang || typeof parsedResponseData !== 'string') return null;
    return formatCode(parsedResponseData, lang);
  }, [parsedResponseData, lang]);

  const jsonBlocks = useMemo((): HtmlJsonBlock[] => {
    if (typeof parsedResponseData !== 'string' || lang !== 'html') return [];
    return extractJsonFromHtml(parsedResponseData);
  }, [parsedResponseData, lang]);

  // 当 jsonViewMode / selectedJsonBlockIdx / jsonBlocks 变化时，初始化 currentBlockState
  useEffect(() => {
    if (jsonViewMode && jsonBlocks.length > 0) {
      const idx = Math.min(selectedJsonBlockIdx, jsonBlocks.length - 1);
      const block = jsonBlocks[idx];
      setCurrentBlockState({ json: block.json, jsonStr: block.originalJson });
    }
  }, [jsonViewMode, selectedJsonBlockIdx, jsonBlocks]);

  // 处理 HTML 内嵌 JSON 的编辑
  const handleEmbeddedJsonChange = (path: string[], newValue: any) => {
    if (!currentBlockState) return;
    const newJson = applyPathChange(currentBlockState.json, path, newValue);
    const newJsonStr = JSON.stringify(newJson);
    const currentHtml =
      codeEditValue ?? (typeof parsedResponseData === 'string' ? parsedResponseData : '');
    const pos = currentHtml.indexOf(currentBlockState.jsonStr);
    const newHtml =
      pos === -1
        ? currentHtml
        : currentHtml.slice(0, pos) +
          newJsonStr +
          currentHtml.slice(pos + currentBlockState.jsonStr.length);
    setCurrentBlockState({ json: newJson, jsonStr: newJsonStr });
    setCodeEditValue(newHtml);
    onValueChange([], newHtml);
  };

  return (
    <>
      <div className="p-3">
        {/* 图片资源：直接预览 */}
        {request.resourceType === 'image' && (
          <div className="mb-3 border border-border rounded bg-bg-secondary flex items-center justify-center p-2 min-h-20">
            <img
              src={request.url}
              alt={request.apiName}
              className="max-w-full max-h-64 object-contain"
              title={request.url}
            />
          </div>
        )}
        {request.responseBody ? (
          <DetailSection
            title={
              <div className="flex items-center gap-2">
                <span>{t('responseBody')}</span>
                <BodySizeDisplay
                  headers={request.responseHeaders}
                  size={request.responseBodySize}
                  data={request.responseBody}
                  label={t('responseBody')}
                />
                {/* 修改模式启用时显示响应时长控件 */}
                {modificationEnabled && onDurationChange && (
                  <EditableNumber
                    value={durationValue}
                    onChange={onDurationChange}
                    placeholder={t('responseDurationPlaceholder')}
                    title={t('responseDurationMs')}
                    min={0}
                    step={100}
                    suffix="ms"
                  />
                )}
                {lang && typeof parsedResponseData === 'string' && (
                  <span
                    className={clsx(
                      `inline-flex items-center px-1.5 rounded text-2xs leading-4.5 font-semibold ${LANG_COLOR[lang]}`,
                    )}
                  >
                    {LANG_LABEL[lang]}
                  </span>
                )}
              </div>
            }
            collapsed={!!collapsedSections['response-body']}
            onToggle={() => toggleSection('response-body')}
            action={
              <div className="flex flex-wrap justify-end items-center gap-x-2 gap-y-1 ml-auto">
                {/* 优先展示翻译进度 */}
                {isTranslating ? (
                  <div className="px-2 py-0.5 text-2xs rounded bg-blue-500 text-white">
                    {translateProgress?.phase === 'downloading'
                      ? translateProgress.downloadProgress !== undefined
                        ? `${t('downloadingModel')} ${Math.round(translateProgress.downloadProgress * 100)}%`
                        : t('downloadingModel')
                      : translateProgress && translateProgress.total > 0
                        ? `${t('translating')} ${translateProgress.current}/${translateProgress.total}`
                        : t('translating')}
                  </div>
                ) : (
                  /* 没有翻译进度时才显示重置按钮 */
                  request.responseOverride && (
                    <button
                      onClick={onRemoveOverride}
                      className="px-2 py-0.5 text-2xs rounded transition-colors bg-red-500 text-white hover:opacity-80 cursor-pointer"
                      title={t('resetResponse')}
                    >
                      {t('resetResponse')}
                    </button>
                  )
                )}
                {/* 保存用例 + 场景名称（仅 mtop 接口） */}
                {requestCasesEnabled && request.source !== 'requests' && onMockConfigChange && (
                  <>
                    <SaveTestCaseButton
                      apiName={request.apiName}
                      mockBody={request.responseOverride?.modifiedData ?? parsedResponseData}
                      mockConfig={request.responseOverride?.mockConfig}
                      onMockConfigChange={onMockConfigChange}
                      sceneComment={localSceneComment}
                      persistConfig={!!request.responseOverride}
                      onSaveComplete={() => setLocalSceneComment('')}
                    />
                    <input
                      type="text"
                      value={localSceneComment}
                      onChange={e => setLocalSceneComment(e.target.value)}
                      onCompositionStart={() => {
                        isComposingRef.current = true;
                      }}
                      onCompositionEnd={e => {
                        isComposingRef.current = false;
                        setLocalSceneComment((e.target as HTMLInputElement).value);
                      }}
                      onBlur={e => onSceneCommentChange?.(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      onKeyDown={e => e.stopPropagation()}
                      placeholder={t('sceneNamePlaceholder')}
                      className="h-5 px-1.5 text-2xs rounded border border-border bg-bg-secondary text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:border-blue-500 w-24 min-w-0"
                    />
                  </>
                )}
                {/* 代码资源修改保存按钮 */}
                {modificationEnabled && codeEditValue !== null && (
                  <button
                    onClick={() => {
                      onValueChange([], codeEditValue);
                      setCodeEditValue(null);
                    }}
                    className="px-2 py-0.5 text-2xs rounded bg-blue-500 text-white hover:opacity-80 cursor-pointer"
                  >
                    {t('save')}
                  </button>
                )}
                {/* 重定向输入框（仅非 mtop 资源） */}
                {onSetRedirect && (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={e => {
                      e.preventDefault();
                      const trimmed = redirectInput.trim();
                      onSetRedirect(request.url, trimmed || null);
                    }}
                    onClick={e => e.stopPropagation()}
                  >
                    <input
                      type="text"
                      value={redirectInput}
                      onChange={e => setRedirectInput(e.target.value)}
                      onKeyDown={e => e.stopPropagation()}
                      placeholder={t('redirectToUrlPlaceholder')}
                      title={t('redirectInputTitle')}
                      className="h-5 px-1.5 text-2xs rounded border border-border bg-bg-secondary text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:border-blue-500 w-36 min-w-0"
                    />
                  </form>
                )}
                {jsonBlocks.length > 0 && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      toggleJsonViewMode();
                    }}
                    className={clsx(
                      `px-2 py-0.5 text-2xs rounded transition-colors cursor-pointer ${
                        jsonViewMode
                          ? 'bg-blue-500 text-white'
                          : 'bg-bg-secondary text-text-secondary hover:text-text-primary'
                      }`,
                    )}
                    title={t('extractHtmlJson')}
                  >
                    JSON
                  </button>
                )}
                <CopyButton
                  text={formatJson(request.responseOverride?.modifiedData || request.responseBody)}
                />
              </div>
            }
          >
            {/* 显示关注的响应字段 */}
            {pinnedFields.filter(f => f.type === 'response').length > 0 && (
              <>
                <PinnedFieldsDisplay
                  fields={pinnedFields.filter(f => f.type === 'response')}
                  onUnpin={path => onUnpinField(path, request.apiName, 'response')}
                  onPinField={(path, value) => {
                    onPinField(path, value, 'response');
                  }}
                  onReorder={(fromIndex, toIndex) => {
                    onReorderPinnedFields?.(fromIndex, toIndex, request.apiName, 'response');
                  }}
                  editable={modificationEnabled}
                  expandedPaths={expandedPaths}
                  onToggleExpand={onToggleExpand}
                  onValueChangeForField={onValueChangeForField}
                />
                <div className="mb-1.5 text-xxs font-medium px-1 text-text-primary">
                  {t('fullResponse')}
                </div>
              </>
            )}

            {(() => {
              if (lang && typeof parsedResponseData === 'string') {
                // JSON 视图：提取 HTML 中的内嵌 JSON 展示/编辑
                if (jsonViewMode && jsonBlocks.length > 0) {
                  const activeIdx = Math.min(selectedJsonBlockIdx, jsonBlocks.length - 1);
                  return (
                    <div>
                      {jsonBlocks.length > 1 && (
                        <div className="flex gap-1 flex-wrap mb-2">
                          {jsonBlocks.map((b, i) => (
                            <button
                              key={b.id}
                              onClick={() => setSelectedJsonBlockIdx(i)}
                              className={clsx(
                                `px-1.5 py-0.5 text-2xs rounded border cursor-pointer transition-colors ${
                                  i === activeIdx
                                    ? 'bg-blue-500/20 text-blue-700 dark:text-blue-400 border-blue-500/30'
                                    : 'bg-bg-secondary text-text-secondary border-border hover:text-text-primary'
                                }`,
                              )}
                            >
                              {b.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <JsonViewer
                        json={currentBlockState?.json ?? jsonBlocks[activeIdx].json}
                        onPinField={(path, value) => onPinField(path, value, 'response')}
                        editable={modificationEnabled}
                        onValueChange={handleEmbeddedJsonChange}
                        onTranslate={modificationEnabled ? handleTranslate : undefined}
                        translateSuccess={translateSuccess}
                        onFullscreen={() =>
                          onOpenModal({
                            title: t('responseBody'),
                            type: 'response',
                            pathPrefix: 'html-json-block',
                            data: currentBlockState?.json ?? jsonBlocks[activeIdx].json,
                          })
                        }
                        expandedPaths={expandedPaths}
                        onToggleExpand={onToggleExpand}
                        pathPrefix="html-json-block"
                      />
                    </div>
                  );
                }
                const displayContent = codeEditValue ?? formattedContent ?? parsedResponseData;
                return (
                  <Suspense fallback={null}>
                    <CodeEditor
                      code={displayContent}
                      language={lang}
                      onChange={modificationEnabled ? setCodeEditValue : undefined}
                    />
                  </Suspense>
                );
              }
              return (
                <JsonViewer
                  json={parsedResponseData}
                  onPinField={(path, value) => onPinField(path, value, 'response')}
                  editable={modificationEnabled}
                  onValueChange={onValueChange}
                  onTranslate={modificationEnabled ? handleTranslate : undefined}
                  translateSuccess={translateSuccess}
                  onFullscreen={() =>
                    onOpenModal({
                      title: t('responseBody'),
                      type: 'response',
                      pathPrefix: 'response-body',
                      data: parsedResponseData,
                    })
                  }
                  expandedPaths={expandedPaths}
                  onToggleExpand={onToggleExpand}
                  pathPrefix="response-body"
                />
              );
            })()}
          </DetailSection>
        ) : (
          !request.responseBody &&
          request.resourceType !== 'image' && (
            <DetailSection
              title={
                <div className="flex items-center gap-2">
                  <span>{t('responseBody')}</span>
                  {modificationEnabled && onDurationChange && (
                    <EditableNumber
                      value={durationValue}
                      onChange={onDurationChange}
                      placeholder={t('responseDurationPlaceholder')}
                      title={t('responseDurationMs')}
                      min={0}
                      step={100}
                      suffix="ms"
                    />
                  )}
                </div>
              }
              collapsed={!!collapsedSections['response-body']}
              onToggle={() => toggleSection('response-body')}
              action={
                modificationEnabled && request.responseOverride ? (
                  <button
                    onClick={onRemoveOverride}
                    className="px-2 py-0.5 text-2xs rounded transition-colors bg-red-500 text-white hover:opacity-80 cursor-pointer ml-auto"
                    title={t('resetResponse')}
                  >
                    {t('resetResponse')}
                  </button>
                ) : undefined
              }
            >
              {modificationEnabled ? (
                <JsonViewer
                  json={parsedResponseData ?? {}}
                  onPinField={(path, value) => onPinField(path, value, 'response')}
                  editable
                  onValueChange={onValueChange}
                  onFullscreen={() =>
                    onOpenModal({
                      title: t('responseBody'),
                      type: 'response',
                      pathPrefix: 'response-body',
                      data: parsedResponseData ?? {},
                    })
                  }
                  expandedPaths={expandedPaths}
                  onToggleExpand={onToggleExpand}
                  pathPrefix="response-body"
                />
              ) : (
                <div className="flex items-center justify-center h-16 text-text-secondary text-xs">
                  {t('noResponseBody')}
                </div>
              )}
            </DetailSection>
          )
        )}
      </div>

      {/* 翻译错误弹窗 */}
      <TranslateErrorModal
        isOpen={showErrorModal}
        onClose={closeErrorModal}
        errorType={errorType}
        errorMessage={errorMessage}
      />
    </>
  );
};
