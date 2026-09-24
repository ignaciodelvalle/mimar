// Lost-pet broadcast — fans out in-app notifications to verified org members
// whose coverage matches the pet's jurisdiction when a pet is marked lost.
//
// This is the REAL org-coordination layer, not a mock or placeholder — task
// #43 audit (Cursor #735) confirmed no owner-facing "broadcast mock" UI
// exists anywhere; this backend fanout to verified orgs IS the intended
// coordination mechanism (strategy triage), so it stays live/ungated.
//
// Design decisions:
//   D4 — broadcast targets verified orgs only, severity = 'warning'
//   D5 — notification body is PII-free; the CTA links to the public credential
//          where the owner's disclosure preferences govern what is visible
//   D8 — the helper is defensive: any failure is logged and returns an empty
//          result WITHOUT re-throwing, so the caller (setPetLostWriter) is
//          never blocked by a broadcast error

import { type db, organizationCoverage, organizationMemberships, organizations } from "@/db";
import type * as schema from "@/db/schema";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { speciesLabel } from "@/lib/utils/format";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// The transaction type accepted by Drizzle's `db.transaction(async (tx) => …)`
// callback. We use a looser type here so tests can pass either `db` or a `tx`.
type DbOrTx =
  | PostgresJsDatabase<typeof schema>
  | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PetForBroadcast = {
  id: string;
  publicToken: string;
  name: string;
  species?: string | null;
  breed?: string | null;
  color?: string | null;
  jurisdictionProvince?: string | null;
  jurisdictionLocality?: string | null;
};

export type OwnerProfileForBroadcast = {
  id: string;
  displayName: string;
};

export type LastLocationForBroadcast = {
  province?: string | null;
  locality?: string | null;
} | null;

export type BroadcastResult = {
  broadcastedToMemberIds: string[];
  orgCount: number;
  /**
   * How many recipient payloads were dead-lettered because their insert failed
   * (surfaced from createNotificationsBulk). >0 means some members were not
   * notified live but the payloads are recoverable via the
   * drain-notification-dead-letter cron. 0 on the no-op / early-return paths.
   */
  deadLetteredCount: number;
  /**
   * Set only when the broadcast threw BEFORE any payload was built (e.g. the
   * coverage/member query failed). D8 keeps this non-fatal to the caller, but we
   * now SURFACE the error instead of swallowing it silently so a pre-insert
   * failure is observable rather than an indistinguishable empty result.
   */
  error?: string;
};

// Builds the notification body: intentionally minimal and PII-free.
// The CTA goes to the public credential where the owner controls exposure.
function buildBroadcastBody(pet: PetForBroadcast): string {
  const parts: string[] = [
    `${pet.name} — ${pet.species ? speciesLabel(pet.species) : "mascota"}${pet.breed ? `, ${pet.breed}` : ""}.`,
  ];
  if (pet.color) parts.push(`Color: ${pet.color}.`);
  parts.push(`Tocá "Ver credencial" para detalles y contacto.`);
  return parts.join("\n");
}

// Main export — call after the pet's status_changed event is committed.
// Pass `db` directly (not a tx) so the broadcast is outside the main
// transaction; failures don't roll back the lost-flip (D8).
//
// Accepts either `db` or a `tx` so tests can drive it directly.
//
// `opts.episodeKey` (the lost_pet_episode case id) makes the fan-out
// IDEMPOTENT per lost episode: each recipient's dedupe key is
// `lost:${episodeKey}:${userId}`, so a retry of the SAME episode (client
// timeout, double-submit, a re-entered lost branch) is a no-op instead of
// re-notifying every org member — the highest-blast-radius duplication site in
// the codebase (review B.1). A genuinely NEW lost episode carries a new case id
// and re-notifies correctly. When no episodeKey is supplied the pet id is the
// fallback scope (still idempotent for an immediate retry).
export async function broadcastLostPet(
  client: DbOrTx,
  pet: PetForBroadcast,
  _ownerProfile: OwnerProfileForBroadcast,
  lastLocation: LastLocationForBroadcast,
  opts?: { episodeKey?: string | null },
): Promise<BroadcastResult> {
  try {
    // 1. Require province (locality is optional — province-only rows cover the whole province).
    const province = lastLocation?.province ?? pet.jurisdictionProvince ?? null;
    const locality = lastLocation?.locality ?? pet.jurisdictionLocality ?? null;

    if (!province) {
      return { broadcastedToMemberIds: [], orgCount: 0, deadLetteredCount: 0 };
    }

    // 2. Find verified, active orgs with coverage matching the jurisdiction.
    //
    //    Matching rules (C2 — broader reach for locality-less lost pets):
    //
    //    - pet has locality → match rows where
    //        jurisdictionLocality = locality (exact) OR jurisdictionLocality IS NULL (province-level).
    //        An org with province-level coverage catches any locality; a locality-specific org
    //        catches only its registered locality.
    //
    //    - pet has NO locality → match ALL coverage rows for the province.
    //        Drop the locality predicate entirely (just eq(province)). A pet lost somewhere
    //        in province X with no known locality should alert every org covering any
    //        part of province X — both province-level and locality-specific orgs.
    const localityPredicate =
      locality !== null
        ? or(
            eq(organizationCoverage.jurisdictionLocality, locality),
            isNull(organizationCoverage.jurisdictionLocality),
          )
        : undefined; // no locality filter — match all coverage rows for the province

    const coveringOrgs = await (client as typeof db)
      .select({
        orgId: organizations.id,
        orgDisplayName: organizations.displayName,
      })
      .from(organizations)
      .innerJoin(organizationCoverage, eq(organizationCoverage.organizationId, organizations.id))
      .where(
        and(
          eq(organizations.verified, true),
          eq(organizations.status, "active"),
          eq(organizationCoverage.jurisdictionProvince, province),
          localityPredicate,
        ),
      );

    if (coveringOrgs.length === 0) {
      return { broadcastedToMemberIds: [], orgCount: 0, deadLetteredCount: 0 };
    }

    // 3. Collect unique member IDs across all covering orgs in a SINGLE query.
    //    Previously this looped one query per org (N+1) — at national scale a
    //    pet lost in a populous province can match hundreds of orgs, each
    //    triggering its own round-trip. A single `inArray` over all org ids
    //    fetches every eligible member at once; dedup happens in JS because a
    //    user may belong to multiple orgs in the same jurisdiction (notify once).
    const orgIds = coveringOrgs.map((org) => org.orgId);
    const members = await (client as typeof db)
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          inArray(organizationMemberships.organizationId, orgIds),
          eq(organizationMemberships.receivesBroadcasts, true),
          isNull(organizationMemberships.leftAt),
        ),
      );

    const notifiedUserIds = new Set<string>();
    for (const member of members) {
      if (member.userId) {
        notifiedUserIds.add(member.userId);
      }
    }

    if (notifiedUserIds.size === 0) {
      return { broadcastedToMemberIds: [], orgCount: coveringOrgs.length, deadLetteredCount: 0 };
    }

    // 4. Fan out one notification per unique member through the canonical
    //    write path (createNotificationsBulk). This gives the broadcast BOTH
    //    guards the review (B.1 / C.2) demanded without losing the chunked
    //    performance work:
    //      - IDEMPOTENCY: each row's deterministic dedupeKey
    //        `lost:${episodeScope}:${userId}` runs with ON CONFLICT DO NOTHING,
    //        so a retry of the same episode re-notifies nobody.
    //      - DURABILITY: a chunk that throws is dead-lettered instead of
    //        silently swallowed, so a mid-fanout blip is recoverable.
    const body = buildBroadcastBody(pet);
    const title = `Mascota perdida en tu zona: ${pet.name}`;
    const ctaUrl = `/p/${pet.publicToken}`;
    const episodeScope = opts?.episodeKey ?? pet.id;

    const notifInputs = Array.from(notifiedUserIds).map((userId) => ({
      userId,
      notificationType: "lost_pet_broadcast",
      severity: "warning" as const,
      title,
      body,
      ctaLabel: "Ver credencial",
      ctaUrl,
      relatedPetId: pet.id,
      dedupeKey: `lost:${episodeScope}:${userId}`,
    }));

    const bulk = await createNotificationsBulk(notifInputs, client);

    return {
      broadcastedToMemberIds: Array.from(notifiedUserIds),
      orgCount: coveringOrgs.length,
      deadLetteredCount: bulk.deadLetteredCount,
    };
  } catch (err) {
    // D8: non-fatal to the caller (the lost-flip must not roll back). But we no
    // longer swallow the error into an indistinguishable empty result — a
    // pre-insert failure (coverage/member query threw before any payload was
    // built, so createNotificationsBulk never ran to dead-letter anything) is
    // now surfaced via `error` for observability.
    const message = err instanceof Error ? err.message : String(err);
    console.error("[broadcastLostPet] broadcast failed (non-fatal):", err);
    return { broadcastedToMemberIds: [], orgCount: 0, deadLetteredCount: 0, error: message };
  }
}
