/**
 * The frame of a QR code: black modules on white paper in every theme, with
 * a quiet zone around them, and kept so under a contrast theme of Windows
 * (`forced-color-adjust: none`), since scanners expect dark on light. Give
 * the frame its width in rem (such as `w-[12.5rem]`); the code inside fills
 * it (`QRCodeSVG` with `fgColor="currentColor"`, `bgColor="transparent"` and
 * `className="h-full w-full"`), so the code's `size` is not its size on
 * screen. The PNG of "Guardar QR" takes its colours from `resolveTokens`.
 */
export const QR_FRAME =
  'inline-flex aspect-square items-center justify-center rounded-ui bg-ui-qr-paper p-3 text-ui-qr-ink [forced-color-adjust:none]';
