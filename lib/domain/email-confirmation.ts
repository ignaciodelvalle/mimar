// "Escribí el correo de nuevo" — the typo guard on the institutional create
// forms (/admin/govts/new, /admin/admins/new).
//
// Creating an institutional account MAILS its access link to the address
// typed (pilot T1-P3). A typo there does not bounce harmlessly: if the
// misspelled address exists, a stranger receives working access to a
// govt/admin/national account. So the address is typed twice and must match.
//
// Compared trimmed and case-insensitively: GoTrue stores addresses lowercased,
// so "Ana@Muni.gob.ar" and "ana@muni.gob.ar" are the same account and asking
// the admin to match the case would be friction with no protection in it.
//
// PURE: used by client components and unit-tested on its own.

export const EMAIL_CONFIRMATION_MESSAGES = {
  missing: "Escribí el correo de nuevo para confirmarlo.",
  mismatch: "Los dos correos no coinciden. Revisalos: el link de acceso se manda a esa dirección.",
} as const;

/** Null when the confirmation matches; otherwise the es-AR message to show. */
export function emailConfirmationProblem(email: string, confirmation: string): string | null {
  const typed = confirmation.trim().toLowerCase();
  if (!typed) return EMAIL_CONFIRMATION_MESSAGES.missing;
  return email.trim().toLowerCase() === typed ? null : EMAIL_CONFIRMATION_MESSAGES.mismatch;
}
