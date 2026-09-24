// Rehome-sponsorship payload schemas — rehome-by-titular.
//
// Split out of event-schemas.ts, which is at its file-size ratchet
// (scripts/file-size-baseline.json), following the caretaker-event-schemas.ts
// and tag-event-schemas.ts precedent. The registry in event-schemas.ts imports
// these two and maps them to `rehome_sponsorship_started` /
// `rehome_sponsorship_ended`; nothing else changes about how they validate.
//
// WHAT A SPONSORSHIP IS. The titular keeps their `ownerships(role='owner')` row
// for the whole arrangement and the animal keeps living with them; the org gets
// a `shelter_custody` row alongside it so the existing adoption catalog, which
// keys on that role, lists the pet with no predicate change. That is the PO's
// accepted overload of the word "custodia" and the reason every org-facing
// surface has to say the animal is NOT in the org's possession.

import { z } from "zod";

import { withVersion } from "./payload-version";

/**
 * The sponsorship became active: the org accepted the titular's
 * `rehome_request`, and the `ownerships(role='shelter_custody')` row was
 * written in the same transaction.
 *
 * `ownership_id` is not decoration. It is what lets rollback, drift detection
 * and any audit say WHICH custody row belongs to this sponsorship, instead of
 * guessing from timestamps — the same job `caretakerDesignated.grant_id` does.
 * Selecting rows by the catalog predicate instead would sweep up decomiso and
 * intake custody that has nothing to do with this feature.
 */
export const rehomeSponsorshipStarted = z
  .object(
    withVersion({
      ownership_id: z.string().uuid(),
      sponsoring_organization_id: z.string().uuid(),
      consented_by_user_id: z.string().uuid(),
      request_case_public_code: z.string().min(1),
      listing_case_id: z.string().uuid().nullable(),
      note: z.string().nullable(),
    }),
  )
  .strict();

/**
 * The sponsorship stopped being active, for one of five reasons.
 *
 * The key is `outcome`, not `reason`. HISTORICAL NOTE: until migration 0240
 * (T3-A2b), erase_subject_data sentinel-redacted the key `reason` across ALL
 * event types, which would have destroyed this enum fact — the trap
 * `tag_revoked` and `caretaker_ended` also avoided. Since 0240 erasure acts on
 * each key's privacy class (lib/events/payload-privacy.ts).
 *
 * `withdrawn_by_platform` is the outcome for an end that no party to the
 * arrangement chose. It was decided up front for the rollback script (design
 * ADR-7 — scripts/rollback-rehome-sponsorships.ts) — deciding it then cost one
 * enum member; discovering it during an incident would have cost a strict-Zod
 * migration under pressure, on a path that has to run BEFORE the app commit is
 * reverted. Since the WU3 review (M-2) it is also what a custody hand-off
 * decided by an authority writes — a decomiso, a custody dispute resolved
 * against the titular — through lib/infra/end-pet-ownerships.ts: the titular
 * did not withdraw, the org did not resign, nobody adopted, and the other
 * four members would each state a falsehood on an append-only spine.
 *
 * `pet_deceased` is written by the death cascade
 * (lib/infra/rehome-death-cascade.ts, CASCADE D of createDeathRecord), signed
 * by whoever recorded the death.
 */
export const rehomeSponsorshipEnded = z
  .object(
    withVersion({
      ownership_id: z.string().uuid(),
      outcome: z.enum([
        "adopted",
        "withdrawn_by_titular",
        "ended_by_org",
        "pet_deceased",
        "withdrawn_by_platform",
      ]),
      ended_at: z.string().min(1),
    }),
  )
  .strict();
