/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, es2022: true },
  ignorePatterns: ['dist', 'coverage', 'node_modules'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
  },
  overrides: [
    {
      // The browser entry must stay free of Node and server code (AC3); fail fast in the editor
      // rather than only in the check-browser CI step.
      files: ['src/client/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              { group: ['node:*', '@aws-sdk/*', '@nestjs/*'], message: 'The client entry must be browser-safe.' },
              { group: ['../*', '!../errors'], message: 'The client entry may only import ../errors.' },
            ],
          },
        ],
      },
    },
    {
      files: ['src/**/*.ts'],
      excludedFiles: ['src/nestjs/**'],
      rules: {
        'no-restricted-imports': [
          'error',
          { patterns: [{ group: ['@nestjs/*', 'reflect-metadata'], message: 'Only src/nestjs may import NestJS (AC4).' }] },
        ],
      },
    },
  ],
};
