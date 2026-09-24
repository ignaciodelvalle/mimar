// Identity completeness — is this profile still carrying the PROVISIONAL name?
//
// WHY THIS EXISTS (staging finding, 2026-08-01)
// ---------------------------------------------
// 15 of 25 owner profiles on staging had `display_name` set to the exact
// local-part of their email (e.g. "qa-maintainer+cursor-owner2"). That is
// the provisional value written by the `handle_new_user` trigger:
//
//   coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
//
// signupAction deliberately supplies no display_name metadata, so every brand
// new account starts provisional; completeIdentityAction (signup step 2) is the
// only thing that overwrites it with a real "First Last". When step 2 is skipped
// or abandoned, the provisional value becomes permanent — and this system is an
// identity registry, so a titular with no real name is a record that does not
// do its job.
//
// The detection rule is deliberately TIGHT: it matches exactly what the trigger
// produces and nothing else.
//
//   pending  <=>  display_name is blank
//             OR  display_name === split_part(email, '@', 1)   (case-insensitive)
//
// It is NOT "display_name has no surname". A single-word name written by an
// admin or a service-role script is not the defect we measured, and widening the
// rule would nag accounts that were never broken. Widening is a product call,
// not a silent one.
//
// False-positive shape: a user whose real full name happens to equal their email
// local-part. completeIdentityAction requires BOTH firstName and lastName and
// joins them with a space, and an unquoted email local-part cannot contain a
// space — so the form itself can never produce that collision.
//
// WHY THE `MeV1User` PROJECTION LIVES HERE TOO (native QA batch 1, D1)
// ---------------------------------------------------------------------------
// `GET /api/v1/me` and `POST /api/v1/auth/login` both answered
// `profilePending: false` for a brand-new native account, and the native gate
// therefore let it straight into "Mis mascotas" — where it could register a pet
// under a name nobody had entered. Both handlers were reading ROW EXISTENCE
// (`profile ? … : …`), on a stated belief that "a brand-new account has no
// profile row yet" (session-store.ts, CrearCuentaScreen.tsx). That belief is
// false and has been since the trigger existed: `handle_new_user`
// (db/triggers.sql) inserts a `profiles` row inside the same transaction that
// creates the `auth.users` row, so the window those comments describe is never
// observed by anything that runs after signup returns. The provisional name it
// writes is exactly what `isIdentityPending` above was built to detect.
//
// The projection is shared rather than written twice because the two payloads
// are ONE type on purpose — `LoginV1.user` IS `MeV1User`, so a native client can
// write a single exhaustive switch — and the last time these handlers each built
// that union by hand they disagreed about the same account in the same second
// (see the `LoginV1` docblock). One function is what makes "one type, one
// answer" a fact instead of a promise.

import type { MeV1User } from "@dim/contract/api";

/**
 * The provisional display name the `handle_new_user` trigger derives from an
 * email address.
 *
 * Mirrors Postgres `split_part(email, '@', 1)` — the FIRST segment, not the
 * last. That distinction only matters for malformed addresses, but this
 * function's whole job is to reproduce the trigger byte for byte, so it splits
 * the way the trigger splits.
 */
export function emailLocalPart(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.indexOf("@");
  return (at === -1 ? email : email.slice(0, at)).trim();
}

/**
 * True when the profile never completed signup step 2 and is still showing the
 * trigger's provisional, email-derived name.
 *
 * Server-computed on purpose. The two-step signup form kept its step in React
 * `useState`, which dies with the browser tab; this predicate is re-evaluated
 * from the database on every request, so an abandoned signup is still
 * recoverable tomorrow, on another device, after any number of closed tabs.
 */
export function isIdentityPending(input: {
  displayName: string | null | undefined;
  email: string | null | undefined;
}): boolean {
  const name = (input.displayName ?? "").trim();
  if (name === "") return true;

  const localPart = emailLocalPart(input.email);
  // No email to compare against (service accounts, imported rows): a non-blank
  // name is the best evidence available. Do not nag.
  if (localPart === "") return false;

  return name.toLowerCase() === localPart.toLowerCase();
}

/**
 * The `/api/v1` shell projection of "who is this caller", for the two endpoints
 * that answer it: `GET /api/v1/me` and `POST /api/v1/auth/login`.
 *
 * `profilePending: true` means THE IDENTITY IS NOT COMPLETE — not "there is no
 * row". Two distinct states collapse into that arm and both are the same thing
 * to a client:
 *
 *   · no `profiles` row at all — the window the contract's docblock describes.
 *     Unreachable through signup while `handle_new_user` exists, but still the
 *     shape a service-role delete or a partially-restored account produces, so
 *     it is answered rather than assumed away;
 *   · a row still carrying the trigger's PROVISIONAL, email-derived name —
 *     signup step 2 was never completed. This is the state every native signup
 *     lands in, and since 2026-09-05 it is also one the app can LEAVE on its own:
 *     `identidad-pendiente` collects nombre and apellido and posts them to
 *     `POST /api/v1/me/identity`. This paragraph used to say the app
 *     "deliberately has no identity form of its own", which was true until that
 *     door landed; the DNI is still web-only.
 *
 * The completed arm deliberately drops nothing and adds nothing: same four
 * fields, same union, same payload version. What changed is only WHICH arm a
 * provisional account gets.
 *
 * Role and accountType are NOT reported for a pending identity, and that is the
 * original reasoning unchanged: "owner" is a bad guess to make about a person
 * who has not finished registering, and a provisional profile row carries
 * exactly that guess — the trigger hard-codes `'owner'` for every row it writes
 * (migration 0134).
 */
export function toMeV1User(input: {
  id: string;
  email: string | null | undefined;
  profile: {
    displayName: string;
    role: "owner" | "vet" | "govt" | "admin" | "national";
    accountType: "personal" | "institutional";
  } | null;
}): MeV1User {
  if (
    input.profile === null ||
    isIdentityPending({ displayName: input.profile.displayName, email: input.email })
  ) {
    return { profilePending: true, id: input.id };
  }

  return {
    profilePending: false,
    id: input.id,
    displayName: input.profile.displayName,
    role: input.profile.role,
    accountType: input.profile.accountType,
  };
}
