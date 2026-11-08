import { useState, useEffect, FC } from 'react';
import { CapturedRequest, PinnedField } from '../../types';
import { t } from '../../utils/i18n';
import { CopyButton } from '../CopyButton';
import { ResendButton } from '../ResendButton';
import { DetailSection } from '../detail/DetailSection';
import { JsonViewer } from '../detail/JsonViewer';
import { PinnedFieldsDisplay } from '../detail/PinnedFieldsDisplay';
import { BodySizeDisplay, SizeDisplay } from '../detail/SizeDisplay';
import { extractRequestData, formatJson, setValueByPathInParsedData } from '../../utils/helpers';
import { showToast } from '../../utils/toast';

interface RequestTabProps {
  inspectedTabId?: number;
  request: CapturedRequest;
  parsedRequestData: any;
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
  expandedPaths: Record<string, boolean>;
  onToggleExpand: (paths: Record<string, boolean>) => void;
  onOpenModal: (data: {
    title: string;
    type: 'request' | 'response';
    pathPrefix: string;
    data: any;
    editable?: boolean;
    onValueChange?: (path: string[], newValue: any) => void;
  }) => void;
}

export const RequestTab: FC<RequestTabProps> = ({
  inspectedTabId,
  request,
  parsedRequestData,
  collapsedSections,
  toggleSection,
  pinnedFields,
  onUnpinField,
  onPinField,
  onReorderPinnedFields,
  expandedPaths,
  onToggleExpand,
  onOpenModal,
}) => {
  const [isEditingForResend, setIsEditingForResend] = useState(false);
  const [editedRequestData, setEditedRequestData] = useState<any>(null);
  const [originalRequestData, setOriginalRequestData] = useState<any>(null);

  // 切换请求时重置编辑状态
  useEffect(() => {
    setIsEditingForResend(false);
    setEditedRequestData(null);
    setOriginalRequestData(null);
  }, [request.id]);

  const requestData = extractRequestData(request);
  const hasRequestBody = request.postData !== null && request.postData !== undefined;
  const hasRequestData = !!requestData;
  const requestContentLabel = hasRequestBody ? t('requestBody') : t('queryParams');

  // 当开始编辑时，创建一个可编辑的副本（使用预处理后的数据）
  const handleEditStart = () => {
    setIsEditingForResend(true);
    // 保存原始请求数据，用于还原格式
    setOriginalRequestData(requestData);
    // 使用预处理后的 parsedRequestData 作为编辑起点，更易读易编辑
    setEditedRequestData(JSON.parse(JSON.stringify(parsedRequestData)));
  };

  // 取消编辑
  const handleEditCancel = () => {
    setIsEditingForResend(false);
    setEditedRequestData(null);
    setOriginalRequestData(null);
  };

  // 处理编辑中的值变更
  const handleValueChange = (path: string[], newValue: any) => {
    if (!editedRequestData) return;

    const updatedData = setValueByPathInParsedData(
      editedRequestData,
      editedRequestData,
      path,
      newValue,
    );
    setEditedRequestData(updatedData);
  };

  // 获取要发送的数据（编辑后的数据，用于 background 发送）
  const getRequestDataToSend = () => {
    if (!isEditingForResend || !editedRequestData) {
      return requestData;
    }

    // 如果原始数据是字符串类型的 key=value 格式（如 "data={...}"）
    if (typeof originalRequestData === 'string') {
      const keyValueMatch = originalRequestData.trim().match(/^(\w+)=(.+)$/);
      if (keyValueMatch) {
        const key = keyValueMatch[1];
        // 提取编辑后的内层对象，让 background.ts 自己处理 JSON.stringify
        return editedRequestData[key] || editedRequestData;
      }
      return editedRequestData;
    }

    // 原始数据是对象，如果只有一个 'data' key，提取内层对象
    if (editedRequestData.data && Object.keys(editedRequestData).length === 1) {
      return editedRequestData.data;
    }

    return editedRequestData;
  };

  // 获取要记录的数据（保留完整结构，包括 data 层级）
  const _getRequestDataToRecord = () => {
    return isEditingForResend && editedRequestData ? editedRequestData : requestData;
  };

  return (
    <div className="p-3">
      {hasRequestData ? (
        <DetailSection
          title={
            <div className="flex items-center gap-2">
              <span>{requestContentLabel}</span>
              {hasRequestBody ? (
                <BodySizeDisplay
                  headers={request.headers}
                  size={request.requestBodySize}
                  data={requestData}
                  label={requestContentLabel}
                />
              ) : (
                <SizeDisplay data={requestData} label={requestContentLabel} />
              )}
              {isEditingForResend && (
                <span className="text-2xs px-2 rounded bg-blue-500 text-white">
                  {t('editRequest')}
                </span>
              )}
            </div>
          }
          collapsed={!!collapsedSections['request-body']}
          onToggle={() => toggleSection('request-body')}
          action={
            <div className="flex items-center gap-2">
              <ResendButton
                inspectedTabId={inspectedTabId}
                originalUrl={request.proxyRequestUrl || request.url}
                apiName={request.apiName}
                method={request.method}
                queryParams={request.queryString}
                requestData={getRequestDataToSend()}
                isEditing={isEditingForResend}
                onEditStart={handleEditStart}
                onEditCancel={handleEditCancel}
                onError={error => {
                  console.error('Failed to send request:', error);
                  showToast(error, 'error');
                }}
              />
              {!isEditingForResend && <CopyButton text={formatJson(requestData)} />}
            </div>
          }
        >
          {/* 显示关注的请求字段 */}
          {pinnedFields.filter(f => f.type === 'request').length > 0 && (
            <>
              <PinnedFieldsDisplay
                fields={pinnedFields.filter(f => f.type === 'request')}
                onUnpin={path => onUnpinField(path, request.apiName, 'request')}
                onPinField={(path, value) => {
                  onPinField(path, value, 'request');
                }}
                onReorder={(fromIndex, toIndex) => {
                  onReorderPinnedFields?.(fromIndex, toIndex, request.apiName, 'request');
                }}
                expandedPaths={expandedPaths}
                onToggleExpand={onToggleExpand}
              />
              <div className="mb-1.5 text-xxs font-medium px-1 text-text-primary">
                {t('fullRequest')}
              </div>
            </>
          )}

          <JsonViewer
            json={isEditingForResend && editedRequestData ? editedRequestData : parsedRequestData}
            onPinField={(path, value) => {
              onPinField(path, value, 'request');
            }}
            onValueChange={isEditingForResend ? handleValueChange : undefined}
            editable={isEditingForResend}
            onFullscreen={() =>
              onOpenModal({
                title: t('requestBody'),
                type: 'request',
                pathPrefix: 'request-body',
                data:
                  isEditingForResend && editedRequestData ? editedRequestData : parsedRequestData,
                editable: isEditingForResend,
                onValueChange: isEditingForResend ? handleValueChange : undefined,
              })
            }
            expandedPaths={expandedPaths}
            onToggleExpand={onToggleExpand}
            pathPrefix="request-body"
          />
        </DetailSection>
      ) : (
        <div className="flex items-center justify-center h-32 text-text-secondary text-xs">
          {t('noRequestBody')}
        </div>
      )}
    </div>
  );
};
