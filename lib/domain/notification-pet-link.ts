// When a notification's "Ver {nombre}" affordance is a dead end.
//
// IT LIVES OUTSIDE THE CARD because it now has two renderers. It was born in
// `components/NotificationCard.tsx`, which was the right home while a browser was
// the only thing that drew a notification; `app/api/v1/me/notifications` now has
// to answer the same question for a phone, and a React component is not
// something a route handler should import to get at a constant. The card
// re-exports it, so every existing caller and
// `__tests__/notification-pet-link-dead-end.test.tsx` are untouched by the move.

/**
 * Notification types whose whole point is that custody LEFT the recipient.
 *
 * The "Ver {nombre}" button aims at the pet page. For these types the recipient
 * is, by construction, the party that no longer holds the pet, so the button is a
 * guaranteed dead end — the notification confirming you handed your pet over
 * offered, as its only action, a link to a page that answered "No encontramos
 * esta página" (adversarial review 2026-08-08, S6-F02). The body and its own
 * ctaUrl still explain what happened.
 *
 * A DENYLIST BY TYPE, and deliberately not an ownership check on the join.
 * The first attempt at this required a live `ownerships.ownerUserId` row for the
 * reader, which looked principled and was wrong: `ownerships` is polymorphic
 * (ownerUserId XOR ownerOrganizationId, db/schema.ts), so it hid the pet from
 * every member of a holding ORGANISATION — people `requirePetAccess` grants the
 * page to via its org-mediated path — and from a former owner reading during an
 * open custody episode, who has a purpose-built view (PO 2026-07-18).
 * /mis-mascotas/{token} is not owner-only, so "no live personal ownership" is
 * not the same question as "cannot open this page". Caught in review before it
 * reached anyone; kept written down so it is not re-derived.
 */
export const PET_LINK_DEAD_FOR_RECIPIENT: ReadonlySet<string> = new Set([
  // --- Custody left the recipient -----------------------------------------
  // Sender side of a citizen-to-citizen transfer: the receiver accepted.
  "pet_transfer_accepted",
  // Sender side of an org-to-org transfer (the gaining org gets its own type).
  "cross_org_transfer_accepted_sender",
  // A foster placement ended; the writer closes the foster ownership first.
  "foster_ended_by_transfer",
  "foster_ended",
  "foster_ended_by_adoption",
  "foster_ended_by_death",
  // The former adopter, after the shelter reversed the adoption.
  "adoption_reversed",

  // --- The recipient never held the pet ------------------------------------
  // Proposals and cancellations aimed at a prospective holder. The writer of
  // pet_transfer_cancelled says it outright — "the recipient never gained the
  // pet and there is no transfer/pet surface to open" — and deliberately ships
  // no ctaUrl, while the card handed them a "Ver …" button anyway.
  "pet_transfer_cancelled",
  "pet_transfer_received",
  "cross_org_transfer_proposed_receiver",
  "cross_org_transfer_cancelled_receiver",
  "decomiso_handoff_proposed_receiver",
  // Rival applicants auto-rejected when someone else's adoption finalised.
  "adoption_application_closed",
]);

// NOT in the list, and the reason is worth keeping: `decomiso_owner_lost_custody`
// goes to the immediate former owner while the custody_episode is OPEN, and
// getFormerOwnerReadAccess grants exactly that person a purpose-built read-only
// view of the pet. Their link works. "Lost custody" is not the same question as
// "cannot open the page" — the mistake the first version of this fix made at the
// query layer, generalised from one finding to everyone.

/**
 * Whether a row may offer the "Ver {nombre}" affordance at all.
 *
 * Both halves in one predicate, so the two renderers cannot each remember one:
 * there has to BE an animal, and the type must not be one whose recipient no
 * longer holds it.
 */
export function petLinkAvailable(input: {
  notificationType: string;
  hasRelatedPet: boolean;
}): boolean {
  if (!input.hasRelatedPet) return false;
  return !PET_LINK_DEAD_FOR_RECIPIENT.has(input.notificationType);
}
