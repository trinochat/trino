/**
 * Your key as Settings > Advanced shows it (Settings:264-267): the
 * fingerprint, which the backend gives as lowercase hex in groups of four
 * joined by dots ("70a5.83c6.766d.aad7"), in capitals and groups of four
 * split by spaces ("70A5 83C6 766D AAD7"), easier to read aloud. Anything
 * that is not hex is left out.
 */
export function formatKey(fp: string): string {
  const hex = fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return (hex.match(/.{1,4}/g) ?? []).join(' ');
}
