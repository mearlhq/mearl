import { FC } from 'react';
import { CapturedRequest } from '../../types';
import { t, getCurrentLanguage } from '../../utils/i18n';
import { browserUiText } from '@mearl/preset/bundles';
import { useBrowserRequestUi } from '../../hooks/useBrowserRequestUi';
import { DetailSection } from '../detail/DetailSection';
import { DetailRow } from '../detail/DetailRow';
import { DetailRowUrl } from '../detail/DetailRowUrl';
import { HsfDetailRows } from '../detail/HsfDetailRows';
import { HsfToggleButton } from '../detail/HsfToggleButton';
import { RequestApiLink } from '../detail/RequestApiLink';
import { JsonViewer } from '../detail/JsonViewer';
import { CookieDisplay } from '../CookieDisplay';
import { CopyButton } from '../CopyButton';
import { SizeDisplay } from '../detail/SizeDisplay';
import { EagleeyeTraceidLink } from '../detail/EagleeyeTraceidLink';
import { TtidQueryParam } from '../detail/TtidQueryParam';
import {
  formatTimestamp,
  parseCookies,
  tryParseJsonString,
  safeDecodeURIComponent,
} from '../../utils/helpers';
import { detectFormat } from '../../utils/stringFormats';
import { detectRequestEnvironment, REQUEST_ENV_LABELS } from '../../utils/requestEnvironment';

interface HeadersTabProps {
  request: CapturedRequest;
  collapsedSections: Record<string, boolean>;
  toggleSection: (id: string) => void;
  expandedPaths: Record<string, boolean>;
  onToggleExpand: (paths: Record<string, boolean>) => void;
  onTabChange: (tab: string) => void;
  showHsfEntry?: boolean;
  hsfEnabled?: boolean;
  hsfLoading?: boolean;
  hsfDisplayValue?: string;
  hsfMaintainerDisplayValue?: string;
  hsfMaintainerTitle?: string;
  onToggleHsf?: () => void;
  onOpenHsf?: () => void;
  onOpenModal: (data: {
    title: string;
    type: 'request' | 'response';
    pathPrefix: string;
    data: any;
  }) => void;
  requestMetadataEnabled?: boolean;
  requestImportEnabled?: boolean;
  trackingMetadataEnabled?: boolean;
}

export const HeadersTab: FC<HeadersTabProps> = ({
  request,
  collapsedSections,
  toggleSection,
  expandedPaths,
  onToggleExpand,
  onTabChange,
  showHsfEntry,
  hsfEnabled,
  hsfLoading,
  hsfDisplayValue,
  hsfMaintainerDisplayValue,
  hsfMaintainerTitle,
  onToggleHsf,
  onOpenHsf,
  onOpenModal,
  requestMetadataEnabled = false,
  requestImportEnabled = false,
  trackingMetadataEnabled = false,
}) => {
  const { definition } = useBrowserRequestUi();
  const metadataLocale = getCurrentLanguage();
  const requestUrl = request.proxyRequestUrl || request.url;
  const envInfo = detectRequestEnvironment(requestUrl, request.environment);
  const envLabel = Object.hasOwn(REQUEST_ENV_LABELS, envInfo.environment)
    ? REQUEST_ENV_LABELS[envInfo.environment]
    : envInfo.environment;
  const showHsfDetails = Boolean(showHsfEntry && hsfEnabled && (hsfLoading || hsfDisplayValue));

  return (
    <div className="p-3">
      {/* 基本信息 */}
      <DetailSection
        title={t('basicInfo')}
        collapsed={!!collapsedSections['basic-info']}
        onToggle={() => toggleSection('basic-info')}
      >
        <DetailRow
          label={t('apiName')}
          value={requestMetadataEnabled ? <RequestApiLink request={request} /> : request.apiName}
          action={
            <div className="flex items-center gap-2">
              {showHsfEntry && definition && (
                <HsfToggleButton
                  enabled={hsfEnabled}
                  loading={hsfLoading}
                  onClick={onToggleHsf}
                  label={browserUiText(definition.details.toggleLabel, metadataLocale)}
                  title={browserUiText(definition.details.viewTitle, metadataLocale)}
                />
              )}
              <CopyButton text={request.apiName} />
            </div>
          }
        />
        {definition && <HsfDetailRows
          visible={showHsfDetails}
          loading={hsfLoading}
          displayValue={hsfDisplayValue}
          maintainerDisplayValue={hsfMaintainerDisplayValue}
          maintainerTitle={hsfMaintainerTitle}
          onOpenHsf={onOpenHsf}
          interfaceLabel={browserUiText(definition.details.interfaceLabel, metadataLocale)}
          maintainerLabel={browserUiText(definition.details.maintainerLabel, metadataLocale)}
          viewTitle={browserUiText(definition.details.viewTitle, metadataLocale)}
        />}
        <DetailRow label={t('requestMethod')} value={request.method} />
        <DetailRow label={t('statusCode')} value={`${request.status} ${request.statusText}`} />
        <DetailRow
          label={t('requestEnvironment')}
          value={
            <span className="text-text-primary">
              {envLabel}
              {envInfo.host ? (
                <span className="text-text-secondary">{` (${envInfo.host})`}</span>
              ) : null}
            </span>
          }
        />
        {request.duration !== undefined && (
          <DetailRow label={t('duration')} value={<span>{request.duration}ms</span>} />
        )}
        <DetailRow label={t('timestamp')} value={formatTimestamp(request.timestampMs)} />
        <DetailRowUrl label="URL" value={requestUrl} />
      </DetailSection>

      {/* 查询参数 */}
      {request.queryString && request.queryString.length > 0 && (
        <DetailSection
          title={t('queryParams')}
          collapsed={!!collapsedSections['query-params']}
          onToggle={() => toggleSection('query-params')}
        >
          {request.queryString.map((q, idx) => {
            const displayValue = q.value ? safeDecodeURIComponent(q.value) : q.value;

            const { parsed, format } = tryParseJsonString(displayValue);
            if (format) {
              // 如果是 data 参数，只显示按钮跳转到 Request tab
              if (q.name === 'data') {
                return (
                  <DetailRow
                    key={idx}
                    label={q.name}
                    value={
                      <span
                        onClick={() => onTabChange('request')}
                        className="cursor-pointer border-b border-dashed border-text-secondary hover:border-solid"
                        title={t('viewInRequestTab')}
                      >
                        {t('viewDetails')}
                      </span>
                    }
                  />
                );
              }
              return (
                <DetailRow
                  key={idx}
                  label={q.name}
                  value={
                    <JsonViewer
                      json={parsed}
                      pathPrefix={`query-${idx}`}
                      expandedPaths={expandedPaths}
                      onToggleExpand={onToggleExpand}
                      defaultActionsVisible={false}
                    />
                  }
                />
              );
            }

            // TTID 参数特殊处理
            if (trackingMetadataEnabled && q.name === 'ttid') {
              return <TtidQueryParam key={idx} ttidValue={displayValue} />;
            }

            return <DetailRow key={idx} label={q.name} value={displayValue} />;
          })}
        </DetailSection>
      )}

      {/* 请求头 */}
      <DetailSection
        title={
          <div className="flex items-center gap-2">
            <span>{t('requestHeaders')}</span>
            {request.requestHeadersSize !== undefined && (
              <SizeDisplay size={request.requestHeadersSize} />
            )}
          </div>
        }
        collapsed={!!collapsedSections['request-headers']}
        onToggle={() => toggleSection('request-headers')}
      >
        {request.headers.map((h, idx) => {
          if (h.name.toLowerCase() === 'cookie') {
            const cookies = parseCookies(h.value);
            return (
              <DetailRow key={idx} label={h.name} value={<CookieDisplay cookies={cookies} />} />
            );
          }

          const displayValue = safeDecodeURIComponent(h.value);

          if (detectFormat(displayValue)) {
            return (
              <DetailRow
                key={idx}
                label={h.name}
                value={
                  <JsonViewer
                    json={displayValue}
                    defaultRawFormats={['url']}
                    defaultActionsVisible={false}
                    onFullscreen={() =>
                      onOpenModal({
                        title: `${t('requestHeaders')} - ${h.name}`,
                        type: 'request',
                        pathPrefix: `request-header-${idx}`,
                        data: displayValue,
                      })
                    }
                    expandedPaths={expandedPaths}
                    onToggleExpand={onToggleExpand}
                    pathPrefix={`request-header-${idx}`}
                  />
                }
              />
            );
          }

          return <DetailRow key={idx} label={h.name} value={displayValue} />;
        })}
      </DetailSection>

      {/* 响应头 */}
      <DetailSection
        title={
          <div className="flex items-center gap-2">
            <span>{t('responseHeaders')}</span>
            {request.responseHeadersSize !== undefined && (
              <SizeDisplay size={request.responseHeadersSize} />
            )}
          </div>
        }
        collapsed={!!collapsedSections['response-headers']}
        onToggle={() => toggleSection('response-headers')}
      >
        {request.responseHeaders.map((h, idx) => {
          if (h.name.toLowerCase() === 'set-cookie') {
            const cookies = parseCookies(h.value);
            return (
              <DetailRow key={idx} label={h.name} value={<CookieDisplay cookies={cookies} />} />
            );
          }
          const headerNameLower = h.name.toLowerCase();
          if (headerNameLower === 'eagleeye-traceid') {
            return (
              <DetailRow
                key={idx}
                label={h.name}
                value={
                  requestImportEnabled ? (
                    <EagleeyeTraceidLink traceid={h.value} timestampMs={request.timestampMs} />
                  ) : (
                    h.value
                  )
                }
                showCopy
                copyText={h.value}
              />
            );
          }

          const displayRespValue = safeDecodeURIComponent(h.value);

          if (detectFormat(displayRespValue)) {
            return (
              <DetailRow
                key={idx}
                label={h.name}
                value={
                  <JsonViewer
                    json={displayRespValue}
                    defaultRawFormats={['url']}
                    defaultActionsVisible={false}
                    onFullscreen={() =>
                      onOpenModal({
                        title: `${t('responseHeaders')} - ${h.name}`,
                        type: 'response',
                        pathPrefix: `response-header-${idx}`,
                        data: displayRespValue,
                      })
                    }
                    expandedPaths={expandedPaths}
                    onToggleExpand={onToggleExpand}
                    pathPrefix={`response-header-${idx}`}
                  />
                }
              />
            );
          }

          return <DetailRow key={idx} label={h.name} value={displayRespValue} />;
        })}
      </DetailSection>
    </div>
  );
};
