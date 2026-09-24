// Shared copy for every public surface a finder can reach on a credential
// whose titularidad is under review (pets.in_custody_dispute).
//
// WHY IT IS ONE CONSTANT
// ---------------------
// Five surfaces render this state — the credential's found-form slot,
// PublicLostSections' contact box, the sticky action bar's target, and the two
// standalone finder routes (/p/[token]/sighting and /p/[token]/encontre). They
// used to each carry their own literal, which is how the /sighting and
// /encontre pages ended up promising "será dirigida a la autoridad competente"
// while offering no form to write it in.
//
// WHY THE WORDING CHANGED (PO decision 2026-07-30)
// -----------------------------------------------
// The previous line opened with "La titularidad de esta mascota está en
// revisión por la autoridad." Two people read that text and only one of them
// is a party to anything: the other is a stranger who just found an animal on
// the street. They do not need to learn that two people are fighting over it —
// that is the disputing parties' business, and telling a finder invites them to
// take a side or to walk away from a mess. What they DO need is the truth about
// where their message lands, because the alternative — letting them believe the
// owner was notified — is a lie that costs the animal its way home.
//
// So the copy states the routing and withholds the reason. Every word of it is
// true, and nothing in it exposes the conflict.
//
// The reason is NOT secret in general — the reviewing authority, the parties
// and the audit trail all have it. It is simply not the finder's to carry.

/** Heading above the neutral finder-tip form. */
export const DISPUTE_TIP_HEADING = "Tu aviso va a la autoridad";

/**
 * The routing sentence. Says where the message goes and who reads it, never
 * why. Rendered directly above the tip form on every surface.
 */
export const DISPUTE_TIP_INTRO =
  "En esta credencial los avisos los recibe la autoridad competente, no la persona registrada como dueña. Contanos qué viste: es la forma de ayudar a este animal.";

/**
 * Compact variant for the lost-credential contact box, where the surrounding
 * card is already offering contact channels and the notice has to explain, in
 * one line, why none of them are the owner.
 */
export const DISPUTE_TIP_NOTICE =
  "En esta credencial los avisos los recibe la autoridad competente, no la persona registrada como dueña.";
