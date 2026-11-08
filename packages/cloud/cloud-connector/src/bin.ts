#!/usr/bin/env node

import { main } from './cli.js';

try {
  process.exitCode = await main();
} catch (error) {
  console.error('[CloudConnector] Fatal error:', error);
  process.exitCode = 1;
}
