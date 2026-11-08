import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { vitestExecArgv } from '../../vitest.shared.ts';

export default defineConfig({
  test: {
    execArgv: vitestExecArgv,
    name: 'setup',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@mearl/client/native-host': fileURLToPath(
        new URL('../client/src/nativeHost.ts', import.meta.url),
      ),
      '@mearl/provider/host': fileURLToPath(
        new URL('../provider/src/host.ts', import.meta.url),
      ),
    },
  },
});
