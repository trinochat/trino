/** Two letters for an avatar without a photo. Moved out of App.tsx unchanged. */
export function identityInitials(name: string): string {
  const clean = name.trim().replace(/^[@#]+/, '');
  if (!clean) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length > 1) {
    return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}
