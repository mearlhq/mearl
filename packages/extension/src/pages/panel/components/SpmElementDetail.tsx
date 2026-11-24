import { FC, useState } from 'react';
import type { ElementPickerSelection } from '../../content-script/elementCommentTypes';
import { t } from '../utils/i18n';
import { DetailRow } from './detail/DetailRow';
import { DetailRowUrl } from './detail/DetailRowUrl';
import { DetailSection } from './detail/DetailSection';
import { JsonViewer } from './detail/JsonViewer';
import { SpmQueryParam } from './detail/SpmQueryParam';

interface SpmElementDetailProps {
  selection: ElementPickerSelection;
  trackingMetadataEnabled?: boolean;
}

function getTrackingKind(attributes: Record<string, string>): string {
  if (attributes['data-spm-click']) return t('spmElementClick');
  if (attributes['data-spm-anchor-id']) return t('spmElementAnchor');
  if (attributes['data-spm-abcd']) return t('spmElementFullPoint');
  return t('spmElementNode');
}

export const SpmElementDetail: FC<SpmElementDetailProps> = ({
  selection,
  trackingMetadataEnabled = false,
}) => {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) =>
    setCollapsed(previous => ({ ...previous, [key]: !previous[key] }));
  const element = selection.element;
  const attributes = Object.fromEntries(
    Object.entries(element?.attributes ?? {}).filter(([name]) => !name.startsWith('data-mtop-')),
  );
  const trackingAttributes = Object.fromEntries(
    Object.entries(attributes).filter(([name]) => name.startsWith('data-spm')),
  );
  const pageUrl = selection.frame?.url ?? selection.page.url;

  return (
    <div className="w-full h-full overflow-auto bg-bg-primary text-text-primary p-3">
      <DetailSection
        title={t('spmElementDetail')}
        collapsed={!!collapsed.basic}
        onToggle={() => toggleSection('basic')}
      >
        <DetailRow label="SPM" value={selection.spm ?? ''} showCopy copyText={selection.spm} />
        <DetailRow label={t('spmElementType')} value={getTrackingKind(attributes)} />
        {element && (
          <DetailRow
            label={t('spmElementDomNode')}
            value={`<${element.tagName}>${element.id ? `#${element.id}` : ''}`}
          />
        )}
        {selection.text && <DetailRow label={t('spmElementText')} value={selection.text} />}
        {pageUrl && <DetailRowUrl label="URL" value={pageUrl} />}
        {trackingMetadataEnabled && selection.spm && <SpmQueryParam spmValue={selection.spm} />}
      </DetailSection>

      {Object.keys(trackingAttributes).length > 0 && (
        <DetailSection
          title={t('spmElementConfig')}
          collapsed={!!collapsed.config}
          onToggle={() => toggleSection('config')}
        >
          <JsonViewer json={trackingAttributes} defaultExpandDepth={2} />
        </DetailSection>
      )}

      {element && (
        <DetailSection
          title={t('spmElementDomDetail')}
          collapsed={!!collapsed.dom}
          onToggle={() => toggleSection('dom')}
        >
          <DetailRow
            label="CSS Selector"
            value={element.selector}
            showCopy
            copyText={element.selector}
          />
          <DetailRow label="XPath" value={element.xpath} showCopy copyText={element.xpath} />
          <JsonViewer json={attributes} defaultExpandDepth={1} />
          {element.outerHTML && (
            <pre className="mt-2 rounded bg-bg-secondary p-2 text-xxs font-mono whitespace-pre-wrap break-all text-text-secondary">
              {element.outerHTML.replace(/\sdata-mtop-spm-source-id=(['"])[^'"]*\1/g, '')}
            </pre>
          )}
        </DetailSection>
      )}
    </div>
  );
};
