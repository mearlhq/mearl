import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { vitestExecArgv } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: { '@mearl/browser-core': fileURLToPath(new URL('../browser-core/src/index.ts', import.meta.url)) } },
  test: {
    execArgv: vitestExecArgv,
    name: 'app-profiles',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
