import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // CampusOS brand palette
        campus: {
          50: '#e8f0f8',
          100: '#d1e1f1',
          200: '#a3c3e3',
          300: '#75a5d5',
          400: '#3d7ab5',
          500: '#1a5276',
          600: '#1a3a5c',
          700: '#152e4a',
          800: '#102238',
          900: '#0b1626',
        },
        // Semantic colours
        success: '#28a745',
        warning: '#e5a919',
        danger: '#dc3545',
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        display: ['DM Serif Display', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [],
};

export default config;
