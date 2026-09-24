// WHICH ORGANISATION A RETURN GOES BACK TO — one implementation, two callers.
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// `ownerProposeReturnToOrgUseCase` used to resolve this inline, and the bearer
// door's READ needs the same answer to say whether a "Devolver" control may be
// drawn at all. Two implementations of "who receives this animal back" is the
// shape this repo has been bitten by four times: a screen that offers a control
// the writer refuses, or hides one it would have allowed.
//
// So the rule moved here and the WRITER CALLS IT. That is deliberately not the
// arrangement `bookSlotAction` and `list-appointments-for-user.ts` settled for
// (two declared copies): those are `"use server"` entry points the browser
// drives, and this is not — `ownerProposeReturnToOrgUseCase` is a plain module,
// its own action is a five-line controller, and extracting from the INSIDE of a
// use-case changes no entry point and no e2e surface.
//
// THE TIE-BREAK IS THE SCAR, AND IT IS THE REASON THIS FILE IS NOT A PURE MOVE
// ---------------------------------------------------------------------------
// Both of the inline copies this replaces selected the parallel
// `shelter_custody` row with `.limit(1)` and NO `ORDER BY`. That is the exact
// defect `adoption-public-reads.ts` carries a paragraph about, found live by the
// 9-role external run on 2026-08-18: "That page's single query used to pick an
// ARBITRARY ownership row for a pet transferred between orgs, and in the wild it
// picked the ORIGINAL shelter's ENDED row: the public detail credited a refuge
// that no longer answered for the animal." Its remedy is the one applied here —
// `orderBy(desc(ownerships.startedAt))`, so that "two open custody rows should
// not exist; if the invariant ever breaks, the MOST RECENT wins, consistently."
//
// It is the same remedy `resolvePetHolderAccess` applied to its own `.limit(1)`
// for the same reason ("harmless while the result was role-agnostic, a coin flip
// the moment `role` became load-bearing"). Here the row decides WHICH
// ORGANISATION is asked to take an animal back, which is as load-bearing as it
// gets on this surface.
//
// THE CALLER STILL OWNS THE SENTENCE. This function answers with a CODE; the two
// refusal strings the web renders differ per role and are kept byte-for-byte at
// the writer, because they are copy a person reads and this is a rule.

import { and, desc, eq, isNull } from "drizzle-orm";

import { type db, organizations, ownerships, petEvents } from "@/db";

/** Accepts either the top-level db instance or a transaction handle. */
type DbOrTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ReturnTargetOrg = {
  orgId: string;
  /** `null` when the id resolves to no `organizations` row — see the callers. */
  displayName: string | null;
  publicToken: string | null;
};

export type ReturnTargetResolution =
  | { ok: true; target: ReturnTargetOrg }
  /**
   * An `adoption_finalized` exists for this animal and names a DIFFERENT
   * adopter. A hard refusal with no fallback, exactly as the writer had it:
   * somebody who is not the registered adopter may not hand the animal back to
   * the shelter that placed it with someone else.
   */
  | { ok: false; code: "not_the_adopter" }
  /** Nothing names an organisation to return this animal to. */
  | { ok: false; code: "no_source_org" };

/**
 * Resolve the organisation a return proposal is addressed to.
 *
 * FOSTER: the organisation holding the parallel active `shelter_custody` row —
 * the shelter whose animal this person is fostering.
 *
 * OWNER: the shelter that placed the animal, read off the latest
 * `adoption_finalized`, with a fallback to a parallel active `shelter_custody`
 * when there is no adoption on record. THE FALLBACK IS THE WRITER'S AND NOT THE
 * PAGE'S: `app/(app)/mis-mascotas/{token}/devolucion/page.tsx` renders the form
 * only when the adoption event names the caller, so the browser hides a control
 * its own writer would have accepted. That divergence is pre-existing, it is the
 * safe direction on the web, and this function follows the WRITER because the
 * writer is what decides — a read that modelled the page would tell a phone it
 * cannot do something the server would allow.
 */
export async function resolveReturnTargetOrg(args: {
  petId: string;
  userId: string;
  callerRole: "owner" | "foster";
  exec: DbOrTx;
}): Promise<ReturnTargetResolution> {
  const { petId, userId, callerRole, exec } = args;

  let toOrgId: string | null = null;

  if (callerRole === "owner") {
    const [adoptionEvent] = await exec
      .select({ payload: petEvents.payload })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "adoption_finalized")))
      .orderBy(desc(petEvents.occurredAt))
      .limit(1);

    if (adoptionEvent) {
      const payload = adoptionEvent.payload as {
        previous_owner_organization_id?: string | null;
        adopter_user_id?: string | null;
      };
      if (payload.adopter_user_id !== userId) return { ok: false, code: "not_the_adopter" };
      toOrgId = payload.previous_owner_organization_id ?? null;
    }
  }

  if (!toOrgId) {
    toOrgId = await activeShelterCustodyOrgId(petId, exec);
  }

  if (!toOrgId) return { ok: false, code: "no_source_org" };

  const [orgRow] = await exec
    .select({ displayName: organizations.displayName, publicToken: organizations.publicToken })
    .from(organizations)
    .where(eq(organizations.id, toOrgId))
    .limit(1);

  return {
    ok: true,
    target: {
      orgId: toOrgId,
      // NOT defaulted here. The writer folds a missing row into "el refugio" for
      // a notification body; a screen has to say something different, and
      // deciding that in a rule would put copy in the wrong layer.
      displayName: orgRow?.displayName ?? null,
      publicToken: orgRow?.publicToken ?? null,
    },
  };
}

/**
 * The organisation holding this animal's open `shelter_custody`, MOST RECENT
 * FIRST.
 *
 * The ordering is the 2026-08-18 scar — see the header. Two open rows should not
 * exist; when the invariant breaks, the newest custody is the one that answers
 * for the animal, and it must be the same one every time it is asked.
 */
async function activeShelterCustodyOrgId(petId: string, exec: DbOrTx): Promise<string | null> {
  const [row] = await exec
    .select({ ownerOrganizationId: ownerships.ownerOrganizationId })
    .from(ownerships)
    .where(
      and(
        eq(ownerships.petId, petId),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    .orderBy(desc(ownerships.startedAt))
    .limit(1);
  return row?.ownerOrganizationId ?? null;
}
