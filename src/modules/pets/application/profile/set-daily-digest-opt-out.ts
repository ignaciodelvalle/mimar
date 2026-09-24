// Use-case: setDailyDigestOptOutForUser — the one write behind both places a
// user can flip the daily operator digest preference (T2-N1):
//   - app/actions/profile-self-service.ts (setDailyDigestOptOutAction), the
//     /cuenta toggle, session-resolved.
//   - app/api/digest/unsubscribe/route.ts, the mailed link — no session, the
//     capability lives entirely in the signed token
//     (lib/infra/digest-unsubscribe-token.ts) that route validates BEFORE
//     calling this writer.
//
// Deliberately NOT audited. This is a low-stakes personal preference on the
// caller's own row (no third party affected, no legal/statutory weight), same
// class as `organization_memberships.receives_broadcasts` — audited actions in
// this repo are operator/institutional acts or acts with legal consequence
// (account state changes, role changes, custody). Canon B02: this is the ONE
// place either call site writes `profiles.daily_digest_opt_out`.

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";

export async function setDailyDigestOptOutForUser(
  userId: string,
  optOut: boolean,
): Promise<{ ok: true; optOut: boolean }> {
  await db.update(profiles).set({ dailyDigestOptOut: optOut }).where(eq(profiles.id, userId));
  return { ok: true, optOut };
}
