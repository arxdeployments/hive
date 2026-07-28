import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default [
  { ignores: ['dist', 'node_modules'] },
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': ['warn', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      'react-hooks/exhaustive-deps': 'off',
      // A `const` referenced above its initializer is a runtime ReferenceError
      // (temporal dead zone), and neither the type-free build nor a smoke test
      // catches it. This shipped once: a useEffect naming a useCallback in its
      // dependency array sat ABOVE that callback, so ChatPanel threw
      // "Cannot access 'scrollToLoaded' before initialization" on every render
      // and the whole chat pane rendered as the error boundary's fallback.
      // functions/classes stay allowed because hoisted function declarations and
      // component definitions are legitimately referenced earlier.
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
    },
  },
];
