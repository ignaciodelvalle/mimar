// Domain types for the service-offerings module.
// Pure value shapes — no DB, no framework, no external imports.

export type ServiceOfferingResult = { error: string } | { ok: true };

export type UpdateCapacityResult = { ok: true; slotsUpdated: number } | { error: string };

export type ServiceOfferingFormState = {
  error: string | null;
  /**
   * N3 post-action destination. The action must NOT redirect() — the App
   * Router drops a server action's own redirect in production: the write
   * commits and the screen never moves (lib/ui/full-page-action-nav.ts).
   */
  redirectTo?: string | null;
};

/** Discriminated provider: org-side only (vet provider is not yet exposed here). */
export type OrgProvider = {
  organizationId: string;
  organizationPublicToken: string;
  organizationDisplayName: string;
};

/**
 * Authority scope threaded from the boundary guard (requireAdminOrGovtOrRedirect)
 * into the authority-side approve/reject use-cases so they can ENFORCE
 * jurisdiction bounds on the offering's owning org.
 *
 *   - admin → universal scope; no per-offering jurisdiction check.
 *   - govt  → bounded to the account's active govt_assignments. The offering's
 *             org (jurisdictionProvince/jurisdictionLocality) MUST fall within
 *             one of these, honoring whole-province subsumption
 *             (see jurisdictionScopeContains).
 *
 * Mirrors the AdminOrGovtSession shape (profile.role + jurisdictions) so the
 * action can build it directly from the guard result.
 */
export type AuthorityScope =
  | { role: "admin" }
  | { role: "govt"; jurisdictions: ReadonlyArray<{ province: string; locality: string }> };
