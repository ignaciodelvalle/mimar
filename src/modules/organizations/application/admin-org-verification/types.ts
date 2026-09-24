// Result types for admin-org-verification use-cases.

export type VerifyOrgResult = { error: string } | { ok: true; noOp?: boolean };
