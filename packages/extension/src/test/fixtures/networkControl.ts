import type { SelectedBrowserControl } from '@mearl/preset/bundles';
export function networkControlFixture(settings: { mtopGateways?: Record<string, { prod: string; pre: string }> }, text: (key: string) => { en: string } = key => ({ en: key })): SelectedBrowserControl | undefined {
  const gateways = settings.mtopGateways ?? {};
  if (!Object.keys(gateways).length) return undefined;
  return { bundleId: 'fixture', revision: JSON.stringify(gateways), definition: {
    schemaVersion: 1, id: 'environment', kind: 'segmented', label: text('envSwitch'), description: text('envSwitchDesc'), defaultValue: 'default',
    messages: { changed: text('envSwitchReloadHint'), failed: text('envSwitchChangeFailed') },
    options: [
      { value: 'default', label: text('envSwitchOff'), networkRoutes: { routes: [] } },
      ...(['pre', 'prod'] as const).map(value => ({ value, label: text(value === 'pre' ? 'requestEnvironmentPreRelease' : 'requestEnvironmentProd'), networkRoutes: { routes: Object.entries(gateways).map(([id, hosts]) => ({ id, fromHost: hosts[value === 'pre' ? 'prod' : 'pre'], toHost: hosts[value] })) } })),
    ],
  } };
}
