// The former-owner face of `GET /api/v1/pets/{publicToken}` (notificaciones-
// destinos, 2026-10): `FormerOwnerPetReadV1` from a granted
// `getFormerOwnerReadAccess` — the same handful of fields the web's
// `FormerOwnerCustodyReadOnlyView` renders (app/(app)/mis-mascotas/
// [publicToken]/page.tsx), and nothing more.

import {
  FORMER_OWNER_FACE_PARAM,
  FORMER_OWNER_FACE_VALUE,
  FORMER_OWNER_PET_READ_PAYLOAD_VERSION,
  FORMER_OWNER_PET_READ_STALE_AFTER_MS,
  type FormerOwnerPetReadV1,
} from "@dim/contract/api";

import { apiV1Envelope, apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { type FormerOwnerReadAccess, getFormerOwnerReadAccess } from "@/lib/infra/pet-access";

/** Whether the caller asked for the former-owner face (`?face=former_owner`). */
export function wantsFormerOwnerFace(request: Request): boolean {
  return new URL(request.url).searchParams.get(FORMER_OWNER_FACE_PARAM) === FORMER_OWNER_FACE_VALUE;
}

export function buildFormerOwnerPetReadV1(
  access: Extract<FormerOwnerReadAccess, { ok: true }>,
  now: Date = new Date(),
): FormerOwnerPetReadV1 {
  const { pet, custodyCase } = access;
  return {
    ...apiV1Envelope({
      payloadVersion: FORMER_OWNER_PET_READ_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: FORMER_OWNER_PET_READ_STALE_AFTER_MS,
    }),
    face: "former_owner_during_custody",
    pet: {
      publicToken: pet.publicToken,
      name: pet.name,
      species: pet.species,
      breed: pet.breed ?? null,
      sex: pet.sex ?? null,
      dateOfBirth: pet.dateOfBirth ?? null,
    },
    custodyCase: { publicCode: custodyCase.publicCode },
  };
}

/**
 * The face, answered EXCLUSIVELY: the read-only custody face or `not_found`,
 * never the holder detail, so a client always knows which shape it holds.
 * `userId` must already be a live, verified account — the route resolves it.
 */
export async function formerOwnerFaceResponse(
  publicToken: string,
  userId: string,
  budgetMs: number,
  retryAfterSeconds: number,
) {
  let former: FormerOwnerReadAccess;
  try {
    former = await withDbBudgetOrThrow(
      getFormerOwnerReadAccess(publicToken, userId),
      budgetMs,
      "api-v1-pet-detail-former-owner",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) {
      return apiV1Error("temporarily_unavailable", 503, {
        "retry-after": String(retryAfterSeconds),
      });
    }
    throw err;
  }
  if (!former.ok) return apiV1Error("not_found", 404);
  return apiV1Json(buildFormerOwnerPetReadV1(former), { status: 200 });
}
