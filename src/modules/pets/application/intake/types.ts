// IntakeFormState for the org-side intake use-case.

export type IntakeFormState = {
  error: string | null;
  // Present when a tattoo cross-check found a possible match (advisory WARN state).
  // Tattoo codes collide across registries, so the UI shows the possible match and
  // offers a photo-verified "continue anyway" path backed by the tattooAckToken.
  // (An ACTIVE-chip match is NOT a warning — it is a hard block returned via `error`,
  // because a second intake for the same chip always violates the unique index.)
  warning?: "TATTOO_MATCH_POSSIBLE";
  matchedPetToken?: string;
  // Tattoo advisory ack token — bound to the normalized tattoo code, expires in 15 min.
  // Re-submitting with a valid tattooAckToken skips the tattoo cross-check.
  tattooAckToken?: string;
  // Optional success flag. Default success path reports `redirectTo` for the
  // org mascotas list. The intake wizard (sprint 4 PR-030) passes noRedirect=1
  // so it can render its own SuccessScreen with the new pet's name + token.
  ok?: boolean;
  createdPetToken?: string;
  createdPetName?: string;
  // Where the caller should navigate — nav contract N3. The use-case REPORTS a
  // destination; it never calls next/navigation redirect(), because the App
  // Router drops a Server Action's own redirect intermittently in production
  // (lib/ui/full-page-action-nav.ts) and because a use-case that navigates
  // cannot be called from anything that is not a Next request.
  //
  // Two shapes reach this field, and they are NOT both successes:
  //   - the chip cross-check found a LOST pet → the match-confirmation page,
  //     with `ok` unset, because nothing was created;
  //   - the intake committed and the caller did not ask for noRedirect → the
  //     org's mascotas list.
  redirectTo?: string;
};
