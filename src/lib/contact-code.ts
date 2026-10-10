// Compact shareable code: `trino1:<base64url(bundle without avatar)>`.
// The avatar is dropped so the code stays small enough to fit in a QR.
// Moved out of App.tsx unchanged; contact-code.test.ts pins the format.

/** UTF-8, then base64 with the URL-safe alphabet (- and _) and no = padding. */
export function b64urlEncode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of `b64urlEncode`. Throws when the input is not base64url. */
export function b64urlDecode(s: string): string {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** The `trino1:` code of a bundle as returned by `share_bundle`, or '' if it is not a JSON object. */
export function toCompactCode(bundleJson: string): string {
  try {
    const obj = JSON.parse(bundleJson);
    delete obj.avatar;
    return 'trino1:' + b64urlEncode(JSON.stringify(obj));
  } catch {
    return '';
  }
}

/** The bundle JSON inside a pasted `trino1:` code, or null if it is not one. */
export function fromCompactCode(input: string): string | null {
  const raw = input.trim();
  if (!raw.startsWith('trino1:')) return null;
  try {
    return b64urlDecode(raw.slice(7));
  } catch {
    return null;
  }
}

/**
 * The code the new screens share and show. `trino1:` for now: W4 moves it to
 * `trino2:`, and the screens that import it (W1, W4) stay the same.
 */
export const toShareCode: (bundleJson: string) => string = toCompactCode;
