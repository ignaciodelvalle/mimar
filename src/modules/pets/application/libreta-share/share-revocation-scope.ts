// Who may revoke a libreta share — the scope rule, named once.
//
// The same shape `lost-mode/disclosure-scope.ts` takes for its titular-only key
// set, and for the same reason: the rule was enforced inside one writer, and a
// SECOND consumer appeared that needs to report it rather than enforce it.
//
// THE RULE (review 2026-05-19 §2.2, enforced at `revoke-libreta-share.ts:35`):
// the CREATOR can always revoke, and a platform admin can revoke for moderation
// or compliance. Other current owners of the pet — including co-owners, fosters
// and post-transfer owners — CANNOT revoke somebody else's share. That protects
// the medical-history continuity libreta shares exist for.
//
// `GET /api/v1/pets/{token}/shares` reports it PER ROW so a client can say
// "solo quien creó este link puede revocarlo" instead of offering a button that
// answers 403 — which is what the web does, after the tap
// (`SharesManager.tsx:306`). This module is what keeps the reporting and the
// enforcing reading the same fact: `isPlatformAdmin` is the exact probe the
// writer runs, lifted so both callers share it.

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";

/**
 * Whether this user holds the platform `admin` role.
 *
 * Called ONLY when it can change an answer — the writer runs it only after the
 * creator check fails, and the read runs it only when some listed link was
 * minted by somebody else. An unconditional probe would be one query per request
 * to answer a question that is almost always moot.
 */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: profiles.role })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);
  return row?.role === "admin";
}

/**
 * Whether `userId` may revoke a share created by `createdByUserId`.
 *
 * The creator half is a comparison and needs no query; the admin half is the
 * caller's, already resolved. Kept as one function so the two halves cannot
 * drift apart in the two places that ask.
 */
export function canRevokeShare(input: {
  createdByUserId: string;
  userId: string;
  isPlatformAdmin: boolean;
}): boolean {
  return input.createdByUserId === input.userId || input.isPlatformAdmin;
}
