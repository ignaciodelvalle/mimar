// es-AR labels for the profile role and account-type enums.
//
// WHY THIS IS NOT IN `lib/utils/format.ts`, WHERE IT LIVED UNTIL 2026-09-09:
// these two functions are the only readers of the `user_role` and
// `account_type` enums in that file, and every other export there formats a
// value that has no domain of its own (dates, numbers, names, sex-aware copy).
// Adding the `national` role pushed `format.ts` past the 1500-line ceiling that
// `scripts/check-file-size.ts` enforces, and the honest split is by subject:
// a role label changes whenever the role enum changes, which is a schema event,
// not a formatting one.
//
// The labels are the operator-facing wording, so they are es-AR (invariant #4)
// and they carry the neutral "/a" convention the rest of the operator surface
// uses ("Dueño/a"). A role this file does not know is returned verbatim rather
// than replaced with a placeholder: an unlabelled role is a bug to see, not a
// blank to hide.

/** es-AR label for a profile account type (`personal` | `institutional`). */
export function accountTypeLabel(accountType: string): string {
  switch (accountType) {
    case "personal":
      return "Personal";
    case "institutional":
      return "Institucional";
    default:
      return accountType;
  }
}

/**
 * es-AR label for an operator role
 * (`owner` | `vet` | `govt` | `national` | `admin`).
 */
export function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "Dueño/a";
    case "vet":
      return "Veterinario/a";
    case "govt":
      return "Gobierno";
    case "national":
      // Read-only institutional role with country-wide read scope (migration
      // 0214). The label names the CAPABILITY rather than the office, because
      // "Nacional" alone reads as a rank above "Gobierno" and this role can do
      // strictly less than one.
      return "Lectura nacional";
    case "admin":
      return "Administrador/a";
    default:
      return role;
  }
}
