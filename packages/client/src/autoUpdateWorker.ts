import { runCliAutoUpdate } from './autoUpdate.js';

const [installedVersion, packageRoot, token] = process.argv.slice(2);
if (installedVersion && packageRoot && token) {
  await runCliAutoUpdate(installedVersion, packageRoot, token);
}
