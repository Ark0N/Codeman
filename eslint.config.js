// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'off',
      'no-debugger': 'error',
      // Relax some rules that conflict with existing patterns
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'off', // TypeScript compiler already handles this
    },
  },
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'src/web/public/vendor/**',
      'src/web/public/app.js',
      'scripts/**/*.mjs',
      'tools/**',
      'remotion/**',
    ],
  }
);
