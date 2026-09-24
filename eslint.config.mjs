// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      '**/*.config.js',
      'docs/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },

  // ---------------------------------------------------------------------------
  // Architectural guardrails.
  //
  // These encode decisions that are otherwise only written down. A rule that
  // fails CI is worth more than a paragraph nobody re-reads — especially on a
  // solo build with no reviewer (R15).
  // ---------------------------------------------------------------------------

  {
    files: ['apps/mobile/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@react-native-async-storage/async-storage',
              message:
                'Session tokens must live in expo-secure-store (Keychain/Keystore). ' +
                'AsyncStorage is unencrypted plain text. See README §9.1.',
            },
            {
              name: '@supabase/supabase-js',
              message:
                'The app does not talk to the database directly except on the narrow ' +
                'Path A reads. Use @nikahmate/api-client. See README §9.2.',
            },
          ],
          patterns: [
            {
              group: ['**/services/api/**', '@nikahmate/api/*'],
              message:
                'The mobile app may not import server code. Business rules live in ' +
                'services/api; share types through @nikahmate/domain. See README §3.',
            },
          ],
        },
      ],
    },
  },

  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-native', 'expo*', 'fastify', '@supabase/*'],
              message:
                '@nikahmate/domain is the shared vocabulary for mobile, api, admin and ' +
                'the future website. It must stay free of platform dependencies.',
            },
          ],
        },
      ],
    },
  },
);
