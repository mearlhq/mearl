import { CapturedRequest, ResponseOverride } from '../types';

const isSameOverride = (
  request: CapturedRequest,
  apiName: string,
  removedOverride: ResponseOverride,
): boolean => {
  if (!request.responseOverride || request.apiName !== apiName) return false;
  if (removedOverride.id) return request.responseOverride.id === removedOverride.id;
  return true;
};

export const clearRemovedResponseOverride = (
  requests: CapturedRequest[],
  apiName: string,
  removedOverride: ResponseOverride,
): CapturedRequest[] =>
  requests.map(request => {
    if (!isSameOverride(request, apiName, removedOverride)) return request;
    const duration = request.responseOverride?.duration ?? request.duration;
    return { ...request, responseOverride: undefined, duration };
  });
