import { describe, expect, it } from 'vitest';
import * as ui from './index';
import { QR_FRAME } from './qr';

describe('QR_FRAME', () => {
  // Scanners expect dark modules on a light quiet zone. A contrast theme of
  // Windows would repaint both, so the frame keeps its own colours.
  it('keeps a QR code black on white, under forced colours too', () => {
    const classes = QR_FRAME.split(' ');
    for (const name of ['bg-ui-qr-paper', 'text-ui-qr-ink', '[forced-color-adjust:none]']) {
      expect(classes).toContain(name);
    }
  });

  it('leaves a quiet zone around the code, in rem', () => {
    expect(QR_FRAME.split(' ')).toContain('p-3');
  });

  it('is in the library barrel', () => {
    expect(ui.QR_FRAME).toBe(QR_FRAME);
  });
});
