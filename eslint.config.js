import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'public/js/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.js', 'scripts/*.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': 'warn',
    },
  },
  {
    files: ['eslint.config.js', 'scripts/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // node:test's `test()` intentionally returns a promise the top-level
    // call site does not await -- the test runner tracks completion itself.
    files: ['test/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
    },
  },
  eslintConfigPrettier,
);
