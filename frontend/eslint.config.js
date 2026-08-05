import js from '@eslint/js';
import react from 'eslint-plugin-react';
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
    plugins: { react, 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Without this, `no-unused-vars` cannot see JSX. Every identifier used only
      // in markup — `<motion.div>`, a destructured `icon: Icon` — was reported
      // unused, which is where 44 of the 77 warnings in this project came from:
      // false ones. `varsIgnorePattern: '^[A-Z_]'` had been added to mask them,
      // but that only covers Capitalized names, so lowercase `motion` still
      // warned in 41 files. Deleting those "unused" imports compiles cleanly and
      // then throws ReferenceError in the browser, because Vite does not resolve
      // identifiers at build time — the warnings were actively dangerous to act
      // on, so nobody acted on any of them and the real ones sat in the noise.
      'react/jsx-uses-vars': 'error',
      // The other half, and an ERROR because both fast gates miss it. A component
      // referenced in JSX but not in scope — a deleted import, a renamed export,
      // a bad merge — is a ReferenceError the moment the element renders, yet
      // `vite build` passes it (it does not resolve identifiers) and so does core
      // `no-undef` (it does not descend into JSX). Only the Playwright suite
      // catches it today: three and a half minutes in, and only on a page some
      // test actually opens. This catches it in seconds, everywhere.
      'react/jsx-no-undef': 'error',
      // The pattern escape hatch is gone with the cause fixed: a genuinely unused
      // Capitalized import is now reported instead of silently exempted.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
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
