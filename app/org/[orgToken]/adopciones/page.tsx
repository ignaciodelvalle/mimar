// Adoption-applications review surface — queue index (UX audit 1.3 adopciones).
//
// Migrated from a plain grouped list to a selectable queue with:
//   - Filter chips (pendientes / aprobadas / rechazadas) via ?status= param.
//   - Age/SLA badge per row (days pending; warning past ADOPTION_SLA_WARNING_DAYS).
//   - Bulk approve / reject via OpBulkBar (shift-click range select supported).
//   - Partial-failure surfacing with a shared bulkActionId for audit traceability.
//
// The detail page at /{appEventId} remains the single-item canonical path;
// this queue is an additive faster path for batch decisions.
//
// Gated on `adoption.review`. The server component fetches applications filtered
// by status (default: pending). Client-side selection + bulk actions live in
// AdoptionQueueList.

import { sql } from "drizzle-orm";
import Link from "next/link";

import { AdoptionQueueList } from "@/components/AdoptionQueueList";
import type { AdoptionQueueRow, AdoptionQueueStatus } from "@/components/AdoptionQueueList";
import { SponsorshipPossessionNotice } from "@/components/adoption/SponsorshipPossessionNotice";
import { db } from "@/db";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { safePayloadUuid } from "@/lib/infra/sql-fragments";
import { listOpenSponsorshipPetIds } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// DB row shapes per status
// ---------------------------------------------------------------------------

type PendingRow = {
  application_id: string;
  pet_id: string;
  pet_name: string;
  pet_public_token: string;
  applicant_user_id: string;
  applicant_name: string | null;
  // Null once the applicant exercised art. 16 erasure (T3-A2b).
  housing_type: string | null;
  submitted_at: string;
  info_requested: boolean;
};

type ResolvedRow = {
  application_id: string;
  pet_id: string;
  pet_name: string;
  pet_public_token: string;
  applicant_name: string | null;
  housing_type: string | null;
  submitted_at: string;
  outcome: string;
  decided_at: string;
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AdoptionReviewIndexPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgToken: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const { orgToken } = await params;
  const { status: statusParam } = await searchParams;

  const { organization: orgFromToken } = await requireOrgAccessByToken(orgToken);
  // A page READ: a deactivated institutional account keeps it, per
  // lib/infra/auth-guards.ts:60-70 — reads stay open, writes stop.
  const auth = await requireCapability("adoption.review", orgFromToken.id, { access: "read" });

  if (auth.error !== null) {
    return (
      <div className="max-w-2xl mx-auto space-y-4">
        <h1 className="text-title font-semibold text-ln-op-ink">Sin acceso</h1>
        <p className="text-md text-ln-op-ink-2">{auth.error}</p>
        <Link href={`/org/${orgToken}`} className="text-sm text-ln-op-azul hover:underline">
          ← Volver al panel
        </Link>
      </div>
    );
  }

  const { organization } = auth;

  // Resolve active status filter. Default to "pending".
  const activeStatus: AdoptionQueueStatus =
    statusParam === "approved" ? "approved" : statusParam === "rejected" ? "rejected" : "pending";

  // ---------------------------------------------------------------------------
  // Fetch rows by status
  // ---------------------------------------------------------------------------

  let rows: AdoptionQueueRow[] = [];
  // The pet behind each row, for the possession disclosure below (REQ-11).
  let petsByRow: Array<{ petId: string; petName: string }> = [];
  // UX 3.6 (d): fetch one extra row past the cap to detect truncation, so the
  // list can tell the operator there are more results instead of silently
  // cutting off at 200.
  let truncated = false;

  if (activeStatus === "pending") {
    // Pending: submitted with no posterior resolution and pet not yet finalized.
    const dbRows = await db.execute<PendingRow>(sql`
      SELECT
        s.id::text AS application_id,
        p.id::text AS pet_id,
        p.name AS pet_name,
        p.public_token AS pet_public_token,
        s.payload->>'applicant_user_id' AS applicant_user_id,
        pr.display_name AS applicant_name,
        s.payload->>'housing_type' AS housing_type,
        s.recorded_at::text AS submitted_at,
        EXISTS (
          SELECT 1 FROM pet_events n
          WHERE n.pet_id = s.pet_id
            AND n.event_type = 'note_added'
            AND n.payload->>'kind' = 'adoption_info_requested'
            AND n.payload->>'application_event_id' = s.id::text
        ) AS info_requested
      FROM pet_events s
      JOIN pets p ON p.id = s.pet_id
        -- Art. 16: the sponsorship row survives an erasure; the pet must not.
        AND p.deleted_at IS NULL
      JOIN ownerships o ON o.pet_id = p.id
        AND o.role = 'shelter_custody'
        AND o.ended_at IS NULL
        AND o.owner_organization_id = ${organization.id}
      LEFT JOIN profiles pr ON pr.id = ${safePayloadUuid(sql`s.payload->>'applicant_user_id'`)}
      WHERE s.event_type = 'adoption_application_submitted'
        AND NOT EXISTS (
          SELECT 1 FROM pet_events d
          WHERE d.pet_id = s.pet_id
            AND d.event_type = 'adoption_application_resolved'
            AND d.payload->>'application_event_id' = s.id::text
        )
        AND NOT EXISTS (
          SELECT 1 FROM pet_events f
          WHERE f.pet_id = s.pet_id AND f.event_type = 'adoption_finalized'
        )
      ORDER BY s.recorded_at ASC
      LIMIT 201
    `);

    truncated = dbRows.length > 200;
    const pageRows = dbRows.slice(0, 200);
    petsByRow = pageRows.map((r) => ({ petId: r.pet_id, petName: r.pet_name }));
    rows = pageRows.map((r) => ({
      applicationEventId: r.application_id,
      petName: r.pet_name,
      petPublicToken: r.pet_public_token,
      applicantName: r.applicant_name,
      housingType: r.housing_type,
      submittedAt: r.submitted_at,
      infoRequested: r.info_requested,
      livesWithFamily: false,
    }));
  } else {
    // Approved / rejected: find resolved applications belonging to this org.
    const outcome = activeStatus === "approved" ? "approved" : "rejected";

    const dbRows = await db.execute<ResolvedRow>(sql`
      SELECT
        s.id::text AS application_id,
        p.id::text AS pet_id,
        p.name AS pet_name,
        p.public_token AS pet_public_token,
        pr.display_name AS applicant_name,
        s.payload->>'housing_type' AS housing_type,
        s.recorded_at::text AS submitted_at,
        res.payload->>'outcome' AS outcome,
        res.recorded_at::text AS decided_at
      FROM pet_events s
      JOIN pets p ON p.id = s.pet_id
        -- Art. 16: same filter as the pending tab above.
        AND p.deleted_at IS NULL
      JOIN ownerships o ON o.pet_id = p.id
        AND o.role = 'shelter_custody'
        AND o.owner_organization_id = ${organization.id}
      LEFT JOIN profiles pr ON pr.id = ${safePayloadUuid(sql`s.payload->>'applicant_user_id'`)}
      JOIN pet_events res ON res.pet_id = s.pet_id
        AND res.event_type = 'adoption_application_resolved'
        AND res.payload->>'application_event_id' = s.id::text
        AND res.payload->>'outcome' = ${outcome}
        AND res.payload->>'auto_generated' IS DISTINCT FROM 'true'
      WHERE s.event_type = 'adoption_application_submitted'
      ORDER BY res.recorded_at DESC
      LIMIT 201
    `);

    // For resolved views we show read-only rows (no bulk actions).
    // submittedAt is used for the age badge (days to decision).
    truncated = dbRows.length > 200;
    const pageRows = dbRows.slice(0, 200);
    petsByRow = pageRows.map((r) => ({ petId: r.pet_id, petName: r.pet_name }));
    rows = pageRows.map((r) => ({
      applicationEventId: r.application_id,
      petName: r.pet_name,
      petPublicToken: r.pet_public_token,
      applicantName: r.applicant_name,
      housingType: r.housing_type,
      submittedAt: r.submitted_at,
      infoRequested: false,
      livesWithFamily: false,
    }));
  }

  // rehome-by-titular, REQ-11: which of these pets live with their family
  // while this org runs the evaluation — on the spine, one query per page.
  // Each such row says so, and the page leads with one notice per pet.
  const sponsoredPetIds = await listOpenSponsorshipPetIds(
    petsByRow.map((p) => p.petId),
    db,
  );
  rows = rows.map((row, i) => ({
    ...row,
    livesWithFamily: sponsoredPetIds.has(petsByRow[i].petId),
  }));
  const sponsoredPets = [
    ...new Map(
      petsByRow.filter((p) => sponsoredPetIds.has(p.petId)).map((p) => [p.petId, p]),
    ).values(),
  ];

  return (
    <div className="space-y-6">
      {/* Page header */}
      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Postulaciones</h1>
        <p className="text-md text-ln-op-mute">
          Revisá, aprobá o rechazá postulaciones de adopción. Podés seleccionar varias para
          procesarlas en lote.
        </p>
      </header>

      {sponsoredPets.map((p) => (
        <SponsorshipPossessionNotice
          key={p.petId}
          petName={p.petName}
          orgDisplayName={organization.displayName}
          surface="op"
        />
      ))}

      {/* Queue — filter chips + row list (incl. its own empty state) + bulk bar
          live here. AdoptionQueueList renders the chips and a single dashed
          empty block for every status, so the page must NOT add a second one. */}
      <AdoptionQueueList rows={rows} orgToken={orgToken} activeStatus={activeStatus} />
      {truncated && (
        <p className="text-sm text-ln-op-mute">
          Mostrando las primeras 200. Hay más — refiná los filtros para acotar la lista.
        </p>
      )}

      <footer className="pt-4 border-t border-ln-op-line">
        <Link href={`/org/${orgToken}`} className="text-sm text-ln-op-azul hover:underline">
          ← Panel de {organization.displayName}
        </Link>
      </footer>
    </div>
  );
}
