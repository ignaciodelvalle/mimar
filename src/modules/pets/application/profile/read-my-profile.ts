// The six fields a person may change about THEMSELVES, read back so a form can
// pre-fill itself.
//
// WHY IT IS EXACTLY THE WRITER'S FIELD LIST AND NOT ONE MORE
// ---------------------------------------------------------------------------
// `updateProfileForUser` takes `displayName`, `phone` and the four vet /
// emergency-contact columns. This reads those six and stops, and the discipline
// is not tidiness: `GET /api/v1/me` deliberately carries NO phone, NO email, NO
// DNI in any form and NO jurisdiction, and its docblock names that as "the whole
// defence for what a stolen access token buys". A read that pre-fills an edit
// form is a different exposure from a shell every cold start fetches — it is one
// deliberate call, by somebody who came to change these values — but it is only
// a different exposure while the two lists agree. The moment this returns a
// field the form cannot write, it has stopped being a form pre-fill and become
// the nicer profile card `/api/v1/me` refuses to be.
//
// THE AVATAR IS ABSENT for a smaller reason, recorded so it is not read as an
// oversight: changing it needs an image picker, which needs a native module,
// which needs an EAS build — the pipeline the board rules out. A payload
// carrying an avatar URL no client can change would be a read whose only use is
// to draw a control that cannot work.

import { eq } from "drizzle-orm";

import { db, profiles } from "@/db";

export type MyEditableProfile = {
  displayName: string;
  /** `null` when never set or explicitly cleared. Never `""` — see the writer. */
  phone: string | null;
  preferredVetName: string | null;
  preferredVetPhone: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
};

/**
 * The caller's own editable profile, or `null` when they have no `profiles` row.
 *
 * `null` IS REACHABLE and is not an error condition: an account created through
 * signup exists in `auth.users` before its profile row is completed, which is
 * the window `MeV1`'s `profilePending: true` describes. A surface that treated
 * it as a failure would report "the platform is broken" to somebody who simply
 * has not finished registering.
 */
export async function readMyEditableProfile(userId: string): Promise<MyEditableProfile | null> {
  const rows = await db
    .select({
      displayName: profiles.displayName,
      phone: profiles.phone,
      preferredVetName: profiles.preferredVetName,
      preferredVetPhone: profiles.preferredVetPhone,
      emergencyContactName: profiles.emergencyContactName,
      emergencyContactPhone: profiles.emergencyContactPhone,
    })
    .from(profiles)
    .where(eq(profiles.id, userId))
    .limit(1);

  return rows[0] ?? null;
}
