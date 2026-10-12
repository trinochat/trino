/** @type {import('tailwindcss').Config} */
export default {
  // Tests are left out: their fixtures (the colour scanner's `bg-white`...) are not app classes.
  content: ['./index.html', './src/**/*.{ts,tsx}', '!./src/**/*.test.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // The tokens (src/design/tokens.ts), set on <html> as --t-*
        // variables by src/design/apply.ts: `bg-ui-surface`, `text-ui-muted`,
        // `bg-ui-bubble-me`... The namespace is `ui` and not `t` because
        // Tailwind already reads `border-t-ink` and `rounded-t-lg` as "top
        // side". The values are full colours, so there are no `/50` opacity
        // modifiers: use the soft tokens (accent-soft, warn-bg, danger-bg).
        ui: {
          bg: 'var(--t-bg)',
          side: 'var(--t-side)',
          surface: 'var(--t-surface)',
          raised: 'var(--t-raised)',
          line: 'var(--t-line)',
          'control-line': 'var(--t-control-line)',
          // Black on white in every theme: `text-ui-qr-ink bg-ui-qr-paper` around a QR code.
          'qr-ink': 'var(--t-qr-ink)',
          'qr-paper': 'var(--t-qr-paper)',
          ink: 'var(--t-ink)',
          muted: 'var(--t-muted)',
          accent: 'var(--t-accent)',
          'accent-ink': 'var(--t-accent-ink)',
          'accent-text': 'var(--t-accent-text)',
          'accent-soft': 'var(--t-accent-soft)',
          ok: 'var(--t-ok)',
          warn: 'var(--t-warn)',
          'warn-bg': 'var(--t-warn-bg)',
          danger: 'var(--t-danger)',
          'danger-bg': 'var(--t-danger-bg)',
          badge: 'var(--t-badge)',
          'badge-ink': 'var(--t-badge-ink)',
          'avatar-bg': 'var(--t-avatar-bg)',
          'avatar-fg': 'var(--t-avatar-fg)',
          'bubble-in': 'var(--t-bubble-in)',
          'bubble-in-ink': 'var(--t-bubble-in-ink)',
          'bubble-in-line': 'var(--t-bubble-in-line)',
          'bubble-me': 'var(--t-bubble-me)',
          'bubble-me-ink': 'var(--t-bubble-me-ink)',
          'bubble-me-muted': 'var(--t-bubble-me-muted)',
          'bubble-me-line': 'var(--t-bubble-me-line)',
          outer: 'var(--t-outer)',
        },
      },
      fontFamily: {
        // `font-ui` for reading text, `font-ui-mono` only for keys, codes and
        // times.
        ui: 'var(--t-font)',
        'ui-display': 'var(--t-display)',
        'ui-mono': 'var(--t-mono)',
        'ui-label': 'var(--t-label-font)',
      },
      // The type scale of src/design/type.ts, in rem so it follows the text
      // size (tailwind.test.ts keeps both the same): `text-ui-xs` (12 px at
      // 100 %) to `text-ui-title` (22 px).
      fontSize: {
        'ui-xs': ['0.75rem', { lineHeight: '1.35' }],
        'ui-sm': ['0.8125rem', { lineHeight: '1.35' }],
        'ui-md': ['0.875rem', { lineHeight: '1.4' }],
        'ui-base': ['0.9375rem', { lineHeight: '1.45' }],
        'ui-lg': ['1rem', { lineHeight: '1.4' }],
        'ui-title': ['1.375rem', { lineHeight: '1.25' }],
      },
      borderRadius: {
        // `rounded-ui`, `rounded-ui-lg`, `rounded-ui-bubble`...
        ui: 'var(--t-radius)',
        'ui-lg': 'var(--t-radius-lg)',
        'ui-bubble': 'var(--t-bubble-radius)',
        'ui-avatar': 'var(--t-avatar-radius)',
      },
      // No boxShadow entry for --t-shadow on purpose: it is `none` in Terminal,
      // and `none` inside Tailwind's shadow list would also drop focus rings.
      // Use `[box-shadow:var(--t-shadow)]`.
      // The animations the screens use: a dialog fading in, a toast sliding up
      // and the rings of a call that rings. Each runs only with full motion.
      animation: {
        'fade-in': 'fadeIn 0.18s ease-out',
        'slide-up': 'slideUp 0.22s ease-out',
        'radar': 'radar 1.8s ease-out infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { opacity: '0', transform: 'translateY(6px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        radar: { '0%': { transform: 'scale(1)', opacity: '0.7' }, '100%': { transform: 'scale(2.3)', opacity: '0' } },
      },
    },
  },
  plugins: [
    // Variants for the accessibility settings, which src/design/apply.ts marks
    // on <html>: `safe-colors:`, `more-contrast:`, `reduce-motion:`,
    // `full-motion:` and `wide-spacing:`. The marks already include what the
    // system says, so the redesign uses these, never `motion-reduce:`,
    // `motion-safe:` or `contrast-more:`, which only hear the system.
    function accessibilityVariants({ addVariant }) {
      addVariant('safe-colors', ':root[data-vision="safe"] &');
      addVariant('more-contrast', ':root[data-contrast="more"] &');
      addVariant('reduce-motion', ':root[data-motion="reduce"] &');
      addVariant('full-motion', ':root[data-motion="full"] &');
      addVariant('wide-spacing', ':root[data-spacing="wide"] &');
    },
    // The style of the appearance, which apply.ts marks on <html> too:
    // `terminal:` for what Terminal draws its own way, such as the border of
    // a menu, since it has no shadow.
    function styleVariants({ addVariant }) {
      addVariant('terminal', ':root[data-style="terminal"] &');
    },
  ],
};
