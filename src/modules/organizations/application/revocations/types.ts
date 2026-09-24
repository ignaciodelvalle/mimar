// Result types for admin-revocations use-cases.

export type RevocationResult = { error: string } | { ok: true; noOp?: boolean };
