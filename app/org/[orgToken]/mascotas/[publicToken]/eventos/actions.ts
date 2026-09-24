"use server";

// Org pet ficha — clinical event recording wrappers (staging validation
// 2026-07-04, bug 2: members with event.write had NO surface on the held-pet
// ficha to record a vaccine/weight/note).
//
// These are THIN redirect adapters over the shared event actions in
// src/modules/events/actions.ts. The PET write is authorized downstream:
// requireAlivePetAccess / requirePetAccess (lib/infra/pet-access.ts) accept an
// active org custody row, and the `event.write` capability is enforced
// server-side behind the UI gate on the ficha. Provenance (#43) is stamped
// there too: matriculated signer → vet/verified, otherwise shelter/org_registered.
//
// UNTIL 2026-08-26 THAT SENTENCE WAS TRUE OF TWO OF THESE THREE. The capability
// lives in `requireAlivePetAccess`, and the note wrapper's target guards with
// `requirePetAccess`, which checks none — so `orgRecordNoteAction` checked
// `event.write` here and `createNoteAction` did not check it anywhere. That
// made THIS wrapper the only thing standing between an ungated member and a
// note, and a wrapper is not a boundary: a "use server" export is addressable
// on its own, so calling `createNoteAction` directly walked around it. The PO
// ratified the ficha's gate as the rule and the check moved INTO
// `createNoteAction`. The call below is now belt and braces, kept because it
// refuses before the org token is even resolved and because lint:authz reads
// these bodies for a guard name.
//
// The ONLY thing these wrappers change is the success redirect: the shared
// actions land on the OWNER cockpit (/mis-mascotas/...), which is the wrong
// home for an org operator — they return to the org ficha instead.
//
// THE ORG TOKEN IS ALSO AUTHORIZED HERE (2026-08-05). These wrappers used to
// add no auth of their own and took `orgToken` purely as redirect material:
// nothing checked that the caller belonged to the org they were about to be
// sent into. The blast radius was small (the org ficha guards itself, so a
// forged token bought a bounced navigation, not data) — but "a server action
// accepts an unvalidated org token" is the exact shape of the confused-deputy
// class this repo has a whole linter for, and these three exports were invisible
// to every one of those linters until discovery moved to the "use server"
// directive. requireCapabilityForOrgToken resolves the org FROM the token and
// pins the capability check to that org.id, so the redirect target is now
// something the caller has proven they can act in.

import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";

import type { EventFormState } from "@/src/modules/events/actions";
import { createNoteAction } from "@/src/modules/events/actions";
import { createVaccinationAction, createWeightAction } from "@/src/modules/events/actions-medical";

function orgFichaRedirect(orgToken: string, publicToken: string): string {
  return `/org/${orgToken}/mascotas/${publicToken}?registrado=1`;
}

function withOrgRedirect(
  result: EventFormState,
  orgToken: string,
  publicToken: string,
): EventFormState {
  if (result.ok) {
    return { ...result, redirectTo: orgFichaRedirect(orgToken, publicToken) };
  }
  return result;
}

// The guard call is written out in each action rather than hidden behind a
// module-local helper: lint:authz reads function BODIES for a known guard name,
// so a helper wrapper would make three guarded actions look unguarded again.
export async function orgRecordVaccinationAction(
  orgToken: string,
  publicToken: string,
  previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireCapabilityForOrgToken("event.write", orgToken);
  if (access.error !== null) return { error: access.error };
  const result = await createVaccinationAction(publicToken, previous, formData);
  return withOrgRedirect(result, orgToken, publicToken);
}

export async function orgRecordWeightAction(
  orgToken: string,
  publicToken: string,
  previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireCapabilityForOrgToken("event.write", orgToken);
  if (access.error !== null) return { error: access.error };
  const result = await createWeightAction(publicToken, previous, formData);
  return withOrgRedirect(result, orgToken, publicToken);
}

export async function orgRecordNoteAction(
  orgToken: string,
  publicToken: string,
  previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireCapabilityForOrgToken("event.write", orgToken);
  if (access.error !== null) return { error: access.error };
  const result = await createNoteAction(publicToken, previous, formData);
  return withOrgRedirect(result, orgToken, publicToken);
}
