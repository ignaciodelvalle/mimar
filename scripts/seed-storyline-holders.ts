// Custody normalization for the demo storylines (scripts/seed-demo.ts).
//
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
// The storylines narrate custody with PEOPLE'S NAMES in the id fields
// ("V. Yazdovsky", "Estancia La Rinconada"), leave org-held registrations
// without a custody_kind, and let a shelter intake precede the citizen's
// registration with nothing closing the shelter's custody. The loader then
// wrote ONE hardcoded ownership row per pet, started at "now". Replayed through
// lib/projections/pet-holders.ts, 26 of the 39 storylines disagreed with that
// row (holder drift, audit K3/W8): wrong start, a shelter custody nobody
// ended, a live owner row for somebody the log says handed the animal on.
//
// Two halves, both pure:
//   1. normalizeStorylineHolderEvents — rewrites the custody FACTS of a
//      storyline so they name real seeded accounts and end with the holder the
//      demo relies on (the storyline's resolved owner). Narrative text,
//      dates and every non-custody field are left alone. Party ids are
//      coarsened in every rendered payload (lib/events/payload-privacy.ts), so
//      the names were never shown; a name in a uuid field only broke the
//      lookups that read it.
//   2. The loader then derives its ownerships rows from the replay of the
//      events it actually inserted (replayPetHolders), instead of writing a
//      row the events do not explain — and refuses a storyline whose replay
//      does not leave the resolved owner holding the pet.
//
// The rules, each the minimum the replay needs:
//   R1  A party field (from/to/adopter/foster/claimed_by user, from/to/previous
//       /sponsoring org) that is not a seeded account becomes the storyline's
//       owner (user fields) or its org (org fields); on the other kind of pet
//       the fallback shelter account stands in. Off-platform people have no
//       account, and the custody chain can only name accounts.
//   R2  adoption_finalized without an adopter → the owner; foster_ended
//       without a foster → the foster the last foster_assigned named.
//   R3  An org-held storyline registers the way create-intake does: its
//       pet_registered carries the org as author, and custody_kind
//       `shelter_custody_by_org` when the storyline declared none.
//   R4  On a citizen-held storyline, shelter-authored events are authored by
//       the fallback shelter org (a real org, not the operator's person).
//   R5  When the owner's pet_registered lands while that shelter still holds
//       the animal (an intake narrated BEFORE the registration), the story is
//       an adoption: an adoption_finalized from the shelter to the owner is
//       inserted at the registration instant, marked `synthesized: true` in
//       the storyline so it is visible as the loader's, not the author's.

export const HOLDER_USER_FIELDS = [
  "from_user_id",
  "to_user_id",
  "adopter_user_id",
  "foster_user_id",
  "claimed_by_user_id",
] as const;

export const HOLDER_ORG_FIELDS = [
  "from_organization_id",
  "to_organization_id",
  "previous_owner_organization_id",
  "sponsoring_organization_id",
] as const;

const HOLDER_EVENT_TYPES = new Set([
  "pet_registered",
  "shelter_intake_recorded",
  "foster_assigned",
  "foster_ended",
  "adoption_finalized",
  "adoption_reversed",
  "custody_transferred",
  "ownership_claimed",
  "rehome_sponsorship_started",
  "rehome_sponsorship_ended",
]);

/** A storyline event as the loader reads it (only the fields used here). */
export type StorylineEvent = {
  date: string;
  event_type: string;
  author_role?: string;
  payload?: Record<string, unknown>;
  synthesized?: boolean;
  [key: string]: unknown;
};

export type StorylineHolderContext = {
  /** The resolved owner, exactly one of the two set. */
  ownerUserId: string | null;
  ownerOrgId: string | null;
  /** Stands in for a user party on an org-held pet (the shelter operator). */
  fallbackUserId: string;
  /** Stands in for an org party on a citizen-held pet, and authors R4. */
  fallbackOrgId: string;
  /** Whether an id belongs to a seeded account (profile or organization). */
  isKnownId: (id: string) => boolean;
};

/** A storyline event plus the org the loader must author it as (R3/R4). */
export type NormalizedStorylineEvent = StorylineEvent & {
  /** Org to write as author_organization_id; undefined = the loader's default. */
  authorOrganizationId?: string;
};

type Walk = {
  ctx: StorylineHolderContext;
  userStandIn: string;
  orgStandIn: string;
  lastFoster: string | null;
  /** Whether the fallback shelter holds the animal right now (citizen pets, R5). */
  shelterHolds: boolean;
  ownerRegistered: boolean;
};

/** R1 + R2 on one holder event's payload. */
function normalizeParties(eventType: string, source: unknown, walk: Walk): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...((source ?? {}) as Record<string, unknown>) };
  const replace = (fields: readonly string[], standIn: string) => {
    for (const field of fields) {
      const v = payload[field];
      if (typeof v === "string" && !walk.ctx.isKnownId(v)) payload[field] = standIn;
    }
  };
  replace(HOLDER_USER_FIELDS, walk.userStandIn);
  replace(HOLDER_ORG_FIELDS, walk.orgStandIn);

  if (eventType === "adoption_finalized" && typeof payload.adopter_user_id !== "string") {
    payload.adopter_user_id = walk.userStandIn;
  }
  if (eventType === "foster_assigned" && typeof payload.foster_user_id === "string") {
    walk.lastFoster = payload.foster_user_id;
  }
  if (eventType === "foster_ended" && typeof payload.foster_user_id !== "string") {
    if (walk.lastFoster) payload.foster_user_id = walk.lastFoster;
  }
  return payload;
}

/** R3 — an org-held storyline registers the way create-intake does. */
function orgHeldEvent(event: NormalizedStorylineEvent, walk: Walk): NormalizedStorylineEvent[] {
  if (event.event_type === "pet_registered") {
    event.authorOrganizationId = walk.ctx.ownerOrgId as string;
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.custody_kind !== "string") payload.custody_kind = "shelter_custody_by_org";
  }
  return [event];
}

/** R4 + R5 — a citizen-held storyline. */
function citizenHeldEvent(event: NormalizedStorylineEvent, walk: Walk): NormalizedStorylineEvent[] {
  const { fallbackOrgId } = walk.ctx;
  if (event.author_role === "shelter") event.authorOrganizationId = fallbackOrgId;

  if (event.event_type === "pet_registered") {
    const adoptsOut = !walk.ownerRegistered && walk.shelterHolds;
    walk.ownerRegistered = true;
    if (!adoptsOut) return [event];
    walk.shelterHolds = false;
    return [
      event,
      {
        date: event.date,
        event_type: "adoption_finalized",
        author_role: "shelter",
        authorOrganizationId: fallbackOrgId,
        synthesized: true,
        payload: {
          previous_owner_organization_id: fallbackOrgId,
          adopter_user_id: walk.userStandIn,
          foster_user_id: null,
          contract_attachment_id: null,
          post_adoption_followup_months: null,
          notes: null,
        },
      },
    ];
  }

  const payload = event.payload as Record<string, unknown>;
  if (event.event_type === "shelter_intake_recorded" && event.author_role === "shelter") {
    walk.shelterHolds = true;
  } else if (
    event.event_type === "adoption_finalized" ||
    (event.event_type === "custody_transferred" && payload.from_organization_id === fallbackOrgId)
  ) {
    walk.shelterHolds = false;
  }
  return [event];
}

export function normalizeStorylineHolderEvents(
  events: readonly StorylineEvent[],
  ctx: StorylineHolderContext,
): NormalizedStorylineEvent[] {
  const orgHeld = ctx.ownerOrgId !== null;
  const walk: Walk = {
    ctx,
    userStandIn: ctx.ownerUserId ?? ctx.fallbackUserId,
    orgStandIn: ctx.ownerOrgId ?? ctx.fallbackOrgId,
    lastFoster: null,
    shelterHolds: false,
    ownerRegistered: false,
  };

  const out: NormalizedStorylineEvent[] = [];
  for (const original of events) {
    if (!HOLDER_EVENT_TYPES.has(original.event_type)) {
      const shelterAuthored = !orgHeld && original.author_role === "shelter";
      out.push(
        shelterAuthored ? { ...original, authorOrganizationId: ctx.fallbackOrgId } : original,
      );
      continue;
    }
    const event: NormalizedStorylineEvent = {
      ...original,
      payload: normalizeParties(original.event_type, original.payload, walk),
    };
    out.push(...(orgHeld ? orgHeldEvent(event, walk) : citizenHeldEvent(event, walk)));
  }
  return out;
}
