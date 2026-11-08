import type { RumEvent } from '../types';

const RUM_ASSET_RESOURCE_TYPES = new Set(['js', 'css', 'image', 'font', 'video', 'audio']);
const LEGACY_RUM_ASSET_FILTER_TYPES = new Set(
  Array.from(RUM_ASSET_RESOURCE_TYPES, type => `rum/resource:${type}`),
);

export const RUM_ASSET_FILTER_TYPE = 'rum/assets';

export const getRumEventFilterType = (event: RumEvent): string => {
  if (
    event.source === 'rum' &&
    event.event_type === 'resource' &&
    event.type &&
    RUM_ASSET_RESOURCE_TYPES.has(event.type)
  ) {
    return RUM_ASSET_FILTER_TYPE;
  }

  const eventType =
    event.event_type === 'resource' && event.type ? `resource:${event.type}` : event.event_type;
  return `${event.source ?? 'unknown'}/${eventType}`;
};

export const normalizeRumSelectedTypes = (types: string[]): string[] => {
  if (!types.some(type => LEGACY_RUM_ASSET_FILTER_TYPES.has(type))) return types;

  return Array.from(
    new Set(
      types.map(type => (LEGACY_RUM_ASSET_FILTER_TYPES.has(type) ? RUM_ASSET_FILTER_TYPE : type)),
    ),
  );
};
