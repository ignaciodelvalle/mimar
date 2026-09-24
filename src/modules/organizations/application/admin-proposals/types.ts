// Result type for admin-proposals use-cases.

export type ProposalResult = { error: string } | { ok: true; publicToken: string };
