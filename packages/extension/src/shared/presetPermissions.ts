import { isOriginAllowedByDomain } from '@mearl/browser-core';
import { validateInstallationOrigin } from '@mearl/preset/installation';
import {
  getAgentAllowedOrigins,
  getAgentAllowAllDomains,
  getAllStoredAgentOrigins,
  getDisabledBuiltinOrigins,
  setStoredAgentOrigins,
  setDisabledBuiltinOrigins,
} from './proxyPermissions';

function agentOriginCovered(origin: string, allowed: string[]): boolean {
  const wildcard = /^(?:https?|\*):\/\/\*\./.test(origin);
  const url = (value: string) =>
    new URL(value.replace(/^\*:/, 'https:').replace(/^(https?:\/\/)\*\./, '$1'));
  const target = url(origin);
  return allowed.some(scope => {
    if (scope === '<all_urls>') return true;
    try {
      const candidate = url(scope);
      if (candidate.hostname === '*') return true;
      const coveringWildcard = /^(?:https?|\*):\/\/\*\./.test(scope);
      return (
        isOriginAllowedByDomain(scope, target.hostname) &&
        (!wildcard ||
          (coveringWildcard &&
            (target.hostname === candidate.hostname ||
              target.hostname.endsWith(`.${candidate.hostname}`))))
      );
    } catch {
      return false;
    }
  });
}

export async function missingPresetPermissions(origins: string[]) {
  if (origins.length > 64) throw new Error('Too many preset permission origins');
  origins = [...new Set(origins.map(validateInstallationOrigin))];
  if (!origins.length) return { missingOrigins: [], missingAuthorization: [] };
  const allowed = await getAgentAllowedOrigins();
  const all = await getAgentAllowAllDomains();
  return {
    missingOrigins: (
      await Promise.all(
        origins.map(async origin =>
          (await chrome.permissions.contains({ origins: [origin] })) ? null : origin,
        ),
      )
    ).filter((origin): origin is string => origin !== null),
    missingAuthorization: all ? [] : origins.filter(origin => !agentOriginCovered(origin, allowed)),
  };
}

let granting: Promise<void> = Promise.resolve();
/** Persist host authorization independently; readiness still requires browser grants. */
export function grantPresetOrigins(origins: string[]): Promise<void> {
  const scopes = origins.map(validateInstallationOrigin);
  const result = granting
    .catch(() => {})
    .then(async () => {
      const allowed = await getAllStoredAgentOrigins();
      const hosts = scopes.map(origin => origin.replace(/^(?:https?|\*):/, '*:'));
      await setStoredAgentOrigins([...new Set([...allowed, ...hosts])]);
      const disabled = await getDisabledBuiltinOrigins();
      await setDisabledBuiltinOrigins(disabled.filter(origin => !hosts.includes(origin)));
    });
  granting = result;
  return result;
}
