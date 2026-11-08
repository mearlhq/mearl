#!/usr/bin/env node
import { createQoderPairingInfo, formatQoderPairingOutput } from './pairing.js';
import { readFileSync } from 'node:fs';

if (process.argv[2] === '--version' || process.argv[2] === '-v') console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
else if (process.argv[2] === 'pair') console.log(formatQoderPairingOutput(createQoderPairingInfo()));
else {
  console.log('Usage: mearl-qoder pair\nInstall the Qoder capability preset on the browser machine before starting its connector.');
  if (process.argv[2] && !['--help', '-h'].includes(process.argv[2])) process.exitCode = 2;
}
