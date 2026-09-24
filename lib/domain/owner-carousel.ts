// owner-carousel.ts — pure helpers for the owner credential carousel
// (owner-ia-redesign P4). The pet profile swipes between the owner's LIVE pets,
// urgent-first; this module owns the two decisions that must stay pure and
// testable independent of React / the DB:
//
//   1. the ORDER + which pets are in the swipe (rankOwnerCarousel), reusing the
//      SAME urgency rank (pet-urgency-rank) and compliance→status fallback that
//      /inicio's credential rail and the profile header use, so the position
//      dots agree with every other owner surface;
//   2. the NEIGHBOR of the current pet (computeCarouselNeighbors) — the prev/
//      next token a swipe or arrow navigates to.
//
// Deceased pets NEVER enter the swipe (PO decision 6) — the caller filters them
// out before building the input; this module makes no deceased-specific choice.

import type { LnPetStatus } from "@/components/ui/Chip";
import { petUrgencyRank } from "@/lib/domain/pet-urgency-rank";

// The dot/navigation set is capped so the position dots stay glanceable. Mirror
// of /inicio's OWNER_CAROUSEL_CAP (app/(app)/inicio/page.tsx) — kept local so
// P4 does not reach into /inicio (which P5 folds away). The dots and the swipe
// navigate the SAME capped set, so the dots never lie about position.
export const OWNER_CAROUSEL_CAP = 8;

export type CarouselPet = {
  token: string;
  status: LnPetStatus;
};

export type CarouselPetInput = {
  token: string;
  /** Raw `pet.status` column value (e.g. "active" | "lost" | "deceased"). */
  status: string;
  pregnancyStatus: string | null;
  /**
   * The pet's `lnPetStatusFromCompliance` status when a compliance projection
   * was resolved for it. `null`/`undefined` falls back to the raw-status
   * heuristic below — the SAME fallback /inicio's carouselStatusOf uses.
   */
  complianceStatus?: LnPetStatus | null;
};

/**
 * Resolve a pet's carousel status: the compliance-derived status when present,
 * else a raw-status heuristic (lost > pregnant > registered). Identical to
 * /inicio's `carouselStatusOf`, so a pet reads the same dot tint on both.
 */
export function resolveCarouselStatus(pet: CarouselPetInput): LnPetStatus {
  if (pet.complianceStatus) return pet.complianceStatus;
  if (pet.status === "lost") return "lost";
  if (pet.pregnancyStatus === "in_progress") return "pregnant";
  return "registered";
}

/**
 * Rank the owner's live pets most-urgent-first (pet-urgency-rank) and cap at
 * OWNER_CAROUSEL_CAP. Sort is stable (V8), so ties keep the caller's input
 * order (fetchPetsForOwner returns createdAt-desc — same tiebreak as /inicio).
 *
 * Deceased pets are dropped HERE, not only by the caller — PO decision 6
 * ("deceased never enter the swipe") is structural, so a future caller that
 * forgets to pre-filter cannot reintroduce them (M3 fresh-review minor 6).
 */
export function rankOwnerCarousel(pets: CarouselPetInput[]): CarouselPet[] {
  return pets
    .filter((p) => p.status !== "deceased")
    .map((p) => ({ token: p.token, status: resolveCarouselStatus(p) }))
    .sort((a, b) => petUrgencyRank(a.status) - petUrgencyRank(b.status))
    .slice(0, OWNER_CAROUSEL_CAP);
}

export type CarouselNeighbors = {
  /** Index of `currentToken` in `tokens`, or -1 when absent. */
  index: number;
  /** Token to the LEFT (more urgent), or null at the first position. */
  prevToken: string | null;
  /** Token to the RIGHT (less urgent), or null at the last position. */
  nextToken: string | null;
};

/**
 * Neighbor of `currentToken` in the ranked `tokens` list.
 *
 * CLAMP AT ENDS — NO WRAP (deliberate): the position dots draw a LINEAR
 * sequence, so wrapping (last → first) would make the dots lie — the highlighted
 * dot would jump from the right end back to the left while the reader believes
 * they moved forward. Clamping means the first pet has no previous neighbor and
 * the last has no next; the corresponding arrow/swipe is a no-op and the arrow
 * button renders disabled. When `currentToken` is not in the list (e.g. an owner
 * with more live pets than the cap, viewing one past the cap), both neighbors
 * are null and the caller renders no chrome.
 */
export function computeCarouselNeighbors(
  tokens: string[],
  currentToken: string,
): CarouselNeighbors {
  const index = tokens.indexOf(currentToken);
  if (index === -1) return { index: -1, prevToken: null, nextToken: null };
  return {
    index,
    prevToken: index > 0 ? tokens[index - 1] : null,
    nextToken: index < tokens.length - 1 ? tokens[index + 1] : null,
  };
}

/**
 * Whether the carousel chrome (dots, arrows, swipe handlers) should mount.
 * Owner-only (org/admin/public/vet viewers of the same route get no chrome),
 * and only when there is more than one pet to move between AND the current pet
 * is actually in the ranked set (so the highlighted dot is honest).
 */
export function shouldShowCarousel(args: {
  isOwner: boolean;
  tokens: string[];
  currentToken: string;
}): boolean {
  return args.isOwner && args.tokens.length > 1 && args.tokens.includes(args.currentToken);
}
