import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'src/database/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.mjs'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'grammy', message: 'domain/application must not depend on Telegram' },
            { name: 'express', message: 'domain/application must not depend on HTTP adapters' },
          ],
          patterns: [
            {
              group: [
                '**/telegram/**',
                '**/http/**',
                '**/workers/**',
                '**/database/**',
                '**/integrations/**',
              ],
              message: 'domain/application talks to the outside world only through ports',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/telegram/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'express', message: 'Telegram must not depend on the HTTP adapter' }],
          patterns: [
            {
              group: ['**/http/**', '**/workers/**', '**/database/**', '@prisma/*'],
              message:
                'Telegram depends on application/domain ports, not on Prisma, HTTP or workers',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
