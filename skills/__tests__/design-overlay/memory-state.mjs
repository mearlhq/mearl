import { PluginStateStore } from '../shared/public-runtime.mjs';
import { stateStorage } from '../../design-overlay/scripts/state.mjs';

export function memoryState(directory = '/unused-design-overlay-memory-state') {
  const store = new PluginStateStore(directory);
  const call = async (collection, operation, input) => {
    const namespace = { installationId: '00000000-0000-4000-8000-000000000001', collection, scope: 'browser-session:test' };
    const definition = stateStorage.collections[collection];
    if (operation === 'get') return store.get(namespace, definition, input.key);
    if (operation === 'get-many') return store.getMany(namespace, definition, input.keys);
    if (operation === 'list') return store.list(namespace, definition, input);
    return store.transact(namespace, definition, input.transaction);
  };
  return call;
}
