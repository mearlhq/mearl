import js from '@eslint/js';
import prettierConfig from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['**/dist/**', '**/dist_chrome/**', '**/build/**'] },
  {
    files: ['packages/**/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended, prettierConfig],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Input validators use control-character ranges to reject unsafe values.
      'no-control-regex': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-assignment': 'warn',
      'no-useless-catch': 'warn',
      'no-useless-escape': 'warn',
      'prefer-const': 'error',
      'preserve-caught-error': 'warn',
    },
  },
]);
