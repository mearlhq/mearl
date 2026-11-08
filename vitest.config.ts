import { defineConfig } from 'vitest/config';
import { availableParallelism } from 'node:os';
import { vitestExecArgv } from './vitest.shared.ts';

export default defineConfig({
  test: {
    execArgv: vitestExecArgv,
    maxWorkers: Math.min(4, availableParallelism()),
    projects: [
      'packages/*/vitest.config.ts',
      'packages/cloud/*/vitest.config.ts',
      { test: { name: 'skills', execArgv: vitestExecArgv, environment: 'node', include: ['skills/__tests__/**/*.test.{mjs,ts}'] } },
      { test: { name: 'scripts', environment: 'node', include: ['scripts/__tests__/**/*.test.mjs'] } },
    ],
  },
});
