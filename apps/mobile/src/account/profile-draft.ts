// The form's state, and the two conversions at its edges.
//
// WHY IT IS A MODULE AND NOT INLINE STATE
// ---------------------------------------------------------------------------
// `toEditInput` is where the server's three-way field rule is honoured, and that
// rule is invisible from the screen: an omitted key means "leave it", `""` means
// "clear it", a string means "store it". Getting it wrong does not crash and
// does not look wrong — it silently erases somebody's vet phone number, or
// silently refuses to let them clear it. Logic whose failure mode is silent gets
// a test, and a test needs a module (`jest.roots` is `<rootDir>/src`).
//
// THE CONVERSION IS DELIBERATELY TOTAL, and that is the decision worth reading.
// This form renders ALL SIX fields, so it always sends all six — no key is ever
// omitted. The alternative was to diff the draft against what the server sent
// and post only what moved, which is tempting and is a trap here: the "leave it
// alone" arm would then be doing real work, and the day somebody adds a field to
// the payload without adding it to the form, that field starts being preserved
// silently instead of being visibly unsupported. Sending everything means the
// screen can never clear something it did not show, because there is nothing it
// does not show.

import type { MyProfileV1 } from "@dim/contract/api";
import type { MyProfileEditInput } from "@dim/contract/input";

export { looksLikeArPhone } from "@dim/contract/input";

/**
 * The six editable fields, as strings.
 *
 * `""` for absent, in both directions — the flattening the payload already
 * performs on the way out (`null → ""`) and the writer reverses on the way in
 * (`"" → null`). Nothing here re-derives it.
 */
export type ProfileDraft = {
  displayName: string;
  phone: string;
  preferredVetName: string;
  preferredVetPhone: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
};

/** Seed the form from the server's payload. */
export function draftFrom(view: MyProfileV1): ProfileDraft {
  return {
    displayName: view.profile.displayName,
    phone: view.profile.phone,
    preferredVetName: view.profile.preferredVetName,
    preferredVetPhone: view.profile.preferredVetPhone,
    emergencyContactName: view.profile.emergencyContactName,
    emergencyContactPhone: view.profile.emergencyContactPhone,
  };
}

/**
 * The body to POST.
 *
 * `displayName` IS TRIMMED HERE as well as by the schema and by the writer, and
 * the third copy is not redundancy for its own sake: the length check that
 * enables the save button counts trimmed characters, so a name of five spaces
 * must reach the server as the empty string it is rather than as five
 * characters the schema then accepts.
 *
 * THE OTHER FIVE ARE NOT TRIMMED. A phone number with a trailing space is the
 * person's own value and the server stores it as given; trimming it here would
 * be this form quietly editing what somebody typed, which is the behaviour the
 * "format is a warning, not a refusal" decision exists to avoid.
 */
export function toEditInput(draft: ProfileDraft): MyProfileEditInput {
  return {
    displayName: draft.displayName.trim(),
    phone: draft.phone,
    preferredVetName: draft.preferredVetName,
    preferredVetPhone: draft.preferredVetPhone,
    emergencyContactName: draft.emergencyContactName,
    emergencyContactPhone: draft.emergencyContactPhone,
  };
}
