import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const noConcreteCouriers = {
  group: ['**/integrations/**'],
  message:
    'Concrete couriers may only be referenced from src/integrations and the composition root. Depend on the CourierAdapter contract instead.',
};

function noDeepImportsInto(component) {
  return {
    group: [
      `**/${component}/domain/**`,
      `**/${component}/data-access/**`,
      `**/${component}/entry-points/**`,
    ],
    message: `Import components/${component} through its index.ts, not a deep path.`,
  };
}

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'drizzle/**', 'node_modules/**'] },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-definitions': 'off',
      'no-console': 'error',
      'no-empty': ['error', { allowEmptyCatch: false }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },

  {
    files: ['src/components/**', 'src/libraries/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noConcreteCouriers] }],
    },
  },
  {
    files: ['src/components/orders/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [noConcreteCouriers, noDeepImportsInto('couriers')] },
      ],
    },
  },
  {
    files: ['src/components/couriers/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [noConcreteCouriers, noDeepImportsInto('orders')] },
      ],
    },
  },

  {
    files: ['tests/**', 'scripts/**', '*.config.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  prettier,
);
