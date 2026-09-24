// Use-case types for libreta-share writers (strangler migration 32/61).

export type CreateShareInput = {
  petPublicToken: string;
  expiresInDays: number | null; // null = no expiration
  label: string | null;
};

export type CreateShareResult = { error: string } | { shareToken: string };
// shareTokenRowId lets the client sync its local list (filter the revoked
// row out) from the action's return value instead of relying on a reload —
// revalidatePath() alone only refreshes RSC trees, not already-mounted
// client component state (see SharesManager.tsx).
export type RevokeShareResult = { error: string } | { ok: true; shareTokenRowId: string };
