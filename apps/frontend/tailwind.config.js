/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f5f7fa',
          100: '#e4e9f0',
          800: '#1a2331',
          900: '#0f1521',
          950: '#070b13',
        },
        accent: {
          400: '#43d9b5',
          500: '#1cc8a3',
          600: '#15a587',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
};
