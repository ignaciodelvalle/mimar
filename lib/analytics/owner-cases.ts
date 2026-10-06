// The owner's casos — every open cycle they are waiting on or must answer, and
// the most recent closed ones — as the /mis-mascotas Bandeja and
// `GET /api/v1/me/cases` read them.
//
// WHY ITS OWN FILE (2026-10-06, file-size fence). The grouped casos (PO decision
// 2026-10-06) gave every row its pet and whose turn it is, and that pushed
// owner-dashboard.ts past its baseline. The fence's rule is "shrink it or split
// it", and this is the coherent unit: every fetcher below answers "what cycles
// is this person in", shares the `WorkflowItem` shape, the pet join
// (`workflowPet`) and the turn (`withTurn`), and none of them touches the
// dashboard projections the rest of that file builds.
//
// Re-exported from owner-dashboard.ts, so no consumer import had to move.
//
// Helpers in here MUST NOT throw — return empty arrays on no-data so the
// widgets can render the empty state uniformly.

import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import {
  approvalRequests,
  attachments,
  cases,
  custodyDisputeParties,
  custodyDisputes,
  db,
  disputeHoldsCustodyLock,
  fosterProposals,
  organizations,
  ownerships,
  pets,
  welfareReports,
} from "@/db";
import { PPP_ATTESTED_EVIDENCE } from "@/lib/analytics/compliance-metrics";
import { viewerHoldsPetClause } from "@/lib/infra/pet-holder-clause";
import { petPhotoUrl } from "@/lib/infra/storage";
import { lostReportedTitle, requestOutcomeLabel } from "@/lib/utils/format";
import { TERMINAL_STATUSES } from "@/src/modules/welfare/domain/welfare-status-rules";
import { caseKindNeedsAction } from "@dim/contract/api";

// ---------------------------------------------------------------------------
// Workflows (open + previous)
// ---------------------------------------------------------------------------

export type WorkflowKind =
  | "foster_proposal_pending"
  | "pet_lost"
  | "welfare_report_open"
  | "adoption_application_pending"
  | "custody_transfer_pending"
  | "approval_request_pending"
  | "custody_dispute_open"
  | "bite_observation_open"
  | "dangerous_breed_pending_attestation"
  | "case_generic_open"
  | "foster_proposal_resolved"
  | "welfare_report_closed"
  | "adoption_application_resolved"
  | "approval_request_decided";

/** The pet a workflow row is about — its public identity, never `pets.id`. */
export type WorkflowPet = {
  publicToken: string;
  name: string;
  /** Public photo url (`petPhotoUrl`), or `null` when the pet has none. */
  photoUrl: string | null;
};

export type WorkflowItem = {
  id: string;
  kind: WorkflowKind;
  title: string;
  subtitle: string | null;
  ctaUrl: string;
  since: Date;
  severity: "info" | "warning" | "urgent";
  /** The pet this row is about, or `null` for an account-level row (a denuncia, an approval). */
  pet: WorkflowPet | null;
  /**
   * The owner's turn. `caseKindNeedsAction(kind)` by default, set in ONE place
   * (`withTurn`); a fetcher overrides it only where the kind alone cannot say
   * whose turn it is — today one: a devolución proposal, whose direction decides.
   */
  needsAction: boolean;
  /** Deadline for the owner's answer, or `null` when the cycle has none. */
  dueAt: Date | null;
};

/**
 * What each source fetcher builds; `withTurn` adds the rest from the kind. A
 * fetcher sets `needsAction` itself only when the row's own data decides it.
 */
type WorkflowDraft = Omit<WorkflowItem, "needsAction" | "dueAt"> & {
  dueAt?: Date | null;
  needsAction?: boolean;
};

function withTurn(draft: WorkflowDraft): WorkflowItem {
  return {
    ...draft,
    dueAt: draft.dueAt ?? null,
    needsAction: draft.needsAction ?? caseKindNeedsAction(draft.kind),
  };
}

/** A pet row's identity as a workflow row carries it. */
function workflowPet(
  publicToken: string | null,
  name: string | null,
  photoStoragePath: string | null,
): WorkflowPet | null {
  if (publicToken === null || name === null) return null;
  return { publicToken, name, photoUrl: petPhotoUrl(photoStoragePath) };
}

async function fetchPendingFosterProposals(
  userId: string,
  petIdFilter?: string,
): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: fosterProposals.id,
      publicToken: fosterProposals.publicToken,
      proposedAt: fosterProposals.proposedAt,
      expiresAt: fosterProposals.expiresAt,
      petName: pets.name,
      petPublicToken: pets.publicToken,
      petPhotoPath: attachments.storagePath,
      orgName: organizations.displayName,
    })
    .from(fosterProposals)
    .innerJoin(pets, eq(pets.id, fosterProposals.petId))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .innerJoin(organizations, eq(organizations.id, fosterProposals.organizationId))
    .where(
      and(
        eq(fosterProposals.volunteerUserId, userId),
        eq(fosterProposals.status, "pending"),
        // A proposal past `expires_at` can no longer be answered, whether or
        // not a sweep has flipped its status yet — the volunteer hub treats it
        // as expired too (list-foster-hub-for-volunteer.ts). Listing it would
        // print "Vence el" a date already gone.
        gt(fosterProposals.expiresAt, sql`now()`),
        ...(petIdFilter ? [eq(fosterProposals.petId, petIdFilter)] : []),
      ),
    );
  return rows.map((r) => ({
    id: `foster_proposal:${r.id}`,
    kind: "foster_proposal_pending" as const,
    title: `Propuesta de tránsito para ${r.petName}`,
    subtitle: `${r.orgName} espera tu respuesta`,
    ctaUrl: `/cuenta/transitos/propuestas/${r.publicToken}`,
    since: r.proposedAt,
    severity: "warning" as const,
    pet: workflowPet(r.petPublicToken, r.petName, r.petPhotoPath),
    // The proposal lapses on its own at `expires_at`: that is the owner's deadline.
    dueAt: r.expiresAt,
  }));
}

// Consolidated query: pets requiring attention — lost + pending PPP attestation.
// Replaces fetchLostPets(owner-dashboard) + fetchPendingPppAttestations (2 → 1 query).
async function fetchPetAlerts(userId: string, petIdFilter?: string): Promise<WorkflowDraft[]> {
  // owner-ia-redesign P3: optional pet scoping — the profile reuses this for
  // its own open cycles. Nested sql fragment is inert when no filter is set.
  const petClause = petIdFilter ? sql`AND p.id = ${petIdFilter}` : sql``;
  const rows = await db.execute<{
    kind: "pet_lost" | "dangerous_breed_pending_attestation";
    pet_id: string;
    pet_name: string;
    pet_sex: string | null;
    pet_public_token: string;
    pet_photo_path: string | null;
    since_ts: string;
  }>(sql`
    -- Lost pets owned by user
    SELECT
      'pet_lost'::text AS kind,
      p.id::text        AS pet_id,
      p.name            AS pet_name,
      p.sex::text       AS pet_sex,
      p.public_token    AS pet_public_token,
      ph.storage_path   AS pet_photo_path,
      p.updated_at::text AS since_ts
    FROM pets p
    LEFT JOIN attachments ph ON ph.id = p.primary_photo_id
    JOIN ownerships o ON o.pet_id = p.id
     AND o.owner_user_id = ${userId}
     AND o.role = 'owner'
     AND o.ended_at IS NULL
    WHERE p.status = 'lost'
      ${petClause}

    UNION ALL

    -- PPP pets with no attestation that COUNTS yet.
    --
    -- "No attestation row at all" is what this asked until T4-I1 / #753, and
    -- it left the owner in the new DECLARADA state with a compliance card
    -- telling them to add the inscription number and NOTHING in their
    -- pendientes — while /gob had already stopped counting them. The nudge and
    -- the number an authority reads have to agree about who is still missing
    -- something, so this reads the SAME shared fragment C7 does
    -- (PPP_ATTESTED_EVIDENCE; the rule itself is lib/domain/ppp-attestation.ts).
    --
    -- The subquery alias is pe (renamed from e) because the fragment's column
    -- references are written against that name. No backticks in this comment:
    -- it lives inside a JS template literal, where one would end the string.
    SELECT
      'dangerous_breed_pending_attestation'::text AS kind,
      p.id::text        AS pet_id,
      p.name            AS pet_name,
      p.sex::text       AS pet_sex,
      p.public_token    AS pet_public_token,
      ph.storage_path   AS pet_photo_path,
      p.created_at::text AS since_ts
    FROM pets p
    LEFT JOIN attachments ph ON ph.id = p.primary_photo_id
    JOIN ownerships o ON o.pet_id = p.id
     AND o.owner_user_id = ${userId}
     AND o.role = 'owner'
     AND o.ended_at IS NULL
    WHERE p.potentially_dangerous_breed = TRUE
      AND p.status != 'deceased'
      ${petClause}
      AND NOT EXISTS (
        SELECT 1 FROM pet_events pe
        WHERE pe.pet_id = p.id
          AND pe.event_type = 'dangerous_breed_attested'
          AND ${PPP_ATTESTED_EVIDENCE}
      )
  `);

  return rows.map((r) => {
    if (r.kind === "pet_lost") {
      return {
        id: `pet_lost:${r.pet_id}`,
        kind: "pet_lost" as const,
        // Sex-flexed (ciclo-perdido sweep fix #2): "está reportada como
        // perdida" called a male pet feminine.
        title: lostReportedTitle(r.pet_name, r.pet_sex),
        subtitle: "Avisanos cuando aparezca",
        ctaUrl: `/mis-mascotas/${r.pet_public_token}`,
        since: new Date(r.since_ts),
        severity: "urgent" as const,
        pet: workflowPet(r.pet_public_token, r.pet_name, r.pet_photo_path),
      };
    }
    return {
      id: `ppp_pending:${r.pet_id}`,
      kind: "dangerous_breed_pending_attestation" as const,
      title: `Atestá la raza de ${r.pet_name}`,
      // The subtitle covers BOTH pets this item now reaches: one with nothing
      // on record, and one whose attestation is on record but cites no
      // inscription number (#753). Naming the number is what makes the second
      // person's next move obvious instead of telling them to do again what
      // they already did.
      subtitle:
        "Tu mascota es PPP (potencialmente peligrosa) — hace falta la atestación con su número de inscripción",
      ctaUrl: `/mis-mascotas/${r.pet_public_token}/eventos/atestar-raza-peligrosa`,
      since: new Date(r.since_ts),
      severity: "warning" as const,
      pet: workflowPet(r.pet_public_token, r.pet_name, r.pet_photo_path),
    };
  });
}

async function fetchOpenWelfareReports(userId: string): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: welfareReports.id,
      referenceCode: welfareReports.referenceCode,
      status: welfareReports.status,
      createdAt: welfareReports.createdAt,
    })
    .from(welfareReports)
    .where(
      and(
        eq(welfareReports.reporterUserId, userId),
        // Exclude ALL terminal statuses (closed | invalid | duplicate), not just
        // 'closed' — an invalid/duplicate denuncia is resolved and must NOT surface
        // as an "open denuncia" workflow item (C4). Shares the welfare domain's
        // single TERMINAL_STATUSES with the govt KPIs.
        notInArray(welfareReports.status, [...TERMINAL_STATUSES]),
      ),
    );
  return rows.map((r) => ({
    id: `welfare_report:${r.id}`,
    kind: "welfare_report_open" as const,
    title: "Denuncia de bienestar animal",
    subtitle: r.status === "open" ? "En espera de revisión" : "En revisión por autoridad",
    ctaUrl: `/denuncias/codigo/${r.referenceCode}`,
    since: r.createdAt,
    severity: "info" as const,
    // A denuncia is about somebody else's animal, often one with no record at
    // all: an account-level row, never clustered under a pet.
    pet: null,
  }));
}

// Consolidated query: pending pet-event workflows — adoption applications +
// custody transfer proposals. Replaces two separate petEvents queries (2 → 1).
async function fetchPendingPetEventWorkflows(
  userId: string,
  petIdFilter?: string,
): Promise<WorkflowDraft[]> {
  // owner-ia-redesign P3: optional pet scoping (inert fragment when unset).
  const petClause = petIdFilter ? sql`AND p.id = ${petIdFilter}` : sql``;
  const rows = await db.execute<{
    kind: "adoption_application_pending" | "custody_transfer_pending";
    item_id: string;
    pet_id: string;
    pet_name: string;
    pet_public_token: string;
    pet_photo_path: string | null;
    since_ts: string;
    owner_must_act: boolean;
    waiting_on_org: string | null;
  }>(sql`
    -- Pending adoption applications submitted by this user
    SELECT
      'adoption_application_pending'::text AS kind,
      e.id::text                           AS item_id,
      p.id::text                           AS pet_id,
      p.name                               AS pet_name,
      p.public_token                       AS pet_public_token,
      ph.storage_path                      AS pet_photo_path,
      e.recorded_at::text                  AS since_ts,
      FALSE                                AS owner_must_act,
      NULL::text                           AS waiting_on_org
    FROM pet_events e
    JOIN pets p ON p.id = e.pet_id
    LEFT JOIN attachments ph ON ph.id = p.primary_photo_id
    WHERE e.event_type = 'adoption_application_submitted'
      AND e.payload->>'applicant_user_id' = ${userId}
      ${petClause}
      AND NOT EXISTS (
        SELECT 1 FROM pet_events r
        WHERE r.pet_id = e.pet_id
          AND r.event_type = 'adoption_application_resolved'
          AND r.payload->>'application_event_id' = e.id::text
      )
      AND NOT EXISTS (
        SELECT 1 FROM pet_events f
        WHERE f.pet_id = e.pet_id
          AND f.event_type = 'adoption_finalized'
      )

    UNION ALL

    -- Custody transfer proposals on pets the user owns, not yet resolved.
    --
    -- WHOSE TURN IS IN THE PAYLOAD. A proposal addressed to this user
    -- (to_user_id) waits on them: they confirm or reject the devolución. One
    -- the owner SENT (owner-propose-return-to-org: from_user_id = owner,
    -- to_organization_id = the refugio) waits on the organization, and the
    -- owner only follows it.
    --
    -- RESOLVED = transferred OR cancelled. A rejection by either side and a
    -- withdrawal all write custody_transfer_cancelled naming the proposal
    -- (proposal_event_id), the same structured check hasPendingProposal makes;
    -- without it a refused proposal stayed open here forever.
    SELECT
      'custody_transfer_pending'::text AS kind,
      e.id::text                       AS item_id,
      p.id::text                       AS pet_id,
      p.name                           AS pet_name,
      p.public_token                   AS pet_public_token,
      ph.storage_path                  AS pet_photo_path,
      e.occurred_at::text              AS since_ts,
      COALESCE(e.payload->>'to_user_id' = ${userId}, FALSE) AS owner_must_act,
      org.display_name                 AS waiting_on_org
    FROM pet_events e
    JOIN pets p ON p.id = e.pet_id
    LEFT JOIN attachments ph ON ph.id = p.primary_photo_id
    LEFT JOIN organizations org ON org.id::text = e.payload->>'to_organization_id'
    JOIN ownerships o ON o.pet_id = p.id
     AND o.owner_user_id = ${userId}
     AND o.role = 'owner'
     AND o.ended_at IS NULL
    WHERE e.event_type = 'custody_transfer_proposed'
      ${petClause}
      AND NOT EXISTS (
        SELECT 1 FROM pet_events t
        WHERE t.pet_id = e.pet_id
          AND t.event_type = 'custody_transferred'
          AND t.occurred_at >= e.occurred_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM pet_events c
        WHERE c.pet_id = e.pet_id
          AND c.event_type = 'custody_transfer_cancelled'
          AND c.payload->>'proposal_event_id' = e.id::text
      )

    ORDER BY since_ts DESC
  `);

  return rows.map((r) => {
    if (r.kind === "adoption_application_pending") {
      return {
        id: `adoption_application:${r.item_id}`,
        kind: "adoption_application_pending" as const,
        title: `Tu postulación para ${r.pet_name}`,
        subtitle: "Pendiente de revisión del refugio",
        ctaUrl: "/mis-mascotas/postulaciones",
        since: new Date(r.since_ts),
        severity: "info" as const,
        pet: workflowPet(r.pet_public_token, r.pet_name, r.pet_photo_path),
      };
    }
    // The one per-row override of the kind table: the direction decides.
    const ownerMustAct = r.owner_must_act === true;
    return {
      id: `custody_transfer:${r.item_id}`,
      kind: "custody_transfer_pending" as const,
      title: `Propuesta de devolución para ${r.pet_name}`,
      subtitle: ownerMustAct
        ? "Alguien intenta devolverla — confirmá la transferencia"
        : `Esperando que ${r.waiting_on_org ?? "la otra parte"} responda`,
      ctaUrl: `/mis-mascotas/${r.pet_public_token}/devolucion`,
      since: new Date(r.since_ts),
      severity: ownerMustAct ? ("warning" as const) : ("info" as const),
      pet: workflowPet(r.pet_public_token, r.pet_name, r.pet_photo_path),
      needsAction: ownerMustAct,
    };
  });
}

async function fetchPendingApprovalRequests(userId: string): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: approvalRequests.id,
      publicToken: approvalRequests.publicToken,
      type: approvalRequests.type,
      createdAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .where(
      and(eq(approvalRequests.applicantUserId, userId), eq(approvalRequests.status, "pending")),
    );
  return rows.map((r) => ({
    id: `approval_request:${r.id}`,
    kind: "approval_request_pending" as const,
    title: humanizeApprovalRequestType(r.type),
    subtitle: "Esperando aprobación de la autoridad",
    // /cuenta/solicitudes, NOT /cuenta/aprobaciones/{token} (2026-08-18). That
    // second route has never existed — `git ls-files app/**/aprobaciones/**`
    // returns nothing — so this card, which every applicant with a pending
    // request sees, offered a button that 404s. /cuenta/solicitudes is the
    // applicant's own list: it reads approval_requests filtered by
    // applicantUserId and shows type, status, dates and the decision notes.
    ctaUrl: "/cuenta/solicitudes",
    since: r.createdAt,
    severity: "info" as const,
    pet: null,
  }));
}

async function fetchOpenCustodyDisputes(
  userId: string,
  petIdFilter?: string,
): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: custodyDisputes.id,
      petId: custodyDisputes.petId,
      // The CTA needs the PET's public token, not the dispute's own token and
      // not the pet's uuid. `/mis-mascotas/[publicToken]` resolves through
      // requirePetAccess, which matches on `pets.public_token` and nothing
      // else, so a uuid lands in the dynamic segment and calls notFound().
      // `pets` is already joined below, so this column is free.
      petPublicToken: pets.publicToken,
      createdAt: custodyDisputes.createdAt,
      petName: pets.name,
      petPhotoPath: attachments.storagePath,
    })
    .from(custodyDisputeParties)
    .innerJoin(custodyDisputes, eq(custodyDisputes.id, custodyDisputeParties.disputeId))
    .innerJoin(pets, eq(pets.id, custodyDisputes.petId))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(
      and(
        eq(custodyDisputeParties.partyUserId, userId),
        disputeHoldsCustodyLock(),
        ...(petIdFilter ? [eq(custodyDisputes.petId, petIdFilter)] : []),
      ),
    );
  return rows.map((r) => ({
    id: `custody_dispute:${r.id}`,
    kind: "custody_dispute_open" as const,
    title: `Disputa de custodia sobre ${r.petName}`,
    subtitle: "Procedimiento en curso ante la autoridad",
    ctaUrl: `/mis-mascotas/${r.petPublicToken}`,
    since: r.createdAt,
    severity: "warning" as const,
    pet: workflowPet(r.petPublicToken, r.petName, r.petPhotoPath),
  }));
}

// Case kinds handled by dedicated fetchers elsewhere in this module.
// The combined open-cases sweep below covers the remaining kinds + bite_incident.
const CASES_HANDLED_BY_OTHER_FETCHERS = [
  "foster_placement",
  "lost_pet_episode",
  "welfare_denuncia",
  "adoption_application",
  "custody_dispute",
  "custody_transfer_handshake",
  "adoption_listing",
] as const;

// Consolidated query: open cases connected to the user — bite_incident
// (rabies observation) + any other open case kind not handled by a dedicated
// fetcher. Replaces fetchOpenBiteCases + fetchOpenCasesGenericSweep (2 → 1 query).
async function fetchOpenCasesSweep(userId: string, petIdFilter?: string): Promise<WorkflowDraft[]> {
  const rows = await db
    .selectDistinct({
      caseId: cases.id,
      publicCode: cases.publicCode,
      caseKind: cases.caseKind,
      openedAt: cases.openedAt,
      petName: pets.name,
      petPublicToken: pets.publicToken,
      petPhotoPath: attachments.storagePath,
    })
    .from(cases)
    .leftJoin(pets, eq(pets.id, cases.primaryPetId))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .leftJoin(
      ownerships,
      and(
        eq(ownerships.petId, cases.primaryPetId),
        eq(ownerships.role, "owner"),
        isNull(ownerships.endedAt),
      ),
    )
    .where(
      and(
        ne(cases.status, "closed"),
        notInArray(cases.caseKind, [...CASES_HANDLED_BY_OTHER_FETCHERS]),
        ...(petIdFilter ? [eq(cases.primaryPetId, petIdFilter)] : []),
        or(
          // bite_incident is reachable only via the ownership arm — it must NOT
          // surface through openedByUserId / applicantUserId because those arms
          // would expose bite cases to reporters/applicants who are not owners,
          // breaking the owner-only visibility contract for bite_incident.
          and(eq(cases.caseKind, "bite_incident"), eq(ownerships.ownerUserId, userId)),
          and(
            ne(cases.caseKind, "bite_incident"),
            or(
              eq(ownerships.ownerUserId, userId),
              eq(cases.openedByUserId, userId),
              eq(cases.applicantUserId, userId),
            ),
          ),
        ),
      ),
    );

  return rows.map((r) => {
    if (r.caseKind === "bite_incident") {
      return {
        id: `bite_case:${r.caseId}`,
        kind: "bite_observation_open" as const,
        title: `Observación por mordedura · ${r.petName ?? "mascota"}`,
        subtitle: `${r.publicCode} · procedimiento en curso`,
        ctaUrl: r.petPublicToken ? `/mis-mascotas/${r.petPublicToken}` : `/casos/${r.publicCode}`,
        since: r.openedAt,
        severity: "warning" as const,
        pet: workflowPet(r.petPublicToken, r.petName, r.petPhotoPath),
      };
    }
    return {
      id: `case_generic:${r.caseId}`,
      kind: "case_generic_open" as const,
      title: r.petName ? `Caso ${r.publicCode} · ${r.petName}` : `Caso ${r.publicCode}`,
      subtitle: caseKindLabelFallback(r.caseKind),
      ctaUrl: `/casos/${r.publicCode}`,
      since: r.openedAt,
      severity: "info" as const,
      pet: workflowPet(r.petPublicToken, r.petName, r.petPhotoPath),
    };
  });
}

// Lightweight label lookup that doesn't import lib/case-kinds.ts (avoids
// circular dep risk). Falls back to the raw caseKind if unknown — the
// dashboard still renders, the row is just a bit less polished.
function caseKindLabelFallback(caseKind: string): string {
  switch (caseKind) {
    case "microchip_remediation":
      return "Reemplazo de microchip en curso";
    case "custody_episode":
      return "Episodio de custodia";
    case "outbreak_investigation":
      return "Investigación de brote sanitario";
    case "foster_proposal":
      return "Propuesta de tránsito";
    case "rehome_request":
      return "Solicitud de nuevo hogar";
    default:
      return caseKind.replaceAll("_", " ");
  }
}

// fetchOpenWorkflows: 10 → 7 queries by merging homogeneous sub-fetchers.
//
// Before: fetchLostPets + fetchPendingPppAttestations (2 pets queries)
//         fetchPendingAdoptionApplications + fetchPendingCustodyTransfers (2 petEvents queries)
//         fetchOpenBiteCases + fetchOpenCasesGenericSweep (2 cases queries)
// After:  fetchPetAlerts (1) + fetchPendingPetEventWorkflows (1) + fetchOpenCasesSweep (1)
// Remaining unchanged: fetchPendingFosterProposals, fetchOpenWelfareReports,
//   fetchPendingApprovalRequests, fetchOpenCustodyDisputes (structurally distinct).
// owner-ia-redesign P3: `petIdFilter` scopes the result to open cycles about a
// SINGLE pet, so the pet profile can reuse this fetcher for its own section.
// The two account-scoped (not pet-scoped) sources — welfare denuncias the user
// filed (about OTHER pets) and account-level approval requests — are skipped
// when a pet filter is set; they belong to the /mis-mascotas inbox (P5), not a
// pet's own profile.
export async function fetchOpenWorkflows(
  userId: string,
  petIdFilter?: string,
): Promise<WorkflowItem[]> {
  const [foster, petAlerts, welfare, petEventWorkflows, approval, disputes, casesSweep] =
    await Promise.all([
      fetchPendingFosterProposals(userId, petIdFilter),
      fetchPetAlerts(userId, petIdFilter),
      petIdFilter ? Promise.resolve([]) : fetchOpenWelfareReports(userId),
      fetchPendingPetEventWorkflows(userId, petIdFilter),
      petIdFilter ? Promise.resolve([]) : fetchPendingApprovalRequests(userId),
      fetchOpenCustodyDisputes(userId, petIdFilter),
      fetchOpenCasesSweep(userId, petIdFilter),
    ]);
  // Sort by `since` desc — most recently opened workflow on top.
  return [
    ...foster,
    ...petAlerts,
    ...welfare,
    ...petEventWorkflows,
    ...approval,
    ...disputes,
    ...casesSweep,
  ]
    .map(withTurn)
    .sort((a, b) => b.since.getTime() - a.since.getTime());
}

// ---------------------------------------------------------------------------
// Previous workflows — last N resolved items across all domains
// ---------------------------------------------------------------------------

async function fetchResolvedFosterProposals(
  userId: string,
  limit: number,
): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: fosterProposals.id,
      publicToken: fosterProposals.publicToken,
      status: fosterProposals.status,
      respondedAt: fosterProposals.respondedAt,
      proposedAt: fosterProposals.proposedAt,
      petName: pets.name,
      petPublicToken: pets.publicToken,
      petPhotoPath: attachments.storagePath,
      viewerHolds: sql<boolean>`${viewerHoldsPetClause(userId, pets.id)}`,
    })
    .from(fosterProposals)
    .innerJoin(pets, eq(pets.id, fosterProposals.petId))
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    .where(
      and(
        eq(fosterProposals.volunteerUserId, userId),
        inArray(fosterProposals.status, ["accepted", "rejected", "cancelled", "expired"]),
      ),
    )
    .orderBy(desc(fosterProposals.respondedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: `foster_proposal_resolved:${r.id}`,
    kind: "foster_proposal_resolved" as const,
    title: `Propuesta de tránsito · ${r.petName}`,
    // Was `Estado: ${r.status}` — the raw enum ("accepted", "expired") printed
    // straight onto the owner's case history. Null when unmapped: an unnamed
    // state says nothing rather than leaking the enum again.
    subtitle: requestOutcomeLabel(r.status) ?? "",
    ctaUrl: `/cuenta/transitos/propuestas/${r.publicToken}`,
    since: r.respondedAt ?? r.proposedAt,
    severity: "info" as const,
    // HISTORY NAMES ONLY A PET THE VIEWER STILL HOLDS. A declined or lapsed
    // tránsito is about somebody else's animal now; its token and its current
    // photo are not this person's to keep seeing. The title still names it.
    pet: r.viewerHolds ? workflowPet(r.petPublicToken, r.petName, r.petPhotoPath) : null,
  }));
}

async function fetchClosedWelfareReports(userId: string, limit: number): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: welfareReports.id,
      referenceCode: welfareReports.referenceCode,
      closedAt: welfareReports.closedAt,
      createdAt: welfareReports.createdAt,
    })
    .from(welfareReports)
    .where(and(eq(welfareReports.reporterUserId, userId), eq(welfareReports.status, "closed")))
    .orderBy(desc(welfareReports.closedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: `welfare_report_closed:${r.id}`,
    kind: "welfare_report_closed" as const,
    title: "Denuncia de bienestar cerrada",
    subtitle: "Resuelta por la autoridad",
    ctaUrl: `/denuncias/codigo/${r.referenceCode}`,
    since: r.closedAt ?? r.createdAt,
    severity: "info" as const,
    pet: null,
  }));
}

async function fetchResolvedAdoptionApplications(
  userId: string,
  limit: number,
): Promise<WorkflowDraft[]> {
  const rows = await db.execute<{
    application_id: string;
    pet_name: string;
    pet_public_token: string;
    pet_photo_path: string | null;
    viewer_holds: boolean;
    outcome: string;
    decided_at: string;
  }>(sql`
    SELECT
      s.id::text AS application_id,
      p.name AS pet_name,
      p.public_token AS pet_public_token,
      ph.storage_path AS pet_photo_path,
      ${viewerHoldsPetClause(userId, sql`p.id`)} AS viewer_holds,
      d.payload->>'outcome' AS outcome,
      d.recorded_at::text AS decided_at
    FROM pet_events s
    JOIN pets p ON p.id = s.pet_id
    LEFT JOIN attachments ph ON ph.id = p.primary_photo_id
    JOIN pet_events d
      ON d.pet_id = s.pet_id
     AND d.event_type = 'adoption_application_resolved'
     AND d.payload->>'application_event_id' = s.id::text
    WHERE s.event_type = 'adoption_application_submitted'
      AND s.payload->>'applicant_user_id' = ${userId}
    ORDER BY d.recorded_at DESC
    LIMIT ${limit}
  `);
  return rows.map((r) => ({
    id: `adoption_application_resolved:${r.application_id}`,
    kind: "adoption_application_resolved" as const,
    title: `Postulación para ${r.pet_name}`,
    subtitle: r.outcome === "approved" ? "Aprobada" : "No avanzó",
    ctaUrl: "/mis-mascotas/postulaciones",
    since: new Date(r.decided_at),
    severity: "info" as const,
    // A rejected applicant must never see the adopting family's photo of the
    // animal: only an applicant who now HOLDS the pet gets it on the row.
    pet:
      r.viewer_holds === true
        ? workflowPet(r.pet_public_token, r.pet_name, r.pet_photo_path)
        : null,
  }));
}

async function fetchDecidedApprovalRequests(
  userId: string,
  limit: number,
): Promise<WorkflowDraft[]> {
  const rows = await db
    .select({
      id: approvalRequests.id,
      publicToken: approvalRequests.publicToken,
      type: approvalRequests.type,
      status: approvalRequests.status,
      decidedAt: approvalRequests.decidedAt,
      createdAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.applicantUserId, userId), isNotNull(approvalRequests.decidedAt)))
    .orderBy(desc(approvalRequests.decidedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: `approval_request_decided:${r.id}`,
    kind: "approval_request_decided" as const,
    title: humanizeApprovalRequestType(r.type),
    // Was `Resuelta: ${r.status}` — same raw-enum leak as the foster row above.
    subtitle: requestOutcomeLabel(r.status) ?? "",
    // Same dead link as the pending twin above — see its note.
    ctaUrl: "/cuenta/solicitudes",
    since: r.decidedAt ?? r.createdAt,
    severity: "info" as const,
    pet: null,
  }));
}

export async function fetchPreviousWorkflows(userId: string, limit = 10): Promise<WorkflowItem[]> {
  const [foster, welfare, adoption, approval] = await Promise.all([
    fetchResolvedFosterProposals(userId, limit),
    fetchClosedWelfareReports(userId, limit),
    fetchResolvedAdoptionApplications(userId, limit),
    fetchDecidedApprovalRequests(userId, limit),
  ]);
  return [...foster, ...welfare, ...adoption, ...approval]
    .map(withTurn)
    .sort((a, b) => b.since.getTime() - a.since.getTime())
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function humanizeApprovalRequestType(type: string): string {
  switch (type) {
    case "role_upgrade_vet":
      return "Solicitud para verificar tu matrícula veterinaria";
    case "org_create":
      return "Solicitud de creación de organización";
    case "govt_assignment":
      return "Solicitud de asignación gubernamental";
    case "service_offering":
      return "Solicitud de servicio profesional";
    default:
      return `Solicitud de aprobación (${type})`;
  }
}
