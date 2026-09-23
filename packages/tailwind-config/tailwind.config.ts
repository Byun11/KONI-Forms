import type { Config } from 'tailwindcss/types/config';

export default {
  theme: {
    extend: {
      colors: {
        // KONI design tokens — Ink & Gold palette.
        // Ink navy carries interaction and text (logo wings), swan gold is the
        // single chromatic accent (logo beak), cool tints replace the old blue
        // fills, neutral grey scale for structure.
        koni: {
          navy: {
            700: '#0A3A5C',
            800: '#062B45',
            900: '#0B1720',
          },
          primary: {
            50: '#EEF4F7',
            100: '#DCE9F0',
            500: '#0A3A5C',
            600: '#062B45',
            700: '#04213A',
          },
          gold: {
            100: '#F7EDD3',
            500: '#C9920E',
            700: '#8A6508',
          },
          neutral: {
            50: '#FAFAFA',
            100: '#F4F4F5',
            200: '#E4E4E7',
            300: '#D1D1D6',
            500: '#71717A',
            600: '#52525B',
            700: '#3F3F46',
            900: '#18181B',
          },
          success: '#16A34A',
          danger: '#DC2626',
        },
      },
      fontFamily: {
        // Outfit — humanist geometric variable face (Optimistic VF analogue).
        sans: ['Outfit', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      boxShadow: {
        // Elevation is a commerce/sticky signal, not a marketing flourish.
        card: '0 1px 3px 0 rgba(0, 0, 0, 0.06)',
        sticky: '0 1px 4px 0 rgba(20, 22, 26, 0.12)',
      },
    },
  },
  plugins: [],
} as Omit<Config, 'content'>;
