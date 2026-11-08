const MOCK_SEQUENCE_INDEX_CONDITION = '$index';

// Dynamically registered content scripts execute as classic scripts, so this helper
// stays within the content-script entry graph to keep its bundle self-contained.
export function hasRequestConditions(conditions?: Record<string, unknown>): boolean {
  return Object.keys(conditions ?? {}).some(key => key !== MOCK_SEQUENCE_INDEX_CONDITION);
}
