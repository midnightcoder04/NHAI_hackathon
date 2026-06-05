// ESLint v9 flat config (migrated from .eslintrc.js).
// Mirrors the previous setup: eslint:recommended + @typescript-eslint/recommended +
// react/recommended + the stable react-hooks rules + prettier (formatting off).
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const reactNative = require('eslint-plugin-react-native');
const prettier = require('eslint-config-prettier');
const globals = require('globals');

module.exports = [
  {
    // Build output, native projects, generated/CJS tooling files.
    ignores: [
      'node_modules/**',
      'android/**',
      'ios/**',
      'coverage/**',
      'assets/**',
      'babel.config.js',
      'metro.config.js',
      'jest.setup.js',
      'eslint.config.js',
    ],
  },

  js.configs.recommended,
  // flat/recommended is an array that also wires the @typescript-eslint parser.
  ...tsPlugin.configs['flat/recommended'],
  react.configs.flat.recommended,

  {
    files: ['**/*.{ts,tsx,js,jsx}'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      // Replaces the old `env: { 'react-native/react-native': true }` — RN runs in a
      // browser-like + node-ish global scope, plus the __DEV__ flag.
      globals: { ...globals.browser, ...globals.node, __DEV__: 'readonly' },
    },
    plugins: { 'react-native': reactNative, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/react-in-jsx-scope': 'off',
      // Honour the codebase's `_`-prefix convention for intentionally-unused args/vars.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      // react-hooks v7 ships many experimental rules under "recommended"; enable the
      // two stable, long-standing ones the codebase was written against.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    // Jest globals for the test suites; mock factories legitimately use require()
    // (they cannot reference out-of-scope imports).
    files: ['**/__tests__/**/*.{ts,tsx,js,jsx}', '**/*.test.{ts,tsx,js,jsx}'],
    languageOptions: { globals: { ...globals.jest } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },

  // Must be last: turns off stylistic rules that conflict with Prettier.
  prettier,
];
