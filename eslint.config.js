import globals from 'globals';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  // ----------------------------------------------------------------
  // Legacy block — scripts/**/*.js and tests/**/*.js (unchanged from
  // the pre-P0 config; kept exactly as it was to preserve CI green).
  // ----------------------------------------------------------------
  {
    files: ['scripts/**/*.js', 'tests/**/*.js'],
    ignores: ['**/node_modules/**'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-duplicate-imports': 'error',
      'no-debugger': 'error',
      'no-constant-condition': 'warn',
    },
  },

  // ----------------------------------------------------------------
  // New TypeScript block — apps/**/*.ts, libs/**/*.ts, sdk/**/*.ts
  // Excludes vitest.config.ts files (not covered by tsconfig.json),
  // spec files (handled by the test block below), and dist/.
  // ----------------------------------------------------------------
  {
    files: ['apps/**/*.ts', 'libs/**/*.ts', 'sdk/**/*.ts'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts', '**/*.test.ts', '**/vitest.config.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // TypeScript recommended rules
      ...tsPlugin.configs['recommended'].rules,

      // Disallow @prisma/client imports outside libs/prisma (SPEC §4 #1)
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client'],
              message:
                'Direct @prisma/client imports are forbidden outside libs/prisma. Use the PrismaService from @cclaw/prisma instead.',
            },
          ],
        },
      ],

      // Disallow direct process.env access outside libs/config (SPEC §4 #6).
      // Legitimate exceptions use // eslint-disable-next-line no-restricted-syntax
      // with a justification comment.
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Direct process.env access is forbidden. Use the typed AppConfig from @cclaw/config instead.',
        },
      ],

      // No console.log in committed source (pre-commit hook also blocks this).
      // Exceptions use // eslint-disable-next-line no-console with a comment.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      // Relax some TS rules appropriate for P0 scaffolding
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ----------------------------------------------------------------
  // Config/bootstrap files that legitimately read process.env.
  // These are the ONLY files permitted to do so (SPEC §4 #6).
  // ----------------------------------------------------------------
  {
    files: ['libs/config/src/**/*.ts', 'libs/logger/src/logger.module.ts', 'apps/*/src/main.ts'],
    ignores: ['**/node_modules/**', '**/*.spec.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      // process.env is allowed in libs/config and app boot entrypoints
      'no-restricted-syntax': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/client'],
              message:
                'Direct @prisma/client imports are forbidden outside libs/prisma. Use the PrismaService from @cclaw/prisma instead.',
            },
          ],
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ----------------------------------------------------------------
  // Test and config files — relax rules
  // ----------------------------------------------------------------
  {
    files: ['**/*.spec.ts', '**/*.test.ts', 'tests/**/*.ts', '**/vitest.config.ts', 'vitest.workspace.ts'],
    ignores: ['**/node_modules/**'],
    languageOptions: {
      parser: tsParser,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-imports': 'off',
      'no-console': 'off',
    },
  },
];
