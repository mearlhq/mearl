import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserExtensionConflictError,
  downloadMearlBrowserExtension,
  extensionArchiveUrl,
  fetchBrowserExtensionRelease,
  findLatestExtensionVersion,
  installMearlBrowserExtension,
  MEARL_EXTENSION_SETUP_MARKER,
  resolveChromeUserDataDirectory,
  updateSetupManagedBrowserExtensionFiles,
} from '../browserExtension.js';

const temporaryDirectories: string[] = [];

vi.mock('../setupVersion.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../setupVersion.js')>()),
  SETUP_VERSION: '3.0.0',
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mearl-extension-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('browser extension release resolution', () => {
  it('selects the newest archive advertised by the download page', () => {
    expect(
      findLatestExtensionVersion(`
        <a href="mearl-chrome-v2.7.9.zip">old</a>
        <a href="mearl-chrome-v2.8.0-beta.2.zip">beta</a>
        <a href="mearl-chrome-v2.8.0.zip">latest</a>
      `),
    ).toBe('2.8.0');
    expect(extensionArchiveUrl('2.8.0')).toBe(
      'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
    );
  });

  it('rejects unsafe archive versions', () => {
    expect(() => extensionArchiveUrl('../extension')).toThrow('Invalid');
  });

  it('reads and validates release metadata from remote config', async () => {
    await expect(
      fetchBrowserExtensionRelease(
        vi.fn<typeof fetch>(async () =>
          Response.json({
            latestVersion: '2.8.1',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            downloadSha256: 'A'.repeat(64),
          }),
        ),
      ),
    ).resolves.toEqual({
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
      sha256: 'a'.repeat(64),
      version: '2.8.1',
    });

    await expect(
      fetchBrowserExtensionRelease(
        vi.fn<typeof fetch>(async () =>
          Response.json({
            latestVersion: '2.8.1',
            downloadUrl: 'https://example.com/mearl-chrome-v2.8.1.zip',
          }),
        ),
      ),
    ).rejects.toThrow('does not match');
  });
});

describe('updateSetupManagedBrowserExtensionFiles', () => {
  it('validates SHA256 and atomically replaces a setup-managed directory', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'obsolete.txt'), 'old');
    fs.writeFileSync(
      path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER),
      JSON.stringify({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
        path: targetDirectory,
        schemaVersion: 1,
      }),
    );
    const archive = Buffer.from([80, 75, 3, 4]);
    const sha256 = createHash('sha256').update(archive).digest('hex');

    await expect(
      updateSetupManagedBrowserExtensionFiles(
        {
          release: {
            archiveUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            sha256,
            version: '2.8.1',
          },
          targetDirectory,
        },
        {
          fetch: vi.fn<typeof fetch>(async () => new Response(archive)),
          extractArchive: async (_archivePath, destination) => {
            fs.writeFileSync(
              path.join(destination, 'manifest.json'),
              JSON.stringify({
                key: 'stable-key',
                manifest_version: 3,
                name: 'Mearl',
                version: '2.8.1',
              }),
            );
          },
        },
      ),
    ).resolves.toMatchObject({ path: targetDirectory, sha256, version: '2.8.1' });
    expect(fs.existsSync(path.join(targetDirectory, 'obsolete.txt'))).toBe(false);
    expect(fs.existsSync(path.join(targetDirectory, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER))).toBe(true);
  });

  it('rejects a checksum mismatch before replacing existing files', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory);
    fs.writeFileSync(path.join(targetDirectory, 'existing.txt'), 'unchanged');
    fs.writeFileSync(
      path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER),
      JSON.stringify({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
        path: targetDirectory,
        schemaVersion: 1,
      }),
    );

    await expect(
      updateSetupManagedBrowserExtensionFiles(
        {
          release: {
            archiveUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.1/mearl-chrome-v2.8.1.zip',
            sha256: '0'.repeat(64),
            version: '2.8.1',
          },
          targetDirectory,
        },
        { fetch: vi.fn<typeof fetch>(async () => new Response(new Uint8Array([1, 2, 3]))) },
      ),
    ).rejects.toThrow('SHA256');
    expect(fs.readFileSync(path.join(targetDirectory, 'existing.txt'), 'utf8')).toBe('unchanged');
  });
});

describe('resolveChromeUserDataDirectory', () => {
  it('uses the default Chrome profile root on every desktop platform', () => {
    expect(resolveChromeUserDataDirectory('darwin', '/home/test')).toBe(
      '/home/test/Library/Application Support/Google/Chrome',
    );
    expect(resolveChromeUserDataDirectory('linux', '/home/test')).toBe(
      '/home/test/.config/google-chrome',
    );
    expect(
      resolveChromeUserDataDirectory('win32', 'C:\\Users\\test', {
        LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
      }),
    ).toBe(path.join('C:\\Users\\test\\AppData\\Local', 'Google', 'Chrome', 'User Data'));
  });
});

describe('installMearlBrowserExtension', () => {
  it('downloads the latest archive, replaces the stable directory, and loads it through CDP', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(path.join(targetDirectory, 'obsolete.txt'), 'old');
    const fetchImpl = vi.fn<typeof fetch>(async input => {
      const url = String(input);
      if (url.endsWith('/config.json')) {
        return Response.json({
          latestVersion: '2.8.0',
          downloadUrl:
            'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
        });
      }
      return new Response(new Uint8Array([80, 75, 3, 4]), {
        headers: { 'content-length': '4' },
      });
    });
    const extractArchive = vi.fn(async (_archivePath: string, destination: string) => {
      fs.writeFileSync(
        path.join(destination, 'manifest.json'),
        JSON.stringify({ key: 'stable-key', manifest_version: 3, name: 'Mearl', version: '2.8.0' }),
      );
      fs.writeFileSync(path.join(destination, 'service-worker-loader.js'), '');
    });
    const loadUnpacked = vi.fn(async () => ({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
    }));
    const inspectInstallation = vi.fn(async () => ({
      id: 'aoehhjnofngknnjefamjbplchbolghkm',
      location: 'UNPACKED',
      name: 'Mearl',
      path: targetDirectory,
      version: '2.7.0',
    }));

    await expect(
      installMearlBrowserExtension(
        { targetDirectory },
        { extractArchive, fetch: fetchImpl, inspectInstallation, loadUnpacked },
      ),
    ).resolves.toEqual({
      activation: 'cdp',
      archiveUrl:
        'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
      filesUpdated: true,
      loaded: true,
      path: targetDirectory,
      version: '2.8.0',
    });
    expect(fs.existsSync(path.join(targetDirectory, 'obsolete.txt'))).toBe(false);
    expect(fs.existsSync(path.join(targetDirectory, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER))).toBe(true);
    expect(loadUnpacked).toHaveBeenCalledWith(targetDirectory, expect.any(String));
  });

  it('reuses one CDP connection for source inspection and initial loading', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );
    const session = {
      close: vi.fn(),
      inspectInstallation: vi.fn(async () => null),
      loadUnpacked: vi.fn(async () => ({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
      })),
    };
    const connectCdp = vi.fn(async () => session);

    const result = await installMearlBrowserExtension(
      { targetDirectory },
      {
        connectCdp,
        fetch: fetchImpl,
        extractArchive: async (_archivePath, destination) => {
          fs.writeFileSync(
            path.join(destination, 'manifest.json'),
            JSON.stringify({
              key: 'stable-key',
              manifest_version: 3,
              name: 'Mearl',
              version: '2.8.0',
            }),
          );
        },
      },
    );

    expect(result).toMatchObject({ activation: 'cdp', loaded: true });
    expect(connectCdp).toHaveBeenCalledOnce();
    expect(session.inspectInstallation).toHaveBeenCalledOnce();
    expect(session.loadUnpacked).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('skips source inspection when force is set and loads through the shared CDP connection', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );
    const session = {
      close: vi.fn(),
      inspectInstallation: vi.fn(async () => {
        throw new Error('Unexpected end of JSON input');
      }),
      loadUnpacked: vi.fn(async () => ({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
      })),
    };

    const result = await installMearlBrowserExtension(
      { force: true, targetDirectory },
      {
        connectCdp: vi.fn(async () => session),
        fetch: fetchImpl,
        extractArchive: async (_archivePath, destination) => {
          fs.writeFileSync(
            path.join(destination, 'manifest.json'),
            JSON.stringify({
              key: 'stable-key',
              manifest_version: 3,
              name: 'Mearl',
              version: '2.8.0',
            }),
          );
        },
      },
    );

    expect(result).toMatchObject({ activation: 'cdp', loaded: true });
    expect(session.inspectInstallation).not.toHaveBeenCalled();
    expect(session.loadUnpacked).toHaveBeenCalledWith(targetDirectory);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('updates a confirmed setup-managed extension and reloads it without CDP', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER),
      JSON.stringify({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
        path: targetDirectory,
        schemaVersion: 1,
      }),
    );
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );
    const inspectInstalled = vi.fn(async () => ['chrome:profile-a']);
    const reloadInstalled = vi.fn(async () => {});
    const inspectInstallation = vi.fn();
    const loadUnpacked = vi.fn();

    const result = await installMearlBrowserExtension(
      { targetDirectory },
      {
        extractArchive: async (_archivePath, destination) => {
          fs.writeFileSync(
            path.join(destination, 'manifest.json'),
            JSON.stringify({
              key: 'stable-key',
              manifest_version: 3,
              name: 'Mearl',
              version: '2.8.0',
            }),
          );
        },
        fetch: fetchImpl,
        inspectInstalled,
        inspectInstallation,
        loadUnpacked,
        reloadInstalled,
      },
    );

    expect(result).toMatchObject({ activation: 'native-host', loaded: true });
    expect(reloadInstalled).toHaveBeenCalledWith(['chrome:profile-a']);
    expect(inspectInstallation).not.toHaveBeenCalled();
    expect(loadUnpacked).not.toHaveBeenCalled();
  });

  it('falls back to CDP when the optional Native Host reload path is unavailable', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER),
      JSON.stringify({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
        path: targetDirectory,
        schemaVersion: 1,
      }),
    );
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );
    const inspectInstallation = vi.fn(async () => null);
    const loadUnpacked = vi.fn(async () => ({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
    }));

    const result = await installMearlBrowserExtension(
      { targetDirectory },
      {
        extractArchive: async (_archivePath, destination) => {
          fs.writeFileSync(
            path.join(destination, 'manifest.json'),
            JSON.stringify({
              key: 'stable-key',
              manifest_version: 3,
              name: 'Mearl',
              version: '2.8.0',
            }),
          );
        },
        fetch: fetchImpl,
        inspectInstalled: vi.fn(async () => {
          throw new Error('Native Host is unavailable');
        }),
        inspectInstallation,
        loadUnpacked,
      },
    );

    expect(result).toMatchObject({ activation: 'cdp', loaded: true });
    expect(inspectInstallation).toHaveBeenCalledOnce();
    expect(loadUnpacked).toHaveBeenCalledOnce();
  });

  it('does not trust a stale setup marker after the store extension replaces it', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(path.join(targetDirectory, 'existing.txt'), 'unchanged');
    fs.writeFileSync(
      path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER),
      JSON.stringify({
        extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
        path: targetDirectory,
        schemaVersion: 1,
      }),
    );
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        latestVersion: '2.8.0',
        downloadUrl:
          'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
      }),
    );

    await expect(
      installMearlBrowserExtension(
        { targetDirectory },
        {
          fetch: fetchImpl,
          inspectInstalled: vi.fn(async () => []),
          inspectInstallation: vi.fn(async () => ({
            id: 'aoehhjnofngknnjefamjbplchbolghkm',
            location: 'INTERNAL',
            name: 'Mearl',
            path: '/Chrome/Default/Extensions/aoehhjnofngknnjefamjbplchbolghkm/2.8.0_0',
            version: '2.8.0',
          })),
        },
      ),
    ).rejects.toBeInstanceOf(BrowserExtensionConflictError);
    expect(fs.readFileSync(path.join(targetDirectory, 'existing.txt'), 'utf8')).toBe('unchanged');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('does not download or mutate the target when CDP is unavailable', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );
    const extractArchive = vi.fn(async (_archivePath: string, destination: string) => {
      fs.writeFileSync(
        path.join(destination, 'manifest.json'),
        JSON.stringify({ key: 'stable-key', manifest_version: 3, name: 'Mearl', version: '2.8.0' }),
      );
    });

    const result = await installMearlBrowserExtension(
      { targetDirectory },
      {
        extractArchive,
        fetch: fetchImpl,
        inspectInstallation: vi.fn(async () => {
          throw new Error('Chrome remote debugging is not enabled');
        }),
      },
    );

    expect(result).toMatchObject({
      cdpError: 'Chrome remote debugging is not enabled',
      loaded: false,
      path: targetDirectory,
      version: '2.8.0',
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(extractArchive).not.toHaveBeenCalled();
    expect(fs.existsSync(targetDirectory)).toBe(false);
  });

  it('does not wait when Chrome reports an unsupported CDP method', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    const sleep = vi.fn(async () => {});

    const result = await installMearlBrowserExtension(
      { targetDirectory, waitForCdpMs: 120_000 },
      {
        connectCdp: vi.fn(async () => {
          throw new Error("'Extensions.loadUnpacked' wasn't found");
        }),
        fetch: vi.fn<typeof fetch>(async () =>
          Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          }),
        ),
        sleep,
      },
    );

    expect(result).toMatchObject({
      cdpError: "'Extensions.loadUnpacked' wasn't found",
      loaded: false,
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(fs.existsSync(targetDirectory)).toBe(false);
  });

  it('preserves a store installation unless force is set', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    fs.mkdirSync(targetDirectory, { recursive: true });
    fs.writeFileSync(path.join(targetDirectory, 'existing.txt'), 'unchanged');
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({
        latestVersion: '2.8.0',
        downloadUrl:
          'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
      }),
    );
    const installed = {
      id: 'aoehhjnofngknnjefamjbplchbolghkm',
      location: 'INTERNAL',
      name: 'Mearl',
      path: '/Chrome/Default/Extensions/aoehhjnofngknnjefamjbplchbolghkm/2.7.2_0',
      version: '2.7.2',
    };
    const loadUnpacked = vi.fn(async () => ({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
    }));

    await expect(
      installMearlBrowserExtension(
        { targetDirectory },
        {
          fetch: fetchImpl,
          inspectInstallation: vi.fn(async () => installed),
          loadUnpacked,
        },
      ),
    ).rejects.toBeInstanceOf(BrowserExtensionConflictError);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(loadUnpacked).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(targetDirectory, 'existing.txt'), 'utf8')).toBe('unchanged');
  });

  it('replaces a non-setup installation when force is set', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );
    const extractArchive = vi.fn(async (_archivePath: string, destination: string) => {
      fs.writeFileSync(
        path.join(destination, 'manifest.json'),
        JSON.stringify({ key: 'stable-key', manifest_version: 3, name: 'Mearl', version: '2.8.0' }),
      );
    });
    const loadUnpacked = vi.fn(async () => ({
      extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
    }));

    const result = await installMearlBrowserExtension(
      { force: true, targetDirectory },
      {
        extractArchive,
        fetch: fetchImpl,
        inspectInstallation: vi.fn(async () => ({
          id: 'aoehhjnofngknnjefamjbplchbolghkm',
          location: 'INTERNAL',
          name: 'Mearl',
          path: '/Chrome/Default/Extensions/aoehhjnofngknnjefamjbplchbolghkm/2.7.2_0',
          version: '2.7.2',
        })),
        loadUnpacked,
      },
    );

    expect(result.loaded).toBe(true);
    expect(loadUnpacked).toHaveBeenCalledOnce();
  });

  it('rejects an archive whose manifest version does not match the advertised release', async () => {
    const root = temporaryDirectory();
    const targetDirectory = path.join(root, 'chrome-extension');
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      String(input).endsWith('/config.json')
        ? Response.json({
            latestVersion: '2.8.0',
            downloadUrl:
              'https://github.com/mearlhq/mearl/releases/download/v2.8.0/mearl-chrome-v2.8.0.zip',
          })
        : new Response(new Uint8Array([80, 75, 3, 4])),
    );

    await expect(
      installMearlBrowserExtension(
        { targetDirectory },
        {
          fetch: fetchImpl,
          inspectInstallation: vi.fn(async () => null),
          extractArchive: async (_archivePath, destination) => {
            fs.writeFileSync(
              path.join(destination, 'manifest.json'),
              JSON.stringify({
                key: 'stable-key',
                manifest_version: 3,
                name: 'Mearl',
                version: '2.7.0',
              }),
            );
          },
        },
      ),
    ).rejects.toThrow('does not match 2.8.0');
    expect(fs.existsSync(targetDirectory)).toBe(false);
  });
});

it('reads an explicit release configuration at request time', async () => {
  vi.stubEnv('MEARL_EXTENSION_CONFIG_URL', 'https://updates.example.com/releases/config.json');
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      latestVersion: '3.0.0',
      downloadUrl: 'https://updates.example.com/releases/mearl-chrome-v3.0.0.zip',
    }),
  );
  await expect(fetchBrowserExtensionRelease(fetcher)).resolves.toEqual({
    version: '3.0.0',
    archiveUrl: 'https://updates.example.com/releases/mearl-chrome-v3.0.0.zip',
  });
  expect(fetcher).toHaveBeenCalledWith('https://updates.example.com/releases/config.json', {
    cache: 'no-store',
  });
});

it('does not invent a release when release metadata is missing', async () => {
  await expect(
    fetchBrowserExtensionRelease(vi.fn<typeof fetch>(async () => Response.json({}))),
  ).rejects.toThrow();
});

it('installs a beta archive by verifying its numeric Chrome version and display release together', async () => {
  const root = temporaryDirectory();
  const targetDirectory = path.join(root, 'beta-extension');
  const archiveUrl =
    'https://github.com/mearlhq/mearl/releases/download/v3.0.0-beta.0/mearl-chrome-v3.0.0-beta.0.zip';
  await expect(
    installMearlBrowserExtension(
      { targetDirectory },
      {
        fetch: vi.fn<typeof fetch>(async input =>
          String(input).endsWith('/config.json')
            ? Response.json({ latestVersion: '3.0.0-beta.0', downloadUrl: archiveUrl })
            : new Response(new Uint8Array([80, 75, 3, 4])),
        ),
        inspectInstallation: vi.fn(async () => null),
        extractArchive: async (_file, destination) => {
          fs.writeFileSync(
            path.join(destination, 'manifest.json'),
            JSON.stringify({
              key: 'stable-key',
              manifest_version: 3,
              name: 'Mearl',
              version: '3.0.0.0',
              version_name: '3.0.0-beta.0',
            }),
          );
        },
      },
    ),
  ).resolves.toMatchObject({ version: '3.0.0-beta.0' });
});

describe('real extension ZIP extraction', () => {
  it('unpacks downloads into separate directories for manual loading and cleans up an invalid download', async () => {
    const directory = temporaryDirectory();
    const archive = new AdmZip();
    const manifest = { manifest_version: 3, name: 'Mearl', version: '3.0.0', key: 'stable-key' };
    archive.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    archive.addFile('assets/app.js', Buffer.from('example'));
    const buffer = new Uint8Array(archive.toBuffer());
    const archiveUrl = extensionArchiveUrl(manifest.version);
    const fetchImpl = vi.fn<typeof fetch>(async input =>
      input === archiveUrl
        ? new Response(buffer)
        : Response.json({ latestVersion: manifest.version, downloadUrl: archiveUrl }),
    );

    const first = await downloadMearlBrowserExtension(directory, { fetch: fetchImpl });
    const second = await downloadMearlBrowserExtension(directory, { fetch: fetchImpl });
    expect(second.path).not.toBe(first.path);
    for (const result of [first, second]) {
      expect(result.version).toBe(manifest.version);
      expect(path.dirname(result.path)).toBe(directory);
      expect(fs.readFileSync(path.join(result.path, 'assets/app.js'), 'utf8')).toBe('example');
      expect(fs.existsSync(path.join(result.path, MEARL_EXTENSION_SETUP_MARKER))).toBe(false);
    }

    fetchImpl.mockImplementation(async input =>
      input === archiveUrl
        ? new Response('invalid archive')
        : Response.json({ latestVersion: manifest.version, downloadUrl: archiveUrl }),
    );
    await expect(downloadMearlBrowserExtension(directory, { fetch: fetchImpl })).rejects.toThrow();
    expect(fs.readdirSync(directory).sort()).toEqual(
      [first.path, second.path].map(value => path.basename(value)).sort(),
    );
  });

  it.each(['file', 'symlink', 'traversal', 'windows-path', 'corrupt-deflate'])(
    'handles a %s entry without escaping or damaging the installed extension',
    async kind => {
      const root = temporaryDirectory();
      const targetDirectory = path.join(root, 'chrome-extension');
      const outside = path.join(root, 'outside.txt');
      fs.mkdirSync(targetDirectory);
      fs.writeFileSync(outside, 'outside-original');
      fs.writeFileSync(path.join(targetDirectory, 'existing.txt'), 'installed-original');
      fs.writeFileSync(
        path.join(targetDirectory, MEARL_EXTENSION_SETUP_MARKER),
        JSON.stringify({
          schemaVersion: 1,
          extensionId: 'aoehhjnofngknnjefamjbplchbolghkm',
          path: targetDirectory,
        }),
      );
      const archive = new AdmZip();
      archive.addFile(
        'manifest.json',
        Buffer.from(
          JSON.stringify({
            manifest_version: 3,
            name: 'Mearl',
            version: '3.0.0',
            key: 'stable-key',
          }),
        ),
      );
      archive.addFile('assets/', Buffer.alloc(0));
      const entry = archive.addFile('assets/app.js', Buffer.from('example'));
      if (kind === 'symlink') {
        entry.header.attr = (0o120777 << 16) >>> 0;
        archive.updateFile(entry, Buffer.from(outside));
      } else if (kind === 'traversal') {
        entry.entryName = '../outside.txt';
      } else if (kind === 'windows-path') {
        entry.entryName = 'C:\\outside.txt';
      }
      const buffer = archive.toBuffer();
      if (kind === 'corrupt-deflate') {
        const header = buffer.indexOf(Buffer.from('assets/app.js')) - 30;
        expect(buffer.readUInt32LE(header)).toBe(0x04034b50);
        const payload =
          header + 30 + buffer.readUInt16LE(header + 26) + buffer.readUInt16LE(header + 28);
        buffer[payload] = 0x07; // Reserved DEFLATE block type: must reject, never crash the process.
      }
      const result = updateSetupManagedBrowserExtensionFiles(
        {
          targetDirectory,
          release: {
            version: '3.0.0',
            archiveUrl:
              'https://github.com/mearlhq/mearl/releases/download/v3.0.0/mearl-chrome-v3.0.0.zip',
          },
        },
        { fetch: vi.fn<typeof fetch>(async () => new Response(new Uint8Array(buffer))) },
      );
      if (kind === 'file') {
        await expect(result).resolves.toMatchObject({ version: '3.0.0' });
        expect(fs.readFileSync(path.join(targetDirectory, 'assets/app.js'), 'utf8')).toBe(
          'example',
        );
        expect(fs.existsSync(path.join(targetDirectory, 'existing.txt'))).toBe(false);
      } else {
        if (kind === 'corrupt-deflate') await expect(result).rejects.toThrow();
        else await expect(result).rejects.toThrow('unsafe entry');
        expect(fs.readFileSync(path.join(targetDirectory, 'existing.txt'), 'utf8')).toBe(
          'installed-original',
        );
      }
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside-original');
      expect(fs.readdirSync(root).sort()).toEqual(['chrome-extension', 'outside.txt']);
    },
  );
});
