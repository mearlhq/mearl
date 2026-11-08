import { defineConfig } from 'vitest/config';
import { vitestExecArgv } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    execArgv: vitestExecArgv,
    name: 'plugin-qoder',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
