// Result types for admin-institutional use-cases.

export type CreateInstitutionalResult =
  | { error: string }
  | {
      ok: true;
      profileId: string;
      magicLink: string;
      /** The mail provider accepted the access-link mail (pilot T1-P3). False → forward the link by hand. */
      inviteEmailSent: boolean;
    };

export type DeactivateResult = { error: string } | { ok: true; noOp?: boolean };

export type ResetCredentialsResult = { error: string } | { ok: true; magicLink: string };

export type AssignGovtLocalityResult =
  | { error: string }
  | { ok: true; assignmentId: string; noOp?: boolean };
