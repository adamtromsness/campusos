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
        // Attendance status — used by StatusBadge and the marking UI
        status: {
          present: { DEFAULT: '#16a34a', soft: '#dcfce7', text: '#166534' },
          tardy: { DEFAULT: '#d97706', soft: '#fef3c7', text: '#92400e' },
          absent: { DEFAULT: '#dc2626', soft: '#fee2e2', text: '#991b1b' },
          excused: { DEFAULT: '#6366f1', soft: '#e0e7ff', text: '#3730a3' },
        },
      },
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif'],
        display: ['DM Serif Display', 'Georgia', 'serif'],
      },
      borderRadius: {
        card: '12px',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)',
        elevated: '0 4px 12px rgba(15, 23, 42, 0.08), 0 2px 4px rgba(15, 23, 42, 0.04)',
      },
    },
  },
  plugins: [],
};

export default config;
