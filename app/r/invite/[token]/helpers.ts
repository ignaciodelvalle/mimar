/**
 * Mask a PII email address so token-holders cannot read the full address.
 * Shows the first character of the local part + "***" + "@" + domain.
 * e.g. "juan@refugio.org" → "j***@refugio.org"
 */
export function maskEmail(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx <= 0) return "***";
  return `${email[0]}***${email.slice(atIdx)}`;
}
