// Use-case: createLibretaShareForUser — strangler migration 32/61.
//
// Pure writer: receives userId + input, runs the DB mutation, and returns the
// result. No Next.js request context.
//
// The outer shim (app/actions/libreta-share.ts) gates via the Supabase session.
// Tests call createLibretaShareForUser directly with a known userId.

import { and, count, eq, isNull } from "drizzle-orm";

import { db, libretaShareTokens, ownerships, pets } from "@/db";
import { generateLibretaShareToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";
import { MAX_ACTIVE_LIBRETA_SHARES } from "@dim/contract/input";

import type { CreateShareInput, CreateShareResult } from "./types";

/**
 * The five-active cap, FROM THE CONTRACT.
 *
 * MOVED THERE (WU-N) from a module-local const here, so both doors read ONE
 * number — the `MAX_WEIGHT_KG` move, for the same reason. It is enforced HERE
 * and nowhere else; the contract carries it so a client can disable the create
 * control with an explanation instead of offering a button that answers with the
 * refusal below. An affordance hint, never the rule.
 */
const MAX_ACTIVE_SHARES_PER_PET = MAX_ACTIVE_LIBRETA_SHARES;

export async function createLibretaShareForUser(
  userId: string,
  input: CreateShareInput,
): Promise<CreateShareResult> {
  // Verify active ownership of the pet identified by publicToken.
  const [petRow] = await db
    .select({ id: pets.id })
    .from(pets)
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .where(
      and(
        eq(pets.publicToken, input.petPublicToken),
        eq(ownerships.ownerUserId, userId),
        isNull(ownerships.endedAt),
      ),
    )
    .limit(1);
  if (!petRow) return { error: "Mascota no encontrada o sin permisos." };

  // Enforce hard cap of 5 active shares per pet.
  const [{ activeCount }] = await db
    .select({ activeCount: count() })
    .from(libretaShareTokens)
    .where(and(eq(libretaShareTokens.petId, petRow.id), isNull(libretaShareTokens.revokedAt)));
  if (activeCount >= MAX_ACTIVE_SHARES_PER_PET) {
    return {
      error: `Ya tenés ${MAX_ACTIVE_SHARES_PER_PET} compartidos activos para esta mascota. Revocá uno antes de crear otro.`,
    };
  }

  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  // Idempotency guard (projection-writes audit §6): a double-submit of the
  // share form posts the same label + expiry twice within moments. Instead of
  // minting a second token (burning through the 5-active cap), reuse the
  // existing active token when one matches the same label and an equivalent
  // expiry (both permanent, or expiring within a minute of the requested
  // window — the double-click delta). A deliberate second share with a
  // different label or duration still creates a fresh token.
  const activeShares = await db
    .select({
      shareToken: libretaShareTokens.shareToken,
      label: libretaShareTokens.label,
      expiresAt: libretaShareTokens.expiresAt,
    })
    .from(libretaShareTokens)
    .where(
      and(
        eq(libretaShareTokens.petId, petRow.id),
        eq(libretaShareTokens.createdByUserId, userId),
        isNull(libretaShareTokens.revokedAt),
      ),
    );
  const duplicate = activeShares.find((s) => {
    if ((s.label ?? null) !== (input.label ?? null)) return false;
    if (s.expiresAt === null || expiresAt === null) return s.expiresAt === expiresAt;
    return Math.abs(s.expiresAt.getTime() - expiresAt.getTime()) < 60_000;
  });
  if (duplicate) return { shareToken: duplicate.shareToken };

  const shareToken = await generateUniqueToken(
    libretaShareTokens,
    libretaShareTokens.shareToken,
    generateLibretaShareToken,
  );

  await db.insert(libretaShareTokens).values({
    shareToken,
    petId: petRow.id,
    createdByUserId: userId,
    label: input.label,
    expiresAt,
  });

  return { shareToken };
}
