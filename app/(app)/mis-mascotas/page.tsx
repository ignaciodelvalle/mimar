// Mis Mascotas — the owner index + inbox (owner-ia-redesign P5).
//
// /inicio folded away (it now redirects into the most-urgent pet's credential),
// so this page carries the surfaces a per-pet swipe structurally cannot:
//   1. the cross-pet ROLLUP (decision 3 / inventory §9.1) — "is anything on
//      fire across all my pets?" — próximos vencimientos, al día, casos.
//   2. the INBOX (decision 4 / §9.2) — everything that is NOT (yet) your pet and
//      so has no credential to live on: open workflows (foster proposals,
//      denuncias, custody, approvals) AND their closed history, inbound
//      transfers, adoption postulaciones, plus the resume-application banner.
//   3. the per-pet INDEX — the LnRegRow credential rows (PO ronda 4 revert from
//      the P5 card grid back to list rows), with a real name search (§9.3) so
//      the 200-cap notice stops promising a buscador that never existed.
//   4. "En memoria" — deceased pets live HERE ONLY (decision 6), never in the
//      swipe.
//   5. reclamar — the claim-code entry.
//
// The vet role redirect and its ?as=owner escape hatch are preserved verbatim
// (inventory §8): a vet who also owns pets reaches their own pets only via
// ?as=owner; dropping it would send every vet to the owner index.

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ActionLinkCard } from "@/components/ActionLinkCard";
import { CasesWidget, adaptWorkflow } from "@/components/CasesWidget";
import { isTransitRole } from "@/components/PetCard.helpers";
import { LnBadge } from "@/components/ui/Badge";
import { LnButton } from "@/components/ui/Button";
import type { LnPetStatus } from "@/components/ui/Chip";
import { LnSectionHead } from "@/components/ui/DocElements";
import { LnEmptyState } from "@/components/ui/EmptyState";
import { LnRegRow, LnRegistry } from "@/components/ui/RegRow";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import {
  countOutgoingPendingTransfers,
  countPendingApplications,
  countPendingTransfers,
  fetchActiveReminders,
  fetchComplianceStatesForPets,
  fetchOpenWorkflows,
  fetchPreviousWorkflows,
} from "@/lib/analytics/owner-dashboard";
import { ownerPetCountLabel, splitOwnerPetCounts } from "@/lib/domain/owner-pet-counts";
import { petUrgencyRank } from "@/lib/domain/pet-urgency-rank";
import { splitProximosReminders } from "@/lib/domain/vaccine-reminder-state";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { getProfileCached } from "@/lib/infra/request-cache";
import { resolveVetLanding } from "@/lib/infra/role-landing";
import { petPhotoUrl } from "@/lib/infra/storage";
import { lnPetStatusFromCompliance } from "@/lib/projections/pet-compliance";
import { pluralizeEs, speciesLabel } from "@/lib/utils/format";
import { trimmedSearchParam } from "@/lib/utils/search-params";
import {
  OWNER_PET_LIST_LIMIT,
  listOwnerPets,
} from "@/src/modules/pets/application/read/list-owner-pets";

import { IntentApplyBanner } from "./_components/IntentApplyBanner";
import { OwnerRollupStrip } from "./_components/OwnerRollupStrip";
import { PetSearchInput } from "./_components/PetSearchInput";

/**
 * Maximum pet rows rendered on this page.
 *
 * Re-exported from the read door rather than re-declared: `GET /api/v1/me/pets`
 * caps at the same number and reports `truncated` against it, and two constants
 * that agree today are two constants. The reasoning for the cap itself lives
 * with the query it bounds (`OWNER_PET_LIST_LIMIT`).
 */
const MIS_MASCOTAS_LIMIT = OWNER_PET_LIST_LIMIT;

export default async function MisMascotasPage({
  searchParams,
}: {
  searchParams: Promise<{ reclamado?: string; as?: string; q?: string }>;
}) {
  const { supabase, user } = await requireUserOrRedirect();

  // getProfileCached is warmed by (app)/layout.tsx in the same render pass.
  const profile = await getProfileCached(user.id);
  const params = await searchParams;
  const claimedCount = params.reclamado ? Number.parseInt(params.reclamado, 10) : null;
  // Q1: a repeated ?q= makes Next hand back string[], not string — the
  // declared prop type says otherwise, so `.trim()` on it throws at runtime.
  const query = trimmedSearchParam(params.q) ?? "";

  // Vets land at their org portal (or /cuenta if they have no org yet).
  // They can still access their pet list via direct sub-paths or `?as=owner`.
  if (profile?.role === "vet" && params.as !== "owner") {
    redirect(await resolveVetLanding(user.id));
  }

  const { data: authData } = await supabase.auth.getUser();
  const userEmail = (authData?.user?.email ?? "").toLowerCase();

  // BOUNDED (2026-08-09 resilience pass). Seven aggregates on the page an owner
  // opens first, awaited bare: on a degraded pooler this hung with no error and
  // nothing in the logs — the same shape as the /gob outage, on the citizen
  // side, where nobody is watching a dashboard to notice.
  const load = await loadWithTimeout(
    Promise.all([
      // The scope predicate, the ESCAPE-clause name filter, the cap and the
      // matching COUNT all moved into listOwnerPets (WU-B): `GET /api/v1/me/pets`
      // answers the same question and must not carry a second copy of "which
      // pets are yours" — a second copy is how a native list eventually shows a
      // pet the web list does not. Display order is still re-derived by urgency
      // (sortedActivePets) below.
      listOwnerPets({ ownerUserId: user.id, query, limit: MIS_MASCOTAS_LIMIT }),
      countPendingApplications(user.id),
      countPendingTransfers(user.id, userEmail),
      countOutgoingPendingTransfers(user.id),
      fetchOpenWorkflows(user.id),
      fetchPreviousWorkflows(user.id),
      fetchActiveReminders(user.id),
    ]),
  );
  if (!load.ok) {
    // The CTA and the search box do NOT depend on `load` — the link is static
    // and `query` comes from searchParams, resolved above. Dropping them left
    // an owner whose list failed to load with a dead end, unable to do the one
    // thing that still works: register a pet. Same shell/degraded shape as
    // app/gob/censo/CensoScreen.tsx.
    return (
      <div className="mx-auto max-w-4xl px-8 py-7 pb-12">
        <div className="mb-6 flex items-start justify-between gap-4">
          <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Mis mascotas
          </h1>
          <LnButton href="/mis-mascotas/nueva" variant="primary" size="md">
            + Registrar mascota
          </LnButton>
        </div>
        <div className="mb-4">
          <Suspense fallback={null}>
            <PetSearchInput initialQuery={query} />
          </Suspense>
        </div>
        <AnalyticsLoadFallback
          reason={load.reason}
          correlationId={load.id}
          retryHref="/mis-mascotas"
        />
      </div>
    );
  }
  const [
    { rows: ownedPets, total: matchingTotal },
    pendingApplicationsCount,
    pendingTransfersCount,
    outgoingTransfersCount,
    openWorkflows,
    previousWorkflows,
    reminders,
  ] = load.value;

  // Split into active (ok/registered/lost/pregnant) and deceased.
  const activePets = ownedPets.filter(({ pet }) => pet.status !== "deceased");
  const deceasedPets = ownedPets.filter(({ pet }) => pet.status === "deceased");

  // Same compliance projection the pet-profile header + carousel derive — the
  // card chip must agree with the detail header (one pet, one status truth).
  // BOUNDED separately: it genuinely depends on activePets, so it cannot join
  // the batch above. Its budget is short and its failure is soft — an absent
  // compliance map falls through to statusForPet's existing no-compliance
  // branch (lost / pregnant / registered), which is the same thing a pet with
  // no compliance record already renders. Losing a freshness chip beats losing
  // the page.
  const complianceLoad = await loadWithTimeout(
    fetchComplianceStatesForPets(
      user.id,
      activePets.map(({ pet }) => pet.id),
    ),
    3_000,
  );
  const complianceByPet = complianceLoad.ok ? complianceLoad.value : new Map();

  // Single status mapper shared with the carousel + pet profile
  // (lnPetStatusFromCompliance). The no-compliance fallback mirrors the
  // carousel exactly (lost -> lost, pregnant -> pregnant, else registered).
  const statusForPet = (pet: (typeof activePets)[number]["pet"]): LnPetStatus => {
    const compliance = complianceByPet.get(pet.id);
    if (compliance) {
      return lnPetStatusFromCompliance(
        { status: pet.status, pregnancyStatus: pet.pregnancyStatus ?? null },
        compliance,
      );
    }
    if (pet.status === "lost") return "lost";
    if (pet.pregnancyStatus === "in_progress") return "pregnant";
    return "registered";
  };

  // Urgency ordering — the SAME rank the credential carousel and the profile
  // swipe use (lib/domain/pet-urgency-rank.ts): Perdido → En tratamiento →
  // Preñada → Por vencer → Al día.
  const sortedActivePets = [...activePets].sort(
    (a, b) => petUrgencyRank(statusForPet(a.pet)) - petUrgencyRank(statusForPet(b.pet)),
  );

  // Rollup (decision 3): próximos vencimientos + al día + casos. Vencimientos
  // and casos are household-wide (dedicated bounded fetchers); "al día" is over
  // the shown active pets — for the common 1-8 pet owner that IS the household,
  // and under a search it honestly reflects the matched subset.
  // D-11: the same reminders, split into the two states the per-pet landing
  // already distinguishes — vencida vs por vencer. Same classifier
  // (getReminderVariant, via splitProximosReminders), so the rollup and the
  // per-pet cards cannot disagree about which side a dose is on.
  const vencimientos = splitProximosReminders(reminders);
  const alDia = sortedActivePets.filter(({ pet }) => statusForPet(pet) === "ok").length;
  const openCases = openWorkflows.map(adaptWorkflow);
  const previousCases = previousWorkflows.map(adaptWorkflow);

  const isSearching = query.length > 0;
  const hasAnyOwned = matchingTotal > 0 || (!isSearching && ownedPets.length > 0);

  /* D.9 (2026-07-30): "Registrar" is now the ONE verb for this act on every
     surface, which turned the header CTA and the first-run empty state's CTA
     into the SAME three words twice on one screen, ~300px apart with only the
     search box between them. (The 2026-07-27 craft review already flagged the
     pair as "doble primario en el vacío"; identical wording removes the last
     excuse for it.) One has to cede, and it is the HEADER: the empty state's
     button is the one with the REASON attached — it sits directly under the
     sentence that says what registering GIVES you — and stripping the box's
     action would end the first-run screen on an explanation the owner cannot
     act on without scrolling back up. The header CTA returns the moment there
     is anything to list (including an owner whose only pets are in memoriam,
     whose empty state is deliberately absent). */
  const showFirstRunEmptyState = activePets.length === 0 && !isSearching && !hasAnyOwned;

  return (
    <div className="mx-auto max-w-4xl px-8 py-7 pb-12">
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="m-0 font-ln-serif text-4xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            Mis mascotas
          </h1>
          {/* custodia-temporal T9.9/T9.10 — the count SPLITS the moment a
              caretaker arrangement exists. Both this list and the count behind
              it join "any active ownership row, no role filter": right for the
              list (the animal must appear for whoever is caring for it), a lie
              for the total, which sits under a heading that says "Mis
              mascotas". Owners with no arrangement read exactly what they read
              before. */}
          <p className="mt-1.5 text-md text-[var(--color-ln-mute)]">
            {ownerPetCountLabel({
              ...splitOwnerPetCounts(activePets),
              deceasedCount: deceasedPets.length,
            })}
          </p>
        </div>
        {/* "Registrar" — the ONE verb for this act (D.8, ratified as D.9 and
            extended to every surface including the mobile tab bar). This said
            "Inscribir", the form's H1 said "Registrar" and its submit button
            said "Crear": three words for one thing, two of them on the same
            screen. The domain agrees with "registrar" (the event is
            pet_registered), so that is the one that stays.
            Hidden on the first-run screen — see showFirstRunEmptyState. */}
        {!showFirstRunEmptyState && (
          <LnButton href="/mis-mascotas/nueva" variant="primary" size="md">
            + Registrar mascota
          </LnButton>
        )}
      </div>

      {/* Claimed pets banner */}
      {claimedCount !== null && (
        <p className="mb-4 rounded-[var(--radius-sm)] border border-[var(--color-ln-ok)] bg-[var(--color-ln-ok-050)] px-3.5 py-2.5 text-sm text-[var(--color-ln-ok)]">
          {claimedCount > 0
            ? `Reclamaste ${claimedCount} ${pluralizeEs(claimedCount, "mascota")} ${pluralizeEs(claimedCount, "adoptada")} a tu cuenta.`
            : "Vinculamos tu DNI a tu cuenta. Si esperabas una adopción, pedile al refugio que verifique el DNI cargado."}
        </p>
      )}

      {/* Resume-application banner — for a pet you don't own yet (§9.2). */}
      <IntentApplyBanner />

      {/* ------------------------------------------------------------------ */}
      {/* Cross-pet rollup (decision 3, §9.1) — the "is anything on fire?"     */}
      {/* glance the swipe cannot give. Only when the owner has active pets.   */}
      {/* ------------------------------------------------------------------ */}
      {activePets.length > 0 && (
        <OwnerRollupStrip
          vencidas={vencimientos.vencidas}
          porVencer={vencimientos.porVencer}
          alDia={alDia}
          totalPets={activePets.length}
          casosAbiertos={openWorkflows.length}
        />
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Index — search + per-pet credential cards                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="mb-4">
        <Suspense fallback={null}>
          <PetSearchInput initialQuery={query} />
        </Suspense>
      </div>

      {/* Scale guard notice — shown only when the (matching) list is capped. */}
      {ownedPets.length < matchingTotal && (
        <p className="mb-3.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] px-3.5 py-2.5 text-sm text-[var(--color-ln-azul)]">
          Mostrando {ownedPets.length} de {matchingTotal} mascotas. Afiná la búsqueda por nombre o
          accedé directamente desde la chapita o QR de cada mascota.
        </p>
      )}

      {activePets.length === 0 ? (
        isSearching ? (
          deceasedPets.length > 0 ? (
            // The search matched ONLY deceased pets — the In memoriam section
            // below shows them, so a bare "Sin resultados" would lie. Point the
            // owner at the matches instead of contradicting them.
            <LnEmptyState
              variant="dashed"
              title={`Sin resultados entre tus mascotas activas para "${query}".`}
              description="Hay coincidencias en In memoriam, más abajo."
            />
          ) : (
            <LnEmptyState
              variant="dashed"
              title={`Sin resultados para "${query}".`}
              description="Probá con otro nombre."
            />
          )
        ) : hasAnyOwned ? // Owner has only deceased pets — the In memoriam section below carries
        // them; don't show a "no pets" box that contradicts it.
        null : (
          /* D.8 (2026-07-30): this box used to restate the absence and then ask
             for the act ("…para verla acá") without ever saying what the act
             GIVES you — circular. The credential is the product, and the first
             screen a pets-less owner sees is where it has to be named. Sober
             and literal on purpose: only what the pet actually gets, no
             promise of the physical chapita (that channel is gated per
             jurisdiction). Guarded by owner-process-clarity-19.test.ts.
             This branch is exactly showFirstRunEmptyState, which is why the
             header CTA above is suppressed while it renders: with D.9 both
             buttons say "Registrar mascota", and this is the copy of the pair
             that carries the reason. */
          <LnEmptyState
            variant="dashed"
            title="Todavía no registraste ninguna mascota."
            description="Al registrarla obtiene su credencial digital: una página pública con código QR que cualquiera puede verificar desde el celular. Es lo que ve quien la encuentre si alguna vez se pierde."
            action={
              <LnButton href="/mis-mascotas/nueva" variant="primary" size="sm">
                Registrar mascota
              </LnButton>
            }
          />
        )
      ) : (
        // List rows (PO ronda 4): the pet index reverts from cards to the
        // original registry list. Each live pet is one LnRegRow linking into its
        // credential; the index+inbox structure, search, memorial and rollup
        // (all P5 additions) stay — only the live-pet presentation reverts.
        <LnRegistry className="mb-8">
          {sortedActivePets.map(({ pet, photo, ownershipRole }) => {
            const status = statusForPet(pet);
            const breedLine = [
              pet.breed,
              pet.sex ? (pet.sex === "male" ? "Macho" : "Hembra") : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <LnRegRow
                key={pet.id}
                name={pet.name}
                status={status}
                sex={pet.sex}
                breed={breedLine || undefined}
                species={speciesLabel(pet.species)}
                photoSrc={petPhotoUrl(photo?.storagePath) ?? undefined}
                photoSize={72}
                href={`/mis-mascotas/${pet.publicToken}`}
                nextLine={
                  // Two DIFFERENT arrangements, two different badges. A
                  // caretaker row used to render with none at all, which is how
                  // somebody else's animal ended up sitting unmarked in the
                  // middle of your own list.
                  ownershipRole === "caretaker" ? (
                    <LnBadge variant="info">Al cuidado</LnBadge>
                  ) : isTransitRole(ownershipRole) ? (
                    <LnBadge variant="warning">En tránsito</LnBadge>
                  ) : undefined
                }
              />
            );
          })}
        </LnRegistry>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* In memoriam (decision 6) — deceased pets live HERE ONLY.             */}
      {/* ------------------------------------------------------------------ */}
      {deceasedPets.length > 0 && (
        <div className="mb-8">
          <LnSectionHead
            num="†"
            title="In memoriam"
            meta={`${deceasedPets.length} ${pluralizeEs(deceasedPets.length, "recordada")}`}
          />
          <div className="overflow-hidden rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-ln-paper">
            {deceasedPets.map(({ pet, photo }) => (
              <MemorialRow
                key={pet.id}
                name={pet.name}
                breed={pet.breed ?? undefined}
                href={`/mis-mascotas/${pet.publicToken}`}
                photoSrc={petPhotoUrl(photo?.storagePath) ?? undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* ================================================================== */}
      {/* Bandeja — the inbox for everything that isn't (yet) your pet (§9.2). */}
      {/* Anchor target for /cuenta/casos' redirect (/mis-mascotas#inbox).    */}
      {/* ================================================================== */}
      <section id="inbox" className="mt-8 scroll-mt-24">
        <LnSectionHead num="01" title="Bandeja" className="mb-4" />

        <div className="flex flex-col gap-5">
          {/* Open workflows — foster proposals, denuncias, custody, approvals.
              Self-empties with an explanatory line. */}
          <CasesWidget cases={openCases} title="Casos abiertos" />

          {/* Inbound transfers + adoption postulaciones — both about pets you
              do not own yet. hideWhenZero keeps transfers quiet at zero. */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <ActionLinkCard
              href="/mis-mascotas/postulaciones"
              icon="corazon"
              title="Mis postulaciones"
              description="Adopciones a las que te postulaste"
              badge={pendingApplicationsCount > 0 ? pendingApplicationsCount : null}
            />
            {/* C.2 — the card hides only when there is nothing in EITHER
                direction. It used to hide on the incoming count alone, which
                orphaned the route for a user who had SENT a transfer and had no
                incoming ones: /transferencias has carried an "Enviadas" section
                since UX 3.1, so the page had a live pending proposal on it and
                the IA had no way to reach it.
                The badge still counts INCOMING only — that is what needs the
                user to act. An outgoing proposal is waiting on someone else, so
                it earns the link but not a call to action. The description now
                names both directions so the card does not promise only one. */}
            <ActionLinkCard
              href="/transferencias"
              icon="transferencia"
              title="Transferencias pendientes"
              description="Mascotas que alguien quiere transferirte, y las que enviaste"
              badge={pendingTransfersCount > 0 ? pendingTransfersCount : null}
              hideWhenZero={pendingTransfersCount === 0 && outgoingTransfersCount === 0}
            />
          </div>

          {/* Closed-cases history — restored here (it lived on the removed
              /cuenta/casos via fetchPreviousWorkflows; P1 knowingly orphaned
              it until this inbox landed). Only when there is history. */}
          {previousCases.length > 0 && (
            <CasesWidget
              cases={previousCases}
              title="Historial"
              emptyText="Sin casos anteriores."
            />
          )}

          {/* Denunciar maltrato — about someone else's animal, so it can never
              live on your own credential (§9.2). The /inicio entry point lands
              here. */}
          <Link
            href="/denuncias/nueva"
            className="text-sm text-[var(--color-ln-azul)] no-underline hover:underline"
          >
            + Denunciar maltrato animal
          </Link>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Reclamar una mascota — routes to the existing ClaimWizard.           */}
      {/* ------------------------------------------------------------------ */}
      <section className="mt-8">
        <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4">
          <h2 className="m-0 font-ln-serif text-lg font-semibold leading-tight text-[var(--color-ln-ink)]">
            Reclamar una mascota
          </h2>
          <p className="mt-1 text-md text-[var(--color-ln-mute)]">
            Tu mascota ya tiene chapita o microchip registrado. Ingresá el código de transferencia
            para reclamarla a tu cuenta.
          </p>
          <div className="mt-3">
            <LnButton href="/mis-mascotas/reclamar" variant="primary" size="md">
              Reclamar con un código
            </LnButton>
          </div>
          <p className="mt-2 text-sm text-[var(--color-ln-faint)]">
            El titular actual debe confirmar la transferencia.
          </p>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MemorialRow({
  name,
  breed,
  href,
  photoSrc,
}: {
  name: string;
  breed?: string;
  href: string;
  photoSrc?: string;
}) {
  return (
    <a
      href={href}
      className="grid items-center gap-4 border-b border-[var(--color-ln-line-2)] px-5 py-4 text-inherit no-underline last:border-b-0 hover:bg-ln-stripe"
      style={{ gridTemplateColumns: "72px 1fr auto" }}
    >
      {/* Sepia photo */}
      <div
        className="relative h-[64px] w-[64px] flex-shrink-0 overflow-hidden rounded-full border border-[var(--color-ln-line-strong)]"
        style={{ filter: "grayscale(1) sepia(0.25) opacity(0.85)" }}
      >
        {photoSrc ? (
          <Image src={photoSrc} alt={name} fill sizes="64px" className="object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[repeating-linear-gradient(135deg,var(--pattern-no-photo-a)_0_6px,var(--pattern-no-photo-b)_6px_12px)]">
            <span className="font-ln-mono text-[7px] uppercase tracking-[.04em] text-[var(--color-ln-mute)]">
              foto
            </span>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="min-w-0">
        <span className="font-ln-serif text-lg font-semibold leading-tight tracking-[-0.01em] text-[var(--color-ln-memorial-sepia)]">
          {name}
        </span>
        {breed && <p className="mt-0.5 text-sm text-[var(--color-ln-mute)]">{breed}</p>}
      </div>

      {/* Right */}
      <div className="flex items-center gap-1.5 font-ln-mono text-sm whitespace-nowrap text-[var(--color-ln-mute)]">
        <span>Ver memorial</span>
        <span aria-hidden="true">›</span>
      </div>
    </a>
  );
}
