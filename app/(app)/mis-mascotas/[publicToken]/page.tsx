import { ownerPetDetailPorts } from "@/app/_composition/owner-pet-detail-ports";
import { PetOpenCasesSection } from "@/components/PetOpenCasesSection";
import { PregnancyInProgressCard } from "@/components/PregnancyInProgressCard";
import { CaretakerBanner } from "@/components/pet-profile/CaretakerBanner";
import { CredentialFace } from "@/components/pet-profile/CredentialFace";
import {
  LibretaFace,
  type LibretaFaceEmergencyContacts,
} from "@/components/pet-profile/LibretaFace";
import { LostCaseBlock } from "@/components/pet-profile/LostCaseBlock";
import { PetActionRow } from "@/components/pet-profile/PetActionRow";
import { type PetAlert, PetAlertStrip } from "@/components/pet-profile/PetAlertStrip";
import { PetCredentialCarousel } from "@/components/pet-profile/PetCredentialCarousel";
import {
  PetDetailTabsPanel,
  TabErrorState,
  TabLoadingSkeleton,
} from "@/components/pet-profile/PetDetailTabsPanel";
import {
  RabiesObservationBanner,
  RehomeSponsorshipBanner,
  TransitBanner,
} from "@/components/pet-profile/PetProfileBanners";
import {
  type AvatarSwitcherPet,
  PetSwitcherAvatars,
} from "@/components/pet-profile/PetSwitcherAvatars";
import { PppExportAffordance } from "@/components/pet-profile/PppExportAffordance";
import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { AnalyticsLoadFallback } from "@/components/ui/dashboard/AnalyticsLoadFallback";
import { db } from "@/db";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { resolveEmergencyContacts } from "@/lib/domain/emergency-contacts";
import { type CarouselPet, shouldShowCarousel } from "@/lib/domain/owner-carousel";
import { buildFromLostRedirectTarget, resolvePetFace } from "@/lib/domain/pet-face-nav";
import { pppExportAvailability } from "@/lib/domain/ppp-export-eligibility";
import { isPetAdoptedByUser } from "@/lib/infra/adoption-checkin";
import {
  type PetAccessSuccess,
  getFormerOwnerReadAccess,
  requirePetAccess,
} from "@/lib/infra/pet-access";
import { resolvePhysicalCredentialChannels } from "@/lib/infra/physical-credential-channels";
import { getPhysicalTagInterest } from "@/lib/infra/physical-tag-interest";
import { SERVICE_TYPE_LABELS, buildPresentarHref } from "@/lib/infra/service-dog-labels";
import { credentialQrUrl } from "@/lib/infra/site-url";
import {
  deriveFirstStepsChecklist,
  hasReviewedDisclosurePrefs,
} from "@/lib/projections/first-steps-checklist";
import { ageFromDateOfBirth, sexLabel, speciesLabel } from "@/lib/utils/format";
import { canStartPregnancy } from "@/src/modules/pets/application/pregnancy/pregnancy-eligibility";
import {
  type OwnerPetAlertId,
  loadOwnerPetDetail,
} from "@/src/modules/pets/application/read/load-owner-pet-detail";
import { getLibretaFaceData } from "@/src/modules/pets/application/tab-data/get-libreta-face-data";
import { fetchPendingReturnProposalForOwner } from "@/src/modules/return-to-owner/application/proposal-queries";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { SheetMounter } from "./SheetMounter";
import { resolveCaptureIntentUrl } from "./anotar/handoff";

// ---------------------------------------------------------------------------
// Pet-state standardization (PO 2026-07-16): the masthead band (chromeSituation
// below) is the single state authority on this page. The old page-local
// derivePetState/derivePetStateLabel helpers (a third, unused state mapping)
// were removed — derivePetSituation (lib/ui/pet-situation.ts) is the one
// derivation every surface reads. (The transitional "Ciclos abiertos" dedup
// filter died with the under-card PetOwnerActivity block — tarjeta-todo.)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Libreta face (Face 2) — server-rendered (perf audit 2026-07-19, PF3)
// ---------------------------------------------------------------------------
//
// Wrapped in its own <Suspense> below (see `documentNode`) so it streams
// independently of the eager, SSR'd Face 1 (CredentialFace never waits on
// this). Calls the tab-data use-case DIRECTLY with the access this page
// already resolved via requirePetAccess — no re-auth, and no client-trusted
// token crosses the wire. This replaces the old client mount-effect in
// PetDetailTabsPanel that called the `getLibretaFaceData` SERVER ACTION on
// every profile load: that action re-ran requirePetAccess's full auth +
// pet-access chain (a second getUser() + ownership query) for data the page
// had already authorized in the SAME request — wasted backend work on every
// view, not critical-path latency (the credential card paints without
// waiting for this).
async function LibretaFaceSection({
  user,
  pet,
  accessPath,
  organization,
  isOwner,
  emergencyContacts,
}: {
  user: PetAccessSuccess["user"];
  pet: PetAccessSuccess["pet"];
  accessPath: PetAccessSuccess["accessPath"];
  organization: PetAccessSuccess["organization"];
  isOwner: boolean;
  emergencyContacts: LibretaFaceEmergencyContacts | null;
}) {
  const result = await getLibretaFaceData({ user, pet, accessPath, organization });
  if (!result.ok) return <TabErrorState message={result.error} />;
  return (
    <div className="op-fade-in">
      <LibretaFace
        data={result.data}
        petPublicToken={pet.publicToken}
        isOwner={isOwner}
        emergencyContacts={emergencyContacts}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function PetDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ publicToken: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { publicToken } = await params;
  const sp = await searchParams;
  const tabParam = typeof sp.tab === "string" ? sp.tab : undefined;
  const lenteParam = typeof sp.lente === "string" ? sp.lente : undefined;

  // REQ-6.3 (pet-document-redesign): the D9 `?fromLost=1` bypass has no
  // target anymore — LostCockpit is gone and the normal profile always
  // renders for lost pets (REQ-5.1). Redirect to the plain profile URL
  // (fromLost stripped, every other param preserved) so old deep links /
  // bookmarks don't retain a dead param or error.
  const fromLostRedirectTarget = buildFromLostRedirectTarget(publicToken, sp);
  if (fromLostRedirectTarget) {
    redirect(fromLostRedirectTarget);
  }

  // Auth chain (external audit 2026-07): an expired/absent session must NOT
  // render a 404 — it must bounce to /login carrying returnTo so the visitor
  // lands back on this pet after signing in. requirePetAccess exposes a
  // structural `reason` so we branch WITHOUT string-matching the error message:
  //   - "no-session"            → redirect to login (returnTo = this pet's path)
  //   - "not-found-or-forbidden" → notFound() (unchanged — no information leak;
  //       covers no-such-pet, out-of-scope, and erased accounts alike)
  // NOTE on the split-brain race (documented): middleware swallows a stale
  // refresh-token AuthApiError and continues, and the (app) layout's
  // requireUserOrRedirect runs a SECOND concurrent getUser() that can race this
  // page's getUser() and rotate the refresh token — the loser gets null. That
  // race is supabase-ssr behavior and is NOT fixed here; this branch only makes
  // its worst case a login-with-returnTo instead of a bare 404.
  const access = await requirePetAccess(publicToken);
  if (!access.ok) {
    if (access.reason === "no-session") {
      redirect(`/iniciar-sesion?returnTo=${encodeURIComponent(`/mis-mascotas/${publicToken}`)}`);
    }
    // Former-owner READ-ONLY fallback (PO decision 2026-07-18): a session
    // that resolved but has no write-side access might still be the
    // IMMEDIATE former owner of a pet currently under an open custody
    // episode (decomiso) — "el ex-dueño conserva lectura durante el
    // proceso." That grant is read-only and lives entirely outside
    // requirePetAccess's write boundary; see getFormerOwnerReadAccess in
    // lib/infra/pet-access.ts for the derivation and why it can never leak
    // write capability (no write-side call site reaches it).
    if (access.user) {
      const formerOwnerAccess = await getFormerOwnerReadAccess(publicToken, access.user.id);
      if (formerOwnerAccess.ok) {
        return (
          <FormerOwnerCustodyReadOnlyView
            pet={formerOwnerAccess.pet}
            casePublicCode={formerOwnerAccess.custodyCase.publicCode}
          />
        );
      }
    }
    notFound();
  }
  const { user, pet, accessPath, organization, holderRole } = access;

  const isOwner = accessPath === "owner";

  // No-flash capture routing (code review 2026-07-03): when a deep link /
  // notification or home deeplink lands on `?sheet=anotar` carrying a
  // resolvable intent (a known `kind`, or free text the deterministic matcher
  // recognizes), resolve it HERE and redirect server-side — before any render.
  // The old client-side ResolvedCaptureRedirect wasted a full profile render
  // and used router.replace on the cross-route hop, inheriting the Next 15.5
  // silent-drop defect that lib/ui/sheet-nav.ts exists to route around. Only
  // owners capture (REQ-4.4) and never for a deceased pet (REQ-9.3); an
  // unresolvable `?sheet=anotar` falls through to SheetMounter's sheet.
  if (sp.sheet === "anotar" && isOwner && pet.status !== "deceased") {
    const captureText = typeof sp.text === "string" ? sp.text : undefined;
    // QA A9 viewer gate for the free-text branch: the matcher can resolve
    // "check-in" to post_adoption_checkin, whose page 404s for anyone but the
    // registered adopter. One indexed read, only on this rare deep-link shape,
    // so the server-side no-flash redirect can't send a non-adopter into the
    // 404 (adversarial review 2026-08-14). The batched read further down
    // feeds the sheet catalog; this one has to exist BEFORE the redirect.
    const checkinAllowed = captureText?.trim() ? await isPetAdoptedByUser(pet.id, user.id) : false;
    const captureTarget = resolveCaptureIntentUrl(
      publicToken,
      {
        kind: typeof sp.kind === "string" ? sp.kind : undefined,
        text: captureText,
      },
      { showCheckinOption: checkinAllowed },
    );
    if (captureTarget) redirect(captureTarget);
  }

  // Two-face redesign (2026-07-01): resolvePetFace is the single pure mapper
  // for every legacy ?tab= deep link (see lib/domain/pet-face-nav.ts). Org
  // viewers get the same clamp behavior as before, now expressed as a lens
  // clamp (Libreta is reachable, `todo` is not) instead of hiding the face.
  const { face: activeFace } = resolvePetFace({
    tab: tabParam,
    lente: lenteParam,
    isOwner,
  });

  // Deceased (pet-document-redesign ADR-15): NO early return anymore — the
  // pet always renders the SAME document with an In-Memoriam skin (see
  // `memorial` below, threaded into CredentialFace). The old heavy O(N)
  // deceasedEvents + attachment-signing query is gone too: the Libreta back
  // (deferred fetch, "todo" lens = no filtering) already returns the pet's
  // full history including death_recorded, subsuming the old parallel
  // LnMemorialTimeline.
  const isDeceased = pet.status === "deceased";

  // THE OWNER FACE, read in one place (owner-parity WU-I).
  //
  // What used to live here — a five-query Stage 1, a nine-read Promise.all, an
  // owner-only Stage 2 and the carousel, interleaved with the JSX that renders
  // them — is now `loadOwnerPetDetail`, which the native endpoint
  // `GET /api/v1/pets/{publicToken}` calls too. That is the point: the web face
  // and the native face are the same face because they are the same read. What
  // stays on this page is the RENDER, plus the handful of reads only a WRITE
  // affordance needs (the sheets below).
  //
  // THE DEADLINE STAYS AT THIS CALL SITE, not inside the reader. This page
  // degrades to AnalyticsLoadFallback; the route answers 503 with a retry-after.
  // A timeout baked into the reader would have made one of those two callers
  // wrong, silently.
  const profileLoad = await loadWithTimeout(
    // `holderRole` comes from the guard, which RANKS a viewer's ownership rows.
    // The reader used to re-query it unordered, so a titular who is also
    // caretaker of the same animal resolved at random — see
    // `OwnerPetDetailInput.holderRole`.
    loadOwnerPetDetail({ user: { id: user.id }, pet, accessPath, holderRole }, ownerPetDetailPorts),
  );
  if (!profileLoad.ok) {
    // Degraded profile. `pet` came from requirePetAccess, before any of this
    // ran, so the owner still gets the name they navigated for and a way back
    // — instead of a spinner that never resolves.
    return (
      <div className="mx-auto max-w-2xl px-6 py-10 space-y-4">
        <Link href="/mis-mascotas" className="text-sm text-ln-azul hover:underline">
          ← Mis mascotas
        </Link>
        <h1 className="m-0 font-ln-serif text-3xl font-semibold text-ln-ink">{pet.name}</h1>
        <AnalyticsLoadFallback
          reason={profileLoad.reason}
          correlationId={profileLoad.id}
          retryHref={`/mis-mascotas/${pet.publicToken}`}
        />
      </div>
    );
  }
  const detail = profileLoad.value;
  const {
    ownershipRole,
    isTransit,
    typedEvents,
    canonicalIds,
    viewerContacts,
    caretakerState,
    caretakerConsentName,
    rehomeState,
    ownerFirstName,
    serviceDog: serviceDogRow,
    pppBreedRule,
  } = detail;
  const complianceState = detail.compliance;
  const petActiveReminders = detail.reminders;
  const { lostEpisode, lostScans, alertsOriginShelter } = detail.lost;
  // Both photoUrl and editPhotoUrl come from the same single read.
  const photoUrl = detail.identity.photoUrl;
  const editPhotoUrl = photoUrl;

  // Stage 2: the reads that exist ONLY to prime a write affordance — the sheets
  // this page mounts. They are deliberately NOT in the reader: the native face
  // is read-only, and an endpoint that loaded the chapita-interest row to serve
  // a GET would be paying for a button it does not render.
  // hasPendingReturnProposal depends on ownershipRole (must be "owner").
  let hasPendingReturnProposal = false;
  // Chapita (physical-tag-interest) state for the owner — powers the 5th
  // action-bar icon + ?sheet=chapita (pet-document-redesign ADR-17b). Never
  // fetched for a deceased pet (REQ-9.3 suppresses the entry point).
  let chapitaData: { interested: boolean; requestedAt: Date | null } | null = null;
  // Physical credential channel availability for the pet's jurisdiction
  // (admin-rules-console ADR-5/R3.5) — which channels (printable QR, engraved
  // plate, NFC) are configured for this jurisdiction, resolved via the same
  // cascade tiers as other rule types. Rendered inside the chapita sheet.
  let physicalCredentialChannels: Awaited<
    ReturnType<typeof resolvePhysicalCredentialChannels>
  > | null = null;
  // QA A9 — gates the "Check-in post-adopción" entry in the anotar catalog
  // (SheetMounter → CaptureOptionsList). Same predicate the check-in page
  // 404s on; false for org viewers (anotar is owner-only anyway).
  let showCheckinOption = false;

  // Gates the "Registrar embarazo" entry in the same anotar catalog. Unlike the
  // check-in above this is a pure read of the `pets` row already in hand — no
  // query, so no reason to compute it inside the owner branch. See
  // canStartPregnancy for why the null arms are strict here and permissive on
  // the phone.
  const showPregnancyStartOption = canStartPregnancy(pet);

  if (accessPath === "owner") {
    // "Confirmar devolución": only the legal owner, only when a pending return
    // proposal exists. Reuses the same ARCH-B tri-check as /devolucion.
    const returnProposalQuery =
      ownershipRole === "owner"
        ? fetchPendingReturnProposalForOwner(pet.id, user.id, db)
        : Promise.resolve(false);

    const chapitaQuery = isDeceased
      ? Promise.resolve(null)
      : getPhysicalTagInterest(pet.id, user.id);

    const physicalCredentialChannelsQuery = isDeceased
      ? Promise.resolve(null)
      : resolvePhysicalCredentialChannels({
          country: "AR",
          province: pet.jurisdictionProvince ?? null,
          locality: pet.jurisdictionLocality ?? null,
        });

    // Deceased pets never mount the anotar sheet (REQ-9.3), so skip the read.
    const adoptedQuery = isDeceased ? Promise.resolve(false) : isPetAdoptedByUser(pet.id, user.id);

    const [returnProposalResult, chapitaState, channels, adoptedByViewer] = await Promise.all([
      returnProposalQuery,
      chapitaQuery,
      physicalCredentialChannelsQuery,
      adoptedQuery,
    ]);

    hasPendingReturnProposal = returnProposalResult;
    chapitaData = chapitaState;
    physicalCredentialChannels = channels;
    showCheckinOption = adoptedByViewer;
  }

  const pregnancyCardData = detail.pregnancy;

  // tarjeta-todo (PO 2026-07-18): the under-card PetOwnerActivity block
  // (nudges / RemindersSection / Próximos turnos / Ciclos abiertos) was
  // DELETED — the rotating card is the whole profile. Its unique actions
  // moved INTO the card: reminder "Posponer 7 días"/"Registrar" live on the
  // libreta face's PRÓXIMO rows (FutureLedgerList), turnos already render
  // there ("Ver turno"), and open cases keep their one authoritative surface
  // in the Avisos strip (PetOpenCasesSection). The chip_missing nudge CTA
  // duplicated the Cumplimiento card; the scan-activity signal's outside
  // surface dies per PO (the libreta remains the one place scans surface).

  // The hero's composed subtitle, its chips, the memorial skin and the ring
  // status all come from the reader now. Two of them carry a rule worth
  // restating at the call site, because both were REGRESSIONS once:
  //   · the "chip" tag is derived from the compliance projection, never from
  //     mere microchip presence, so the hero cannot say "Microchip verificado"
  //     over a card that correctly says "Declarada · sin verificar";
  //   · lnPetStatusFromCompliance is the SINGLE mapper shared with /inicio and
  //     /mis-mascotas, so this header chip and every row chip always agree.
  const heroTags = detail.identity.tags;
  const breedLine = detail.identity.breedLine;
  const memorial = detail.memorial;
  const lnPetStatus = detail.ringStatus;

  // Prioritized alert strip (urgency-ordered): lost → rabies → transit →
  // open-cases → pregnancy. Built once so CredentialFace only grows an "Avisos"
  // section when it is genuinely non-empty (no empty divider). Same ordering
  // and same nodes as before the "Una sola libreta" redesign — now hosted
  // INSIDE the credential sheet instead of stacked below it.
  // WHICH alerts fire, in WHAT order, is the reader's decision — made once and
  // shared with the native face, because an ordering that only this page could
  // demonstrate is an ordering nobody can check. What stays here is the NODE
  // each one renders: a strip of React is not something an API can serve.
  const alertNodes: Record<OwnerPetAlertId, () => PetAlert["node"]> = {
    lost: () => (
      <LostCaseBlock
        pet={pet}
        photoUrl={photoUrl}
        episode={lostEpisode}
        scans={lostScans}
        ownerFirstName={ownerFirstName}
        alertsOriginShelter={alertsOriginShelter}
        isOwner={isOwner}
        // The LEGAL owner only. A caretaker keeps the rest of this block —
        // including "Marcar como encontrada" — but the disclosure toggles
        // govern the TITULAR's own name, phone and location.
        canManageDisclosure={ownershipRole === "owner"}
        caretakerConsentName={caretakerConsentName}
      />
    ),
    // D1 (PO 2026-08-23): the owner has no in-product way to lift an observation
    // opened in error, so the banner must at least name who opened it.
    rabies: () => (
      <RabiesObservationBanner
        pet={pet}
        events={typedEvents}
        openedByOrgName={detail.observationOpenedByOrgName}
      />
    ),
    // "Convertir en mi mascota" / "Buscar nuevo hogar" are org-mediated foster
    // actions — a vecino-helps-stray shelter_custody row has no org link, so
    // those CTAs would dead-end for it. The vecino still gets the banner text
    // and badge, just not actions that assume an org relationship.
    transit: () => (
      <TransitBanner
        petName={pet.name}
        petPublicToken={pet.publicToken}
        canManageFosterActions={ownershipRole === "foster"}
      />
    ),
    caretaker: () =>
      caretakerState ? (
        <CaretakerBanner
          petName={pet.name}
          petPublicToken={pet.publicToken}
          state={caretakerState}
        />
      ) : null,
    rehome: () =>
      rehomeState && rehomeState.kind !== "none" ? (
        <RehomeSponsorshipBanner
          petName={pet.name}
          petPublicToken={pet.publicToken}
          state={{ kind: rehomeState.kind, orgDisplayName: rehomeState.orgDisplayName }}
        />
      ) : null,
    "open-cases": () => (
      <div data-section="cases">
        <PetOpenCasesSection petId={pet.id} />
      </div>
    ),
    pregnancy: () =>
      pregnancyCardData ? (
        <PregnancyInProgressCard
          petPublicToken={pet.publicToken}
          pregnancyStartedAt={pregnancyCardData.startedAt}
          weeksAtDiagnosis={pregnancyCardData.weeksAtDiagnosis}
          expectedBirthAt={pregnancyCardData.expectedBirthAt}
          lastClinicalAt={pregnancyCardData.lastClinicalAt}
        />
      ) : null,
  };
  const petAlerts: PetAlert[] = detail.alerts.map((a) => ({
    id: a.id,
    tone: a.tone,
    node: alertNodes[a.id](),
  }));

  // The credential adopts the situation's skin only for a non-default,
  // non-deceased situation; a deceased animal keeps the memorial skin and the
  // two never stack. The masthead band is the documented exception — see the
  // reader, which owns both derivations.
  const credentialSituation = detail.situation;
  const chromeSituation = detail.chromeSituation;

  // RUPPPA export (L-11): the LEGAL owner of a pet flagged potentially
  // dangerous gets the button on the PPP card (CABA) or a plain note saying
  // why not (elsewhere). Everyone else — a vet, a shelter, a foster — gets
  // nothing. Not on a memorial: a deceased dog is registered nowhere.
  const pppAvailability = memorial
    ? null
    : pppExportAvailability({
        isLegalOwner: isOwner && ownershipRole === "owner",
        potentiallyDangerousBreed: pet.potentiallyDangerousBreed ?? null,
        jurisdictionProvince: pet.jurisdictionProvince ?? null,
      });
  const pppExportSlot = pppAvailability ? (
    <PppExportAffordance petPublicToken={pet.publicToken} availability={pppAvailability} />
  ) : null;

  // owner-ia-redesign P4 — the credential carousel ("the heart"). The profile
  // SWIPES between the owner's LIVE pets, urgent-first, deceased NEVER in the
  // swipe. Owner-only: org/admin/public/vet viewers of the same route get no
  // chrome (shouldShowCarousel gates on isOwner).
  const carouselPets: CarouselPet[] = detail.carousel.items.map((p) => ({
    token: p.token,
    status: p.status,
  }));
  // Avatar switcher (PO "reemplazo total" of the dots): the ranked/capped set
  // enriched with each pet's name + photo.
  const avatarPets: AvatarSwitcherPet[] = detail.carousel.items.map((p) => ({
    token: p.token,
    status: p.status,
    name: p.name,
    photoUrl: p.photoUrl,
  }));
  // D2: the TRUE number of live pets across the household. The swipe is capped,
  // but /mis-mascotas lists every live pet, so the two silently disagreed (8
  // dots vs 14 in the index). The carousel shows an honest "Mostrando N de M".
  const liveTotal = detail.carousel.total;
  const showCarousel = shouldShowCarousel({
    isOwner,
    tokens: carouselPets.map((p) => p.token),
    currentToken: pet.publicToken,
  });

  // owner-ia-redesign P2: pet-level override with account fallback. Resolution
  // is pure (lib/domain/emergency-contacts.ts) — the pet's own columns win per
  // row, else the owner's profile default shows (tagged "de tu cuenta" in the
  // block). Non-owners get null (no block), and so do foster/transit holders —
  // legal owners only (M2 fresh-review required fix 2). Hoisted (used by both
  // the emergencyContacts prop below AND the "Primeros pasos" checklist).
  const resolvedEmergencyContacts =
    isOwner && ownershipRole === "owner"
      ? resolveEmergencyContacts(
          {
            preferredVetName: pet.preferredVetName,
            preferredVetPhone: pet.preferredVetPhone,
            emergencyContactName: pet.emergencyContactName,
            emergencyContactPhone: pet.emergencyContactPhone,
          },
          {
            preferredVetName: viewerContacts?.preferredVetName ?? null,
            preferredVetPhone: viewerContacts?.preferredVetPhone ?? null,
            emergencyContactName: viewerContacts?.emergencyContactName ?? null,
            emergencyContactPhone: viewerContacts?.emergencyContactPhone ?? null,
          },
        )
      : null;

  // "Primeros pasos" owner-onboarding checklist (lib/projections/
  // first-steps-checklist.ts) — legal owner only, never for a deceased pet (a
  // closed life record has no onboarding left to do). Empty array on every
  // other viewer/state renders no section (CredentialFace's `firstSteps.length
  // > 0` gate).
  const firstSteps =
    isOwner && ownershipRole === "owner" && !isDeceased
      ? deriveFirstStepsChecklist({
          petPublicToken: pet.publicToken,
          hasPhoto: Boolean(pet.primaryPhotoId),
          hasMicrochip: canonicalIds.microchip !== null,
          hasVaccineRecorded: typedEvents.some((e) => e.eventType === "vaccination_administered"),
          hasEmergencyContact: resolvedEmergencyContacts?.emergency !== null,
          disclosurePrefsDecided: hasReviewedDisclosurePrefs(pet),
          dismissedKeys: pet.dismissedFirstSteps,
        })
      : [];

  // Libreta face (Face 2) — server-rendered, streamed via its OWN Suspense
  // boundary so it never blocks Face 1's SSR paint (PF3 perf fix — see
  // LibretaFaceSection above).
  // `op-fade-in` on the STREAMED child, not on the page body: Face 1 has
  // already SSR-painted by the time this flushes, so the fade lands on a
  // section arriving into a stable shell — the one shape the motion audit
  // sanctions (§5.7 forbids it on a route body, where it would delay first
  // legible text). Same placement as the 19 uses on /admin/sistema.
  const libretaContent = (
    // degraded-states: fallback escalates to waiting text / degraded card if
    // the stream stalls (pure CSS — components/ui/DegradedFallback.tsx).
    <Suspense
      fallback={
        <DegradedFallback>
          <TabLoadingSkeleton />
        </DegradedFallback>
      }
    >
      <LibretaFaceSection
        user={user}
        pet={pet}
        accessPath={accessPath}
        organization={organization}
        isOwner={isOwner}
        emergencyContacts={resolvedEmergencyContacts}
      />
    </Suspense>
  );

  // The credential document — server-rendered per route. A swipe/key/dot is a
  // NAVIGATION to the neighbor's route, not a client pane slide, so this same
  // node renders whether or not the carousel gesture shell wraps it.
  const documentNode = (
    // degraded-states: same escalation as libretaContent above.
    <Suspense
      fallback={
        <DegradedFallback>
          <div className="h-12 rounded-[var(--radius-sm)] bg-[var(--color-ln-stripe)] animate-pulse" />
        </DegradedFallback>
      }
    >
      <PetDetailTabsPanel
        petPublicToken={pet.publicToken}
        initialFace={activeFace}
        isOwner={isOwner}
        situation={chromeSituation}
        libretaContent={libretaContent}
        credencialContent={
          // The whole front face is ONE framed sheet ("Una sola libreta"):
          // identity → Cumplimiento → Avisos → Anotar → action row, bound by
          // labeled hairline dividers inside CredentialFace. H1 provenance
          // gates the stamp row. Deceased (ADR-15/REQ-9.3): `anotar` is null
          // (a closed life record accepts no new events) and `actions`
          // collapses to [Compartir][Más]; org viewers get the same read-only
          // object with a null `anotar`.
          <CredentialFace
            heroProps={{
              name: pet.name,
              status: lnPetStatus,
              breed: breedLine,
              photoSrc: photoUrl ?? undefined,
              // Empty-state shortcut: with no photo, the 132px placeholder is
              // the tap target that opens the edit sheet already mounted on
              // this page — same form, same file input, same action. Gated on
              // isOwner because this page also renders for a vet or a shelter
              // reading the credential, and they cannot save it.
              addPhotoHref: isOwner
                ? `/mis-mascotas/${pet.publicToken}?sheet=editar-mascota`
                : undefined,
              tags: heroTags,
            }}
            complianceState={complianceState}
            // The QR is no longer encoded here: CredentialFace hands this
            // absolute URL to <CredentialQr>, which draws the code in the
            // browser (native-readiness Track 2 — the QR is a pure function of
            // a cached string, so it survives an offline load).
            credentialUrl={credentialQrUrl(pet.publicToken)}
            publicHref={`/p/${pet.publicToken}`}
            serviceDog={
              serviceDogRow &&
              serviceDogRow.credentialStatus === "vigente" &&
              serviceDogRow.inService
                ? {
                    serviceTypeLabel:
                      SERVICE_TYPE_LABELS[serviceDogRow.serviceType] ?? serviceDogRow.serviceType,
                    manageHref: `/mis-mascotas/${pet.publicToken}/asistencia`,
                    presentHref: buildPresentarHref(pet.publicToken),
                  }
                : null
            }
            petPublicToken={pet.publicToken}
            petSex={pet.sex}
            pppExport={pppExportSlot}
            memorial={memorial}
            situation={credentialSituation}
            avisos={petAlerts.length > 0 ? <PetAlertStrip alerts={petAlerts} /> : null}
            firstSteps={firstSteps}
            // 3b improvement C — the embedded mid-face capture textarea was
            // REMOVED to declutter the front. Capture now lives in the fixed
            // "Asentar un hecho" bar (CitizenTabBar, mobile — task #9) and, as
            // a pet-specific one-tap shortcut on every breakpoint, in the
            // PetActionRow "Anotar" quiet link below (opens ?sheet=anotar for
            // THIS pet). No `anotar` node is passed, so CredentialFace's inline
            // "Anotar" section stays dormant (owners still write while lost —
            // the /anotar sheet is gated on owner + not-deceased, unchanged).
            actions={
              <PetActionRow
                petPublicToken={pet.publicToken}
                isOwner={isOwner}
                isDeceased={isDeceased}
                petStatus={pet.status as "active" | "lost" | "deceased"}
              />
            }
          />
        }
      />
    </Suspense>
  );

  return (
    <div
      className="mx-auto max-w-4xl pb-12 px-4 md:px-8"
      style={{ fontFamily: "var(--font-ln-sans)" }}
    >
      {/* Back link — ORG viewers only. For owners the global AppShell nav
          already carries "Mis mascotas", so a second page-level "← Mis
          mascotas" right under it read as confusing duplication (PO). Org
          viewers need it because "Animales en custodia" is a distinct
          destination the global nav doesn't cover. */}
      {accessPath === "org" && organization && (
        <Link
          href={`/org/${organization.publicToken}/mascotas`}
          className="mb-[18px] mt-4 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-mute)] no-underline hover:text-[var(--color-ln-ink-2)]"
          data-section="back-link"
        >
          ← Animales en custodia
        </Link>
      )}

      {/* Org-mediated access notice */}
      {accessPath === "org" && organization && (
        <div className="mb-3.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-celeste-100)] bg-[var(--color-ln-celeste-050)] px-3.5 py-2.5 text-md text-[var(--color-ln-ink-2)]">
          Estás viendo {pet.name} como miembro de <strong>{organization.displayName}</strong>.
          Cualquier evento que registres queda atribuido a la organización.
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Two-face tabs: Credencial (eager) · Libreta (deferred). Face 1     */}
      {/* owns identity/credential + avisos + capture, per the new AGENTS.md */}
      {/* rule 5 block order (design.md ADR-1/ADR-6).                        */}
      {/*                                                                    */}
      {/* owner-ia-redesign P4 — when the owner has more than one live pet,   */}
      {/* the document is wrapped by the INVISIBLE carousel gesture shell     */}
      {/* (constrained swipe + keyboard + prefetch). Non-owner viewers, and   */}
      {/* owners with a single live pet, get the bare document (no shell).    */}
      {/*                                                                    */}
      {/* PO correction (2026-07-18, reversing tarjeta-todo's dots-in-band    */}
      {/* placement): "El carousel lo quiero FUERA de la credencial. No       */}
      {/* tiene nada que ver la navegación en la app con la credencial        */}
      {/* digital de una mascota." The credential is ONE pet's document;      */}
      {/* switching between pets is APP-LEVEL navigation, a different layer   */}
      {/* — PetSwitcherDots mounts here, ABOVE the card, never touching the   */}
      {/* credential's frame/band. Same gate as the swipe shell (owner + >1   */}
      {/* live pet); single-pet owners and non-owners get no nav element.     */}
      {/* ------------------------------------------------------------------ */}
      {showCarousel && (
        <PetSwitcherAvatars
          pets={avatarPets}
          currentToken={pet.publicToken}
          liveTotal={liveTotal}
        />
      )}
      {showCarousel ? (
        <PetCredentialCarousel pets={carouselPets} currentToken={pet.publicToken}>
          {documentNode}
        </PetCredentialCarousel>
      ) : (
        documentNode
      )}

      {/* Quick-capture sheets — driven by ?sheet=<id> URL param.
            Renders nothing when the param is absent or unknown.
            Lives outside PetDetailTabsPanel so it's always mounted. */}
      <SheetMounter
        petToken={pet.publicToken}
        petName={pet.name}
        petSex={pet.sex}
        species={pet.species}
        petStatus={pet.status as "active" | "lost" | "deceased"}
        accessPath={accessPath === "org" ? "org" : "owner"}
        ownershipRole={ownershipRole}
        hasPendingReturnProposal={hasPendingReturnProposal}
        tier2PublicEnabledUntil={
          pet.tier2PublicEnabledUntil ? new Date(pet.tier2PublicEnabledUntil).toISOString() : null
        }
        tier2PublicPermanent={pet.tier2PublicPermanent}
        markLostData={
          pet.status === "active"
            ? {
                petHasMicrochip: canonicalIds.microchip !== null,
                petHasTattoo: canonicalIds.tattoo !== null,
                petColor: pet.color ?? null,
                petDistinguishingFeatures: pet.distinguishingFeatures ?? null,
                petJurisdictionProvince: pet.jurisdictionProvince ?? null,
                petJurisdictionLocality: pet.jurisdictionLocality ?? null,
              }
            : null
        }
        editPetData={{
          // Client props reach EVERY viewer of this route (org included) —
          // never ship the pet-level emergency-contact columns here. PetForm
          // does not read them; nulling keeps the Pet shape without the PII
          // (M2 fresh-review required fix 1).
          existingPet: {
            ...pet,
            preferredVetName: null,
            preferredVetPhone: null,
            emergencyContactName: null,
            emergencyContactPhone: null,
          },
          existingPhotoUrl: editPhotoUrl,
          pppBreedList: pppBreedRule.payload.breeds,
        }}
        chapitaData={chapitaData}
        alertsOriginShelter={alertsOriginShelter}
        showCheckinOption={showCheckinOption}
        showPregnancyStartOption={showPregnancyStartOption}
        physicalCredentialChannels={physicalCredentialChannels}
        emergencyContacts={
          // The edit sheet writes the PET-LEVEL override (owner-ia-redesign P2),
          // so its initial values are this pet's own columns (empty when unset),
          // NOT the account default. Clearing a field falls back to the account.
          // Gated on the LEGAL ownership role, not just accessPath: a foster /
          // transit holder is accessPath "owner" but must not see or edit the
          // legal owner's emergency contacts (M2 fresh-review required fix 2 —
          // matches the write path, which enforces ownerships.role = 'owner').
          isOwner && ownershipRole === "owner"
            ? {
                preferredVetName: pet.preferredVetName ?? "",
                preferredVetPhone: pet.preferredVetPhone ?? "",
                emergencyContactName: pet.emergencyContactName ?? "",
                emergencyContactPhone: pet.emergencyContactPhone ?? "",
              }
            : null
        }
        disclosurePrefs={
          // "Primeros pasos" star item (?sheet=privacidad) — same LEGAL-owner
          // gate as emergencyContacts above: a foster/transit holder must not
          // review or edit the legal owner's lost-mode disclosure choices.
          isOwner && ownershipRole === "owner" && !isDeceased
            ? {
                discloseFirstNameWhenLost: pet.discloseFirstNameWhenLost,
                disclosePhoneWhenLost: pet.disclosePhoneWhenLost,
                discloseEmailWhenLost: pet.discloseEmailWhenLost,
                discloseLastLocationWhenLost: pet.discloseLastLocationWhenLost,
                allowFinderFormWhenLost: pet.allowFinderFormWhenLost,
                discloseCaretakerContactWhenLost: pet.discloseCaretakerContactWhenLost,
              }
            : null
        }
        ownerFirstName={ownerFirstName}
        caretakerConsentName={caretakerConsentName}
      />

      {/* PostCreateModal was deleted (flow audit 2026-07-03 + PO decision):
            the credencial aha page owns the post-create moment; nothing
            produced ?recienCreado=true anymore, so the modal was dead code
            stacking a third celebration screen when it did fire. */}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Former-owner READ-ONLY custody view (PO decision 2026-07-18)
//
// A deliberately minimal, self-contained render — NOT a stripped-down
// CredentialFace/Libreta. This view never touches the carousel/compliance
// machinery those components own; it renders directly from the bare `pets`
// row getFormerOwnerReadAccess already resolved. No edit affordances, no
// action row, no Anotar — read-only means read-only.
// ---------------------------------------------------------------------------

function FormerOwnerCustodyReadOnlyView({
  pet,
  casePublicCode,
}: {
  pet: {
    name: string;
    species: string;
    breed: string | null;
    sex: "male" | "female" | "unknown" | null;
    dateOfBirth: string | null;
  };
  casePublicCode: string;
}) {
  // No death cut-off here: getFormerOwnerReadAccess's pet payload is a narrow
  // read-only projection that does not carry deceasedAt, and widening that query
  // for a pet that is BOTH deceased and under an open custody dispute buys
  // nothing. The main profile above passes it (master test CIU, B0b).
  const age = ageFromDateOfBirth(pet.dateOfBirth);
  const breedLine = [pet.breed, pet.sex ? sexLabel(pet.sex) : null, age, speciesLabel(pet.species)]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="mx-auto max-w-4xl pb-12 px-4 md:px-8"
      style={{ fontFamily: "var(--font-ln-sans)" }}
    >
      <Link
        href="/mis-mascotas"
        className="mb-[18px] mt-4 inline-block font-ln-mono text-sm uppercase tracking-[.06em] text-[var(--color-ln-mute)] no-underline hover:text-[var(--color-ln-ink-2)]"
        data-section="back-link"
      >
        ← Mis mascotas
      </Link>

      <section
        className="mb-3.5 rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-050)] px-4 py-3.5 space-y-1.5"
        data-section="former-owner-custody-banner"
      >
        <p className="font-semibold text-md text-[var(--color-ln-warn)]">
          Custodia oficial en curso
        </p>
        <p className="text-md text-[var(--color-ln-warn)]">
          Tu mascota está bajo custodia oficial — acceso de solo lectura mientras dure el proceso.
          Caso {casePublicCode}.
        </p>
      </section>

      <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-stripe)] px-4 py-3.5">
        <h1 className="text-lg font-semibold text-[var(--color-ln-ink)]">{pet.name}</h1>
        {breedLine && <p className="text-md text-[var(--color-ln-mute)]">{breedLine}</p>}
      </div>
    </div>
  );
}
