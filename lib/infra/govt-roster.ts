// Pure predicates for the admin govt roster (/admin/govts).

/**
 * A "dead" govt account (C24): active at the profile level but holding zero
 * active locality assignments. Per AGENTS.md a govt needs ≥1 active assignment
 * to enter /gob, so an active govt with 0 localities cannot operate — it is a
 * dead account that the roster must flag ("sin localidades — no puede operar").
 *
 * Deactivated govts are never "dead" in this sense: they are already surfaced as
 * Desactivado, so the 0-localities state carries no additional warning for them.
 */
export function isDeadGovt(active: boolean, activeLocalityCount: number): boolean {
  return active && activeLocalityCount === 0;
}

/**
 * The way OUT of the dead state (V4 onboarding).
 *
 * `isDeadGovt` only DIAGNOSES — the roster pill "sin localidades — no puede
 * operar" tells an admin the account is stuck but not what clears it. A live
 * capture of a real govt account (portal review 2026-07-25) sat in exactly that
 * state with no in-product next step on screen, which read as "hand-edit
 * govt_assignments" even though the assign flow already exists.
 *
 * So the rule this module now enforces: the dead state is NEVER rendered
 * without this remedy beside it. The capability was never missing — the
 * WAYFINDING was. Assignment happens on the govt detail screen, which hosts
 * AssignLocalityForm → assignGovtLocalityAction → assignGovtLocalityForAuthority
 * (admin-capability checked, canonical-catalog validated, audited, notified).
 */
export const DEAD_GOVT_REMEDY =
  "Asignale al menos una localidad para que pueda entrar a /gob. La cuenta ya existe: solo le falta jurisdicción.";

/** Where an admin goes to clear the dead state — the detail screen that hosts
 * the assign-locality form. Kept beside the copy so the two can never drift. */
export function deadGovtRemedyHref(govtUserId: string): string {
  return `/admin/govts/${govtUserId}`;
}

// ---------------------------------------------------------------------------
// Roster console filters (/admin/govts) — pure input normalizers so the page
// can search + status-filter + truncate without special-casing seed rows.
// ---------------------------------------------------------------------------

/**
 * Status filter for the govt roster:
 *   - all      → every govt (default)
 *   - active   → deactivatedAt IS NULL
 *   - inactive → deactivatedAt IS NOT NULL
 *   - dead     → active but holding zero active localities (cannot operate)
 */
export type GovtStatusFilter = "all" | "active" | "inactive" | "dead";

/** Validate an untrusted `?status=` param down to a known filter. */
export function normalizeGovtStatus(raw: string | null | undefined): GovtStatusFilter {
  return raw === "active" || raw === "inactive" || raw === "dead" ? raw : "all";
}

/**
 * Returns the ids whose email contains `query` (case-insensitive substring).
 * Emails live in auth.users, not `profiles`, so an email search cannot be a
 * SQL ILIKE on the profiles query — the caller ORs these ids into the WHERE
 * clause instead. Empty/whitespace query returns no ids.
 */
export function matchEmailIds(emailMap: Map<string, string>, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ids: string[] = [];
  for (const [id, email] of emailMap) {
    if (email.toLowerCase().includes(q)) ids.push(id);
  }
  return ids;
}
