import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // Keep this in step with .gitignore: local packaging writes `release/` *and*
  // `apps/desktop/release-<something>/`, and linting a bundled build turns a
  // clean checkout into 139 errors that belong to nobody.
  {
    ignores: [
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/release-*/**',
      '**/win-unpacked/**',
      '**/node_modules/**',
      'examples/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  }
)
