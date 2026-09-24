// The two-key gate on showing a caretaker as an alternate contact on the
// PUBLIC, unauthenticated credential.
//
// THE RULE, in one sentence: never, unless BOTH keys are set.
//
//   Key 1 — the TITULAR's. `pets.disclose_caretaker_contact_when_lost`
//           (migration 0193), off by default like every disclosure flag that
//           reveals a person. It rides the existing lost-mode toggle family
//           rather than opening a new surface.
//   Key 2 — the CARETAKER's. `pet_caretaker_grants.public_contact_consent_at`,
//           captured at invitation-accept (migration 0189), where the invitee
//           is already being told what they are accepting.
//
// WHY TWO. Publishing a third party's phone number on a page anyone can open is
// not a consent the titular is able to give. The PO approved this shape with
// the trade-off named out loud: if the caretaker declines, the titular simply
// cannot publish. Do not let a later "simplification" collapse it into one
// owner-side flag — that is the whole decision, inverted.
//
// WHY IT LIVES IN lib/infra AND NOT IN THE CARETAKERS MODULE: the public page
// is the caller, and a page that must import src/modules/caretakers to render a
// credential is the dependency inversion the module boundary exists to prevent.
// Same shelf and same argument as origin-shelter-alert.ts and
// pet-alert-recipients.ts.

import { and, eq, gt, isNotNull } from "drizzle-orm";

import { db, petCaretakerGrants, pets, profiles } from "@/db";

export type CaretakerPublicContact = {
  /**
   * FIRST name only. The same rule the titular's own disclosure follows: a
   * public credential never carries somebody's full legal name.
   */
  firstName: string | null;
  phoneE164: string | null;
};

/**
 * The caretaker to show as an alternate contact, or `null` — which is the
 * answer in every case except the one where both keys hold.
 *
 * @param petId internal pet id, not the public token.
 * @param now   injected so the "the arrangement is still live" boundary is testable.
 */
export async function resolveCaretakerPublicContact(args: {
  petId: string;
  now?: Date;
}): Promise<CaretakerPublicContact | null> {
  const now = args.now ?? new Date();

  // ONE query, both keys. Splitting it into "is key 1 on?" then "is key 2 on?"
  // would leave a shape where a caller can accidentally consult only the first
  // — and the first is the one that is not the caretaker's to give.
  const [row] = await db
    .select({
      displayName: profiles.displayName,
      phone: profiles.phone,
      deletedAt: profiles.deletedAt,
    })
    .from(petCaretakerGrants)
    .innerJoin(pets, eq(pets.id, petCaretakerGrants.petId))
    .innerJoin(profiles, eq(profiles.id, petCaretakerGrants.caretakerUserId))
    .where(
      and(
        eq(petCaretakerGrants.petId, args.petId),
        // KEY 1 — the titular's toggle.
        eq(pets.discloseCaretakerContactWhenLost, true),
        // KEY 2 — the caretaker's consent, captured at accept.
        isNotNull(petCaretakerGrants.publicContactConsentAt),
        // ...and the arrangement has to be LIVE. `status='accepted'` alone is
        // not enough: the expiry cron runs once a day, so between `ends_at` and
        // the next 04:00 the row still says accepted. Publishing a stranger's
        // phone for up to a day after their arrangement ended is exactly the
        // failure the two keys are protecting against, arriving through the
        // back door.
        eq(petCaretakerGrants.status, "accepted"),
        gt(petCaretakerGrants.endsAt, now),
      ),
    )
    .limit(1);

  if (!row) return null;
  // An erased profile keeps its row with a redacted display name; publishing a
  // sentinel string on a credential would be worse than publishing nothing.
  if (row.deletedAt) return null;

  const firstName = row.displayName?.trim().split(/\s+/)[0] ?? null;
  return { firstName: firstName || null, phoneE164: row.phone ?? null };
}
