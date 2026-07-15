import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'out/**',
      'release/**',
      'release-smoke/**',
      'smoke-data/**',
      'data/**',
      'coverage/**',
      'node_modules/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'react-hooks/set-state-in-effect': 'off',
    },
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
  {
    files: ['electron/**/*.cjs', 'forge.config.cjs'],
    languageOptions: {
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['miniprogram/**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        App: 'readonly',
        Page: 'readonly',
        Component: 'readonly',
        getApp: 'readonly',
        wx: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Promise: 'readonly',
        require: 'readonly',
        module: 'readonly',
        Error: 'readonly',
        Math: 'readonly',
        Date: 'readonly',
        JSON: 'readonly',
        encodeURIComponent: 'readonly',
        Boolean: 'readonly',
        Number: 'readonly',
      },
    },
  },
);
