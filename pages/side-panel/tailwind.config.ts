import baseConfig from '@extension/tailwindcss-config';
import type { Config } from 'tailwindcss/types/config';

export default {
  ...baseConfig,
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    ...baseConfig.theme,
    extend: {
      // Preserve the shared KONI tokens (colors, fontFamily, boxShadow) from
      // baseConfig — without this spread the local theme replaced them, so every
      // koni-* class + the Outfit font silently no-op'd in the side panel.
      ...baseConfig.theme?.extend,
      keyframes: {
        progress: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        progress: 'progress 1.5s infinite ease-in-out',
      },
    },
  },
} as Config;
