import { latestExtensionDownload } from '../lib/extension-download';

export async function GET(): Promise<Response> {
  const release = await latestExtensionDownload();
  if (!release) throw new Error('Cannot publish extension configuration without a release');
  return Response.json({ latestVersion: release.version, downloadUrl: release.url });
}
