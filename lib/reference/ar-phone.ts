// Argentine phone-number heuristics — NOW A RE-EXPORT, not a definition.
//
// The regex and the predicate moved to `@dim/contract/input`'s `ar-phone.ts` on
// 2026-08-29 (WU-R), because the native "editar mis datos" form needs the same
// soft warning this one gives and `lib/` is not reachable from `apps/mobile`.
// The alternative was a second copy of the regex in the app: two opinions about
// what an Argentine phone number looks like, drifting the first time either was
// tuned, on the field a rescuer dials when they find somebody's dog.
//
// THIS FILE STAYS so the three existing web call sites keep their import path —
// `EditProfileForm.tsx` and `EmergencyContactFields.tsx` did not need to change
// for a package move, and a rename touching them would have made the diff read
// like a behaviour change. It is a re-export and nothing else: the rules,
// including why the empty string answers `true`, live with the definition.

export { AR_PHONE_RE, looksLikeArPhone } from "@dim/contract/input";
