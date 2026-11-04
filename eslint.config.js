import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.claude/worktrees/**', '**/dist/**', '**/node_modules/**', 'packages/contract/src/generated/**', 'packages/app/dist/**', 'packages/app/src-tauri/**', 'packages/cli/templates/devhost-root.js'] }, // JXA (osascript), not Node: property-style ObjC calls
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // Node scripts outside the packages (npm run soak).
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', setTimeout: 'readonly' } },
  },
  {
    // Plugins run under the CLI's Node.
    files: ['plugins/**/*.js'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } },
  },
  {
    files: ['packages/app/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    // The two classic rules; the React Compiler rules of v7's preset do not apply (no compiler here).
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
);
