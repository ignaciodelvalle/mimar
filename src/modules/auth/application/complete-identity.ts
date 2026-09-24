// Use-case: completeIdentityAction — step 2 of the two-step signup flow (strangler migration 26/61).
//
// THE BROWSER'S ADAPTER, AND SINCE 2026-09-05 ONLY THAT
// ---------------------------------------------------------------------------
// This file used to be both the adapter and the act. The act now lives in
// `./complete-identity-for-user.ts`, which takes a `userId` and two names and has
// no Next request anywhere in it — that is what let the same step land as
// `POST /api/v1/me/identity` for the app (PO decision 2026-09-05: the identity
// step moves INTO the native app; the web keeps the DNI).
//
// What stayed HERE is everything that is about a browser form:
//   · `FormData` in, `IdentityFormState` out;
//   · the session, resolved from the cookie-backed Supabase client;
//   · (THE DNI USED TO BE ON THIS LIST — its format rule and its optionality.
//     Both are gone since 2026-09-07 and the block below says why. This bullet
//     stays as a pointer rather than vanishing, because "what stayed HERE" is an
//     inventory somebody trusts instead of re-reading the file, and an inventory
//     that silently drops an entry teaches nothing.);
//   · the es-AR sentences, which are prose for a page rather than codes for a
//     client.
//
// Every non-redirecting error branch echoes firstName/lastName back in
// IdentityFormState, mirroring the login/signup field-wipe fix (bug #46):
// React 19 auto-resets this uncontrolled form once the action resolves, and
// a validation error (no redirect) would otherwise wipe the name the user
// just typed. (This sentence used to end "DNI is intentionally not echoed — out
// of scope for this fix." There is no DNI to echo any more.)

import { createClient } from "@/lib/supabase/server";

import { completeIdentityForUser } from "./complete-identity-for-user";
import type { IdentityFormState } from "./types";

// NO DNI IS READ FROM THIS FORM ANY MORE (2026-09-07). The reasoning lives next
// to the field that was removed, in `app/(auth)/registro/SignupForm.tsx`; the
// short version is that a DNI typed here left `dni_verified` false and so
// unlocked nothing, while still occupying `profiles_dni_hash_unique` — which is
// partial on `dni_hash IS NOT NULL`, not on `dni_verified` — and could therefore
// lock a stranger out of verifying their own.
//
// THE PARSE IS GONE, NOT JUST THE INPUT, and that is the point: dropping the
// field alone would leave a server action that still accepts `dni` from any
// hand-crafted POST. A form field is a suggestion; the reader is the boundary.
//
// `/cuenta/verificar-dni` is deliberately untouched — it is the voluntary,
// audited door, and it is what the four gated flows (vet upgrade, create
// organization, create consultorio, tránsito volunteer) actually read.

export async function completeIdentityAction(
  _previous: IdentityFormState,
  formData: FormData,
): Promise<IdentityFormState> {
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();

  if (!firstName || !lastName) {
    return { error: "Ingresá tu nombre y apellido.", firstName, lastName };
  }

  // NO LOCATION IS COLLECTED HERE ANY MORE (2026-08-27, PO decision:
  // "la jurisdicción implica compliance, pero es a nivel mascota y no cuenta").
  //
  // This step used to render a locality field and write
  // profiles.jurisdiction_province / _locality. It had exactly ONE writer — this
  // function — and ZERO readers: every aggregate, panorama layer, k-anonymity
  // cell and routing path in the product keys on pets.*, welfare_reports.*,
  // service_offerings.*, govt_assignments.* or organizations.*, never on
  // profiles. lib/infra/admin-search.ts records the profile→jurisdiction link
  // being REJECTED on purpose for govt user scoping.
  //
  // The field's own hint said it "ayuda a las campañas regionales de salud
  // animal" and the public privacy page said the province and locality "se usan
  // para enrutar denuncias y estimar coberturas". Neither was true of the code.
  // Collecting a personal datum for a purpose that does not exist is a finalidad
  // problem under Ley 25.326 art. 4 in its own right, so the honest fix is not
  // to erase it harder — it is to stop asking. Migration 0205 nulls the two
  // columns for every existing profile and marks them inert.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // No active session at step 2. With email confirmation OFF (the current
    // posture — see signup.ts), step 1's signUp returns a session, so reaching
    // here means the session was lost: cookies cleared, an expired cookie, or —
    // the case the pilot actually walks — a browser opened from the app through
    // `IDENTITY_COMPLETION_URL`, which carries no session at all. Previously this
    // silently redirected back to step 1, which both LOOPED and discarded the
    // name the user had just typed. Fail HONESTLY instead: keep the user on step
    // 2, echo their name back (no data loss), and tell them what to do.
    //
    // THE COPY NO LONGER MENTIONS CONFIRMING AN EMAIL (2026-09-05). It used to
    // hedge — "si te pedimos confirmar tu correo, revisá tu casilla" — against a
    // posture that has been OFF since the PO decided it on 2026-07-10, and the
    // pilot paid for the hedge: testers read the sentence as an instruction,
    // went looking for a mail that is never sent, and some created a second
    // account instead (8 invalid-credential attempts and 2 duplicate signups in
    // one hour of GoTrue log, 2026-09-05). A conditional about a feature that is
    // switched off is not caution; it is a wrong instruction with a "si" in
    // front of it. If confirmations are ever switched on, THIS sentence is one
    // of the things that has to change with them.
    //
    // It still says nothing about whether the address has an account — the
    // enumeration stance from audit 28-#3 is unchanged, and "iniciá sesión" is
    // the same instruction for a stranger and for the person this page is for.
    return {
      error:
        "No pudimos activar tu sesión. Iniciá sesión con tu correo y contraseña para completar tus datos.",
      firstName,
      lastName,
    };
  }

  // THE ACT, which is no longer in this file.
  //
  // `dni: null` ALWAYS, since 2026-09-07. The writer still accepts one — the
  // parameter is kept rather than deleted because the PO's decision is "por
  // ahora", pending Mi Argentina, and a capability that may come back should
  // come back as one line rather than as a reconstruction. It now has no caller
  // that passes a value: this action pins null, and the native path
  // (`app/api/v1/me/identity/route.ts`) already refused to carry one ("NO DNI,
  // AND ITS ABSENCE IS THE DECISION").
  const result = await completeIdentityForUser({
    userId: user.id,
    email: user.email,
    firstName,
    lastName,
    dni: null,
  });

  if (!result.ok) {
    // THREE REFUSALS, ONE SENTENCE EACH, AND THE WRITE FAILURE STAYS GENERIC.
    //
    // That last part is the DNI enumeration defence (audit 28-#3, pilot MED)
    // preserved verbatim: a distinct "ese DNI ya está registrado por otra
    // cuenta" would confirm to an authenticated attacker which DNIs exist,
    // turning the `profiles_dni_hash_unique` index (migration 0106) into an
    // oracle. The writer collapses every driver failure into one arm precisely
    // so this branch cannot accidentally learn to tell them apart. The duplicate
    // is still prevented — the index rejects the write.
    if (result.error === "VALIDATION") {
      // THE CODE, NOT AN ASSUMPTION ABOUT WHICH RULE FIRED. This branch answered
      // "es demasiado largo" to every schema refusal, on the reasoning that the
      // empty case is already caught above — true until `NAME_INVALID` landed
      // (2026-09-05), at which point it told somebody who had pasted a zero-width
      // character that their four-letter name was too long.
      const noun = result.field === "lastName" ? "apellido" : "nombre";
      return {
        error:
          result.code === "NAME_TOO_LONG"
            ? `Ese ${noun} es demasiado largo. Escribilo más corto.`
            : `Revisá ese ${noun}: necesita al menos una letra y no puede llevar caracteres invisibles. Si lo copiaste y pegaste, escribilo a mano.`,
        firstName,
        lastName,
      };
    }
    if (result.error === "STILL_PROVISIONAL") {
      return {
        error: "Ese nombre no nos sirve para identificarte. Escribí tu nombre y apellido reales.",
        firstName,
        lastName,
      };
    }
    return {
      error: "No pudimos guardar tus datos. Revisá la información e intentá de nuevo.",
      firstName,
      lastName,
    };
  }

  // The fresh `MeV1User` is deliberately DROPPED here. A browser re-renders from
  // the server on the next navigation and the page's own identity guard re-reads
  // the profile, so handing it back through `IdentityFormState` would put a
  // second copy of the session state in a form's return value for nobody to
  // read. The native route is the caller that needs it — it has a store to
  // update and no re-render to fall back on.
  return { error: null, ok: true };
}
