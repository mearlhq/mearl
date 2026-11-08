import { describe, expect, it } from 'vitest';
import { extractCloudConnectorUrl } from '../cloudConnectorInput';

describe('extractCloudConnectorUrl', () => {
  it.each([
    [
      'npx --@mearl:registry=https://registry.npmjs.org @mearl/cloud-connector start "wss://cloud.example.com/ws?token=test"',
      'wss://cloud.example.com/ws?token=test',
    ],
    [
      'npx --@mearl:registry=https://registry.npmjs.org @mearl/cloud-connector start "qoder://pair/abcdefghijklmnop?created=1786729177143"',
      'qoder://pair/abcdefghijklmnop?created=1786729177143',
    ],
    [
      'npx --@mearl:registry=https://registry.npmjs.org @mearl/cloud-connector "qoder://pair/abcdefghijklmnop?created=1786729177143',
      'qoder://pair/abcdefghijklmnop?created=1786729177143',
    ],
    [
      'qoder://pair/abcdefghijklmnop?created=1786729177143',
      'qoder://pair/abcdefghijklmnop?created=1786729177143',
    ],
  ])('extracts a supported URL from %s', (input, expected) => {
    expect(extractCloudConnectorUrl(input)).toBe(expected);
  });

  it('keeps partial input editable until it contains a supported URL', () => {
    expect(extractCloudConnectorUrl('qoder://pa')).toBe('qoder://pa');
  });
});
