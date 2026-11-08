export const MOCK_SEQUENCE_INDEX_CONDITION = '$index';

export function splitMockConditions(conditions?: Record<string, any>): {
  sequenceIndex: number | undefined;
  requestConditions: Record<string, any> | undefined;
} {
  if (!conditions) return { sequenceIndex: undefined, requestConditions: undefined };
  const { [MOCK_SEQUENCE_INDEX_CONDITION]: sequenceIndex, ...requestConditions } = conditions;
  return {
    sequenceIndex,
    requestConditions: Object.keys(requestConditions).length > 0 ? requestConditions : undefined,
  };
}

export function hasRequestConditions(conditions?: Record<string, any>): boolean {
  return splitMockConditions(conditions).requestConditions !== undefined;
}
