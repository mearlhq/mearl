import { describe, expect, it } from 'vitest';
import { isValidServiceDefaultsCache, resolveExternalServices } from '../externalServices';

describe('external service defaults', () => {
  it('disables services without installed defaults', () => {
    expect(resolveExternalServices({}, undefined)).toEqual({
      accountsEnabled: false,
      requestCasesEnabled: false,
      requestMetadataEnabled: false,
      requestImportEnabled: false,
      trackingMetadataEnabled: false,
    });
  });

  it('uses installed defaults and preserves explicit true and false choices', () => {
    const cache = { services: { accountsEnabled: true, requestCasesEnabled: false, requestMetadataEnabled: true } };
    expect(resolveExternalServices({ accountsEnabled: false, requestCasesEnabled: true }, cache)).toEqual({
      accountsEnabled: false,
      requestCasesEnabled: true,
      requestMetadataEnabled: true,
      requestImportEnabled: false,
      trackingMetadataEnabled: false,
    });
  });

  it('accepts custom declared service keys', () => {
    const key = `${'a'.repeat(96)}Enabled`;
    const cache = { services: { [key]: true, accountsEnabled: true } };
    expect(isValidServiceDefaultsCache(cache)).toBe(true);
    expect(resolveExternalServices({}, cache).accountsEnabled).toBe(true);
    expect(isValidServiceDefaultsCache({ services: {} })).toBe(true);
  });

  it.each([null, {}, [], { services: null }, { services: [] }, { services: { accountsEnabled: 'true' } }])('ignores malformed defaults %j', cache => {
    expect(isValidServiceDefaultsCache(cache)).toBe(false);
    expect(resolveExternalServices({ accountsEnabled: true }, cache).accountsEnabled).toBe(true);
    expect(resolveExternalServices({}, cache).accountsEnabled).toBe(false);
  });
});
