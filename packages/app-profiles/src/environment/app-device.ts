import type { EnvironmentChange, EnvironmentSnapshot } from './changes.js';

type Component = 'device' | 'app';
type Values = { device: unknown; app: unknown };
export type AppDeviceChanges<T extends Values> = { [K in Component]?: EnvironmentChange<T[K]> };
export type AppDeviceSnapshots<T extends Values> = { [K in Component]: EnvironmentSnapshot<T[K]> };
export interface AppDeviceEnvironmentHost<T extends Values> {
  /** Validate the composed physical environment as well as reading each component's intent. */
  read(): Promise<AppDeviceSnapshots<T>>;
  save(changes: AppDeviceChanges<T>): Promise<void>;
  matchesRestored<K extends Component>(component: K, baseline: T[K], current: T[K]): boolean;
}

/** App and device share physical fields. A coordinated change keeps their original baselines. */
export async function changeAppDeviceEnvironment<T extends Values, R>(
  owner: string,
  components: readonly Component[],
  changes: AppDeviceChanges<T>,
  host: AppDeviceEnvironmentHost<T>,
  effect: () => Promise<R>,
  restore = false,
): Promise<{ result?: R; changes: AppDeviceChanges<T> }> {
  if (!owner) throw new Error('Environment owner is required');
  if (!components.length || new Set(components).size !== components.length || components.some(key => key !== 'device' && key !== 'app'))
    throw new Error('Invalid App/device change components');
  const selected = new Set(components.filter(key => !restore || changes[key]));
  if (!selected.size) return { changes };
  const before = await host.read();
  const next: AppDeviceChanges<T> = structuredClone({ device: changes.device, app: changes.app });
  for (const key of ['device', 'app'] as const) {
    const change = changes[key];
    if (!change) continue;
    if (change.owner !== owner || change.component !== key) throw new Error('ENVIRONMENT_OWNER_CONFLICT');
    if (change.phase !== 'active' || !change.applied) throw new Error('ENVIRONMENT_UNCONFIRMED');
    if (change.applied.revision !== before[key].revision || change.applied.fingerprint !== before[key].fingerprint) {
      next[key] = { ...change, phase: 'conflict' } as typeof next[typeof key];
      await host.save(next);
      throw new Error(`ENVIRONMENT_STATE_CONFLICT: ${key} changed after this owner wrote it`);
    }
  }
  const isChanging = (key: Component) => selected.has(key);
  const stage = <C extends Component>(key: C) => {
    const previous = changes[key];
    if (previous || (!restore && isChanging(key))) next[key] = {
      owner, component: key,
      baseline: previous?.baseline ?? structuredClone(before[key]),
      ...(previous?.applied ? { applied: previous.applied } : {}),
      phase: restore && isChanging(key) ? 'restoring' : 'pending',
    };
  };
  stage('device'); stage('app');
  // One host save covers every owned component affected by the shared UA/container transition.
  await host.save(next);
  const result = await effect();
  const after = await host.read();
  if (restore) for (const key of selected) {
    if (!host.matchesRestored(key, next[key]!.baseline.value, after[key].value))
      throw new Error(`ENVIRONMENT_RESTORE_UNCONFIRMED: ${key}`);
  }
  const commit = <C extends Component>(key: C) => {
    const change = next[key];
    if (!change) return;
    if (restore && isChanging(key)) delete next[key];
    else next[key] = { ...change, phase: 'active', applied: structuredClone(after[key]) };
  };
  commit('device'); commit('app');
  await host.save(next);
  return { result, changes: next };
}
