// Shared, role-aware case-detail view. Rendered by BOTH the public route
// (app/(public)/casos/[publicCode]) and the govt operator route
// (app/gob/casos/[publicCode]) so a government operator opening a case from
// /gob/casos KEEPS the operator shell instead of being dropped into the
// citizen chrome. The two routes differ only in the surrounding layout —
// the content, the auth resolution and the canReadCase gate live here.
//
// The view is role-aware:
//   - admin / govt-in-scope / subject-owner / per-kind party (foster,
//     org member, applicant, dispute party) → full view with PII
//   - anonymous (no session) → redacted public view, only for the case
//     kinds in PUBLIC_ANONYMOUS_KINDS (bite_incident, lost_pet_episode,
//     adoption_listing). Other kinds 404 to avoid leaking existence.
//     welfare_denuncia left that set in legal/denuncias-despublicadas
//     (2026-08-17) — the anon branch below renders jurisdiction + openedReason,
//     which identifies the ACCUSED in an unverified crime allegation.
//
// Access is gated via canReadCase. Outside parties get notFound() (not
// 403) so case existence is never leaked. Mounting this under the /gob
// layout does NOT widen access — canReadCase still enforces the govt
// reader's (province, locality) scope.

import Link from "next/link";
import { notFound } from "next/navigation";

import { SponsorshipPossessionNotice } from "@/components/adoption/SponsorshipPossessionNotice";
import { CaseNotForCaretaker } from "@/components/casos/CaseNotForCaretaker";
import { CaseOperatorActions } from "@/components/casos/CaseOperatorActions";
import { RehomeRequestAnswerActions } from "@/components/casos/RehomeRequestAnswerActions";
import { caseEntryLabel } from "@/components/casos/case-entry-label";
import { casePetLink } from "@/components/casos/case-pet-link";
import { shouldRedactPetName } from "@/components/casos/pet-name-redaction";
import { StaticFirstMap } from "@/components/maps/StaticFirstMap";
import { LnEmptyState } from "@/components/ui/EmptyState";
import {
  CaseDetailShell,
  type CaseParty,
  type CaseSubjectDescriptor,
} from "@/components/ui/dashboard/CaseDetailShell";
import { db } from "@/db";
import { getNormativesForCase } from "@/lib/domain/case-normatives";
import { caseTimelineSummary } from "@/lib/events/events";
import { canReadCase, holdsActiveCaretakerRow } from "@/lib/infra/case-access";
import { getCaseDetailByPublicCode } from "@/lib/infra/case-queries";
import { getJurisdictionsCached, getProfileCached } from "@/lib/infra/request-cache";
import { petPhotoUrl } from "@/lib/infra/storage";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime, sexLabel, speciesLabel } from "@/lib/utils/format";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { availableCaseActions } from "@/src/modules/cases/domain/available-actions";
import { logPiiReadSafely } from "@/src/modules/organizations/application/admin-proposals/log-pii-query";
import {
  getActiveMemberships,
  getGrantedCapabilities,
} from "@/src/modules/organizations/infrastructure/authz-resolver";

interface CaseDetailViewProps {
  publicCode: string;
  /**
   * When set (operator context, e.g. "/gob/casos"), the "Casos" breadcrumb
   * links back to the operator case list and the citizen "Inicio → /" link is
   * omitted — an operator must never be handed a one-click path back into the
   * citizen shell. Defaults to the public breadcrumb.
   */
  casosHref?: string;
}

export async function CaseDetailView({ publicCode, casosHref }: CaseDetailViewProps) {
  const detail = await getCaseDetailByPublicCode(publicCode);
  if (!detail) notFound();

  // Resolve session (optional — anonymous viewers reach the public branch).
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let viewerRole: "owner" | "vet" | "govt" | "admin" | "national" | null = null;
  let viewerUserId: string | null = null;
  let jurisdictions: Array<{ province: string; locality: string }> = [];

  if (user) {
    const profile = await getProfileCached(user.id);
    if (profile) {
      viewerRole = profile.role;
      viewerUserId = profile.id;
      if (profile.role === "govt") {
        jurisdictions = await getJurisdictionsCached(profile.id);
      }
    }
  }

  const allowed = await canReadCase(
    detail,
    viewerUserId && viewerRole ? { userId: viewerUserId, role: viewerRole, jurisdictions } : null,
  );
  if (!allowed) {
    // custodia-temporal T9.11/T9.12 — the ONE denial that must not be a 404.
    //
    // Cases are titular-only in v1 (design F2): the subject-pet branch of
    // canReadCase requires `role='owner'`. A CARETAKER is denied by that rule
    // and yet sees the links — LostCaseBlock and the open-case badges render on
    // the pet they are looking after — so every one of them landed here and
    // 404'd. Telling the person currently caring for an animal that its case
    // does not exist is false, unrecoverable, and reads as a broken product.
    //
    // Case existence still never leaks: this branch requires a LIVE caretaker
    // ownership row on this exact pet. Everyone else keeps the 404.
    if (await holdsActiveCaretakerRow(detail.pet?.id, viewerUserId)) {
      return (
        <CaseNotForCaretaker
          petPublicToken={detail.pet?.publicToken ?? null}
          petName={detail.pet?.name ?? null}
        />
      );
    }
    notFound();
  }

  // Lote B3 — an AUTHORITY reading a case detail is a PII read and leaves a
  // pii_queried trail. Gated to admin/govt only: this same component renders
  // the public and owner views, which must never log self-views. Fail-soft.
  if ((viewerRole === "admin" || viewerRole === "govt") && viewerUserId) {
    await logPiiReadSafely(viewerUserId, publicCode, 1, "case_detail");
  }

  // Anonymous viewers see a redacted view: no opener/closer names, no
  // event notes, generic "Ver perfil público" pet link instead of the
  // authed `/mis-mascotas` deep link.
  const isPublic = viewerUserId === null;

  const petLink = isPublic
    ? detail.pet
      ? `/p/${detail.pet.publicToken}`
      : null
    : casePetLink(detail.pet?.publicToken, viewerRole ?? "owner");

  const photoUrl = detail.pet?.primaryPhotoStoragePath
    ? petPhotoUrl(detail.pet.primaryPhotoStoragePath)
    : null;

  const normatives = getNormativesForCase(detail.caseKind, {
    country: detail.jurisdictionCountry,
    province: detail.jurisdictionProvince ?? undefined,
    locality: detail.jurisdictionLocality ?? undefined,
  });

  // Build parties list for CaseDetailShell.
  const parties: CaseParty[] = [];
  if (detail.openedByUser) {
    parties.push({ role: "opener", name: detail.openedByUser.displayName });
  }
  if (detail.openedByOrganization) {
    parties.push({
      role: "organization",
      name: detail.openedByOrganization.displayName,
      orgPublicToken: detail.openedByOrganization.publicToken,
    });
  }
  // A rehome_request is ADDRESSED to its org (the titular opens it), so the
  // sponsoring org is a party the header must name — it is who the titular
  // is waiting on, and who the reader would otherwise have to infer from
  // the opened-reason prose.
  if (detail.caseKind === "rehome_request" && detail.receiverOrganization) {
    parties.push({
      role: "organization",
      name: detail.receiverOrganization.displayName,
      orgPublicToken: detail.receiverOrganization.publicToken,
    });
  }

  // rehome-by-titular, task 5.7: the receiver org's answer. Rendered only
  // while the request is open, only to an active member of THAT org holding
  // `adoption.listing.manage` (accepting IS publishing, so it is the same
  // capability the action enforces). A member without it never sees a
  // control the server would refuse — a boundary, not a wall.
  const rehomeAnswer = await resolveRehomeAnswer(detail, viewerUserId);
  // rehome-by-titular, REQ-11: an ACCEPTED request and the adoption_listing
  // it opened both read "custody" on the org's side; the animal is with its
  // family. Said on the case itself, for every viewer who can read it.
  const possession = await resolvePossessionDisclosure(detail);
  if (detail.closedByUser) {
    parties.push({ role: "closer", name: detail.closedByUser.displayName });
  }

  // BITE-NAME-HIDE (PO decision): on the ANONYMOUS public view of a cruelty/bite
  // case (Ley 14.346) the pet's proper NAME is redacted — species/sex/photo/
  // timeline/org stay. Lost-pet and adoption cases are unaffected (there the name
  // helps recovery/matching). An authed in-scope viewer always sees the name.
  const redactPetName = shouldRedactPetName(detail.caseKind, isPublic);

  // Build subject descriptor for CaseDetailShell.
  let subject: CaseSubjectDescriptor | null = null;
  if (detail.pet) {
    subject = {
      kind: "pet",
      petName: redactPetName ? null : detail.pet.name,
      petSpecies: `${speciesLabel(detail.pet.species)} · ${sexLabel(detail.pet.sex)}`,
      // When the name is redacted, also drop the deep link to the pet's public
      // credential page (which shows the name) so the redaction isn't one click away.
      petHref: redactPetName ? null : petLink,
      petPhotoUrl: photoUrl,
    };
  } else {
    subject = {
      kind:
        detail.primarySubjectKind === "unowned_animal"
          ? "unowned_animal"
          : detail.primarySubjectKind === "location"
            ? "location"
            : "general",
      locationLabel:
        detail.primarySubjectKind === "location"
          ? detail.jurisdictionLocality
            ? `${detail.jurisdictionLocality}, ${detail.jurisdictionProvince}`
            : undefined
          : undefined,
    };
  }

  // map-QOL P3: read-only static-first map for the case's primary location.
  // The coordinates were ALREADY in CaseDetail (no new query) but never
  // rendered. Privacy gate: institutional viewers only (govt/admin) — a
  // case's primary location can be a denounced address, so it is never
  // surfaced to anonymous, owner or vet viewers (data minimisation).
  // Dispute-safe finder tips (PO 2026-07-24): a "finder_tip" case entry is
  // written from the public credential of a custody-disputed pet FOR the
  // reviewing authority ONLY (report-dispute-tip.ts). The disputing parties
  // (subject owner, registered dispute parties) pass canReadCase for this
  // case kind, so the filter lives here: tips render — title, payload AND
  // notes — exclusively for govt/admin viewers. Everyone else must not even
  // learn a tip exists.
  const isAuthorityViewer = viewerRole === "govt" || viewerRole === "admin";
  const timelineEvents = detail.events.filter(
    (e) => e.eventType !== "finder_tip" || isAuthorityViewer,
  );

  const caseLat = detail.primaryLocationLat !== null ? Number(detail.primaryLocationLat) : null;
  const caseLng = detail.primaryLocationLng !== null ? Number(detail.primaryLocationLng) : null;
  const showCaseMap =
    isAuthorityViewer &&
    caseLat !== null &&
    caseLng !== null &&
    Number.isFinite(caseLat) &&
    Number.isFinite(caseLng);

  // Breadcrumb nav — operator context (casosHref set) links "Casos" back to
  // the operator queue and omits the citizen "Inicio" link entirely.
  const breadcrumb = (
    <nav className="font-ln-mono text-sm uppercase tracking-[.06em] text-ln-mute">
      {casosHref ? (
        <Link href={casosHref} className="hover:text-ln-ink-2 hover:underline">
          Casos
        </Link>
      ) : (
        <>
          <Link href="/" className="hover:text-ln-ink-2 hover:underline">
            Inicio
          </Link>
          <span className="mx-2">›</span>
          <span>Casos</span>
        </>
      )}
      <span className="mx-2">›</span>
      <span className="text-ln-ink-2">{detail.publicCode}</span>
    </nav>
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      {/* "Por qué es público" banner — only for anonymous viewers. */}
      {isPublic && <PublicTransparencyBanner caseKind={detail.caseKind} />}

      <CaseDetailShell
        publicCode={detail.publicCode}
        kind={detail.caseKind}
        status={detail.status}
        openedAt={detail.openedAt}
        closedAt={detail.closedAt}
        openedReason={detail.openedReason}
        openedReasonCode={detail.openedReasonCode}
        openedReasonParams={detail.openedReasonParams}
        jurisdictionCountry={detail.jurisdictionCountry}
        jurisdictionProvince={detail.jurisdictionProvince}
        jurisdictionLocality={detail.jurisdictionLocality}
        normatives={normatives}
        parties={parties}
        subject={subject}
        isPublic={isPublic}
        breadcrumb={breadcrumb}
      >
        {/* Acciones de operador (#41). Sólo gobierno y admin: asentar en un
            expediente o darlo por terminado es un acto de la autoridad, no
            algo que una membresía de organización pueda conferir. Las acciones
            concretas las decide el ciclo de vida del kind, no esta pantalla. */}
        {(viewerRole === "govt" || viewerRole === "admin") && (
          <CaseOperatorActions
            publicCode={detail.publicCode}
            actions={availableCaseActions(detail.caseKind, detail.status)}
          />
        )}

        {possession && (
          <SponsorshipPossessionNotice
            petName={possession.petName}
            orgDisplayName={possession.orgDisplayName}
            surface="ln"
          />
        )}

        {rehomeAnswer && detail.pet && (
          <RehomeRequestAnswerActions
            orgToken={rehomeAnswer.orgToken}
            casePublicCode={detail.publicCode}
            petName={detail.pet.name}
            orgDisplayName={rehomeAnswer.orgDisplayName}
          />
        )}

        {/* map-QOL P3: primary-location embed (institutional viewers only). */}
        {showCaseMap && (
          <section aria-label="Ubicación del caso">
            <h2 className="mb-3 font-ln-serif text-xl font-semibold tracking-[-0.01em] text-ln-ink">
              Ubicación
            </h2>
            <StaticFirstMap
              lat={caseLat as number}
              lng={caseLng as number}
              label={`Caso ${detail.publicCode}`}
              precision="exact"
              heightClassName="h-48"
            />
          </section>
        )}

        {/* Timeline */}
        <section>
          <h2 className="mb-3 font-ln-serif text-title font-semibold tracking-[-0.01em] text-ln-ink">
            Línea de tiempo
          </h2>
          {timelineEvents.length === 0 ? (
            <LnEmptyState icon="nota" title="Todavía no hay eventos registrados en este caso." />
          ) : (
            <ol className="space-y-3">
              {timelineEvents.map((e) => (
                <li
                  key={e.id}
                  className="rounded-[var(--radius-sm)] border border-ln-line bg-ln-card p-4"
                >
                  <div className="flex items-baseline justify-between">
                    <span className="text-md font-medium text-ln-ink">
                      {/* One reader for both sources: pet events keep the
                          libreta's label, case_events entries get theirs, and
                          a rehome close says WHO decided (REQ-5). */}
                      {caseEntryLabel(e.eventType, e.payload)}
                    </span>
                    <time className="font-ln-mono text-sm text-ln-mute">
                      {formatDateTime(e.occurredAt)}
                    </time>
                  </div>
                  {(() => {
                    // Anonymous viewers get the redacted summary: the owner's
                    // last-seen-location opt-in is honoured here exactly as the
                    // credential honours it, and complaint prose is withheld.
                    const summary = caseTimelineSummary(e.eventType, e.payload, {
                      isPublic,
                      discloseLastLocation: detail.pet?.discloseLastLocationWhenLost ?? false,
                    });
                    const text = [summary.primary, summary.secondary].filter(Boolean).join(" · ");
                    return text ? <p className="mt-1 text-md text-ln-mute">{text}</p> : null;
                  })()}
                  {/* Internal notes hidden for anon: they're free-form and
                      routinely contain PII (denouncer descriptions, internal
                      org coordination, addresses). */}
                  {!isPublic && e.notes ? (
                    <p className="mt-2 rounded-[var(--radius-sm)] bg-ln-stripe p-2 font-ln-mono text-sm text-ln-mute">
                      {e.notes}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </CaseDetailShell>
    </main>
  );
}

// ---------------------------------------------------------------------------
// resolveRehomeAnswer — may THIS viewer answer THIS rehome_request?
// ---------------------------------------------------------------------------

/**
 * Null unless the case is an OPEN rehome_request and the viewer is an active
 * member of its receiver org holding `adoption.listing.manage`. The action
 * (`respondToRehomeRequestAction`) enforces the same two facts through
 * `requireCapabilityForOrgToken` plus the in-transaction receiver check; this
 * is the half that decides whether the control is SHOWN.
 */
async function resolveRehomeAnswer(
  detail: {
    caseKind: string;
    status: string;
    receiverOrganization: { id: string; displayName: string; publicToken: string } | null;
  },
  viewerUserId: string | null,
): Promise<{ orgToken: string; orgDisplayName: string } | null> {
  if (detail.caseKind !== "rehome_request" || detail.status !== "open") return null;
  if (!detail.receiverOrganization || !viewerUserId) return null;
  const receiver = detail.receiverOrganization;
  const memberships = await getActiveMemberships(viewerUserId);
  const mine = memberships.find((m) => m.membership.organizationId === receiver.id);
  if (!mine) return null;
  const granted = await getGrantedCapabilities(mine.membership);
  if (!granted.has("adoption.listing.manage")) return null;
  return { orgToken: receiver.publicToken, orgDisplayName: receiver.displayName };
}

// ---------------------------------------------------------------------------
// resolvePossessionDisclosure — is THIS case about a sponsored pet?
// ---------------------------------------------------------------------------

/**
 * Non-null when the case is a `rehome_request` (addressed to its receiver org)
 * or an `adoption_listing` (opened by its org) and that org currently
 * sponsors the pet — decided on the spine, never on the ownership shape, and
 * checked against the case's own org so a listing by a DIFFERENT org on the
 * same pet never borrows the sentence.
 */
async function resolvePossessionDisclosure(detail: {
  caseKind: string;
  pet: { id: string; name: string } | null;
  receiverOrganization: { id: string; displayName: string } | null;
  openedByOrganization: { id: string; displayName: string } | null;
}): Promise<{ petName: string; orgDisplayName: string } | null> {
  if (!detail.pet) return null;
  const org =
    detail.caseKind === "rehome_request"
      ? detail.receiverOrganization
      : detail.caseKind === "adoption_listing"
        ? detail.openedByOrganization
        : null;
  if (!org) return null;
  const open = await findOpenSponsorship(detail.pet.id, db);
  if (!open || open.sponsoringOrganizationId !== org.id) return null;
  return { petName: detail.pet.name, orgDisplayName: org.displayName };
}

// ---------------------------------------------------------------------------
// PublicTransparencyBanner — explains why this case is publicly accessible.
// ---------------------------------------------------------------------------

function PublicTransparencyBanner({ caseKind }: { caseKind: string }) {
  const reasons: Record<string, string> = {
    bite_incident:
      "Los incidentes de mordedura son registros de interés sanitario público conforme a la legislación vigente. El seguimiento es visible para la comunidad para promover la seguridad.",
    lost_pet_episode:
      "Las alertas de mascotas perdidas son públicas para que cualquier persona que la encuentre pueda ayudar a devolverla a su familia.",
    adoption_listing:
      "Los procesos de adopción de refugios verificados son transparentes para facilitar el encuentro entre mascotas y familias.",
    // welfare_denuncia intentionally absent. Its copy used to read "las
    // denuncias de bienestar animal son públicas para que la comunidad pueda
    // hacer seguimiento" — a claim the product no longer makes and never should
    // have. canReadCase now 404s the kind for anon, so this branch is
    // unreachable; leaving the string here would be a stale promise waiting for
    // someone to re-add the kind to the allow-list on its authority.
  };

  const reason = reasons[caseKind];
  if (!reason) return null;

  return (
    <div
      role="note"
      className="mb-6 rounded-[var(--radius-sm)] border border-ln-celeste-100 px-4 py-3"
      style={{
        background: "var(--color-ln-celeste-050)",
        borderLeft: "3px solid var(--color-ln-azul)",
      }}
    >
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-azul mb-1">
        ¿Por qué es público?
      </p>
      <p className="text-md leading-[1.5] text-ln-ink-2">{reason}</p>
    </div>
  );
}
