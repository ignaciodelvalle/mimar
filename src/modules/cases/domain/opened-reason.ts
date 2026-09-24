// opened-reason — the closed set of reasons a case can be opened for.
//
// THIS IS THE FENCE. `CreateCaseInput.openedReason` is typed as this union, so
// every case-open in the system must name a code that exists here. Writer #19
// cannot invent a reason and cannot leak a raw string: it gets a `tsc` error
// here, at the write boundary, before any row is ever written.
//
// That is the hole this closes. transfer-custody.ts — the change of legal
// responsible, the most consequential write in the system — passed a bare
// template string for months. Nothing type-checked it, so it rendered as
// "Apertura automática — direct custody handoff to_role=owner": English plus a
// raw enum key, wrapped in a Spanish prefix so it read like a translation.
//
// Three modules hang off this union, each keyed by `code` so adding a member
// without handling it is a compile error (see opened-reason-render.ts):
//   opened-reason-render.ts  → es-AR label a funcionario reads
//   opened-reason-prose.ts   → legacy audit prose (byte-identical to today)
//   opened-reason-labels.ts  → the shared raw-enum → es-AR vocabularies
//
// WHY A ZOD UNION AND NOT AN `as const` ARRAY (the CASE_CLOSED_REASONS shape):
// open reasons carry PARAMS. `closed_reason` is a bare scalar, so an array
// types it completely; `{ code, referenceCode, kind, severity }` is a record.
// And `opened_reason_params` is jsonb — the READ boundary is genuinely
// `unknown` (older deploys, seeds, hand-fixed rows), so a runtime-validated
// parse is not ceremony, it is the only honest way to read that column.
//
// `.strict()` on every member follows lib/events/event-schemas.ts: strictness
// rejects wrong-face payloads for free instead of hand-written refinements —
// and here it does privacy work too (see OpenedReasonAudit below).

import { z } from "zod";

// ---------------------------------------------------------------------------
// Param vocabularies
// ---------------------------------------------------------------------------
//
// Declared as literal enums here rather than imported from each owning module.
// Same call lib/events/event-schemas.ts makes for the corridor ids: this union
// is persisted, so it must not silently change meaning when a source enum is
// refactored. The renderer's label maps cover each value; a source enum that
// grows a value fails this parse loudly instead of leaking the raw key.

const WELFARE_KINDS = [
  "abandonment",
  "neglect",
  "physical_abuse",
  "chained",
  "no_shelter",
  "hoarding",
  "dog_fighting",
  "trafficking",
  "other",
] as const;

const WELFARE_SEVERITIES = ["low", "medium", "high", "critical"] as const;

const BITE_VICTIM_KINDS = ["human", "animal", "unknown"] as const;
const BITE_SEVERITIES = ["minor", "moderate", "severe"] as const;

// orgTypeToReporterRole (surveillance/domain/bite.ts) defaults to "witness".
const REPORTER_ROLES = ["vet", "shelter", "govt", "witness"] as const;

const SEIZURE_MOTIVES = [
  "maltrato_fisico",
  "abandono_extremo",
  "acumulacion",
  "trafico",
  "sin_refugio_critico",
  "pelea_de_perros",
  "otro",
] as const;

const TRANSFER_REASONS = [
  "space_constraint",
  "specialization_needed",
  "network_redistribution",
  "shelter_closing",
  "post_adoption_failed_return",
  "other",
] as const;

// resolveNewRole in transfers/application/transfer-custody.ts
const CUSTODY_HANDOFF_ROLES = ["shelter_custody", "owner"] as const;

const INTAKE_REASONS = ["rescue", "surrender", "stray_found", "other"] as const;

const CHIP_REASONS = [
  "damaged",
  "unreadable",
  "duplicate_detected",
  "fraud_detected",
  "owner_request",
  "device_failure",
  "other",
] as const;

// The custody_disputes CHECK (db/schema.ts) is the authoritative closed set.
//
// NOTE — known doc drift, deliberately not "reconciled" here: AGENTS.md:691
// documents the custody_dispute_raised EVENT PAYLOAD as admin|govt|owner (3
// values, no `org`), while the custody_disputes TABLE allows 4. Different
// surfaces. This column follows the table's CHECK.
const DISPUTE_RAISED_BY_ROLES = ["owner", "org", "govt", "admin"] as const;

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export const OpenedReasonSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("adoption_listing_opened") }).strict(),
  z.object({ code: z.literal("adoption_application_submitted") }).strict(),
  z
    .object({
      code: z.literal("welfare_report_citizen"),
      referenceCode: z.string(),
      kind: z.enum(WELFARE_KINDS),
      severity: z.enum(WELFARE_SEVERITIES),
    })
    .strict(),
  z
    .object({
      code: z.literal("welfare_report_org"),
      referenceCode: z.string(),
      orgDisplayName: z.string(),
    })
    .strict(),
  z
    .object({
      code: z.literal("foster_placement_assigned"),
      actorOrgDisplayName: z.string(),
      expectedWeeks: z.number().int().positive().nullable(),
    })
    .strict(),
  // No params on purpose: the writer's prose names a volunteer id and an org
  // id, and neither may reach params. They travel as OpenedReasonAudit.
  z
    .object({ code: z.literal("foster_proposal_sent") })
    .strict(),
  z
    .object({
      code: z.literal("pet_marked_lost"),
      // Public token when the pet has one; null otherwise. The internal pet
      // UUID is NOT here — see OpenedReasonAudit.
      petPublicToken: z.string().nullable(),
      ownerNote: z.string().nullable(),
    })
    .strict(),
  z.object({ code: z.literal("lost_search_reactivated"), petPublicToken: z.string() }).strict(),
  z
    .object({
      code: z.literal("decomiso_executed"),
      motive: z.enum(SEIZURE_MOTIVES),
      judicialRef: z.string().nullable(),
    })
    .strict(),
  z
    .object({ code: z.literal("decomiso_handoff_accepted"), sourceCasePublicCode: z.string() })
    .strict(),
  z
    .object({
      code: z.literal("bite_reported_owner"),
      victimKind: z.enum(BITE_VICTIM_KINDS),
      severity: z.enum(BITE_SEVERITIES),
    })
    .strict(),
  z
    .object({
      code: z.literal("bite_reported_org"),
      orgDisplayName: z.string(),
      reporterRole: z.enum(REPORTER_ROLES),
      victimKind: z.enum(BITE_VICTIM_KINDS),
      severity: z.enum(BITE_SEVERITIES),
    })
    .strict(),
  z
    .object({ code: z.literal("custody_handoff_direct"), toRole: z.enum(CUSTODY_HANDOFF_ROLES) })
    .strict(),
  z
    .object({ code: z.literal("cross_org_transfer_proposed"), reason: z.enum(TRANSFER_REASONS) })
    .strict(),
  z.object({ code: z.literal("org_intake"), intakeReason: z.enum(INTAKE_REASONS) }).strict(),
  z
    .object({
      code: z.literal("microchip_replaced"),
      reason: z.enum(CHIP_REASONS),
      // The FACT a duplicate was found — never the secondary pet's UUID.
      duplicateDetected: z.boolean(),
    })
    .strict(),
  z
    .object({
      code: z.literal("custody_dispute_raised"),
      raisedByRole: z.enum(DISPUTE_RAISED_BY_ROLES),
    })
    .strict(),
  z
    .object({
      code: z.literal("outbreak_investigation_manual"),
      diseaseCode: z.string(),
      note: z.string(),
    })
    .strict(),
  // rehome-by-titular: the titular asks a verified org to sponsor the listing.
  // Only the org's display name travels — the same param welfare_report_org
  // carries. Neither the titular's id nor the pet's id belongs here.
  z
    .object({ code: z.literal("rehome_requested"), orgDisplayName: z.string() })
    .strict(),
]);

export type OpenedReason = z.infer<typeof OpenedReasonSchema>;
export type OpenedReasonCode = OpenedReason["code"];
export type OpenedReasonParams<C extends OpenedReasonCode> = Omit<
  Extract<OpenedReason, { code: C }>,
  "code"
>;

/**
 * Every code in the union. Derived from the schema itself, so it can never
 * drift from the union it claims to enumerate.
 */
export const OPENED_REASON_CODES = OpenedReasonSchema.options.map(
  (o) => o.shape.code.value,
) as readonly OpenedReasonCode[];

// ---------------------------------------------------------------------------
// Audit-only ids — the prose/params split
// ---------------------------------------------------------------------------

/**
 * Internal ids that appear in the legacy AUDIT prose but must never reach
 * `opened_reason_params`.
 *
 * Why this exists: three writers embed an internal UUID in their prose
 * (foster_proposal_sent's volunteer + org, pet_marked_lost's pet fallback,
 * microchip_replaced's secondary pet). Two requirements collide there —
 * dual-written prose must stay byte-identical to today (the regex layer and
 * the outbreak dedupe read it), but params must not carry UUIDs, because
 * params are what the renderer can reach and therefore what could leak.
 *
 * Both hold by separating the channels: these ids reach `openedReasonProse`
 * and stop there. They are structurally unreachable from `renderOpenedReason`,
 * which only ever sees the parsed union. The regex layer strips these UUIDs at
 * RENDER time; this makes them unrenderable at the TYPE level.
 */
export type OpenedReasonAudit = {
  /** foster_proposal_sent — the volunteer's user id. */
  volunteerUserId?: string | null;
  /** foster_proposal_sent — the proposing org's id. */
  orgId?: string | null;
  /** pet_marked_lost — internal pet UUID; prose uses it only when no public token exists. */
  petId?: string | null;
  /** microchip_replaced — the duplicate-chip pet's id. */
  secondaryPetId?: string | null;
};
