import { useMemo, useState } from 'react';
import type { CapturedRequest } from '../types';
import { useLocalStorage } from './useLocalStorage';

const TYPE_ORDER = [
  'protocol',
  'xhr',
  'fetch',
  'jsonp',
  'script',
  'stylesheet',
  'document',
  'image',
  'font',
  'media',
  'websocket',
  'other',
];
const DEFAULT_HTTP_TYPES = ['xhr', 'fetch', 'jsonp'];

export const getRequestType = (request: CapturedRequest): string =>
  request.source === 'protocol' ? 'protocol' : request.resourceType || 'other';

export function useRequestFilters(
  requests: CapturedRequest[],
  hasCapturedRequests: boolean,
  { filterTypes = true }: { filterTypes?: boolean } = {},
) {
  // 自动选择跟随采集数据，用户操作后保留本次面板的选择。
  const [explicitTypes, setSelectedTypes] = useState<string[] | null>(null);
  const selectedTypes = explicitTypes ?? (hasCapturedRequests ? ['protocol'] : DEFAULT_HTTP_TYPES);
  const [selectedNamespaces, setSelectedNamespaces] = useLocalStorage<string[]>(
    'mearl-selected-namespaces',
    [],
  );

  const availableTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const request of requests) {
      const type = getRequestType(request);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return Array.from(counts, ([type, count]) => ({ type, count })).sort((a, b) => {
      const aIndex = TYPE_ORDER.indexOf(a.type);
      const bIndex = TYPE_ORDER.indexOf(b.type);
      return (aIndex < 0 ? TYPE_ORDER.length : aIndex) - (bIndex < 0 ? TYPE_ORDER.length : bIndex);
    });
  }, [requests]);

  const visibleTypes = availableTypes.filter(({ type }) => selectedTypes.includes(type));
  const onlyProtocol = !filterTypes || (visibleTypes.length === 1 && visibleTypes[0].type === 'protocol');
  const availableNamespaces = useMemo(() => {
    const counts = new Map<string, number>();
    for (const request of requests) {
      if (getRequestType(request) !== 'protocol') continue;
      const namespace = request.namespace;
      if (namespace) counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
    }
    return Array.from(counts, ([ns, count]) => ({ ns, count })).sort(
      (a, b) => b.count - a.count || a.ns.localeCompare(b.ns),
    );
  }, [requests]);

  const validNamespaces = selectedNamespaces.filter(ns =>
    availableNamespaces.some(available => available.ns === ns),
  );
  const displayedRequests = requests.filter(request => {
    if (filterTypes && !selectedTypes.includes(getRequestType(request))) return false;
    return (
      !onlyProtocol ||
      availableNamespaces.length <= 1 ||
      validNamespaces.length === 0 ||
      !request.namespace ||
      validNamespaces.includes(request.namespace)
    );
  });

  return {
    availableTypes: filterTypes ? availableTypes : [],
    selectedTypes,
    setSelectedTypes,
    availableNamespaces: onlyProtocol ? availableNamespaces : [],
    selectedNamespaces,
    setSelectedNamespaces,
    displayedRequests,
  };
}
