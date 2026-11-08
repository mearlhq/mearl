import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { vitestExecArgv } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    execArgv: vitestExecArgv,
    name: 'client',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@mearl/provider/host': fileURLToPath(
        new URL('../provider/src/host.ts', import.meta.url),
      ),
      '@mearl/provider/runtime': fileURLToPath(
        new URL('../provider/src/runtime.ts', import.meta.url),
      ),
      '@mearl/provider': fileURLToPath(
        new URL('../provider/src/index.ts', import.meta.url),
      ),
    },
  },
});
