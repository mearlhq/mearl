import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { vitestExecArgv } from '../../vitest.shared';

export default defineConfig({
  plugins: [react()],
  test: {
    execArgv: vitestExecArgv,
    globals: true,
    environment: 'happy-dom',
    // Tests drive iframe messages and load events themselves; never navigate test frames.
    environmentOptions: {
      happyDOM: {
        settings: {
          enableIframePageLoading: true,
          navigation: { disableChildFrameNavigation: true, disableFallbackToSetURL: true },
        },
      },
    },
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 8000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/test/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/dist/**',
        '**/dist_chrome/**',
      ],
    },
    include: ['**/*.{test,spec}.{ts,tsx}'],
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: '@mearl/app-profiles/metadata',
        replacement: path.resolve(__dirname, '../app-profiles/src/metadata.ts'),
      },
      {
        find: '@mearl/browser-core',
        replacement: path.resolve(__dirname, '../browser-core/src'),
      },
      {
        find: '@mearl/app-profiles',
        replacement: path.resolve(__dirname, '../app-profiles/src/index.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
});
