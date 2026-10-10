/**
 * The Trino mark: "tr" and the wavy line of a trill, the ornament of sheet
 * music ("trino" is both birdsong and that ornament). One colour,
 * `currentColor`, so it takes the text colour of wherever it sits. The letters
 * are outlines of Atkinson Hyperlegible Next Bold (OFL), so it needs no font.
 * Same drawing and units as `assets/brand/trino-mark.svg`, which is the
 * Calma app icon without its tile.
 */
import { cx } from '../cx';

export interface TrinoLogoProps {
  /** Width and height of the square box, in px; the mark fills its width, centred. Default 32. */
  size?: number;
  /** Accessible name. Default "Trino". */
  title?: string;
  /** Decoration beside a visible name: hidden from screen readers. */
  decorative?: boolean;
  className?: string;
}

const VIEW_BOX = '0 0 94 33';
/** The "t" and the "r", two closed outlines. */
const LETTERS =
  'M17.42 32.62L12.64 32.62Q9.62 32.62 7.85 32.07Q6.09 31.53 5.33 29.99Q4.58 28.46 4.58 25.5L4.58 12.39L0.31 12.39' +
  'L0.31 6.83L4.58 6.83L4.58 0.38L11.81 0.38L11.81 6.83L17.42 6.83L17.42 12.39L11.81 12.39L11.81 23.68' +
  'Q11.81 25.55 12.48 26.09Q13.16 26.64 15.03 26.64L17.42 26.64Z' +
  'M29.43 32.62L22.21 32.62L22.21 6.83L27.82 6.83L29.23 11.56Q30.11 9.58 31.31 8.36Q32.5 7.14 34.11 6.62' +
  'Q35.73 6.1 37.75 6.15L37.75 13.43Q34.89 13.12 33.07 13.74Q31.25 14.37 30.34 15.9Q29.43 17.44 29.43 19.98Z';
/** The trill: four half-waves, the first one up. */
const WAVE = 'M49.69 13.62 q5 -9 10 0 t10 0 t10 0 t10 0';

export function TrinoLogo({ size = 32, title = 'Trino', decorative = false, className }: TrinoLogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={VIEW_BOX}
      width={size}
      height={size}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : title}
      aria-hidden={decorative ? true : undefined}
      className={cx('shrink-0', className)}
    >
      <path fill="currentColor" d={LETTERS} />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth={8}
        strokeLinecap="round"
        strokeLinejoin="round"
        d={WAVE}
      />
    </svg>
  );
}
