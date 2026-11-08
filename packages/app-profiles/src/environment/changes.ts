export type EnvironmentComponent = 'device' | 'app' | 'timezone';

/** Hosts supply a revision for coordinated writes and an observation for external drift. */
export interface EnvironmentSnapshot<T> {
  revision: number;
  fingerprint: string;
  value: T;
}

export interface EnvironmentChange<T> {
  owner: string;
  component: EnvironmentComponent;
  baseline: EnvironmentSnapshot<T>;
  applied?: EnvironmentSnapshot<T>;
  phase: 'pending' | 'active' | 'restoring' | 'conflict' | 'restored';
}

/** Callers serialize this flow with their existing page/environment update queue. */
export interface EnvironmentChangeHost<T> {
  read(): Promise<EnvironmentSnapshot<T>>;
  save(change: EnvironmentChange<T>): Promise<void>;
  restore(baseline: T): Promise<void>;
  matchesRestored(baseline: EnvironmentSnapshot<T>, current: EnvironmentSnapshot<T>): boolean;
}

function matches<T>(expected: EnvironmentSnapshot<T>, current: EnvironmentSnapshot<T>): boolean {
  return expected.revision === current.revision && expected.fingerprint === current.fingerprint;
}

async function assertCurrent<T>(change: EnvironmentChange<T>, host: EnvironmentChangeHost<T>): Promise<void> {
  if (change.phase !== 'active' || !change.applied) {
    throw new Error('ENVIRONMENT_UNCONFIRMED: reconcile the previous change before writing again');
  }
  if (!matches(change.applied, await host.read())) {
    await host.save({ ...change, phase: 'conflict' });
    throw new Error('ENVIRONMENT_STATE_CONFLICT: the environment changed after this owner wrote it');
  }
}

/** Persist recovery information before the first effect; failed/unknown effects remain pending. */
export async function applyEnvironmentChange<T, R>(
  owner: string,
  component: EnvironmentComponent,
  previous: EnvironmentChange<T> | undefined,
  host: EnvironmentChangeHost<T>,
  apply: () => Promise<R>,
): Promise<R> {
  if (!owner) throw new Error('Environment owner is required');
  if (previous) {
    if (previous.owner !== owner || previous.component !== component)
      throw new Error('ENVIRONMENT_OWNER_CONFLICT');
    await assertCurrent(previous, host);
  }
  const change: EnvironmentChange<T> = {
    owner,
    component,
    baseline: previous?.baseline ?? structuredClone(await host.read()),
    phase: 'pending',
  };
  await host.save(change);
  const result = await apply();
  const applied = structuredClone(await host.read());
  await host.save({ ...change, phase: 'active', applied });
  return result;
}

/** Restore only this component and only while both coordinated and observed state still match. */
export async function restoreEnvironmentChange<T>(
  owner: string,
  change: EnvironmentChange<T>,
  host: EnvironmentChangeHost<T>,
): Promise<{ restored: boolean; reason?: 'changed' | 'unconfirmed' }> {
  if (change.owner !== owner) throw new Error('ENVIRONMENT_OWNER_CONFLICT');
  if (change.phase === 'restored') return { restored: true };
  if (change.phase !== 'active' || !change.applied) return { restored: false, reason: 'unconfirmed' };
  if (!matches(change.applied, await host.read())) {
    await host.save({ ...change, phase: 'conflict' });
    return { restored: false, reason: 'changed' };
  }
  const restoring = { ...change, phase: 'restoring' as const };
  await host.save(restoring);
  await host.restore(structuredClone(change.baseline.value));
  if (!host.matchesRestored(change.baseline, await host.read()))
    return { restored: false, reason: 'unconfirmed' };
  await host.save({ ...restoring, phase: 'restored' });
  return { restored: true };
}
