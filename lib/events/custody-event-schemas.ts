// Custody & adoption payload schemas — split out of event-schemas.ts (2026-08-21).
//
// WHY THIS FILE EXISTS
// ---------------------------------------------------------------------------
// `event-schemas.ts` sat at its file-size ratchet with ONE line of headroom,
// which made it a hard blocker: the SDD for rehome-by-titular records that "the
// next event type must split that file". This is that split, taken on the seam
// the directory already uses — `tag-event-schemas.ts`,
// `caretaker-event-schemas.ts` and `rehome-event-schemas.ts` are the same
// pattern, and `payload-version.ts` says in its own header that it lives apart
// precisely so a family can be extracted "without a circular import".
//
// THE FILENAME SUFFIX IS LOAD-BEARING, NOT COSMETIC.
// `scripts/check-event-payload-parity.ts` builds its written-key index from
// `lib/events/*event-schemas.ts` — a glob chosen deliberately, with the comment
// "glob the family instead of enumerating it: the next split is free". Naming
// this file `custody-schemas.ts` would drop 60+ written keys (ownership_id,
// seizure_motive, foster_user_id, transfer_token, …) out of the fence's subject,
// and every legitimate read of them would be reported as a ghost-payload read.
//
// WHY NOT src/modules/adoption/ OR src/modules/pets/
// ---------------------------------------------------------------------------
// Over 100 files across twelve different modules import `validateEventPayload`
// from here. These shapes belong to no single module, and putting them inside
// one would invert the dependency for the other eleven.
//
// VERBATIM MOVE. Same declarations, same order, same comments. The only edit is
// `const` → `export const` on the 18 the registry references; the other five
// stay module-private and travel with them because they are only used here.
// event-schemas.ts keeps its entire public API: PayloadSchemas,
// validateEventPayload, EventPayloadValidationError, IMPLEMENTED_EVENT_TYPES
// and the EVENT_TYPES re-export are untouched, so no importer changes.

import { z } from "zod";

import { withVersion } from "./payload-version";
import { eventPlaceSchema } from "./place-payload";

// ---------------------------------------------------------------------------
// Custody & adoption (refugio portal)
// ---------------------------------------------------------------------------

// Intake event fired when an org takes custody of an animal. The payload
// captures intake-specific info (reason, body condition, jurisdiction) so
// pet_registered can stay universal across owner / refugio / citizen flows.
// Authority side-effects (DGSA notification on seizure, etc.) hook off this
// event via projections in later phases — keep the payload spec'd to AGENTS.md
// → Custody & adoption.
// Seizure-motive enum per spec §4.3 (2026-05-19-decomiso-welfare-authority-design.md DC4).
// Same set as welfareReportKindEnum, generalised slightly for decomiso context.
const seizureMotiveEnum = z.enum([
  "maltrato_fisico",
  "abandono_extremo",
  "acumulacion",
  "trafico",
  "sin_refugio_critico",
  "pelea_de_perros",
  "otro",
]);

export const shelterIntakeRecorded = z
  .object(
    withVersion({
      intake_reason: z.enum(["rescue", "surrender", "seizure", "stray_found", "other"]),
      intake_condition: z.string().nullable(),
      rescue_jurisdiction: z.string().nullable(),

      // Decomiso (seizure) extension — spec §4.3.
      // All fields are optional/nullable so non-seizure intakes are unaffected.
      // The superRefine below enforces conditional requirements on seizure intakes.
      seizure_motive: seizureMotiveEnum.nullable().optional(),
      seizure_motive_other_detail: z.string().nullable().optional(),
      judicial_proceeding_reference: z.string().nullable().optional(),
      originating_welfare_report_id: z.string().uuid().nullable().optional(),
      intended_receiver_organization_id: z.string().uuid().nullable().optional(),
    }),
  )
  .strict()
  .superRefine((p, ctx) => {
    // Spec §4.3: when intake_reason === 'seizure', seizure_motive AND
    // intended_receiver_organization_id are required. Additionally,
    // seizure_motive_other_detail is required when seizure_motive === 'otro'.
    // Non-seizure intakes are unaffected — all new fields remain optional.
    if (p.intake_reason === "seizure") {
      if (!p.seizure_motive) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "seizure_motive required when intake_reason is seizure",
          path: ["seizure_motive"],
        });
      }
      if (p.seizure_motive === "otro" && !p.seizure_motive_other_detail) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "seizure_motive_other_detail required when seizure_motive is otro",
          path: ["seizure_motive_other_detail"],
        });
      }
      if (!p.intended_receiver_organization_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "intended_receiver_organization_id required when intake_reason is seizure",
          path: ["intended_receiver_organization_id"],
        });
      }
    }
  });

// Foster assignment — refugio assigns a member to physically care for an
// animal it holds in shelter_custody. The foster's `ownership(role='foster')`
// row coexists with the org's `ownership(role='shelter_custody')` row; the
// unique-active-owner constraint only fires on role='owner', so both rows
// stay active simultaneously by design.
export const fosterAssigned = z
  .object(
    withVersion({
      foster_user_id: z.string().uuid(),
      expected_weeks: z.number().int().min(0).nullable(),
      notes: z.string().nullable(),
    }),
  )
  .strict();

// Foster ending — closes a foster ownership row without an adoption finalize
// (adoption_finalized handles the foster→owner transition in one composite
// event). Used when a tránsito returns the animal to the refugio, the foster
// can't continue, or the refugio reassigns. `ended_reason` is free-text;
// `ended_by` records who initiated the close.
// Foster end — reason catalog (spec foster-volunteers-pool v1.4 §6.9):
//   - returned                  — UI-selectable: devolución normal
//   - early_return_by_foster    — UI-selectable: foster pide cortar antes
//   - pet_died                  — programmatic ONLY: auto-emitted by recordDeathAction
//   - lost_unrecovered          — UI-selectable: perdido sin recuperación >30d
//   - adoption                  — programmatic ONLY: emitted inside finalizeAdoptionAction
//   - other                     — UI-selectable catch-all
// `death_event_id` is populated only when reason='pet_died' (FK to the
// death_recorded event that triggered the auto-close).
export const fosterEnded = z
  .object(
    withVersion({
      foster_user_id: z.string().uuid(),
      reason: z.enum([
        "returned",
        "early_return_by_foster",
        "pet_died",
        "lost_unrecovered",
        "adoption",
        "other",
      ]),
      notes: z.string().nullable().optional(),
      death_event_id: z.string().uuid().nullable().optional(),
    }),
  )
  .strict();

// Adoption finalization — composite event. Atomically: end the prior
// shelter_custody row, end any active foster row, insert a new owner row.
// The payload references the institutional ancestor (previous_owner_org) and
// optional foster so projections can rebuild the custody chain without
// scanning ownerships history. `contract_attachment_id` is reserved; v1 leaves
// it null (upload flow ships in a follow-up). `post_adoption_followup_months`
// drives the follow-up check-in window per AGENTS.md → Custody & adoption.
export const adoptionFinalized = z
  .object(
    withVersion({
      previous_owner_organization_id: z.string().uuid(),
      adopter_user_id: z.string().uuid(),
      foster_user_id: z.string().uuid().nullable(),
      contract_attachment_id: z.string().uuid().nullable(),
      post_adoption_followup_months: z.number().int().min(0).max(36).nullable(),
      notes: z.string().nullable(),
      // When the adoption was finalized FROM an approved online application,
      // this links back to that `adoption_application_submitted` event so the
      // custody chain records that ownership landed on the applicant's real
      // account (not a typed-DNI stub). Null / omitted for offline adoptions.
      adopted_from_application_id: z.string().uuid().nullable().optional(),
    }),
  )
  .strict();

// Shared reason enum for custody transfer events (proposed + transferred).
// Introduced in Lost & Found Fase 1 to support the return-to-owner two-phase
// handshake and citizen-to-org handoff. "org_to_org_handoff" covers the
// existing org-to-org transfer flow.
const custodyTransferReason = z.enum([
  "org_to_org_handoff",
  "return_to_original_owner",
  "citizen_to_org_handoff",
  // Cross-org transfer specific reasons (spec
  // 2026-05-19-cross-org-transfer-ux-design CT4). Used by the
  // refugio→refugio handshake flow.
  "space_constraint",
  "specialization_needed",
  "network_redistribution",
  "shelter_closing",
  "post_adoption_failed_return",
  "other",
]);

// Custody transferred — polymorphic handoff (org-to-org, org-to-user, user-to-org).
// Exactly one of (from_user_id, from_organization_id) must be set (XOR),
// and exactly one of (to_user_id, to_organization_id) must be set (XOR).
// The existing org-to-org shape is backwards-compatible: from_organization_id
// and to_organization_id remain present; from_user_id/to_user_id default null.
// `reason` is optional for backwards-compat with pre-Fase-1 rows.
// If a foster was active on the source side, that row is auto-closed and a
// sibling foster_ended event is emitted in the same tx; its id is captured
// here so the timeline reads as one coherent transfer.
const custodyTransferred = z
  .object(
    withVersion({
      // Polymorphic "from" actor — exactly one must be non-null.
      from_user_id: z.string().uuid().nullable().optional(),
      from_organization_id: z.string().uuid().nullable().optional(),
      // Polymorphic "to" actor — exactly one must be non-null.
      to_user_id: z.string().uuid().nullable().optional(),
      to_organization_id: z.string().uuid().nullable().optional(),
      from_role: z.enum(["shelter_custody", "owner"]),
      to_role: z.enum(["shelter_custody", "owner"]),
      reason: custodyTransferReason.optional(),
      // Links to the matched pet that triggered a cross-check match flow.
      matched_against_pet_id: z.string().uuid().nullable().optional(),
      foster_ended_event_id: z.string().uuid().nullable(),
      notes: z.string().nullable(),
    }),
  )
  .strict()
  .refine(
    (p) => {
      const fromSet = [p.from_user_id, p.from_organization_id].filter(
        (v) => v != null && v !== undefined,
      ).length;
      // Allow legacy shape where neither from_user_id is provided (only from_organization_id).
      // At least one from actor must be set.
      return fromSet >= 1;
    },
    { message: "at least one of from_user_id / from_organization_id must be set" },
  )
  .refine(
    (p) => {
      const toSet = [p.to_user_id, p.to_organization_id].filter(
        (v) => v != null && v !== undefined,
      ).length;
      return toSet >= 1;
    },
    { message: "at least one of to_user_id / to_organization_id must be set" },
  )
  .refine(
    (p) => {
      const fromCount = [p.from_user_id, p.from_organization_id].filter(
        (v) => v != null && v !== undefined,
      ).length;
      return fromCount <= 1;
    },
    { message: "at most one of from_user_id / from_organization_id may be set" },
  )
  .refine(
    (p) => {
      const toCount = [p.to_user_id, p.to_organization_id].filter(
        (v) => v != null && v !== undefined,
      ).length;
      return toCount <= 1;
    },
    { message: "at most one of to_user_id / to_organization_id may be set" },
  );

// P2P owner→owner transfer reasons. Mirrors OWNER_TRANSFER_REASONS in the
// transfers domain (src/modules/transfers/domain/types.ts) — kept inline so
// lib/events stays free of src/modules imports (dependency direction).
const p2pTransferReason = z.enum(["sale", "gift", "inheritance", "other"]);

// Custody transferred — owner→owner peer-to-peer variant. A miMAR citizen
// gifts / sells / bequeaths a pet to another citizen through the PTR
// proposal→accept handshake (src/modules/transfers/application/accept-pet-transfer).
// BOTH actors hold the `owner` role, the `reason` comes from the P2P reason set
// (sale/gift/inheritance/other), and the payload carries the PTR `transfer_token`
// linking back to the pet_transfers proposal row. This is a genuinely distinct
// shape from the org/custody variant above (which carries org ids, the org
// handoff reason set, and the foster-cascade fields foster_ended_event_id/notes),
// so custody_transferred validates as a UNION of the two.
//
// Why z.union and not z.discriminatedUnion: the two variants share no single
// literal discriminator key — what distinguishes them is the presence of
// `transfer_token` / the owner→owner shape. A real discriminated union would
// force adding a discriminator field to every org emitter (accept-cross-org,
// return-to-owner, decomiso, disputes, foster, intake), which is both invasive
// and cross-lane. Keeping the org variant byte-for-byte unchanged means no org
// emitter changes; the strict() on each variant makes the two mutually
// exclusive (an org payload fails the P2P strict shape and vice versa).
const custodyTransferredP2P = z
  .object(
    withVersion({
      from_user_id: z.string().uuid(),
      to_user_id: z.string().uuid(),
      from_role: z.literal("owner"),
      to_role: z.literal("owner"),
      reason: p2pTransferReason,
      transfer_token: z.string(),
    }),
  )
  .strict();

// custody_transferred is polymorphic across two legitimate channels:
// org/custody handoffs (custodyTransferred) OR owner→owner P2P
// (custodyTransferredP2P). Org variant is listed first so org payloads validate
// against the unchanged shape.
export const custodyTransferredEvent = z.union([custodyTransferred, custodyTransferredP2P]);

// Ownership claimed — direct claim of a free pet (claim wizard variant
// "free"). The pet is chip/tattoo-registered but has NO active custody of any
// role, so there is no "from" actor and custody_transferred does not apply
// (its schema requires one). The claimant opens a fresh owner ownership in
// the same tx that emits this event.
export const ownershipClaimed = z
  .object(
    withVersion({
      claimed_by_user_id: z.string().uuid(),
      // How the claimant identified the pet in the wizard.
      identifier_kind: z.enum(["microchip", "tattoo"]),
    }),
  )
  .strict();

// Adoption reversed — umbrella event collapsing the previous
// adoption_revoked (shelter/court-initiated) and adoption_withdrawn
// (adopter-initiated) into one (catalog cleanup 2026-05-19). The actor
// discriminator picks the perspective; reason is free text. When the
// reversed finalization event id is known (post event-sourcing era)
// it's referenced; older data leaves it null.
export const adoptionReversed = z
  .object(
    withVersion({
      actor: z.enum(["shelter", "adopter", "court"]),
      reason: z.string().nullable(),
      reverted_finalization_event_id: z.string().uuid().nullable().optional(),
    }),
  )
  .strict();

// Adoption application submitted — emitted by the public adoption flow
// (spec adoption-listing-public §8.4) when a visitor completes
// /adoptar/{petToken}/postular. The four free-text payload fields are the
// raw user input from the form; the related_organization_id is denormalized
// from the current shelter_custody ownership so the reader can audit which
// refugio received the application without re-joining ownerships at read
// time. housing_type is the only structured field.
// profile_sharing_consent_at captures when the applicant ticked the consent
// checkbox (spec §12.5 addendum v1.4). Stored in the event payload rather
// than a separate table — the table was never created; event-sourced log is
// the single source of truth.
// v2 (PR-14 adoption UX): adds motivation + prior_pets as required nullable
// keys. The v1→v2 upcaster in lib/event-upcasters.ts fills both with null
// for historical rows, per docs/superpowers/event-versioning.md.
export const adoptionApplicationSubmitted = z
  .object({
    payload_version: z.literal(2).default(2),
    applicant_user_id: z.string().uuid(),
    related_organization_id: z.string().uuid(),
    // Nullable since T3-A2b (PO decision 5A): the applicant's erasure nulls
    // housing_type and prior_pets — they describe the person's home, not the
    // pet. Writers always send a value; only the erasure writes null.
    housing_type: z.enum(["casa_con_patio", "casa_sin_patio", "departamento", "otro"]).nullable(),
    other_pets: z.string().nullable(),
    daily_routine: z.string().nullable(),
    notes: z.string().nullable(),
    profile_sharing_consent_at: z.string().datetime(),
    motivation: z.string().nullable(),
    prior_pets: z.enum(["yes_currently", "yes_before", "no"]).nullable(),
  })
  .strict();

// Adoption application resolved — umbrella for approved + rejected +
// withdrawn decisions (catalog cleanup 2026-05-19; "withdrawn" added UI-6
// 2026-06-12). The shelter's admin/coordinator emits the approved/rejected
// variants from the org portal when reviewing a postulation, and the
// finalize-cascade in adoption.ts emits the `rejected + auto_generated`
// variant for sibling applications when one application is finalized
// (spec adoption-listing-public §12 Fase 5.5).
//
// outcome === "rejected" → reason should be set (required by app-layer
// for manual rejections; the cascade uses literal "another_application_finalized").
// outcome === "approved" → reason is optional.
// outcome === "withdrawn" → the APPLICANT retracted their own pending
// application. reviewer_user_id carries the applicant's own user id (the
// actor who resolved it); no shelter reviewer is involved.
// Zod stays permissive on the correlation; the server actions enforce it.
export const adoptionApplicationResolved = z
  .object(
    withVersion({
      application_event_id: z.string().uuid(),
      reviewer_user_id: z.string().uuid(),
      outcome: z.enum(["approved", "rejected", "withdrawn"]),
      reason: z.string().nullable().optional(),
      auto_generated: z.boolean().default(false).optional(),
      notes: z.string().nullable().optional(),
    }),
  )
  .strict();

// Custody dispute raised — flags the pet as subject to an ownership dispute.
// Sets `pets.in_custody_dispute = true` via dual-write from the server action.
//
// Raised by:
//   - admin/govt: external legal proceedings (divorce, succession, seizure)
//   - owner:      self-raised claim via /mis-mascotas/reclamar (P3-1, 2026-05-28).
//                 Triggered when a user submits the claim wizard's variant B
//                 (chip/tatuaje match → existing active owner). Govt/admin
//                 still adjudicates resolution via custody_dispute_resolved.
export const custodyDisputeRaised = z
  .object(
    withVersion({
      raised_by_role: z.enum(["admin", "govt", "owner"]),
      raised_by_user_id: z.string().uuid(),
      external_proceeding_reference: z.string().nullable(),
      reason: z.string(),
    }),
  )
  .strict();

// Custody dispute resolved — closes a prior `custody_dispute_raised`. Sets
// `pets.in_custody_dispute = false`. The outcome enum captures the legal
// result without prescribing post-resolution actions (those are per-feature).
export const custodyDisputeResolved = z
  .object(
    withVersion({
      raised_event_id: z.string().uuid(),
      resolved_by_role: z.enum(["admin", "govt"]),
      resolved_by_user_id: z.string().uuid(),
      outcome: z.enum(["ownership_confirmed", "ownership_transferred", "case_dismissed", "other"]),
      notes: z.string().nullable(),
    }),
  )
  .strict();

// ---------------------------------------------------------------------------
// Foster volunteers pool — proposal lifecycle (spec v1.4 §4.5)
// ---------------------------------------------------------------------------
//
// All 6 events follow the `*_proposed` / `*_executed` cross-cutting pattern:
// the org proposes a foster, the volunteer accepts/rejects, the cron expires
// stale pending rows. Co-foster opt-in is a peer event on the foster
// ownership row created at acceptance. Classified NON-libreta (system flow
// telemetry, not pet medical history).

export const fosterProposed = z
  .object(
    withVersion({
      proposal_public_token: z.string(),
      volunteer_user_id: z.string().uuid(),
      proposed_duration_weeks: z.number().int().positive().nullable().optional(),
      match_warnings: z.array(z.string()).default([]),
    }),
  )
  .strict();

// Umbrella resolution event for a foster proposal's terminal state (catalog
// cleanup 2026-05-19). The `outcome` discriminator picks which optional
// fields apply:
//   - accepted: response_notes
//   - rejected: rejection_reason (enum) + response_notes
//   - cancelled: cancellation_reason + auto_cancelled (true when the D18
//     cascade closed it — volunteer's last slot consumed by accepting
//     another proposal)
//   - expired: only proposal_public_token
// The Zod schema is permissive on the optional fields; the server action
// that writes each row enforces the outcome ↔ fields correlation.
export const fosterProposalResolved = z
  .object(
    withVersion({
      proposal_public_token: z.string(),
      outcome: z.enum(["accepted", "rejected", "cancelled", "expired"]),
      response_notes: z.string().nullable().optional(),
      rejection_reason: z
        .enum(["capacity", "health_mismatch", "timing", "distance", "household", "other"])
        .nullable()
        .optional(),
      cancellation_reason: z.string().nullable().optional(),
      auto_cancelled: z.boolean().default(false).optional(),
    }),
  )
  .strict();

// Peer event on the foster ownership row recording the D17 co-foster
// opt-in flag set (or later toggled) by the first foster.
export const fosterCoFosterAllowed = z
  .object(
    withVersion({
      allow_co_foster: z.boolean(),
      foster_ownership_id: z.string().uuid(),
    }),
  )
  .strict();

// Adoption eligibility — emitted whenever pets.adoption_eligible* columns
// change (intake initial eval, later re-classification, set to null reset).
// The previous_state snapshot is the (eligible, reason) pair right before
// this change, so the timeline reconstructs without a separate journal.
export const adoptionEligibilitySet = z
  .object(
    withVersion({
      eligible: z.boolean(),
      ineligible_reason: z
        .enum([
          "medical_treatment",
          "behavioral_evaluation",
          "recovery",
          "quarantine",
          "legal_hold",
          "age",
          "pending_intake_eval",
          "other",
        ])
        .nullable()
        .optional(),
      ineligible_reason_notes: z.string().nullable().optional(),
      ineligible_until: z.string().datetime().nullable().optional(),
      previous_state: z
        .object({
          eligible: z.boolean().nullable(),
          reason: z.string().nullable(),
        })
        .nullable()
        .optional(),
    }),
  )
  .strict()
  .refine(
    (data) => data.eligible === true || data.ineligible_reason != null,
    "ineligible_reason required when eligible=false",
  )
  .refine(
    (data) =>
      data.ineligible_reason !== "other" ||
      (data.ineligible_reason_notes != null && data.ineligible_reason_notes.trim().length > 0),
    "ineligible_reason_notes required when reason='other'",
  );

// Custody transfer cancelled — structured termination of a
// custody_transfer_proposed (ARCH-B). Replaces the fragile marker-text
// note_added that was previously used to signal cancellation.
// cancelled_by discriminates who terminated the proposal:
//   owner_reject   — the owner actively rejected it
//   actor_cancel   — the proposing actor withdrew it
//   org_reject     — the receiving org rejected an owner-initiated proposal
//   auto_cancel    — system auto-cancelled during the owner-accept precondition check
export const custodyTransferCancelled = z
  .object(
    withVersion({
      // The custody_transfer_proposed event being cancelled.
      proposal_event_id: z.string().uuid(),
      cancelled_by: z.enum(["owner_reject", "actor_cancel", "org_reject", "auto_cancel"]),
      reason: z.string().nullable(),
    }),
  )
  .strict();

// Custody transfer proposed — Phase 1 of the return-to-owner two-phase
// handshake (Lost & Found Fase 5). An actor holding shelter_custody proposes
// returning the pet to the original owner (or to another org). The owner
// accepts via ownerAcceptReturnAction, which emits custody_transferred.
// Exactly one of (from_user_id, from_organization_id) must be non-null (XOR),
// and exactly one of (to_user_id, to_organization_id) must be non-null (XOR).
export const custodyTransferProposed = z
  .object(
    withVersion({
      // Polymorphic "from" actor — exactly one must be non-null.
      from_user_id: z.string().uuid().nullable(),
      from_organization_id: z.string().uuid().nullable(),
      // Polymorphic "to" actor — exactly one must be non-null.
      to_user_id: z.string().uuid().nullable(),
      to_organization_id: z.string().uuid().nullable(),
      reason: custodyTransferReason,
      // Roles carried through the handshake so ACCEPT can honor the requested
      // outcome. `from_role` is the source ownership role being handed off;
      // `to_role` is the role the destination will hold once accepted
      // (shelter_custody = temporary custody, owner = permanent owner). Both
      // optional for backwards-compat: pre-extension proposals (and the
      // return-to-owner / owner→owner handshakes) omit them and ACCEPT defaults
      // to shelter_custody.
      from_role: z.enum(["shelter_custody", "owner"]).optional(),
      to_role: z.enum(["shelter_custody", "owner"]).optional(),
      // Links the proposal to a chip-match flow when applicable.
      matched_against_pet_id: z.string().uuid().nullable().optional(),
      // ISO-8601 datetime when the proposal was created (server-generated).
      proposed_at: z.string().datetime(),
      notes: z.string().nullable().optional(),
    }),
  )
  .strict()
  .refine((p) => [p.from_user_id, p.from_organization_id].filter((v) => v !== null).length === 1, {
    message: "exactly one of from_user_id / from_organization_id must be set",
  })
  .refine((p) => [p.to_user_id, p.to_organization_id].filter((v) => v !== null).length === 1, {
    message: "exactly one of to_user_id / to_organization_id must be set",
  });

// Post-adoption check-in — adopter self-reports during the followup window
// (1m/3m/6m/12m after adoption_finalized, capped by post_adoption_followup_months).
// AGENTS.md → Custody & adoption: follow-up is enforced through notifications,
// not credential shaming; missing check-ins fan out a notification to the
// refugio side. `related_organization_id` is denormalized from the adoption
// chain so projections can group check-ins by org without scanning ownerships.
export const postAdoptionCheckin = z
  .object(
    withVersion({
      related_organization_id: z.string().uuid(),
      photo_attachment_ids: z.array(z.string().uuid()).default([]),
      notes: z.string().nullable(),
      // L1 jurisdiction (optional). Sprint 4 PR-034 / doc 09 §3.A.
      jurisdiction_province: z.string().nullable().optional(),
      jurisdiction_locality: z.string().nullable().optional(),
      // As entered and as resolved (localidades-por-id A8,
      // lib/events/place-payload.ts). Optional: earlier events validate as-is.
      place: eventPlaceSchema.optional(),
    }),
  )
  .strict();

// Libreta Tier-2 share view telemetry used to live here as
// `libreta_shared_viewed`. The 2026-05-19 catalog cleanup moved that signal out
// of pet_events into a dedicated `share_telemetry` table, and migration 0167
// (TEL-1, PO 2026-08-04) dropped that table too — it had no reader. Share views
// are now only a counter on libreta_share_tokens. No Zod schema either way.
