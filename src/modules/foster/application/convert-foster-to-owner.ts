// Use-case: convert an active foster into personal ownership.
//
// The fostering user keeps the pet permanently. In ONE transaction:
//   1. Auth: verify the caller holds an active foster ownership for this pet.
//   2. End the foster ownership row (sets endedAt).
//   3. Emit foster_ended event (reason: "adoption").
//   4. Close the open foster_placement case (if any).
//   5. Close any prior owner/shelter_custody ownership rows (parity with
//      TransfersRepository.closeOwnerOwnerships — prevents unique-active-owner
//      partial index violation).
//   6. Insert new ownership row role='owner', ownerUserId = foster user.
//   7. Emit custody_transferred event (from_role: "owner", to_role: "owner",
//      from_user_id = foster user, to_user_id = foster user — self-transfer
//      semantics for the audit trail).
//   8. Emit conversion notification to the user.
//
// CUSTODY PARITY:
//   - foster_ended UUID is generated UPFRONT (before custody_transferred payload)
//     so the CHECK-constraint ordering (foster_ended_event_id references the
//     foster_ended row) is satisfied — mirrors transfer-custody.ts pattern.
//   - Close prior owner rows BEFORE inserting new owner row (unique-active-owner
//     partial index validation at tx commit time).
//   - authorRole for events = "owner" (the actor is not an org).
//
// AUTH: the action must pass a user whose id matches the active foster's
// ownerUserId. The use-case performs a repo-scoped query (findActiveFosterByUser)
// that implicitly scopes to the caller — server-side auth boundary.

import { randomUUID } from "node:crypto";

import {
  type EndedCaretakerGrant,
  notifyCaretakersOfHandoff,
} from "@/lib/infra/end-pet-ownerships";

import type { FosterRepository } from "../infrastructure/foster-repository";
import type { NewNotification, UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Actor = {
  user: { id: string };
};

type Deps = {
  repo: typeof FosterRepository;
  actor: Actor;
  transaction: <T>(cb: (tx: unknown) => Promise<T>) => Promise<T>;
};

export type ConvertFosterToOwnerInput = {
  petPublicToken: string;
};

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function convertFosterToOwner(
  input: ConvertFosterToOwnerInput,
  deps: Deps,
): Promise<UseCaseResult<{ redirectPath: string }>> {
  const { repo, actor, transaction } = deps;
  const { user } = actor;

  // 1. Pet lookup.
  const petRow = await repo.findPetByToken(input.petPublicToken);
  if (!petRow) {
    return { ok: false, error: "Mascota no encontrada." };
  }

  // 2. Auth: verify caller is the active foster of this pet.
  const fosterRow = await repo.findActiveFosterByUser(petRow.id, user.id);
  if (!fosterRow) {
    return {
      ok: false,
      error: "No tenés un tránsito activo para esta mascota.",
    };
  }

  // Upfront UUID for foster_ended — needed BEFORE custody_transferred payload
  // is constructed (CHECK-constraint ordering: foster_ended_event_id references
  // the foster_ended row UUID). Mirrors transfer-custody.ts pattern exactly.
  const fosterEndedEventId = randomUUID();
  const now = new Date();
  const pendingNotifications: NewNotification[] = [];
  // Filled inside the transaction, flushed after it commits (ARCH-P): telling a
  // caretaker their arrangement ended must never be able to roll back the
  // conversion.
  let endedGrants: EndedCaretakerGrant[] = [];

  try {
    await transaction(async (tx) => {
      const { endedCaretakerGrants } = await repo.insertConvertFosterToOwner(
        {
          petId: petRow.id,
          petName: (petRow as { name: string }).name,
          fosterOwnershipId: fosterRow.id,
          fosterUserId: user.id,
          fosterEndedEventId,
          actorUserId: user.id,
          now,
        },
        tx as Parameters<typeof repo.insertConvertFosterToOwner>[1],
      );
      endedGrants = endedCaretakerGrants;
    });
  } catch (err) {
    return {
      ok: false,
      error: `No se pudo convertir el tránsito: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // The person who was looking after the animal day to day just lost access,
  // and the pet vanished from their list. Best-effort and post-tx.
  if (endedGrants.length > 0) {
    await notifyCaretakersOfHandoff(endedGrants, {
      name: (petRow as { name: string }).name,
      publicToken: input.petPublicToken,
    });
  }

  pendingNotifications.push({
    userId: user.id,
    notificationType: "foster_converted_to_owner",
    title: `¡${(petRow as { name: string }).name} ahora es tuya/tuyo!`,
    body: `Convertiste el tránsito de ${(petRow as { name: string }).name} en adopción permanente. Felicitaciones.`,
    severity: "success",
    ctaLabel: "Ver mascota",
    ctaUrl: `/mis-mascotas/${input.petPublicToken}`,
    relatedPetId: petRow.id,
  });

  return {
    ok: true,
    value: {
      redirectPath: `/mis-mascotas/${input.petPublicToken}`,
    },
    notifications: pendingNotifications,
  };
}
