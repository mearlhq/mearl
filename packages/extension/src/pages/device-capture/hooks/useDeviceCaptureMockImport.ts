import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { MockConfigRef } from '../../../shared/types';
import { CapturedRequest } from '../../panel/types';
import { t } from '../../panel/utils/i18n';
import { showToast } from '../../panel/utils/toast';

export interface MockImportOverride {
  apiName: string;
  responseData: unknown;
  mockConfig?: MockConfigRef;
}

interface UseDeviceCaptureMockImportOptions {
  platformId: string;
  prepareOverride?: (request: CapturedRequest) => Promise<void>;
  requests: CapturedRequest[];
  supportsModify: boolean;
  modificationEnabled: boolean;
  modificationEnabledRef: MutableRefObject<boolean>;
  setModificationEnabled: (value: boolean | ((prev: boolean) => boolean)) => void;
  applyMockOverride: (request: CapturedRequest, modifiedData: unknown) => Promise<void>;
}

const findLatestRequestByApiName = (
  requests: CapturedRequest[],
  apiName: string,
): CapturedRequest | undefined => {
  for (let i = requests.length - 1; i >= 0; i--) {
    if (requests[i].apiName === apiName) return requests[i];
  }
  return undefined;
};

/** 将请求导入的 mock 桥接到能力包的真机修改链路 */
export const useDeviceCaptureMockImport = ({
  platformId,
  prepareOverride,
  requests,
  supportsModify,
  modificationEnabled,
  modificationEnabledRef,
  setModificationEnabled,
  applyMockOverride,
}: UseDeviceCaptureMockImportOptions) => {
  const scope = useRef({ platformId, generation: 0, active: true });
  if (scope.current.platformId !== platformId) {
    scope.current.platformId = platformId;
    scope.current.generation++;
  }
  useEffect(() => {
    scope.current.active = true;
    return () => { scope.current.active = false; scope.current.generation++; };
  }, []);
  const addMockOverride = useCallback(
    async (override: MockImportOverride): Promise<{ success: boolean }> => {
      if (!supportsModify) {
        throw new Error('Mock import is not supported on this platform');
      }

      const request = findLatestRequestByApiName(requests, override.apiName);
      if (!request) {
        showToast(t('deviceCaptureImportNeedRequest'), 'info', 5000);
        throw new Error('No captured request for API');
      }

      if (!scope.current.active) throw new Error('Capture page closed');
      const generation = scope.current.generation;
      await prepareOverride?.(request);
      if (scope.current.generation !== generation || !scope.current.active) throw new Error('Capture platform changed');

      if (!modificationEnabled) {
        modificationEnabledRef.current = true;
        setModificationEnabled(true);
      }

      const requestForImport = override.mockConfig
        ? {
            ...request,
            responseOverride: {
              apiName: request.apiName,
              originalData: request.responseOverride?.originalData ?? request.responseBody,
              modifiedData: override.responseData,
              mockConfig: override.mockConfig,
              sceneComment: request.responseOverride?.sceneComment,
            },
          }
        : request;

      await applyMockOverride(requestForImport, override.responseData);
      return { success: true };
    },
    [
      platformId,
      supportsModify,
      requests,
      prepareOverride,
      modificationEnabled,
      modificationEnabledRef,
      setModificationEnabled,
      applyMockOverride,
    ],
  );

  return { addMockOverride };
};
