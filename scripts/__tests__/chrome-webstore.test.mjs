import { afterEach, expect, it, vi } from 'vitest';
import { storeRequest, storeZipVersion, submitReview } from '../chrome-webstore.mjs';

const version = '3.0.0.65535';
const zip = Buffer.from('verified extension archive');
const olderReview = { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '2.23.0.65535' }] };

afterEach(() => vi.unstubAllGlobals());

it('accepts only the matching stable Chrome manifest with its build permissions', () => {
  const manifest = { version, version_name: '3.0.0', optional_host_permissions: ['<all_urls>'] };
  expect(storeZipVersion(manifest, '3.0.0')).toBe(version);
  expect(() => storeZipVersion({ ...manifest, version: '3.0.0.0' }, '3.0.0')).toThrow('stable release');
  expect(() => storeZipVersion({ version: '3.0.0.0', version_name: '3.0.0-beta.0' }, '3.0.0-beta.0')).toThrow('stable release');
  expect(() => storeZipVersion({ ...manifest, host_permissions: ['<all_urls>'] }, '3.0.0')).toThrow('host permission');
});

it('waits for an asynchronous upload and submits it for review with automatic publishing after approval', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '2.23.0' }] } })
    .mockResolvedValueOnce({ uploadState: 'IN_PROGRESS' })
    .mockResolvedValueOnce({ lastAsyncUploadState: 'SUCCEEDED' })
    .mockResolvedValueOnce({ state: 'PENDING_REVIEW' });
  await expect(submitReview(request, zip, version, async () => {})).resolves.toBe('PENDING_REVIEW');
  expect(request.mock.calls).toEqual([
    ['fetchStatus'],
    ['upload', zip],
    ['fetchStatus'],
    ['publish', { publishType: 'DEFAULT_PUBLISH', skipReview: false, blockOnWarnings: true }],
  ]);
});

it('cancels an older review with an empty POST before uploading and submitting the new version', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ submittedItemRevisionStatus: olderReview }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({ submittedItemRevisionStatus: { ...olderReview, state: 'CANCELLED' } }))
    .mockResolvedValueOnce(Response.json({ uploadState: 'SUCCEEDED', crxVersion: version }))
    .mockResolvedValueOnce(Response.json({ state: 'PENDING_REVIEW' }));
  vi.stubGlobal('fetch', fetch);

  const extensionId = 'a'.repeat(32);
  const request = storeRequest('publisher', extensionId, 'token');
  await expect(submitReview(request, zip, version)).resolves.toBe('PENDING_REVIEW');
  const item = `https://chromewebstore.googleapis.com/v2/publishers/publisher/items/${extensionId}`;
  expect(fetch.mock.calls.map(([url, { method }]) => [url, method])).toEqual([
    [`${item}:fetchStatus`, 'GET'],
    [`${item}:cancelSubmission`, 'POST'],
    [`${item}:fetchStatus`, 'GET'],
    [item.replace('/v2/', '/upload/v2/') + ':upload', 'POST'],
    [`${item}:publish`, 'POST'],
  ]);
  expect(fetch.mock.calls[1][1].body).toBeUndefined();
});

it('stops before uploading if cancellation fails', async () => {
  const request = vi.fn()
    .mockResolvedValueOnce({ submittedItemRevisionStatus: olderReview })
    .mockRejectedValueOnce(new Error('Cancellation failed'));
  await expect(submitReview(request, zip, version)).rejects.toThrow('Cancellation failed');
  expect(request.mock.calls).toEqual([['fetchStatus'], ['cancelSubmission']]);
});

it.each([
  [olderReview, 'PENDING_REVIEW'],
  [{ state: 'STAGED', distributionChannels: olderReview.distributionChannels }, 'STAGED'],
])('checks for active submissions again after cancellation', async (submission, error) => {
  const request = vi.fn()
    .mockResolvedValueOnce({ submittedItemRevisionStatus: olderReview })
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ submittedItemRevisionStatus: submission });
  await expect(submitReview(request, zip, version)).rejects.toThrow(error);
  expect(request.mock.calls).toEqual([['fetchStatus'], ['cancelSubmission'], ['fetchStatus']]);
});

it.each([
  ['publishedItemRevisionStatus', 'PUBLISHED'],
  ['submittedItemRevisionStatus', 'PENDING_REVIEW'],
])('leaves an existing submission for the same version untouched', async (field, state) => {
  const request = vi.fn().mockResolvedValue({ [field]: { state, distributionChannels: [{ crxVersion: version }] } });
  await expect(submitReview(request, zip, version)).resolves.toBe(state);
  expect(request.mock.calls).toEqual([['fetchStatus']]);
});

it.each([
  [{ lastAsyncUploadState: 'IN_PROGRESS', submittedItemRevisionStatus: olderReview }, 'already in progress'],
  [{ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '3.0.1.65535' }] } }, 'PENDING_REVIEW'],
  [{ submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }, 'PENDING_REVIEW'],
  [{ submittedItemRevisionStatus: { ...olderReview, state: 'STAGED' } }, 'STAGED'],
  [{ publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '3.0.1.65535' }] } }, 'newer extension version'],
])('stops before uploading if the store already has conflicting work', async (status, error) => {
  const request = vi.fn().mockResolvedValue(status);
  await expect(submitReview(request, zip, version)).rejects.toThrow(error);
  expect(request.mock.calls).toEqual([['fetchStatus']]);
});

it.each([
  [{ uploadState: 'FAILED' }, 'upload is FAILED'],
  [{ uploadState: 'SUCCEEDED', crxVersion: '3.0.1.65535' }, 'received version'],
])('does not submit a failed or mismatched upload', async (upload, error) => {
  const request = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce(upload);
  await expect(submitReview(request, zip, version)).rejects.toThrow(error);
  expect(request.mock.calls).toEqual([['fetchStatus'], ['upload', zip]]);
});
