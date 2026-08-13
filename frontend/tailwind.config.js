/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  // Deliberately empty. tailwindcss-animate lived here and was never used — not
  // one animate-in / fade-in / slide-in class exists in the tree — but it was
  // not merely idle. It claims the `ease` and `duration` namespaces for
  // animation-* on top of core's transition-*, which made the arbitrary value in
  // `ease-[cubic-bezier(0.2,0.8,0.2,1)]` AMBIGUOUS: Tailwind refused to resolve
  // it and emitted nothing, so the sidebar slid on the browser's default curve
  // while the source said otherwise. That ambiguity is the warning printed on
  // every single build.
  plugins: [],
};
