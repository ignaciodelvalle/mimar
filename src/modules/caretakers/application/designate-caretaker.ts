// Use-case: the titular invites someone to be this pet's temporary caretaker.
//
// AUTH IS THE ACTION'S JOB. `requireTitularAccess` runs at the edge and hands
// this layer an already-authorized `petId` — the use-case never re-resolves it,
// and never sees a session.
//
// NO SPINE EVENT IS WRITTEN HERE. A pending invitation is workflow state, not a
// fact about the animal: there is no `caretaker_proposed`. `caretaker_designated`
// is emitted at ACCEPT, by accept-caretaker-grant.ts. That is why this file
// creates a row and nothing else.

import { validateDesignation } from "../domain/grant-rules";
import { MAX_GRANT_DURATION_DAYS } from "../domain/types";
import type { CaretakersRepositoryPort } from "./ports";
import type { NewNotification, UseCaseResult } from "./types";

type Deps = {
  repo: CaretakersRepositoryPort;
  /** Injected clock. Never `new Date()` inside — the period rules depend on it. */
  now: () => Date;
};

export type DesignateCaretakerInput = {
  petId: string;
  petName: string;
  petPublicToken: string;
  titularUserId: string;
  inviteeEmail: string;
  startsAt: Date;
  endsAt: Date;
  note: string | null;
};

export type DesignateCaretakerValue = {
  grantPublicToken: string;
  /** True when no account matched the email — the action sends an invite mail. */
  inviteeNeedsAccount: boolean;
  inviteeEmail: string;
};

export async function designateCaretaker(
  input: DesignateCaretakerInput,
  deps: Deps,
): Promise<UseCaseResult<DesignateCaretakerValue>> {
  const { repo } = deps;
  const now = deps.now();

  const email = input.inviteeEmail.trim().toLowerCase();
  const inviteeUserId = email.length > 0 ? await repo.findUserIdByEmail(email) : null;

  const validation = validateDesignation({
    titularUserId: input.titularUserId,
    inviteeUserId,
    inviteeEmail: email,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    now,
    maxDurationDays: MAX_GRANT_DURATION_DAYS,
  });
  if (!validation.ok) return { ok: false, error: validation.error };

  // Concurrency: at most one pending AND at most one accepted grant per pet.
  // Both are enforced by partial unique indexes too — this is the readable
  // refusal, not the invariant. The index is what holds under a race.
  //
  // ACCEPTED is reported FIRST: the two indexes have different predicates, so a
  // pet can legitimately hold one of each for a moment, and "there is already
  // an active caretaker" is the more actionable of the two messages.
  const open = await repo.findOpenGrantsForPet(input.petId);
  if (open.some((g) => g.status === "accepted")) {
    return { ok: false, error: `${input.petName} ya tiene un cuidador/a temporal activo.` };
  }
  if (open.some((g) => g.status === "pending")) {
    return {
      ok: false,
      error: "Ya hay una invitación de cuidado pendiente para esta mascota.",
    };
  }

  const grant = await repo.insertGrant({
    petId: input.petId,
    grantedByUserId: input.titularUserId,
    caretakerUserId: inviteeUserId,
    caretakerEmail: email,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    note: input.note?.trim() || null,
    now,
  });

  const notifications: NewNotification[] = [];
  if (inviteeUserId) {
    const titularName = (await repo.findDisplayName(input.titularUserId)) ?? "Alguien";
    notifications.push({
      userId: inviteeUserId,
      notificationType: "caretaker_invitation_received",
      // Stable across: retries of this designate action for the grant row just
      // inserted. Distinct across: every other invitation — a re-invitation
      // after a cancel/reject/expiry is a NEW grant row with a new id, so the
      // titular can always invite again and the invitee is always told.
      // Single-recipient notice, so the recipient id adds no discrimination
      // here; it is kept for one uniform key shape across the module.
      dedupeKey: `caretaker:invitation_received:${grant.id}:${inviteeUserId}`,
      severity: "info",
      title: `${titularName} te propone cuidar a ${input.petName}`,
      body: "Mirá el período y lo que podés hacer antes de aceptar. La invitación vence en 7 días.",
      ctaLabel: "Ver invitación",
      ctaUrl: `/cuidado/${grant.publicToken}`,
      relatedPetId: input.petId,
      category: "custody",
    });
  }

  return {
    ok: true,
    value: {
      grantPublicToken: grant.publicToken,
      inviteeNeedsAccount: inviteeUserId === null,
      inviteeEmail: email,
    },
    notifications,
  };
}
