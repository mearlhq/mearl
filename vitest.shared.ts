import { allowedNodeEnvironmentFlags } from 'node:process';

const disableWebStorageFlag = '--no-webstorage';

// Let Vitest environments own Web Storage when the active Node release exposes the opt-out flag.
export const vitestExecArgv = allowedNodeEnvironmentFlags.has(disableWebStorageFlag)
  ? [disableWebStorageFlag]
  : [];
