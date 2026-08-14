import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // core 是纯逻辑层，必须可以脱离 VS Code 单测；这条规则把约定变成可执行的强制。
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'vscode', message: 'src/core 不得依赖 vscode，请在上层做类型转换。' }] }],
    },
  },
  {
    ignores: ['dist/**', 'dist-test/**', 'node_modules/**'],
  },
);
