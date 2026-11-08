#!/usr/bin/env node

import { main } from './configure.js';

process.exitCode = await main();
