#!/usr/bin/env node

import { main } from './uninstall.js';

process.exitCode = await main();
