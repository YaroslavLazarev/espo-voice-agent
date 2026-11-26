import pluginVue from 'eslint-plugin-vue';
import { configureVueProject, defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript';

// Resolve tsconfigs relative to the repo root, so `eslint .` works from any workspace.
configureVueProject({ rootDir: import.meta.dirname });

export default defineConfigWithVueTs(
  { ignores: ['**/node_modules/**', '**/dist/**', 'eslint.config.js'] },
  pluginVue.configs['flat/recommended'],
  vueTsConfigs.strictTypeChecked,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
);
