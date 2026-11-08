import { defineConfig } from 'vitest/config';
import { vitestExecArgv } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    execArgv: vitestExecArgv,
    name: 'native-host',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
