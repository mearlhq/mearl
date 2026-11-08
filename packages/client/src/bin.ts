#!/usr/bin/env node

import { CLIENT_VERSION } from './runtimePaths.js';

const args = process.argv.slice(2);
if (args[0] === 'guide') {
  const { runGuideCli } = await import('./guide.js');
  process.exitCode = await runGuideCli(args.slice(1));
} else {
  const { runMearlCli } = await import('./cli.js');
  process.exitCode = await runMearlCli(args);
  const { scheduleCliAutoUpdate } = await import('./autoUpdate.js');
  scheduleCliAutoUpdate(CLIENT_VERSION);
}
