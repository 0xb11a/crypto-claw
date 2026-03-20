import globals from 'globals';

export default [
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
];
