// Adoption-application review detail (spec adoption-listing-public §11).
// Shows the applicant's full payload + identity + history pointers, and
// surfaces approve/reject controls via ReviewButtons (client).
//
// Gated on `adoption.review` for the org. notFound() if the application
// doesn't belong to a pet in shelter_custody of this org — same shape as
// queryAdoptionListing's organizationToken filter.

import { and, eq, isNull, sql } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { SponsorshipPossessionNotice } from "@/components/adoption/SponsorshipPossessionNotice";
import { OpBreach, OpCard, OpCardBody, OpCardHead } from "@/components/ui/dashboard";
import { auditLog, db, organizations, ownerships, petEvents, pets, profiles } from "@/db";
import { upcastPayload } from "@/lib/events/event-upcasters";
import { requireOrgAccessByToken } from "@/lib/infra/auth-guards";
import { requireUuidParam } from "@/lib/infra/route-params";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatDateTime } from "@/lib/utils/format";
import { isUuid } from "@/lib/utils/uuid";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { ReviewButtons } from "./ReviewButtons";

export const dynamic = "force-dynamic";

/**
 * The applicant's email, read from `auth.users` at render time.
 *
 * Not mirrored anywhere on purpose: `profiles` deliberately has no email column
 * (no PII duplication, and subject erasure has ONE place to happen), and the
 * append-only event payload is the last place it should live — an immutable
 * spine outlives the right to be forgotten.
 *
 * Best-effort by design: an auth hiccup degrades to "sin email registrado", it
 * never breaks a shelter's review screen.
 */
async function resolveApplicantEmail(applicantUserId: string | null): Promise<string | null> {
  if (!applicantUserId) return null;
  try {
    const { data } = await createAdminClient().auth.admin.getUserById(applicantUserId);
    return data?.user?.email ?? null;
  } catch {
    return null;
  }
}

export default async function AdoptionReviewDetailPage({
  params,
}: {
  params: Promise<{ orgToken: string; appEventId: string }>;
}) {
  const { orgToken, appEventId } = await params;
  // Nonexistent record must answer 404, not a 200 error boundary.
  requireUuidParam(appEventId);
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

  const [row] = await db
    .select({
      application: petEvents,
      pet: pets,
      org: organizations,
    })
    .from(petEvents)
    .innerJoin(pets, eq(pets.id, petEvents.petId))
    .innerJoin(ownerships, eq(ownerships.petId, pets.id))
    .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .where(
      and(
        eq(petEvents.id, appEventId),
        eq(petEvents.eventType, "adoption_application_submitted"),
        eq(ownerships.ownerOrganizationId, organization.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
        // Art. 16 (Ley 25.326): an erased pet's saved application link must
        // 404 — the sponsorship row survives the erasure, this filter is what
        // stops it from resolving the pet (same caller-side rule as the
        // mascotas list/ficha/CSV).
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);
  if (!row) notFound();
  const { application, pet } = row;

  // Upcast before consuming — v1 rows lack motivation/prior_pets; the upcaster
  // fills them with null so downstream rendering is always on the v2 shape.
  const payload = upcastPayload("adoption_application_submitted", application.payload) as {
    applicant_user_id: string;
    // Null once the applicant exercised art. 16 erasure (T3-A2b).
    housing_type: string | null;
    other_pets: string | null;
    daily_routine: string | null;
    notes: string | null;
    motivation: string | null;
    prior_pets: "yes_currently" | "yes_before" | "no" | null;
  };

  // Applicant identity. profiles.id may not be FK-backed via auth.users
  // (stub profiles exist) but for an actual application the submitter is
  // always a real auth user. Historic/seeded payloads can carry a non-uuid
  // applicant_user_id (e.g. external_user_404) — comparing that against the
  // uuid column aborts the query (22P02) and crashes the page, so guard the
  // lookup and fall back to the "(perfil no encontrado)" rendering.
  const applicantUserId = isUuid(payload.applicant_user_id) ? payload.applicant_user_id : null;
  const [applicant] = applicantUserId
    ? await db
        .select({
          id: profiles.id,
          displayName: profiles.displayName,
          phone: profiles.phone,
        })
        .from(profiles)
        .where(eq(profiles.id, applicantUserId))
        .limit(1)
    : [undefined];

  // The applicant's EMAIL (copy audit 2026-08-04, PO decision). Five strings
  // across the adoption flow tell the applicant the shelter will get in touch,
  // and this screen — the shelter's only view of them — showed Nombre and
  // Teléfono and nothing else. A phone-only channel does not honour "te
  // contactamos por email", so the promise was unkeepable from here.
  //
  // Read from `auth.users` at render time rather than mirrored anywhere: the
  // profiles table deliberately has no email column (no PII duplication, and
  // subject erasure has ONE place to happen), and the append-only event payload
  // is the last place it should live — an immutable spine outlives the right to
  // be forgotten. Same targeted `getUserById` pattern as
  // app/admin/admins/[userId]/page.tsx; one call per page load (ADR-8).
  //
  // Best-effort: an auth hiccup must degrade to "sin email registrado", never
  // break a shelter's review screen.
  const applicantEmail = await resolveApplicantEmail(applicantUserId);

  // PII access trail (V1-9). The org reviewer is now reading the applicant's
  // full identity (name, phone, EMAIL, housing). Record one audit row per page
  // view.
  // This is a server-component fetch, so it fires once per load — not on every
  // client re-render. Best-effort: a failed audit write must NOT block the
  // render (same posture as the best-effort notification inserts elsewhere).
  await recordAdopterPiiView({
    actorUserId: auth.user.id,
    organizationId: organization.id,
    applicationEventId: appEventId,
    applicantUserId: payload.applicant_user_id,
    petId: pet.id,
  });

  // Has this application already been resolved? If so we hide the action
  // controls and show the decision summary.
  const decision = await db.execute<{
    outcome: string;
    reviewer_user_id: string;
    notes: string | null;
    auto_generated: string | null;
    decided_at: string;
  }>(sql`
    SELECT payload->>'outcome' AS outcome,
           payload->>'reviewer_user_id' AS reviewer_user_id,
           payload->>'notes' AS notes,
           payload->>'auto_generated' AS auto_generated,
           recorded_at::text AS decided_at
    FROM pet_events
    WHERE pet_id = ${pet.id}
      AND event_type = 'adoption_application_resolved'
      AND payload->>'application_event_id' = ${appEventId}
    ORDER BY recorded_at DESC
    LIMIT 1
  `);
  const finalized = await db.execute<{ id: string }>(sql`
    SELECT id FROM pet_events
    WHERE pet_id = ${pet.id} AND event_type = 'adoption_finalized'
    LIMIT 1
  `);
  const alreadyResolved = decision.length > 0;
  const petAlreadyFinalized = finalized.length > 0;

  // rehome-by-titular, REQ-11: a reviewer who skipped the case and came
  // straight here must still read that the animal is with its family.
  const openSponsorship = await findOpenSponsorship(pet.id, db);
  const livesWithFamily = openSponsorship?.sponsoringOrganizationId === organization.id;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Link
        href={`/org/${orgToken}/adopciones`}
        className="text-sm text-ln-op-azul hover:underline"
      >
        ← Volver a postulaciones
      </Link>

      <header className="space-y-1">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-ln-op-mute">
          {organization.displayName}
        </p>
        <h1 className="text-title font-semibold text-ln-op-ink">Postulación para {pet.name}</h1>
        <p className="text-md text-ln-op-mute">
          {/* AR-pinned via formatDateTime (bug 4): the bare toLocaleString
              rendered the server's UTC clock ("Recibida 07:59:41") with no
              timezone cue for a ~17:00 ART submission. */}
          Recibida el {formatDateTime(application.recordedAt)}
        </p>
      </header>

      {livesWithFamily && (
        <SponsorshipPossessionNotice
          petName={pet.name}
          orgDisplayName={organization.displayName}
          surface="op"
        />
      )}

      <OpCard>
        <OpCardHead title="Postulante" />
        <OpCardBody>
          <dl className="space-y-2">
            <Row label="Nombre" value={applicant?.displayName ?? "(perfil no encontrado)"} />
            {/* Email always rendered, even when absent: its absence is
                information the reviewer needs — it tells them the only channel
                left is the phone. A row that silently disappears reads as "no
                email column here", not as "this person has none". */}
            <Row
              label="Email"
              value={
                applicantEmail ? (
                  <a
                    href={`mailto:${applicantEmail}`}
                    className="text-ln-op-azul underline underline-offset-2"
                  >
                    {applicantEmail}
                  </a>
                ) : (
                  "Sin email registrado"
                )
              }
            />
            {applicant?.phone && <Row label="Teléfono" value={applicant.phone} />}
            <Row label="Tipo de vivienda" value={housingTypeLabel(payload.housing_type)} />
          </dl>
        </OpCardBody>
      </OpCard>

      {(payload.motivation ||
        payload.prior_pets ||
        payload.other_pets ||
        payload.daily_routine ||
        payload.notes) && (
        <OpCard>
          <OpCardHead title="Lo que nos contó" />
          <OpCardBody>
            <div className="space-y-4">
              {payload.motivation && (
                <Block label="Por qué quiere adoptar" body={payload.motivation} />
              )}
              {payload.prior_pets && (
                <Block label="Experiencia con mascotas" body={priorPetsLabel(payload.prior_pets)} />
              )}
              {payload.other_pets && <Block label="Otras mascotas" body={payload.other_pets} />}
              {payload.daily_routine && <Block label="Día a día" body={payload.daily_routine} />}
              {payload.notes && <Block label="Notas" body={payload.notes} />}
            </div>
          </OpCardBody>
        </OpCard>
      )}

      {/* ALWAYS rendered, in this slot: the decision's receipt lives inside
          ReviewButtons and must survive the action's RSC refresh, which is the
          render that turns `alreadyResolved` true. See its header. */}
      <ReviewButtons
        orgToken={orgToken}
        applicationEventId={appEventId}
        applicantName={applicant?.displayName ?? "el postulante"}
        petName={pet.name}
        finalizeHref={`/org/${orgToken}/mascotas/${pet.publicToken}/adoption`}
        resolvedView={
          alreadyResolved ? (
            <DecisionSummary
              decision={decision[0]}
              petAlreadyFinalized={petAlreadyFinalized}
              finalizeHref={`/org/${orgToken}/mascotas/${pet.publicToken}/adoption`}
            />
          ) : petAlreadyFinalized ? (
            <OpBreach
              title={`${pet.name} ya fue adoptado/a`}
              detail="No se pueden revisar más postulaciones para esta mascota."
            />
          ) : null
        }
      />

      <p className="text-sm text-ln-op-mute">
        <Link
          href={`/org/${orgToken}/mascotas/${pet.publicToken}`}
          className="text-ln-op-azul hover:underline"
        >
          Ver ficha de {pet.name}
        </Link>
      </p>
    </div>
  );
}

// Writes the adopter_pii_viewed audit row. Best-effort: errors are captured
// and swallowed so a logging failure never blocks the reviewer from seeing the
// application. target_user_id = applicant (PII subject); target_organization_id
// = the reviewing org. Mirrors the pii_queried trail used for admin searches.
async function recordAdopterPiiView(args: {
  actorUserId: string;
  organizationId: string;
  applicationEventId: string;
  applicantUserId: string;
  petId: string;
}): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorUserId: args.actorUserId,
      action: "adopter_pii_viewed",
      // Historic payloads may carry a non-uuid applicant id; the uuid FK
      // column gets NULL then, and the raw value survives in the payload.
      targetUserId: isUuid(args.applicantUserId) ? args.applicantUserId : null,
      targetOrganizationId: args.organizationId,
      payload: {
        org_id: args.organizationId,
        application_event_id: args.applicationEventId,
        applicant_user_id: args.applicantUserId,
        pet_id: args.petId,
      },
    });
  } catch (e) {
    console.error("adopter_pii_viewed audit insert failed (page render continues)", e);
  }
}

// The resolved-application summary, extracted verbatim from the page body
// (the page sat at biome's cognitive-complexity ceiling; the REQ-11 notice
// above tipped it). Same markup, same S6-F03 finalize shortcut.
function DecisionSummary({
  decision,
  petAlreadyFinalized,
  finalizeHref,
}: {
  decision: {
    outcome: string;
    notes: string | null;
    auto_generated: string | null;
    decided_at: string;
  };
  petAlreadyFinalized: boolean;
  finalizeHref: string;
}) {
  return (
    <OpCard>
      <OpCardBody>
        <p className="text-md font-medium text-ln-op-ink">
          Esta postulación ya fue resuelta:{" "}
          {decision.outcome === "approved"
            ? "aprobada"
            : decision.auto_generated === "true"
              ? "cerrada automáticamente (otra adopción se finalizó)"
              : "rechazada"}
          .
        </p>
        <p className="text-sm text-ln-op-mute mt-1">
          {formatDateTime(decision.decided_at)}
          {decision.notes && ` · ${decision.notes}`}
        </p>

        {/* S6-F03. Aprobada la postulación, esta pantalla ofrecía como
            único camino "Ver ficha de X" — y finalizar la adopción vive
            DENTRO de esa ficha. Un operador que acaba de aprobar tenía que
            adivinar que la acción está en la mascota y no en la
            postulación que está mirando.
            Sólo cuando queda algo por hacer: si la mascota ya fue
            adoptada, el circuito está cerrado y el botón sería una promesa
            falsa. */}
        {decision.outcome === "approved" && !petAlreadyFinalized && (
          <p className="mt-3">
            <Link
              href={finalizeHref}
              className="inline-flex items-center rounded-[var(--radius-md)] bg-ln-op-azul px-3 py-1.5 text-md font-medium text-white no-underline transition-colors hover:bg-ln-op-azul-700"
            >
              Finalizar adopción →
            </Link>
          </p>
        )}
      </OpCardBody>
    </OpCard>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-sm text-ln-op-mute w-32">{label}</dt>
      <dd className="text-md text-ln-op-ink">{value}</dd>
    </div>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-ln-op-mute">{label}</p>
      <p className="text-md text-ln-op-ink-2 whitespace-pre-wrap">{body}</p>
    </div>
  );
}

function housingTypeLabel(value: string | null): string {
  if (value === null) return "Sin dato";
  switch (value) {
    case "casa_con_patio":
      return "Casa con patio";
    case "casa_sin_patio":
      return "Casa sin patio";
    case "departamento":
      return "Departamento";
    default:
      return "Otra";
  }
}

function priorPetsLabel(value: string): string {
  switch (value) {
    case "yes_currently":
      return "Sí, actualmente tiene mascotas";
    case "yes_before":
      return "Sí, tuvo antes";
    case "no":
      return "No, nunca tuvo";
    default:
      return value;
  }
}
