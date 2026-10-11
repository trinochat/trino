import { describe, expect, it } from 'vitest';
import { legacyMarks, markVerifies, readMark, verifiedMark } from './verification-marks';

const FP = 'ab12.cd34.ef56.7890';
const OTHER = '0000.1111.2222.3333';

describe('verification marks', () => {
  it('say how a contact was verified, and with which fingerprint', () => {
    expect(verifiedMark(FP, 'call')).toBe(`call:${FP}`);
    expect(verifiedMark(FP, 'qr')).toBe(`qr:${FP}`);
    expect(readMark(`call:${FP}`)).toEqual({ kind: 'verified', by: 'call', fingerprint: FP });
    expect(readMark(`qr:${FP}`)).toEqual({ kind: 'verified', by: 'qr', fingerprint: FP });
  });

  it('verify only while the fingerprint is still the contact’s', () => {
    expect(markVerifies(verifiedMark(FP, 'call'), FP)).toBe(true);
    expect(markVerifies(verifiedMark(FP, 'qr'), FP)).toBe(true);
    expect(markVerifies(verifiedMark(FP, 'call'), OTHER)).toBe(false);
    expect(markVerifies(verifiedMark(FP, 'call'), '')).toBe(false);
    expect(markVerifies(null, FP)).toBe(false);
  });

  // 0.1.0 stored the bare fingerprint after its weak checks: it no longer counts.
  it('tell the marks of 0.1.0 apart, and never let them verify', () => {
    expect(readMark(FP)).toEqual({ kind: 'legacy' });
    expect(markVerifies(FP, FP)).toBe(false);
    expect(readMark('sms:' + FP)).toEqual({ kind: 'legacy' });
    expect(readMark('call:')).toEqual({ kind: 'legacy' });
    expect(readMark(null)).toEqual({ kind: 'none' });
    expect(readMark('')).toEqual({ kind: 'none' });
  });

  it('list the contacts whose mark comes from 0.1.0', () => {
    expect(
      legacyMarks([
        ['ana', FP],
        ['bruno', verifiedMark(OTHER, 'call')],
        ['carla', null],
        ['diego', OTHER],
      ]),
    ).toEqual(['ana', 'diego']);
  });
});
