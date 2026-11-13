import { FC, useEffect, useRef, useState } from 'react';
import { Crosshair } from 'lucide-react';
import { clsx } from 'clsx';
import { PinnedEventField, RumEvent } from '../types';
import { t } from '../utils/i18n';
import { TabPanel } from './TabPanel';
import { DetailSection } from './detail/DetailSection';
import { DetailRow } from './detail/DetailRow';
import { DetailRowUrl } from './detail/DetailRowUrl';
import { JsonViewer } from './detail/JsonViewer';
import { PinnedFieldsDisplay } from './detail/PinnedFieldsDisplay';
import { SpmQueryParam } from './detail/SpmQueryParam';
import { useLocalStorage } from '../hooks/useLocalStorage';
import { highlightSpmInPage, inspectSpmInElements } from '../utils/spmHighlight';
import { eventFieldToPinnedField } from '../utils/helpers';
import { resolveAplusSpm, type AplusSpmResolution } from '../utils/aplusSpm';

const COLLAPSE_KEY = 'rum-detail-collapsed';
const ACTIVE_TAB_KEY = 'rum-detail-active-tab';

const VALIDATION_LEVEL_COLORS = {
  success: 'text-green-600 dark:text-green-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

interface HotzoneButtonProps {
  spm: string;
  hkey: string;
  result: number | null | undefined;
  onHighlight: (spm: string, key: string) => void;
}

const HotzoneButton: FC<HotzoneButtonProps> = ({ spm, result, onHighlight, hkey }) => {
  const label = t('aplusHighlightButtonTitle');
  return (
    <button
      onClick={() => onHighlight(spm, hkey)}
      title={label}
      aria-label={label}
      className="shrink-0 flex items-center gap-0.5 px-1.5 py-0.5 rounded text-2xs cursor-pointer transition-colors bg-bg-secondary text-text-secondary hover:bg-amber-500/20 hover:text-amber-600 dark:hover:text-amber-400"
    >
      <Crosshair size={11} />
      {result !== null && result !== undefined && <span>{result > 0 ? result : '?'}</span>}
    </button>
  );
};

interface RumEventDetailProps {
  event: RumEvent | null;
  tabId: number | null;
  trackingMetadataEnabled?: boolean;
  pinnedEventFields?: PinnedEventField[];
  onPinEventField?: (path: string[], value: any) => void;
  onUnpinEventField?: (path: string, eventSubType: string) => void;
  onReorderPinnedEventFields?: (fromIndex: number, toIndex: number, eventSubType: string) => void;
}

export const EventDetail: FC<RumEventDetailProps> = ({
  event,
  tabId,
  trackingMetadataEnabled = false,
  pinnedEventFields = [],
  onPinEventField,
  onUnpinEventField,
  onReorderPinnedEventFields,
}) => {
  const [activeTab, setActiveTab] = useLocalStorage<string>(ACTIVE_TAB_KEY, 'event');
  const [collapsedSections, setCollapsedSections] = useLocalStorage<Record<string, boolean>>(
    COLLAPSE_KEY,
    {},
  );
  const [expandedPaths, setExpandedPaths] = useState<Record<string, boolean>>({});
  const [hotzoneResults, setHotzoneResults] = useState<Record<string, number | null>>({});
  const hotzoneRevision = useRef(0);
  const tabContentRef = useRef<HTMLDivElement>(null);
  const devtoolsNetwork = chrome.devtools?.network;
  const locateTitle = devtoolsNetwork
    ? t('aplusHighlightOnPageTitle')
    : t('aplusHighlightButtonTitle');

  const isAplus = event?.source === 'aplus';
  // i18n-tracker 转换后的 rum EXP/CLK 事件也需要展示 aplus 风格的详情
  const isAplusLike =
    isAplus || (event?.source === 'rum' && ['EXP', 'CLK'].includes(event?.event_type ?? ''));
  const [resolvedPoint, setResolvedPoint] = useState<{
    event: RumEvent;
    point: AplusSpmResolution;
  } | null>(null);
  useEffect(() => {
    let current = true;
    if (event && isAplusLike && !event.point) {
      void resolveAplusSpm(event.event_type, event._raw)
        .then(point => {
          if (current) setResolvedPoint({ event, point });
        })
        .catch(console.warn);
    }
    return () => {
      current = false;
    };
  }, [event, isAplusLike]);
  const { mainSpm, highlightSpm } = isAplusLike
    ? (event?.point ??
      (resolvedPoint?.event === event ? resolvedPoint.point : { mainSpm: '', highlightSpm: '' }))
    : { mainSpm: '', highlightSpm: '' };
  const displaySpm = mainSpm;

  useEffect(() => {
    setExpandedPaths({});
    setHotzoneResults({});
    const revision = ++hotzoneRevision.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const highlightMain = () => {
      if (tabId === null || !highlightSpm) return;
      highlightSpmInPage(tabId, highlightSpm, found => {
        if (hotzoneRevision.current === revision) {
          setHotzoneResults(prev => ({ ...prev, 'main-spm': found }));
        }
      });
    };
    highlightMain();
    const onNavigated = () => {
      clearTimeout(timer);
      timer = setTimeout(highlightMain, 500);
    };
    const navigation = tabId !== null && highlightSpm ? devtoolsNetwork?.onNavigated : undefined;
    navigation?.addListener(onNavigated);
    return () => {
      hotzoneRevision.current++;
      clearTimeout(timer);
      navigation?.removeListener(onNavigated);
    };
  }, [event?.id, highlightSpm, tabId, devtoolsNetwork]);

  const toggleSection = (id: string) => {
    setCollapsedSections(prev => ({ ...prev, [id]: !prev[id] }));
  };

  const handleToggleExpand = (paths: Record<string, boolean>) => {
    setExpandedPaths(prev => ({ ...prev, ...paths }));
  };

  const handleHighlight = (spm: string, key: string) => {
    if (tabId === null) return;
    const revision = hotzoneRevision.current;
    setHotzoneResults(prev => ({ ...prev, [key]: null }));
    highlightSpmInPage(tabId, spm, found => {
      if (hotzoneRevision.current === revision) {
        setHotzoneResults(prev => ({ ...prev, [key]: found }));
      }
    });
  };

  const handleLocate = (spm: string, key: string) => {
    if (devtoolsNetwork) inspectSpmInElements(spm);
    else handleHighlight(spm, key);
  };

  const getSpmJumpClass = (canLocate: boolean, mono = false) => {
    return clsx(mono ? 'break-all font-mono' : 'break-all', {
      'cursor-pointer border-b border-dashed border-text-secondary hover:border-solid': canLocate,
    });
  };

  if (!event) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-bg-primary text-text-secondary">
        <div className="text-center text-xs">
          <p>{t('rumSelectEvent')}</p>
        </div>
      </div>
    );
  }

  const { _raw, _context } = event;

  const { timing_data, expdata, _path, _url, ...displayRaw } = _raw;
  const { bizArgs: aplusBizArgs, ...displayRawWithoutBizArgs } = displayRaw;
  const eventFields = isAplusLike ? displayRawWithoutBizArgs : displayRaw;
  const aplusExpdata: any[] = Array.isArray(expdata) ? expdata : [];

  let parsedTiming: any = undefined;
  if (timing_data) {
    try {
      parsedTiming = JSON.parse(timing_data);
    } catch {
      parsedTiming = timing_data;
    }
  }

  const canHighlightMain = tabId !== null && Boolean(highlightSpm);
  const canLocateMain = canHighlightMain && (!devtoolsNetwork || hotzoneResults['main-spm'] !== 0);

  const tabs = [
    {
      id: 'event',
      label: 'Event Data',
      content: (
        <div className="p-3">
          {/* 基本信息 */}
          <DetailSection
            title={t('basicInfo')}
            collapsed={!!collapsedSections['basic-info']}
            onToggle={() => toggleSection('basic-info')}
          >
            {event.source && <DetailRow label={t('trackingSource')} value={event.source} />}
            <DetailRow label={t('rumEventType')} value={event.event_type} />
            {event.type && <DetailRow label={t('rumSubType')} value={event.type} />}
            {event.method && <DetailRow label={t('requestMethod')} value={event.method} />}
            {event.status_code !== undefined && (
              <DetailRow label={t('statusCode')} value={String(event.status_code)} />
            )}
            {event.success !== undefined && (
              <DetailRow
                label={t('rumResult')}
                value={
                  <span className={event.success === 0 ? 'text-red-600' : 'text-green-600'}>
                    {event.success === 0 ? t('rumFailed') : t('rumSuccess')}
                  </span>
                }
              />
            )}
            {event.duration !== undefined && (
              <DetailRow label={t('duration')} value={`${Math.round(event.duration)}ms`} />
            )}
            <DetailRow label={t('timestamp')} value={event.batchTimestamp} />
            {/* aplus / i18n-tracker 主 SPM */}
            {isAplusLike && displaySpm && (
              <DetailRow
                label="SPM"
                showCopy
                copyText={displaySpm}
                value={
                  <div className="flex items-center gap-1.5">
                    <span
                      onClick={
                        canLocateMain ? () => handleLocate(highlightSpm, 'main-spm') : undefined
                      }
                      title={canLocateMain ? locateTitle : undefined}
                      className={getSpmJumpClass(canLocateMain)}
                    >
                      {displaySpm}
                    </span>
                    {canHighlightMain && (
                      <HotzoneButton
                        spm={highlightSpm}
                        hkey="main-spm"
                        result={hotzoneResults['main-spm']}
                        onHighlight={handleHighlight}
                      />
                    )}
                  </div>
                }
              />
            )}
            {/* SPM 中文名称（手动查询） */}
            {trackingMetadataEnabled && isAplus && mainSpm && <SpmQueryParam spmValue={mainSpm} />}
            {/* URL */}
            {event._context.requestUrl && (
              <DetailRowUrl label="URL" value={event._context.requestUrl} />
            )}
          </DetailSection>

          {/* aplus / i18n-tracker 校验结果 */}
          {isAplusLike && event.validation && (
            <DetailSection
              title={
                event.validation.level === 'success' ? (
                  t('aplusValidation')
                ) : (
                  <span className={VALIDATION_LEVEL_COLORS[event.validation.level]}>
                    {t('aplusValidation')} ({event.validation.issues.length})
                  </span>
                )
              }
              collapsed={!!collapsedSections['aplus-validation']}
              onToggle={() => toggleSection('aplus-validation')}
            >
              {event.validation.level === 'success' ? (
                <div className="space-y-0.5">
                  {event.validation.checks && event.validation.checks.length > 0 ? (
                    <ul className="space-y-0.5">
                      {event.validation.checks.map((check, i) => (
                        <li
                          key={i}
                          className="flex items-start gap-1.5 text-xxs px-1 py-0.5 text-text-secondary font-mono"
                        >
                          <span className="shrink-0 text-green-500 mt-px">✓</span>
                          <span className="break-all">{check}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="px-1 py-1 text-xxs text-green-600 dark:text-green-400">
                      {t('aplusValidationPass')}
                    </p>
                  )}
                </div>
              ) : (
                <ul className="space-y-1">
                  {event.validation.issues.map((issue, i) => (
                    <li
                      key={i}
                      className={clsx(
                        'flex items-start gap-1.5 text-xxs px-1 py-0.5',
                        issue.level === 'error'
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-amber-600 dark:text-amber-400',
                      )}
                    >
                      <span className="shrink-0 mt-px">{issue.level === 'error' ? '✕' : '!'}</span>
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DetailSection>
          )}

          {isAplusLike && aplusBizArgs !== undefined && (
            <DetailSection
              title="bizArgs"
              collapsed={!!collapsedSections['aplus-biz-args']}
              onToggle={() => toggleSection('aplus-biz-args')}
            >
              <JsonViewer
                json={aplusBizArgs}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                pathPrefix="aplus-biz-args"
                defaultExpandDepth={1}
              />
            </DetailSection>
          )}

          {/* aplus / i18n-tracker expdata — 自定义渲染，支持每条 SPM 热区高亮 */}
          {isAplusLike && aplusExpdata.length > 0 && (
            <DetailSection
              title={t('aplusExpdata')}
              collapsed={!!collapsedSections['aplus-expdata']}
              onToggle={() => toggleSection('aplus-expdata')}
            >
              {aplusExpdata.map((item: any, i: number) => {
                const expKey = `exp-${i}`;
                const canHighlightExp = tabId !== null;
                const canLocateExp =
                  canHighlightExp && (!devtoolsNetwork || hotzoneResults[expKey] !== 0);
                let bizArgs: unknown;
                let otherExargs = item.exargs;
                if (otherExargs && typeof otherExargs === 'object' && !Array.isArray(otherExargs)) {
                  ({ bizArgs, ...otherExargs } = otherExargs);
                }

                return (
                  <div key={i} className="mb-1 last:mb-0">
                    {item.spm && (
                      <DetailRow
                        label="spm"
                        showCopy
                        copyText={item.spm}
                        value={
                          <div className="flex items-center gap-1.5">
                            <span
                              onClick={
                                canLocateExp ? () => handleLocate(item.spm, expKey) : undefined
                              }
                              title={canLocateExp ? locateTitle : undefined}
                              className={getSpmJumpClass(canLocateExp, true)}
                            >
                              {item.spm}
                            </span>
                            {canHighlightExp && (
                              <HotzoneButton
                                spm={item.spm}
                                hkey={expKey}
                                result={hotzoneResults[expKey]}
                                onHighlight={handleHighlight}
                              />
                            )}
                          </div>
                        }
                      />
                    )}
                    {item.scm !== undefined && (
                      <DetailRow
                        label="scm"
                        value={
                          <span className={clsx('font-mono', !item.scm && 'text-text-secondary')}>
                            {item.scm || '(empty)'}
                          </span>
                        }
                      />
                    )}
                    {bizArgs !== undefined && (
                      <DetailRow
                        label="bizArgs"
                        value={
                          <JsonViewer
                            json={bizArgs}
                            expandedPaths={expandedPaths}
                            onToggleExpand={handleToggleExpand}
                            pathPrefix={`${expKey}-biz-args`}
                            defaultExpandDepth={1}
                          />
                        }
                      />
                    )}
                    {otherExargs && Object.keys(otherExargs).length > 0 && (
                      <DetailRow
                        label="exargs"
                        value={
                          <JsonViewer
                            json={otherExargs}
                            expandedPaths={expandedPaths}
                            onToggleExpand={handleToggleExpand}
                            pathPrefix={`exp-${i}-exargs`}
                            defaultExpandDepth={1}
                          />
                        }
                      />
                    )}
                  </div>
                );
              })}
            </DetailSection>
          )}

          {/* 事件字段 */}
          <DetailSection
            title={t('rumEventFields')}
            collapsed={!!collapsedSections['event-fields']}
            onToggle={() => toggleSection('event-fields')}
          >
            {/* 关注字段 */}
            {pinnedEventFields.length > 0 && (
              <div className="mt-2">
                <PinnedFieldsDisplay
                  fields={pinnedEventFields.map(eventFieldToPinnedField)}
                  onUnpin={path => {
                    const field = pinnedEventFields.find(f => f.path === path);
                    if (field && onUnpinEventField) {
                      onUnpinEventField(path, field.eventSubType);
                    }
                  }}
                  onPinField={onPinEventField}
                  expandedPaths={expandedPaths}
                  onToggleExpand={handleToggleExpand}
                  onReorder={
                    onReorderPinnedEventFields && pinnedEventFields.length > 0
                      ? (from, to) => {
                          onReorderPinnedEventFields(from, to, pinnedEventFields[0].eventSubType);
                        }
                      : undefined
                  }
                />
              </div>
            )}
            <JsonViewer
              json={eventFields}
              onPinField={onPinEventField}
              expandedPaths={expandedPaths}
              onToggleExpand={handleToggleExpand}
              pathPrefix="event-body"
              defaultExpandDepth={2}
            />
          </DetailSection>

          {/* timing_data */}
          {parsedTiming !== undefined && (
            <DetailSection
              title={t('timingData')}
              collapsed={!!collapsedSections['timing']}
              onToggle={() => toggleSection('timing')}
            >
              <JsonViewer
                json={parsedTiming}
                expandedPaths={expandedPaths}
                onToggleExpand={handleToggleExpand}
                pathPrefix="timing"
                defaultExpandDepth={1}
              />
            </DetailSection>
          )}
        </div>
      ),
    },
    ...[
      {
        id: 'context',
        label: 'Context',
        content: (
          <div className="p-3">
            {(
              [
                ['App', _context.app],
                ['User', _context.user],
                ['Session', _context.session],
                ['View', _context.view],
                ['Properties', _context.properties],
                ['OS', _context.os],
                ['Net', _context.net],
              ] as [string, any][]
            )
              .filter(([, val]) => val && Object.keys(val).length > 0)
              .map(([key, val]) => (
                <DetailSection
                  key={key}
                  title={key}
                  collapsed={!!collapsedSections[`ctx-${key}`]}
                  onToggle={() => toggleSection(`ctx-${key}`)}
                >
                  <JsonViewer
                    json={val}
                    expandedPaths={expandedPaths}
                    onToggleExpand={handleToggleExpand}
                    pathPrefix={`ctx-${key}`}
                    defaultExpandDepth={1}
                  />
                </DetailSection>
              ))}
          </div>
        ),
      },
    ],
  ];

  return (
    <div className="w-full h-full flex flex-col bg-bg-primary text-text-primary">
      <TabPanel
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        contentRef={tabContentRef}
      />
    </div>
  );
};
