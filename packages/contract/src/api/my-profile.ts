// `GET /api/v1/me/profile` — what the "Editar mis datos" form pre-fills with,
// and `POST /api/v1/me/profile` — saving it.
//
// NOT A SECOND `/api/v1/me`, AND THE DIFFERENCE IS THE POINT
// ---------------------------------------------------------------------------
// `MeV1` is the SHELL: four fields, fetched on every cold launch, and its
// docblock spends a paragraph on what it deliberately withholds — "No email, no
// DNI in any form, no phone, no jurisdiction. That is the whole defence for what
// a stolen access token buys, and this screen must not undo it by fetching the
// missing pieces from somewhere else to make a nicer profile card."
//
// This payload carries a phone. That is not the thing that paragraph forbids,
// and the distinction is worth stating precisely rather than waving at:
//
//   · WHAT IS FORBIDDEN is widening what a token buys CHEAPLY and PASSIVELY. A
//     shell every client fetches on launch is a payload an attacker gets by
//     doing nothing; adding a field there adds it to every stolen session at
//     once.
//   · WHAT THIS IS is a form pre-fill, on its own URL, fetched only when
//     somebody opens the edit screen — and it returns EXACTLY the six fields
//     that screen writes back. No email, no DNI, no jurisdiction, no role, no
//     avatar. The list is the writer's list (`updateProfileForUser`), so this
//     read discloses nothing a caller could not already obtain by writing.
//
// The second bullet stops being true the moment a seventh field appears here.
// That is the line: this is a mirror of the form, and if it ever becomes a
// profile document it has become the thing `MeV1` refuses to be.
//
// WHY THE WRITE IS A POST AND NOT A PATCH
// ---------------------------------------------------------------------------
// Every write on this surface is a POST — the `/api/v1` convention has no PATCH
// anywhere — and the semantics match anyway: the form submits all six fields
// together and the writer treats an omitted field as "leave it alone" and an
// empty string as "clear it". That three-way distinction is the reason the input
// schema keeps `undefined` and `""` apart, and it is the writer's own rule
// (`update-profile.ts`), stated once and mirrored here rather than re-derived.

export const MY_PROFILE_PAYLOAD_VERSION = 1;

/**
 * SIXTY SECONDS. Short, and shorter than the shell's — because the only reason
 * to hold this payload at all is the form that is open right now, and a client
 * that reopened the screen five minutes later must re-read rather than show a
 * value somebody may have changed from the web in between.
 *
 * It is not zero, unlike `/me/privacy`'s: there is no exfiltration argument here
 * (the caller can write these fields, so reading them buys nothing), and a
 * zero would make an accidental double-mount cost two round trips.
 */
export const MY_PROFILE_STALE_AFTER_MS = 60_000;

/**
 * The caller's own editable profile.
 *
 * EVERY FIELD IS A STRING, `""` FOR ABSENT, and that is a deliberate flattening
 * of the database's `null`. A form binds to strings; a client that had to map
 * `null → ""` on the way in and `"" → null` on the way out would be re-deriving
 * the writer's clearing semantics on the wire, and the two would disagree the
 * first time somebody cleared a field. Here the rule is stated once: `""` means
 * "not set", in both directions, and the writer turns it back into `null`.
 */
export type MyProfileV1 = {
  payloadVersion: typeof MY_PROFILE_PAYLOAD_VERSION;
  /** The three envelope fields §6 requires on every read. Built by `apiV1Envelope`. */
  issuedAt: string;
  staleAfter: string;
  profile: {
    /** The one required field. Two to eighty characters, per the writer. */
    displayName: string;
    phone: string;
    preferredVetName: string;
    preferredVetPhone: string;
    emergencyContactName: string;
    emergencyContactPhone: string;
  };
};

/**
 * The bare write payload, per §2 (a write is not a snapshot, so no envelope).
 *
 * `saved: true` AND NOT `changed: boolean`, WHICH IS THE FIELD THIS WOULD
 * RATHER CARRY. The writer already computes the diff — it has to, for the audit
 * row's `changed_fields` — so a "you changed nothing" signal is one return value
 * away, and it is the better contract: `pets/{token}/profile` reports exactly
 * that as `changed: false`, and a form that can stay silent when nothing moved
 * is a form that does not teach people the button is decorative.
 *
 * It is not here because `updateProfileForUser` shares `UpdateProfileResult`
 * with `updateEmergencyContactsForPet`, and widening the shared type to carry a
 * diff only one of the two computes would either force the second writer to
 * compute one it has no use for, or make the field optional — at which point
 * every reader needs a default, and the only available default (`true`) is the
 * lie the field existed to avoid. Splitting the type is the right change and it
 * is a change to a shared writer during a parallel-worktree window, which is
 * the one thing worth deferring here. Recorded so the next person adds
 * `changed` on purpose rather than discovering the gap.
 */
export type MyProfileUpdatedV1 = { saved: true };
