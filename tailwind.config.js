/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--color-bg) / <alpha-value>)',
          panel: 'rgb(var(--color-bg-panel) / <alpha-value>)',
          deep: 'rgb(var(--color-bg-deep) / <alpha-value>)',
          raised: 'rgb(var(--color-bg-raised) / <alpha-value>)',
          line: 'rgb(var(--color-bg-line) / <alpha-value>)',
        },
        ink: {
          DEFAULT: 'rgb(var(--color-ink) / <alpha-value>)',
          dim: 'rgb(var(--color-ink-dim) / <alpha-value>)',
          muted: 'rgb(var(--color-ink-muted) / <alpha-value>)',
        },
        phosphor: {
          // 'dim' is used for all secondary text — kept clearly readable (was
          // #0d4023, near-invisible, esp. outdoors) while still below the vivid
          // primary green.
          dim: 'rgb(var(--color-accent-dim) / <alpha-value>)',
          DEFAULT: 'rgb(var(--color-accent) / <alpha-value>)',
          bright: 'rgb(var(--color-accent-bright) / <alpha-value>)',
          glow: 'rgb(var(--color-accent-bright) / <alpha-value>)',
        },
        cyan: {
          dim: '#0d3a4d',
          DEFAULT: '#88ccff',
          bright: '#c3e7ff',
        },
        magenta: {
          DEFAULT: '#ff77ff',
          dim: '#5a205a',
        },
        amber: {
          DEFAULT: '#ffcc00',
          dim: '#5a4a00',
        },
        crimson: {
          DEFAULT: '#ff5566',
          dim: '#5a1620',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"IBM Plex Mono"', '"Cascadia Code"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'cursor-blink': 'blink 1s steps(1) infinite',
        'scanline': 'scanline 8s linear infinite',
        'glow-pulse': 'glow 2.4s ease-in-out infinite',
        'decrypt': 'decrypt 0.5s ease-out',
        'fade-in': 'fadeIn 0.18s ease-out',
        'pop-in': 'popIn 0.24s cubic-bezier(0.2, 0.9, 0.3, 1.2)',
        'slide-up': 'slideUp 0.22s ease-out',
        'radar': 'radar 1.8s ease-out infinite',
        'flicker': 'flicker 4s linear infinite',
        'scan-sweep': 'scanSweep 3.5s linear infinite',
        'shackle-close': 'shackleClose 0.9s cubic-bezier(0.3, 1.4, 0.4, 1) forwards',
        'seal-glow': 'sealGlow 1.5s ease-out forwards',
        'seal-pop': 'sealPop 0.4s ease-out 0.7s both',
      },
      keyframes: {
        blink: { '0%, 50%': { opacity: '1' }, '50.01%, 100%': { opacity: '0' } },
        scanline: { '0%': { transform: 'translateY(-100%)' }, '100%': { transform: 'translateY(100vh)' } },
        glow: { '0%, 100%': { textShadow: '0 0 4px currentColor' }, '50%': { textShadow: '0 0 12px currentColor' } },
        decrypt: { '0%': { opacity: '0', filter: 'blur(4px)' }, '100%': { opacity: '1', filter: 'blur(0)' } },
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        popIn: { '0%': { opacity: '0', transform: 'scale(0.92)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        radar: { '0%': { transform: 'scale(1)', opacity: '0.7' }, '100%': { transform: 'scale(2.3)', opacity: '0' } },
        flicker: {
          '0%, 18%, 22%, 55%, 57%, 100%': { opacity: '1' },
          '20%, 56%': { opacity: '0.45' },
          '21%': { opacity: '0.7' },
        },
        scanSweep: { '0%': { transform: 'translateY(-120%)' }, '100%': { transform: 'translateY(520%)' } },
        shackleClose: {
          '0%': { transform: 'translateY(-14px) rotate(-16deg)', opacity: '0.5' },
          '55%': { transform: 'translateY(3px) rotate(4deg)', opacity: '1' },
          '100%': { transform: 'translateY(0) rotate(0)', opacity: '1' },
        },
        sealGlow: {
          '0%, 55%': { filter: 'drop-shadow(0 0 0 rgba(34,255,102,0))' },
          '70%': { filter: 'drop-shadow(0 0 18px rgba(34,255,102,0.9))' },
          '100%': { filter: 'drop-shadow(0 0 6px rgba(34,255,102,0.5))' },
        },
        sealPop: { '0%': { opacity: '0', transform: 'scale(0.7)' }, '100%': { opacity: '1', transform: 'scale(1)' } },
      },
    },
  },
  plugins: [],
};
