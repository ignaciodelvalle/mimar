// The COMPARTIR read payload — what `GET /api/v1/pets/{publicToken}/shares`
// answers, built once from rows the route already holds.
//
// EVERY CAPABILITY IS DECIDED HERE AND NOWHERE ELSE, and each one is a mirror of
// a guard the web performs somewhere else entirely. The web's answers are spread
// across three files — a `requireTitularAccess` in one shim, a
// `requireLiveUser` plus an in-writer creator check in another, and an
// `accessPath !== "owner"` early return in a third — and a client cannot see any
// of them. Collecting them here is the whole point of the payload.

import type { LibretaShareToken } from "@/db";
import { apiV1Envelope } from "@/lib/infra/api-v1";
import { canRevokeShare } from "@/src/modules/pets/application/libreta-share/share-revocation-scope";
import {
  type LibretaShareV1,
  PET_SHARES_PAYLOAD_VERSION,
  PET_SHARES_STALE_AFTER_MS,
  type PetSharesV1,
  type ShareCapabilitiesV1,
  type Tier2StateV1,
} from "@dim/contract/api";
import { MAX_ACTIVE_LIBRETA_SHARES } from "@dim/contract/input";

export type SharesPetRow = {
  id: string;
  publicToken: string;
  name: string;
  status: string;
  tier2PublicEnabledUntil: Date | null;
  tier2PublicPermanent: boolean;
};

export type BuildPetSharesInput = {
  pet: SharesPetRow;
  /** Active (unrevoked) rows for this pet. Empty on the org path — see below. */
  shares: LibretaShareToken[];
  /** `"owner"` on the person path, `"org"` on the org-mediated one. */
  accessPath: "owner" | "org";
  /** The person-path ownership role, or `null` on the org path. */
  holderRole: string | null;
  /** The caller, for the per-row creator check. */
  userId: string;
  /** Whether the caller is a platform admin — the other half of that check. */
  isAdmin: boolean;
  now: Date;
};

/**
 * `requireTitularAccess`, as a shape.
 *
 * Copied as a DENY and not as an allow-list, because an allow-list would quietly
 * narrow the roles the web admits: `requireTitularAccess` denies exactly one
 * thing — a person-path holder whose role is `caretaker` — and a co-owner, a
 * foster and the ORG path all pass it (`lib/infra/pet-access.ts:451`).
 */
export function isTitular(accessPath: "owner" | "org", holderRole: string | null): boolean {
  return !(accessPath === "owner" && holderRole === "caretaker");
}

/**
 * Whether this caller could mint a link at all, ignoring the cap.
 *
 * NARROWER THAN `isTitular`, AND THE NARROWING IS THE WEB'S OWN — just performed
 * one layer down. `createLibretaShareAction` gates on `requireTitularAccess`,
 * which the ORG path passes; then `createLibretaShareForUser` joins `ownerships`
 * on `owner_user_id = $userId` (`create-libreta-share.ts:41`), which an org
 * member has no row for, and answers "Mascota no encontrada o sin permisos."
 * The refusal is real on the web; it just arrives from the writer instead of the
 * guard. Reporting it as a capability is the same outcome, said before the tap.
 */
export function canMintShare(accessPath: "owner" | "org", holderRole: string | null): boolean {
  return accessPath === "owner" && isTitular(accessPath, holderRole);
}

function toShare(row: LibretaShareToken, input: BuildPetSharesInput): LibretaShareV1 {
  return {
    id: row.id,
    shareToken: row.shareToken,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    // The SERVER's clock, because a client comparing against its own would tell
    // an owner a live credential is dead — and they would leave it running.
    expired: row.expiresAt !== null && row.expiresAt.getTime() <= input.now.getTime(),
    // Creator-or-admin, through the SAME function the writer's own check will
    // reach — not a second comparison that happens to agree today.
    canRevoke: canRevokeShare({
      createdByUserId: row.createdByUserId,
      userId: input.userId,
      isPlatformAdmin: input.isAdmin,
    }),
    viewCount: row.viewCountCached,
    lastViewedAt: row.lastViewedAtCached === null ? null : row.lastViewedAtCached.toISOString(),
  };
}

function toTier2(pet: SharesPetRow, now: Date): Tier2StateV1 {
  const until = pet.tier2PublicEnabledUntil;
  const isActive = pet.tier2PublicPermanent || (until !== null && until.getTime() > now.getTime());
  return {
    isActive,
    isPermanent: pet.tier2PublicPermanent,
    // Null when inactive AND when permanent — the web nulls it in both cases
    // (`SheetMounter.tsx:373`) so nothing renders "vence el …" over a window
    // that never does.
    activeUntil:
      isActive && !pet.tier2PublicPermanent && until !== null ? until.toISOString() : null,
  };
}

function toCapabilities(input: BuildPetSharesInput): ShareCapabilitiesV1 {
  const { accessPath, holderRole, pet, shares } = input;
  const titular = isTitular(accessPath, holderRole);
  const remaining = Math.max(0, MAX_ACTIVE_LIBRETA_SHARES - shares.length);

  return {
    canCreateLibretaShare: canMintShare(accessPath, holderRole) && remaining > 0,
    remainingShareSlots: remaining,
    // The org path PASSES here and does not for minting, which looks like an
    // inconsistency and is the web's actual behaviour: the Tier-2 writer takes
    // the pet the guard already resolved and touches no `ownerships` row, so a
    // shelter holding custody can open the window. Deceased is refused outright
    // (`enable-tier2-public.ts:23`).
    canEnableTier2: titular && pet.status !== "deceased",
    // NOT gated on the window being open, and not on the animal being alive:
    // the web's revoke clears both columns unconditionally. A control that
    // means "make sure this is off" is safe to offer always.
    canRevokeTier2: titular,
  };
}

export function buildPetSharesV1(input: BuildPetSharesInput): PetSharesV1 {
  const { pet, shares, now } = input;

  return {
    ...apiV1Envelope({
      payloadVersion: PET_SHARES_PAYLOAD_VERSION,
      issuedAt: now,
      staleAfterMs: PET_SHARES_STALE_AFTER_MS,
    }),
    publicToken: pet.publicToken,
    petName: pet.name,
    // Newest first — the link somebody just made is the one they came to find.
    libretaShares: [...shares]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((row) => toShare(row, input)),
    tier2: toTier2(pet, now),
    capabilities: toCapabilities(input),
  };
}
