import globals from 'globals';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import { createRequire } from 'node:module';

// Load the local CryptoClaw ESLint plugin (CommonJS module)
const require = createRequire(import.meta.url);
const cclawPlugin = require('./tools/eslint-plugin-cclaw/index.js');

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
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.spec.ts',
      '**/*.test.ts',
      '**/vitest.config.ts',
      // libs/prisma is the one place @prisma/client IS allowed — handled below
      'libs/prisma/src/**/*.ts',
      // Generated SDK output — not hand-authored; excluded from lint
      'sdk/generated/**/*.ts',
    ],
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
        // ADR-0026: ban configService.get<T>('') (bare empty-key access).
        // Use per-field gets: configService.get<string>('FIELD_NAME') instead.
        // This rule fires if the first argument to .get() is an empty string literal.
        {
          selector: "CallExpression[callee.property.name='get'][arguments.0.type='Literal'][arguments.0.value='']",
          message:
            "Bare-key configService.get<AppConfig>('') is forbidden (ADR-0026). " +
            "Use per-field gets: configService.get<string>('FIELD_NAME').",
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
  // libs/modules — additional $queryRawUnsafe warning rule.
  // Usages allowed but require inline eslint-disable + comment explaining why.
  // ----------------------------------------------------------------
  {
    files: ['libs/modules/**/*.ts'],
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
      // Warn when $queryRawUnsafe or $executeRawUnsafe is used in module repositories.
      // These are allowed but must be justified with an inline eslint-disable comment
      // explaining why Prisma typed methods cannot be used (ADR-0020).
      'no-restricted-syntax': [
        'warn',
        {
          selector:
            "CallExpression[callee.property.name='$queryRawUnsafe'], CallExpression[callee.property.name='$executeRawUnsafe']",
          message:
            '$queryRawUnsafe/$executeRawUnsafe is allowed but requires inline eslint-disable + comment explaining why Prisma typed methods cannot be used (ADR-0020).',
        },
      ],
    },
  },

  // ----------------------------------------------------------------
  // libs/prisma — @prisma/client imports are allowed here (SPEC §4 #1).
  // This is the ONLY place where PrismaClient is used directly.
  // ----------------------------------------------------------------
  {
    files: ['libs/prisma/src/**/*.ts'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts'],
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
      // @prisma/client is explicitly allowed inside libs/prisma
      'no-restricted-imports': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Direct process.env access is forbidden. Use the typed AppConfig from @cclaw/config instead.',
        },
        // ADR-0026: ban configService.get<T>('') (bare empty-key access).
        {
          selector: "CallExpression[callee.property.name='get'][arguments.0.type='Literal'][arguments.0.value='']",
          message:
            "Bare-key configService.get<AppConfig>('') is forbidden (ADR-0026). " +
            "Use per-field gets: configService.get<string>('FIELD_NAME').",
        },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },

  // ----------------------------------------------------------------
  // Config/bootstrap files that legitimately read process.env.
  // These are the ONLY files permitted to do so (SPEC §4 #6).
  // ----------------------------------------------------------------
  {
    files: [
      'libs/config/src/**/*.ts',
      'apps/*/src/main.ts',
      'apps/*/src/prisma-migrate.bootstrap.ts',
      'apps/*/src/app.module.ts',
      'libs/auth/src/auth.module.ts',
      'libs/prisma/src/prisma.module.ts',
    ],
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
  // CryptoClaw custom rules — controller files only
  // Enforces @Roles on handlers and @Audited on mutating handlers
  // (SPEC §4 #3, §9.5, ADR-0018, ADR-0019).
  // ----------------------------------------------------------------
  {
    files: ['apps/**/*.controller.ts', 'libs/modules/**/*.controller.ts', 'libs/health/src/*.controller.ts'],
    ignores: ['**/node_modules/**', '**/dist/**', '**/*.spec.ts'],
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
      cclaw: cclawPlugin,
    },
    rules: {
      ...tsPlugin.configs['recommended'].rules,
      'cclaw/require-roles-on-handlers': 'error',
      'cclaw/require-audited-on-mutating-handlers': 'error',
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
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: 'Direct process.env access is forbidden. Use the typed AppConfig from @cclaw/config instead.',
        },
        // ADR-0026: ban configService.get<T>('') (bare empty-key access).
        {
          selector: "CallExpression[callee.property.name='get'][arguments.0.type='Literal'][arguments.0.value='']",
          message:
            "Bare-key configService.get<AppConfig>('') is forbidden (ADR-0026). " +
            "Use per-field gets: configService.get<string>('FIELD_NAME').",
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
