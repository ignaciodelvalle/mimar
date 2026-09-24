// Public credential page — Tier 0 view by default. When pet.status === 'lost'
// the page promotes to Tier 1: owner contact info governed by the five
// disclose_*_when_lost preference columns on the pets row, per spec §7 and
// AGENTS.md → "Privacy tiers".
//
// Privacy posture (active pets): NO owner PII, NO microchip number, NO medical
// details, NO scan history.
//
// The TATTOO code is the deliberate exception, and only on the lost branch
// (ratified 2026-08-01 after an audit read the omission as an oversight). A
// microchip needs a reader, so publishing its number helps nobody standing over
// the animal and hands a scraper a national identifier. A tattoo is a mark you
// read OFF the animal — withholding it would withhold the one identifier the
// finder can actually match, in the exact situation the Tier 1 promotion exists
// to serve. It stays out of the active-pet view: this is a reunification
// disclosure, not a public property of the credential.
//
// Security (V1-1): per-IP rate limit enforced before ANY data is fetched.
// Limit: 600 req/min, 6.000 req/hour per IP (bucket `public_token_page`, the
// shared `PUBLIC_TOKEN_READ_LIMIT`), charged ONCE per visit: the landing
// layout's 404 gate, this component's door and `generateMetadata` all read the
// same memoised charge (./credential-probe.ts, 2026-09-23). The unpushed first
// cut of that gate charged twice per visit, which would have halved the real
// ceiling to 300/min without any figure here changing. On rate-limit the page
// renders a soft throttle notice (not a 429 hard error) to preserve UX.
//
// THE NUMBERS IN THIS COMMENT WERE WRONG FOR MONTHS — it claimed "30 req/min,
// 200 req/hour", which this surface never enforced: the shared default was
// 60/min + 400/hr from the day the limiter moved into the adapter. Restated
// against the constant rather than re-guessed, since a comment nobody can check
// is how the first pair of numbers survived.
//
// Raised 2026-08-25 (B13, extended to the four HTML surfaces). The old ceiling
// was NOT "tight enough to stop enumeration" as this comment used to claim — a
// per-IP hourly ceiling never was an enumeration control, and a DISTRIBUTED walk
// is untouched by any value it takes. What it was refusing was a barrio behind
// one carrier NAT passing a lost-pet poster around: at 400/hr that is 0.4 reads
// per subscriber per hour, and the person turned away is a finder standing over
// the animal. Full arithmetic and the corrected 31^8 keyspace figure in
// lib/infra/public-token-throttle.ts.
//
// Token entropy widening is tracked as a follow-up (would invalidate existing tokens).

import "./credential-print.css";

import { Icon } from "@/components/Icon";
import { PppPublicBadge } from "@/components/PppPublicBadge";
import { ConfidenceBadge } from "@/components/event/ConfidenceBadge";
import { PublicLostSections, formatLostSince } from "@/components/pet-profile/PublicLostSections";
import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { LnVstamp } from "@/components/ui/StatusFlag";
import { deriveRabiesSemaphore, isRabiesAtRisk } from "@/lib/domain/credential-badges";
import { publicPlaceReference } from "@/lib/domain/public-place-reference";
import { computeConfidence, isAtLeast } from "@/lib/events/event-confidence";
import { publicTokenThrottle } from "@/lib/infra/public-token-throttle";
import { resolveLostSpecialConditions } from "@/lib/reference/permanent-conditions";
import { BRANDING } from "@/lib/ui/branding";
import { DISPUTE_TIP_INTRO } from "@/lib/ui/dispute-copy";
import { derivePetSituation } from "@/lib/ui/pet-situation";
import {
  AR_TIME_ZONE,
  foundPossessivePhrase,
  lostThirdPersonPhrase,
  normalizePhoneForTel,
  pluralizeEs,
  sexLabel,
  sightingPhrase,
  situationLabelForSex,
  speciesLabel,
  statusLabel,
} from "@/lib/utils/format";
import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";
import { isObservationOpen } from "@/src/modules/surveillance/domain/rabies-observation";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import {
  CredentialActionBar,
  type CredentialActionBarProps,
  DISPUTE_SECTION_ID,
  MEDICAL_SECTION_ID,
  REPORT_SECTION_ID,
} from "./CredentialActionBar";
import { CredentialPhoto } from "./CredentialPhoto";
import {
  CredentialOriginOrg,
  CredentialTier2Medical,
  CredentialTier2MedicalSkeleton,
} from "./CredentialStreamedSections";
import { DegradedCredentialCard } from "./DegradedCredentialCard";
import { DisputeTipForm } from "./DisputeTipForm";
import { FoundPetForm } from "./FoundPetForm";
import { ScanLogger } from "./ScanLogger";
import {
  PermanentConditionsBanner,
  RabiesObservationBanner,
  ServiceDogBanner,
} from "./credential-banners";
import { isRouterPrefetchRender, pageLookupDeps, probePublicCredential } from "./credential-probe";

// The page calls headers() at runtime — mark it dynamic explicitly so Next.js
// does not attempt to statically render it (matches the sibling encontre /
// sighting pages that also carry this export).
//
// Cache policy: ALWAYS LIVE. force-dynamic + `Cache-Control: no-store` (stamped
// in middleware for the /p/ subtree — see lib/infra/public-cache-policy.ts).
// This credential flips active↔lost and, in lost mode, discloses the owner's
// phone / last-seen location; a shared/CDN cache was serving a found pet as
// "SE BUSCA" + phone at the exact QR URL. no-store guarantees the lost→found /
// disclosure change is visible immediately, so no per-action revalidation of
// this public URL is needed.
export const dynamic = "force-dynamic";

/**
 * Open Graph metadata for share previews (task #43, share-first lost flow).
 * When a lost-pet link lands in a WhatsApp chat or a barrio Facebook group,
 * this preview card — photo, urgent title — is what carries the message; a
 * bare URL gets scrolled past.
 *
 * Privacy: name, species and photo only — the same Tier 0 subset the page
 * itself shows to anyone. No owner PII, no location.
 *
 * og:image is NOT set here — deliberately. `opengraph-image.tsx` (sibling
 * file in this route segment) generates the branded SE BUSCA / credencial
 * card automatically via Next's file convention. Setting `openGraph.images`
 * in this config-based metadata would take precedence over that file and
 * silently disable it, so this only carries the non-image OG fields.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;
  // Reads through the SAME memoised probe as the layout's 404 gate and the
  // page's door (2026-09-23): no second throttle charge, no second row read.
  // It USED to run its own budgeted query outside the limiter — the residual
  // lib/infra/public-token-throttle.ts documented — so a throttled caller
  // still got one pet read per request. Now a throttled caller, a missing
  // token and a DB failure all get the generic title; the failure itself is
  // reported once, by the page's door, which receives the same rejection.
  //
  // A ROUTER PREFETCH resolves metadata too (Next renders the head down to the
  // loading boundary), so without this every `<Link href="/p/…">` card on
  // /perdidas would still spend the limiter here even though the layout skips
  // it. A prefetch gets the generic title and reads nothing; the navigation
  // that follows re-renders the head with the real one.
  if (isRouterPrefetchRender()) return { title: "Credencial | miMAR" };
  const probe = await probePublicCredential(publicToken, "page");
  if (probe.status !== "found") return { title: "Credencial | miMAR" };
  const row = probe.row.pet;

  // Canonical URL from the STORED token, never the route param. Middleware
  // already 308s a non-canonical spelling (/p/dim-…) to the issued one, so the
  // two agree on every request that gets this far — but the stored value is
  // the one that cannot drift, and it is what share previews and search
  // engines should consolidate on.
  const canonicalPath = `/p/${row.publicToken}`;

  const isLost = row.status === "lost";
  const title = isLost ? `SE BUSCA: ${row.name} | miMAR` : `${row.name} | Credencial miMAR`;
  const description = isLost
    ? // Rewritten around the pronoun instead of split as "lo/la" — the
      // convention lostThirdPersonPhrase() and its siblings already follow
      // (lib/utils/format.ts). This card is what WhatsApp and Google publish
      // for a lost pet, and it said "perdida" for every animal because the
      // query above did not even select `sex`.
      `${row.name} (${speciesLabel(row.species)}) ${lostThirdPersonPhrase(row.sex)}. ¿Lo viste? Tocá para avisarle a su familia.`
    : `Credencial pública de ${row.name} (${speciesLabel(row.species)}), verificable por QR.`;

  return {
    title,
    description,
    alternates: { canonical: canonicalPath },
    openGraph: {
      title,
      description,
      type: "website",
      url: canonicalPath,
      siteName: BRANDING.appName,
    },
    twitter: {
      // opengraph-image.tsx always produces an image now (branded fallback
      // even without a real photo), so this is unconditional.
      card: "summary_large_image",
      title,
      description,
    },
  };
}

// The per-IP read limit, its budget and its fail-open behaviour moved to
// lib/infra/public-token-throttle.ts on 2026-08-17. They lived here, inline,
// under a comment claiming the guard ran "before touching any pet data" — true
// of this file and of nothing else: the /encontre and /sighting siblings
// resolve the same token through the same lookup and had no limiter at all.
// Sharing the helper is what makes the claim true for the route family.

// DB time budgets: the metadata read's own budget (METADATA_BUDGET_MS, 2500)
// went away with the read itself on 2026-09-23 — `generateMetadata` now reads
// the memoised probe, bounded by the door's PET_ROW_BUDGET_MS. The budgets for
// the pet row and the view-data fan-out live in lookupPublicCredential with the
// reads they bound, so the /api/v1 route inherits the same numbers.

export default async function PublicCredentialPage({
  params,
}: {
  params: Promise<{ publicToken: string }>;
}) {
  const { publicToken } = await params;

  // ---------------------------------------------------------------------------
  // ONE door: throttle → pet row → view-data fan-out, answered as a four-way
  // union (lookupPublicCredential). The branches below are the SAME four this
  // component held inline until Track 2 — same order, same budgets, same
  // degraded shapes — but the decision now lives in a function the coming
  // `GET /api/v1/pets/{token}/credential` calls too. A route handler that
  // re-derived these branches is how the JSON and the HTML start disagreeing
  // about what "degraded" means.
  //
  // The limiter arrives as a PORT (`publicTokenThrottle`) because the use-case
  // may not import next/headers. The page cannot call this door without
  // supplying one — the rate limit is enforced by the type checker here, not by
  // remembering to write a guard statement.
  //
  // `pageLookupDeps` (2026-09-23) answers the door's `findPet` from the
  // memoised probe the landing layout already ran for its 404 gate, and the
  // throttle port lands on the same memoised charge — so this call costs no
  // second charge and no second row read. The view-data fan-out runs only here.
  // ---------------------------------------------------------------------------
  const lookup = await lookupPublicCredential(
    {
      publicToken,
      throttle: publicTokenThrottle("public_token_page"),
    },
    pageLookupDeps,
  );

  switch (lookup.status) {
    // V1-1: over the per-IP read limit. Soft notice (not a hard 500) — no pet
    // data was read.
    case "throttled":
      return <ThrottleNotice />;
    // Never reached on a DB outage: that answers `degraded`, because an outage
    // is not "this token does not exist".
    case "not_found":
      return notFound();
    // Honest degraded card. `pet` is present only when the pet ROW resolved
    // before the failure — bare card otherwise (the token is all we know).
    case "degraded":
      return (
        <DegradedCredentialCard
          publicToken={lookup.publicToken}
          petName={lookup.pet?.name}
          petSex={lookup.pet?.sex}
          isLost={lookup.pet?.isLost}
          allowFinderForm={lookup.pet?.allowFinderForm}
        />
      );
    case "ok":
      break;
    default: {
      // Exhaustiveness: a new status added to the union without a branch here
      // is a compile error, not a blank page.
      //
      // The message names the STATUS ONLY. This branch is unreachable by types,
      // but if a new status ever slips through, `lookup` at runtime is whatever
      // the door returned — the `ok` shape is the entire pet row — and
      // stringifying it would spill a subject's record into an error log and
      // whatever collects it.
      const unhandled: never = lookup;
      throw new Error(
        `Unhandled credential lookup status: ${(unhandled as { status: string }).status}`,
      );
    }
  }

  const { pet, photoUrl, data } = lookup;
  const {
    canonicalIds,
    hasVaccinations,
    latestVaccinationRows,
    openCustodyEpisodeRows,
    rabiesEvents,
    serviceDog,
    lostContext,
    lostTattooPhotoUrl,
    registryClaim,
  } = data;

  // Tri-state antirrábica vigencia for the identity grid (R4). One boolean of
  // the single legally-mandated vaccine — no dates, no vet, no other vaccine
  // (privacy proportionality argued in the spec).
  const rabiesSemaphore = deriveRabiesSemaphore(rabiesEvents, new Date());

  const hasMicrochip = canonicalIds.microchip !== null;
  const hasTattoo = canonicalIds.tattoo !== null;

  const [latestVaccination] = latestVaccinationRows;

  const latestVaccinationTier = latestVaccination
    ? computeConfidence({
        authorRole: latestVaccination.authorRole,
        authorVerified: latestVaccination.authorVerified,
        authorOrganizationId: latestVaccination.authorOrganizationId,
        payload: (latestVaccination.payload ?? {}) as Record<string, unknown>,
      })
    : null;

  // Gate: only institutional_verified or professional_verified (plan §A.4)
  const showVaccinationConfidence =
    latestVaccinationTier !== null && isAtLeast(latestVaccinationTier, "professional_verified");

  // Approximate age — year only (Tier 0 doesn't expose exact DOB).
  //
  // Counted up to the DEATH date when there is one. `Date.now()` alone kept
  // ageing the dead: Kabosu (died 2024) read "20 años" and Hachikō (died 1935)
  // read "102 años" on the public credential — absurd on its face for the
  // historical records, and quietly wrong for any pet whose death was recorded
  // last month (master test CIU, B0b/B0c). A life stops at its end.
  const ageEndsAt = pet.deceasedAt ? new Date(pet.deceasedAt).getTime() : Date.now();
  const ageYears = pet.dateOfBirth
    ? Math.max(
        0,
        Math.floor(
          (ageEndsAt - new Date(pet.dateOfBirth).getTime()) / (1000 * 60 * 60 * 24 * 365.25),
        ),
      )
    : null;

  const isLost = pet.status === "lost";

  // DC13: Public custody disclaimer — rendered when the pet has an open
  // custody_episode case opened by a sanitary_authority org (state seizure).
  // Discriminator: caseKind='custody_episode' + opener.orgType='sanitary_authority'.
  // Never parsed from notes text — canonical discriminator only. No owner PII is
  // exposed: only the authority name and a generic disclaimer. The query itself
  // ran in the Stage 1 Promise.all above (it only needs pet.id).
  const [openCustodyEpisode] = openCustodyEpisodeRows;

  const isUnderOfficialCustody = !!openCustodyEpisode;

  // Tier 2 público — owner-opt-in. Active when either:
  //   • tier2PublicPermanent is true ("siempre" option, no expiry), or
  //   • tier2PublicEnabledUntil is a future timestamp (bounded window).
  // See app/actions/tier2-public.ts + migrations 0049 / 0098.
  const tier2EnabledUntil = pet.tier2PublicEnabledUntil
    ? new Date(pet.tier2PublicEnabledUntil)
    : null;
  const tier2Active =
    pet.tier2PublicPermanent || (!!tier2EnabledUntil && tier2EnabledUntil > new Date());

  // #16a — the Tier-2 medical projection (FULL vaccination history + medications
  // + sterilization, folded with event_amended corrections) is the heaviest read
  // on this page. It no longer blocks the credential shell / LCP photo: it moved
  // into <CredentialTier2Medical>, streamed behind <Suspense> in the active
  // render below. `tier2Active` (a pet-row flag) still gates it here so the
  // skeleton only ever shows for tier2-enabled pets.

  // Service dog banner (Ley 26.858). Renders ONLY when the owner has opted
  // in to full_banner visibility AND the credential is vigente AND in
  // service AND the type is one of the five ANDIS-recognized categories
  // ('otro' explicitly never banners). The 60-day rabies expiry sub-warning
  // is computed below. (Row fetched in loadCredentialViewData.)
  const showServiceDogBanner =
    serviceDog &&
    serviceDog.credentialStatus === "vigente" &&
    serviceDog.inService &&
    serviceDog.publicVisibility === "full_banner" &&
    serviceDog.serviceType !== "otro";

  // Art. 8 risk: rabies vaccination must be up to date for the credential
  // to remain compliant. We surface this as a sub-warning on the banner
  // without auto-revoking (revocation belongs to ANDIS).
  // Heuristic: the most recent vaccine with a past `next_due_at`, IF it is a
  // rabies dose, flags risk. The CORRECTED name/due date is read (WAVE D1) so
  // amending a mistyped rabies dose flips the public warning. Conservative —
  // false negatives OK, false positives only show a soft warning. Reuses the
  // hoisted rabiesEvents fetch (pet-state-header R4) — no extra query.
  const rabiesAtRisk = showServiceDogBanner ? isRabiesAtRisk(rabiesEvents, new Date()) : false;

  // Tier 1 reveal (lostContext) is resolved inside loadCredentialViewData —
  // only when the pet is marked lost, each field gated by the owner's
  // disclose_*_when_lost preference. Active pets expose NO owner PII.

  // Lost-mode extras — pet-state-header R3.1 retired the LostPublicCredential
  // full-page takeover: lost pets render the SAME single card below, with these
  // sections in the body. lostSince falls back to now() when the lost event row
  // is missing (shouldn't happen, but defensive).
  let lostSpecialConditions: ReturnType<typeof resolveLostSpecialConditions> = null;
  let lostIdentityLine = "";
  if (isLost && lostContext) {
    // The identity line is a DESCRIPTION ("Perro · marrón · collar rojo") — it
    // exists so a finder can match the animal in front of them. The species
    // alone describes nothing a finder can use, and it is already stated twice
    // on this card (the breed line under the name, and the "Especie" field in
    // the identity grid), so a pet with no colour and no señas rendered a
    // floating orphan word — "Perro" on its own line (UI review, PO
    // 2026-08-06). Built here rather than hidden at the render site so every
    // consumer of the prop gets the same honest empty string.
    const identityTraits = [pet.color, pet.distinguishingFeatures].filter(Boolean);
    lostIdentityLine =
      identityTraits.length > 0 ? [speciesLabel(pet.species), ...identityTraits].join(" · ") : "";

    // Welfare-safety disclosure: permanent conditions (blind, deaf, medicated,
    // etc.) on the LOST credential. Gated ONLY by discloseConditionsPublicly —
    // same gate the active-credential banner and Tier-2 medical view use for
    // this field; a finder handling a special-needs pet must be told.
    lostSpecialConditions = resolveLostSpecialConditions(
      pet.permanentConditions,
      pet.permanentConditionsOther,
      pet.discloseConditionsPublicly,
    );
  }

  // PUBLIC-SAFE masthead situation (pet-state-header R3.3, privacy checklist).
  // The derivation is fed ONLY the public-safe signals: status (lost/deceased),
  // rabies observation (already public on this page) and official custody
  // (already public via the DC13 disclaimer). Medical/household states
  // (en-tratamiento, prenada, en-adopcion, en-transito) are STRUCTURALLY
  // unreachable here — their inputs are never passed — so the public masthead
  // can never tint for them (Tier 0 exposes no medical/household state).
  const publicSituationRaw = derivePetSituation({
    status: pet.status,
    rabiesObservationStatus: pet.rabiesObservationStatus,
    underOfficialCustody: isUnderOfficialCustody,
  });
  const publicSituation = publicSituationRaw.isDefault ? null : publicSituationRaw;

  // ---------------------------------------------------------------------------
  // Credential — LN "warm libreta / document credential" render (single card
  // for active AND lost pets; the masthead carries the situation).
  // ---------------------------------------------------------------------------

  const breedLine = [speciesLabel(pet.species), pet.breed, sexLabel(pet.sex)]
    .filter(Boolean)
    .join(" · ");
  const ageLabel = ageYears !== null ? `${ageYears} ${pluralizeEs(ageYears, "año")}` : null;

  // Sticky primary CTA (mobile <sm) — cursor citizen review P3: one verb for
  // the street scanner, per state. EVERY disclosure decision is resolved HERE,
  // server-side, so the client bar never receives undisclosed PII:
  //   disputed → NEUTRAL "Tengo información sobre esta mascota" (PO
  //              2026-07-24): opens + scrolls to the dispute-tip form, which
  //              lands on the dispute case for the reviewing authority ONLY.
  //              The D2 hardening (red-team 2026-07) still holds — no relay
  //              CTA of any kind (/encontre, /sighting, tel:) ever surfaces:
  //              those flows end in an owner-directed notification, which
  //              would take sides in a legal dispute. Deceased + disputed
  //              keeps the memorial contract: no bar (the inline tip form
  //              below remains reachable).
  //   lost     → finder form (owner-allowed) else sighting form; secondary
  //              "Llamar" only when the phone is disclosed AND no custody
  //              dispute is open (D2).
  //   active   → tier2 visible: scroll to the medical summary (low urgency);
  //              tier 0: NO bar (PO 2026-07-24 — a sticky found-report on a
  //              pet nobody is looking for invites false reports and dilutes
  //              genuinely-lost urgency; the "¿Encontraste a esta mascota?"
  //              form stays reachable inline lower on the page).
  //   deceased → no bar (memorial — there is no useful street action).
  const actionBar: CredentialActionBarProps | null = pet.inCustodyDispute
    ? pet.status === "deceased"
      ? null
      : { mode: "dispute" }
    : isLost
      ? {
          mode: "lost",
          primaryHref: pet.allowFinderFormWhenLost
            ? `/p/${publicToken}/encontre`
            : `/p/${publicToken}/sighting`,
          primaryLabel: pet.allowFinderFormWhenLost
            ? foundPossessivePhrase(pet.sex)
            : sightingPhrase(pet.sex),
          phoneHref:
            pet.disclosePhoneWhenLost && lostContext?.phone
              ? `tel:${normalizePhoneForTel(lostContext.phone) ?? lostContext.phone}`
              : null,
        }
      : pet.status === "active" && tier2Active
        ? { mode: "medical" }
        : null;

  return (
    // Landing shell (AppShell variant=landing) owns #main-content + min-height.
    <div className="min-h-screen bg-ln-paper font-ln-sans">
      {/* Passive scan floor only — no on-load location prompt (PO 2026-07-24,
          Option A: precise finder GPS is captured intent-driven inside the
          sighting flow, not "antes de tiempo" on scan). */}
      <ScanLogger publicToken={publicToken} />

      {/* Guilloché band — LN security stripe */}
      <div
        aria-hidden="true"
        className="h-[4px] flex-shrink-0 opacity-90"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />

      {/* When the sticky bar renders, mobile bottom padding grows so the last
          content (credential footer) is never hidden behind the fixed bar. */}
      <div className={`mx-auto max-w-[460px] px-4 py-6 ${actionBar ? "pb-28 sm:pb-14" : "pb-14"}`}>
        {/* ------------------------------------------------------------------ */}
        {/* TIER 0+ emergency-info banner — sticky on mobile, always visible.  */}
        {/* Non-hideable by design: the medical alert is the point of 0+.      */}
        {/* Sprint 5 PR-042 / doc 10 §3 punto 4.                               */}
        {/* ------------------------------------------------------------------ */}
        {pet.emergencyInfoVisible && (
          <div
            role="alert"
            data-section="emergency-banner"
            className="sticky top-0 z-30 -mx-4 mb-4 flex items-start gap-[11px] border-b border-ln-err-100 bg-ln-err-050 px-[18px] py-[13px] md:static md:mx-0 md:mb-4 md:rounded-[var(--radius-sm)]"
          >
            {/* Heartbeat icon */}
            <span aria-hidden="true" className="mt-px flex-shrink-0 text-ln-seal">
              <Icon name="corazon" size="md" decorative />
            </span>
            <div>
              <p className="m-0 font-ln-serif text-md font-semibold text-ln-ink">Alerta médica</p>
              <p className="mt-0.5 text-sm leading-[1.45] text-ln-ink-2">
                Esta mascota requiere atención médica. Contactá al dueño escaneando el QR.
              </p>
            </div>
          </div>
        )}

        {/* DC13: Official custody disclaimer — the masthead situation chip
            below is the single authority for announcing the custody STATE
            (pet-state single authority standard, PO decision 2026-07-16,
            mirrored here from the owner profile fix). This box only adds
            what the chip can't: who's in charge and what a finder should do. */}
        {isUnderOfficialCustody && (
          <div
            role="alert"
            data-section="custody-disclaimer"
            className="mb-4 rounded-[var(--radius-sm)] border border-ln-warn-100 border-l-[3px] border-l-ln-warn bg-ln-warn-050 px-4 py-3"
          >
            <p className="mb-1 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-warn">
              Custodia oficial
            </p>
            {openCustodyEpisode?.authorityName && (
              <p className="m-0 text-sm text-ln-ink-2">
                Autoridad a cargo: {openCustodyEpisode.authorityName}
              </p>
            )}
            <p className="mt-1 text-sm text-ln-mute">
              Comunicate con la autoridad sanitaria competente para más información.
            </p>
          </div>
        )}

        {/* D2: custody dispute — neutral banner, no accusation, no dispute
            details. Distinct from the DC13 official-custody box above (that
            one is a sanitary_authority seizure; this is pets.inCustodyDispute,
            set by custody_dispute_raised / cleared by custody_dispute_resolved
            — see custody-disputes module). Reuses the same box structure. */}
        {pet.inCustodyDispute && (
          <div
            role="alert"
            data-section="custody-dispute-disclaimer"
            className="mb-4 rounded-[var(--radius-sm)] border border-ln-warn-100 border-l-[3px] border-l-ln-warn bg-ln-warn-050 px-4 py-3"
          >
            <p className="mb-1 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-warn">
              Titularidad en revisión
            </p>
            <p className="m-0 text-sm text-ln-ink-2">Titularidad en revisión por la autoridad.</p>
            <p className="mt-1 text-sm text-ln-mute">
              Estamos revisando la situación de esta mascota junto a la autoridad competente.
            </p>
          </div>
        )}

        {/* Permanent conditions banner — active pets only: in lost mode the
            in-card special-conditions section (PublicLostSections) carries the
            same disclosure with finder-welfare framing; both are keyed on the
            same discloseConditionsPublicly gate. */}
        {!isLost && pet.discloseConditionsPublicly && pet.permanentConditions.length > 0 && (
          <PermanentConditionsBanner
            codes={pet.permanentConditions}
            other={pet.permanentConditionsOther}
          />
        )}

        {/* PPP badge — Ley CABA 4078 / Ley Prov 14.107 */}
        {pet.potentiallyDangerousBreed && (
          <div className="mb-4">
            <PppPublicBadge petName={pet.name} breed={pet.breed ?? null} />
          </div>
        )}

        {/* Open rabies observation — public-safety signal (no PII). A vecino
            scanning a dog under observation must see it, and must ALSO see when
            the window closed without anyone signing a result (2026-08-17): that
            second state is neither a danger nor an all-clear, and the banner
            says exactly that. */}
        {isObservationOpen(pet.rabiesObservationStatus) && (
          <RabiesObservationBanner
            windowExpired={pet.rabiesObservationStatus === "window_expired_unclosed"}
          />
        )}

        {/* Service dog banner — Ley 26.858 */}
        {showServiceDogBanner && <ServiceDogBanner rabiesAtRisk={rabiesAtRisk} />}

        {/* ------------------------------------------------------------------ */}
        {/* CREDENTIAL CARD                                                     */}
        {/* ------------------------------------------------------------------ */}
        <div
          className="pc-cred overflow-hidden rounded-[var(--radius-input)] border border-ln-line-strong bg-ln-card shadow-[0_6px_18px_rgba(20,40,60,.08)]"
          data-situation={publicSituation?.key}
        >
          {/* Guilloché top band — the 8px strip is half the public masthead
              (pet-state-header D2): its default background lives in .pc-strip
              (globals.css) so the .pc-cred[data-situation] variants can recolor
              it per situation. */}
          <div aria-hidden="true" className="pc-strip h-[8px]" />

          {/* Official header row: crest + brand + tier chip (+ situation chip) */}
          <div className="pc-head flex flex-wrap items-center gap-2 border-b border-ln-line-2 px-4 py-2.5">
            {/* Crest circle */}
            <div
              aria-hidden="true"
              className="grid h-[26px] w-[26px] flex-shrink-0 place-items-center rounded-full border-[1.5px] border-ln-azul bg-ln-celeste-050 font-ln-serif text-sm font-semibold text-ln-azul"
            >
              m
            </div>
            {/* `basis-[7rem]` is what makes the row WRAP instead of crushing.
                Measured at exactly 390px: this block was flex-1 min-w-0 against
                two chips that cannot shrink (a flex item defaults to
                min-width:auto, so their intrinsic text width is a floor). It
                therefore absorbed the whole deficit and collapsed — clientWidth
                2px against a scrollWidth of 58px, i.e. "Credencial pública"
                rendered into a 2-pixel-wide box. Giving it a basis floor makes
                the flex-wrap already on .pc-head do its job: the chips drop to a
                second line. `truncate` is the last-resort guard below it. */}
            {/* RA-10 (b): the label was an 8 px literal — the smallest type on
                the flagship public surface, two steps under the `--text-xs`
                (10px) floor the type scale declares for micro labels. It is now
                the token.
                THE BASIS MOVED WITH IT, and it had to. Measured on the running
                build at 390px: at 10px the tracked uppercase run is 133px wide
                inside a 123px box, so the `truncate` below would have clipped it
                to "CREDENCIAL PÚBLIC…" — trading an unreadable label for a
                mutilated one on the credential's own identity band. `8rem`
                (128px) is the first basis that exceeds what fits beside the
                nowrap tier chip, which is exactly the mechanism the note above
                describes: the chip drops to a second line and the block takes
                the full width. Costs ~30px of masthead height at 390px; at
                desktop widths the row has room and nothing wraps. */}
            <div className="min-w-0 flex-1 basis-[8rem]">
              <span className="font-ln-serif text-md font-semibold text-ln-ink">miMAR</span>
              <span className="block truncate font-ln-mono text-xs uppercase tracking-[.14em] text-ln-mute">
                Credencial pública
              </span>
            </div>
            {/* Tier chip — nowrap so it never breaks "NIVEL 2 · DATOS MÉDICOS"
                mid-label; it wraps as a whole unit or not at all. */}
            <span
              className={`whitespace-nowrap rounded-full border px-2 py-[3px] font-ln-mono text-xs font-semibold tracking-[.08em] ${tier2Active ? "border-ln-ok-100 bg-ln-ok-050 text-ln-ok" : "border-ln-celeste-100 bg-ln-celeste-050 text-ln-azul"}`}
            >
              {tier2Active ? "NIVEL 2 · DATOS MÉDICOS" : "NIVEL 0 · IDENTIDAD"}
            </span>
            {/* Situation chip (pet-state-header R3.2) — icon + gendered label,
                never color alone. role="alert" only for perdida: a finder must
                hear the urgent state immediately; the other public states are
                informational. Recency rides the chip for lost pets. */}
            {publicSituation && (
              <span
                className="pc-sit-chip"
                data-section="masthead-situation-chip"
                role={publicSituation.key === "perdida" ? "alert" : undefined}
              >
                <Icon name={publicSituation.icon} size="sm" decorative />
                {situationLabelForSex(publicSituation.label, pet.sex)}
                {isLost && lostContext && (
                  <span className="pc-sit-chip-recency">
                    · {formatLostSince(lostContext.lostSince ?? new Date())}
                  </span>
                )}
              </span>
            )}
          </div>

          {/* Photo — LCP element on the busiest path in the product (every QR
              scan lands here, mostly mobile). next/image `priority` preloads +
              eager-loads it, preserving the deliberate eager LCP choice, while
              the optimizer serves a device-sized WebP — byte-smaller than the
              raw Supabase original on a phone, never larger. `sizes` reflects the
              card: full-width up to the 460px cap. The Supabase storage host is
              allowlisted in next.config (images.remotePatterns). */}
          <CredentialPhoto src={photoUrl ?? null} petName={pet.name} />
          {/* CredentialPhoto also owns the no-photo placeholder, so a URL that
              404s at request time degrades to the same initial-letter card
              instead of a broken-image glyph. */}

          {/* Name bar */}
          <div className="px-4 pt-[15px] pb-3">
            {/* h1: this is the most-scanned public page in the product (QR landing) —
                it must expose a page-level heading (WCAG 1.3.1 / 2.4.6). */}
            {/* The status DOT that used to sit here is gone (UI review, PO
                2026-08-06). It was an unlabeled colour with no legend on the
                most-scanned public page in the product: a finder had no way to
                learn what green vs amber vs red meant, and every state it could
                express was already spelled out in words one line above (the
                masthead situation chip, which carries icon + label + recency
                and role="alert" for perdida) and again in the identity grid
                below. Removing it costs no information and one fewer thing to
                decode. It was `aria-hidden` decorative, so no accessible name
                was lost — the chip already owns the state for screen readers. */}
            <h1 className="font-ln-serif text-3xl font-semibold leading-none tracking-[-0.02em] text-ln-ink">
              {pet.name}
            </h1>
            <p className="mt-[5px] text-md text-ln-ink-2">
              {breedLine}
              {ageLabel && ` · ${ageLabel}`}
            </p>
          </div>

          {/* Lost body sections (pet-state-header R3.4) — CTA row + última vez
              vista + tattoo + description + welfare box, directly under the
              name bar. Every disclosure gate resolved server-side above. */}
          {isLost && lostContext && (
            <PublicLostSections
              petName={pet.name}
              petSex={pet.sex}
              identityLine={lostIdentityLine}
              // cursor UX D2: titularidad en revisión — never disclose the
              // contested owner's name/phone/email while a custody dispute is
              // open. Red-team hardening 2026-07: the reporting CTAs
              // (finderFormHref / sightingFormHref) now ALSO go null — both
              // flows relay the finder's contact to the contested owner
              // (notification and/or owner-visible timeline payload), which
              // takes sides in a legal dispute. custodyDisputed renders the
              // neutral authority notice in their place.
              custodyDisputed={pet.inCustodyDispute}
              ownerFirstName={
                pet.discloseFirstNameWhenLost && !pet.inCustodyDispute
                  ? lostContext.ownerFirstName
                  : null
              }
              ownerPhoneE164={
                pet.disclosePhoneWhenLost && !pet.inCustodyDispute ? lostContext.phone : null
              }
              ownerEmail={
                pet.discloseEmailWhenLost && !pet.inCustodyDispute ? lostContext.email : null
              }
              // Already null unless BOTH keys hold and no dispute is open —
              // resolved once in the loader rather than re-derived here, so
              // there is exactly one place the rule can be got wrong.
              caretakerContact={lostContext.caretakerContact}
              // THE DOOR COMES OFF HERE, at the publication boundary and not at
              // capture (PO decision 2026-09-16). The full address and the
              // coordinates keep doing their jobs: the coordinate routes the case
              // and alerts organisations by proximity, and the operator working it
              // still sees the address. What a STRANGER reads is the landmark
              // without the number.
              // The reasoning is the PO's and it is the good kind: by the time
              // anybody reads this line, the animal has moved. It is not where the
              // animal is, it is where to start looking — so exactness buys nothing
              // against a search, and costs a home address on an open page, because
              // a pet very often goes missing from its own door.
              lastSeenPlaceName={
                pet.discloseLastLocationWhenLost
                  ? publicPlaceReference(lostContext.locationText)
                  : null
              }
              lastSeenLocality={
                pet.discloseLastLocationWhenLost ? (pet.jurisdictionLocality ?? null) : null
              }
              lastSeenCoords={pet.discloseLastLocationWhenLost ? lostContext.lastSeenCoords : null}
              lastSeenAt={pet.discloseLastLocationWhenLost ? lostContext.lastSeenAt : null}
              distinguishingFeatures={pet.distinguishingFeatures}
              finderFormHref={
                pet.allowFinderFormWhenLost && !pet.inCustodyDispute
                  ? `/p/${publicToken}/encontre`
                  : null
              }
              sightingFormHref={pet.inCustodyDispute ? null : `/p/${publicToken}/sighting`}
              lastSeenLat={pet.discloseLastLocationWhenLost ? lostContext.lostLat : null}
              lastSeenLng={pet.discloseLastLocationWhenLost ? lostContext.lostLng : null}
              lostSince={lostContext.lostSince ?? new Date()}
              tattooCode={canonicalIds.tattoo?.code ?? null}
              tattooLocation={canonicalIds.tattoo?.tattooLocation ?? null}
              tattooDescription={canonicalIds.tattoo?.tattooDescription ?? null}
              tattooPhotoUrl={lostTattooPhotoUrl}
              lostDescription={lostContext.lostDescription}
              specialConditions={lostSpecialConditions}
            />
          )}

          {/* Tier 2 — enabled notice + streamed medical summary (#16a), wrapped
              with the sticky bar's "Ver resumen médico" scroll target. The
              wrapper is style-neutral (the seam divs inside are unchanged);
              scroll-mt clears the sticky emergency banner when present. */}
          {tier2Active && (
            <div id={MEDICAL_SECTION_ID} className="scroll-mt-24">
              <div className="flex items-center gap-[7px] border-t border-ln-celeste-100 bg-ln-celeste-050 px-4 py-2.5 font-ln-mono text-xs leading-[1.5] tracking-[.02em] text-ln-azul-700">
                <Icon name="unlock" size="sm" decorative />
                {pet.tier2PublicPermanent
                  ? "El dueño habilitó la libreta médica de forma permanente"
                  : tier2EnabledUntil
                    ? `El dueño habilitó la libreta médica hasta el ${tier2EnabledUntil.toLocaleString("es-AR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: AR_TIME_ZONE })}`
                    : null}
              </div>

              {/* The shell (photo, name, identity) paints first; this heavy
                  vaccination projection streams in behind a skeleton that
                  reserves its height so the sections below do not jump.
                  degraded-states: the fallback escalates to waiting text /
                  degraded card if the stream stalls (pure CSS). The OriginOrg
                  fallback={null} boundary below stays UNWRAPPED on purpose —
                  the badge is absent for most pets, so any fallback UI there
                  would flash then vanish. */}
              <Suspense
                fallback={
                  <DegradedFallback>
                    <CredentialTier2MedicalSkeleton />
                  </DegradedFallback>
                }
              >
                <CredentialTier2Medical
                  petId={pet.id}
                  sex={pet.sex}
                  species={pet.species}
                  jurisdictionProvince={pet.jurisdictionProvince}
                  jurisdictionLocality={pet.jurisdictionLocality}
                  enabledUntil={tier2EnabledUntil}
                  permanentConditions={pet.permanentConditions ?? []}
                  permanentConditionsOther={pet.permanentConditionsOther}
                />
              </Suspense>
            </div>
          )}

          {/* Identity section */}
          <div className="border-t border-ln-line-2 px-4 py-[13px]">
            {/* Claim tiering (ADR-7, CT1/CT2) — see lib/domain/credential-claims.ts. */}
            <p className="mb-[9px] font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-mute">
              {registryClaim.identityHeading}
            </p>
            <div className="grid grid-cols-2 gap-x-3.5 gap-y-[11px]">
              <CredField label="Credencial" value={statusLabel(pet.status)} mono={false} />
              <CredField
                label="Vacunación"
                value={hasVaccinations ? "Con registros" : "Sin registros"}
                mono={false}
              />
              {/* Rabies semaphore (pet-state-header R4) — tri-state vigencia of
                  the single legally-mandated vaccine (Ley 22.953 framework).
                  LnVstamp for vigente/vencida (icon-free stamp + text label —
                  never color alone); plain honest text otherwise. No dates on
                  Tier 0. */}
              <div data-section="rabies-semaphore">
                <p className="m-0 font-ln-mono text-xs uppercase tracking-[.06em] text-ln-faint">
                  Antirrábica
                </p>
                {/* PROVENANCE RIDES WITH THE CLAIM (2026-08-17). A dose the
                    owner typed in used to render the same green VIGENTE seal as
                    one a matriculated vet signed, and the only provenance
                    signal on the page appeared exclusively when the record was
                    ALREADY verified — present when unnecessary, absent when it
                    mattered. An unqualified green stamp on the one legally
                    mandated vaccine is a verification this registry never
                    performed.

                    A declared dose keeps its factual word — the date IS current
                    — but loses the OK tone, reusing the neutral variant the
                    stamp already has for "we do not know". Same reasoning as
                    that variant's own note: what is unconfirmed must never read
                    as confirmed. The `detail` suffix says which of the two it
                    is, so the qualifier cannot be missed by reading colour
                    alone. */}
                <p className="mt-px text-md font-medium text-ln-ink">
                  {rabiesSemaphore.estado === "vigente" ? (
                    rabiesSemaphore.respaldo === "profesional" ? (
                      <LnVstamp variant="ok" detail="firmada" />
                    ) : (
                      <LnVstamp variant="unknown" label="VIGENTE" detail="declarada" />
                    )
                  ) : rabiesSemaphore.estado === "vencida" ? (
                    <LnVstamp
                      variant="over"
                      detail={rabiesSemaphore.respaldo === "profesional" ? "firmada" : "declarada"}
                    />
                  ) : rabiesSemaphore.estado === "sin-vencimiento" ? (
                    rabiesSemaphore.respaldo === "profesional" ? (
                      "Con registro firmado"
                    ) : (
                      "Con registro declarado"
                    )
                  ) : (
                    "Sin registro"
                  )}
                </p>
              </div>
              <CredField label="Microchip" value={hasMicrochip ? "Sí" : "No"} mono={false} />
              <CredField label="Tatuaje" value={hasTattoo ? "Sí" : "No"} mono={false} />
              <CredField label="Libreta" value={`LIB-AR-${pet.publicToken.toUpperCase()}`} mono />
            </div>
          </div>

          {/* A.4: Vaccination confidence badge */}
          {showVaccinationConfidence && latestVaccinationTier && (
            <div className="flex items-center gap-2 border-t border-ln-line-2 px-4 py-2.5">
              <span className="font-ln-mono text-xs font-semibold uppercase tracking-[.08em] text-ln-mute">
                Vacunación:
              </span>
              <ConfidenceBadge tier={latestVaccinationTier} />
            </div>
          )}

          {/* T-4.3: Origin-org badge — STREAMED (#16a). Below the fold and off
              the LCP path; resolveOriginOrg walks up to three rows. null fallback
              — the badge is absent for most pets, so a skeleton would only flash
              then vanish. Same resolver + gate + markup as the former block. */}
          <Suspense fallback={null}>
            <CredentialOriginOrg petId={pet.id} />
          </Suspense>

          {/* "Found this pet?" action area. Disputed pets (D2 hardening,
              red-team 2026-07) never get the owner-contact-relay form: while
              titularidad is under review the system must not relay a finder's
              name/contact to the contested owner. PO 2026-07-24: instead of a
              dead-end notice, they get the neutral dispute-tip form — the
              submission lands on the dispute case for the reviewing authority
              only (see DisputeTipForm / report-dispute-tip.ts).

              A DECEASED pet gets neither. There is no street action for an
              animal that died, and asking a stranger to "avisarle al dueño" that
              they found it is the cruelest thing this page could say to the
              person who registered the death. The sticky action bar already had
              this rule (CredentialActionBar: "deceased → page renders NO bar");
              this inline block, one screen below it, never received it — so
              Kabosu (2024), Hachikō (1935) and a pet whose death was recorded
              minutes earlier all still offered it (master test CIU, B0b/B0c/
              B5-c — three independent sightings of one missing guard). */}
          {pet.status === "deceased" ? null : pet.inCustodyDispute ? (
            <div
              data-section="found-form-disputed"
              className="border-t border-ln-line bg-ln-stripe px-4 py-3.5"
            >
              {/* id: the sticky bar's "dispute" action opens + scrolls here;
                  scroll-mt clears the sticky emergency banner when present. */}
              <details id={DISPUTE_SECTION_ID} className="group scroll-mt-24">
                <summary className="flex cursor-pointer list-none select-none items-center justify-between gap-3">
                  <div>
                    <p className="m-0 font-ln-serif text-md font-semibold text-ln-ink">
                      ¿Tenés información sobre esta mascota?
                    </p>
                    <p className="mt-0.5 text-sm text-ln-mute">{DISPUTE_TIP_INTRO}</p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0 text-lg text-ln-mute transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                </summary>
                <div className="mt-3 border-t border-ln-line pt-3.5">
                  <DisputeTipForm publicToken={publicToken} />
                </div>
              </details>
            </div>
          ) : (
            <div className="border-t border-ln-line bg-ln-stripe px-4 py-3.5">
              {/* id: the sticky bar's tier-0 "report" action opens + scrolls to
                this existing form (no new flow); scroll-mt clears the sticky
                emergency banner when present. */}
              <details id={REPORT_SECTION_ID} className="group scroll-mt-24">
                <summary className="flex cursor-pointer list-none select-none items-center justify-between gap-3">
                  <div>
                    <p className="m-0 font-ln-serif text-md font-semibold text-ln-ink">
                      ¿Encontraste a esta mascota?
                    </p>
                    <p className="mt-0.5 text-sm text-ln-mute">Tocá acá para avisarle al dueño.</p>
                  </div>
                  <span
                    aria-hidden="true"
                    className="flex-shrink-0 text-lg text-ln-mute transition-transform group-open:rotate-90"
                  >
                    ›
                  </span>
                </summary>
                <div className="mt-3 border-t border-ln-line pt-3.5">
                  <FoundPetForm publicToken={publicToken} />
                </div>
              </details>
            </div>
          )}

          {/* Credential footer */}
          <div className="px-4 py-3 text-center font-ln-mono text-xs leading-[1.7] tracking-[.02em] text-ln-faint">
            {/* "· República Argentina" used to close this line. On a card
                composed as an identity document it named the State as the
                issuing authority, which no convenio grants. The token stands
                on its own; the product's own name is already above it. */}
            CREDENCIAL PÚBLICA · miMAR · Registro Nacional de Mascotas
            <br />
            {pet.publicToken.toUpperCase()}
          </div>
        </div>
        {/* END CREDENTIAL CARD */}
      </div>

      {/* Sticky primary CTA — mobile only (<sm); desktop keeps the inline
          actions. All props pre-gated above (disclosure + D2 dispute). */}
      {actionBar && <CredentialActionBar {...actionBar} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ThrottleNotice — shown when a single IP exceeds the per-IP read limit.
// Renders a friendly message instead of a hard error. Spanish (es-AR) copy
// per project convention for user-facing copy on public surfaces.
// ---------------------------------------------------------------------------

function ThrottleNotice() {
  return (
    // Landing shell (AppShell variant=landing) owns #main-content + min-height.
    <div className="flex min-h-screen items-center justify-center bg-ln-paper font-ln-sans">
      <div className="mx-auto max-w-[400px] px-6 py-12 text-center text-ln-ink">
        {/* Real h1 (not just a styled <p>) — a screen-reader user throttled
            before any pet data loads still needs page orientation. No pet
            name is known at this point, so a generic heading is honest. */}
        <h1 className="mb-3 font-ln-serif text-lg font-semibold">Demasiadas consultas</h1>
        <p className="text-md leading-[1.6] text-ln-ink-2">
          Estás realizando demasiadas consultas desde esta conexión. Esperá unos minutos y volvé a
          intentarlo.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CredField — mono label + value row inside the identity grid
//
// Typography roles (UI review M2 consolidation): the label is the document's
// mono micro-label step (text-xs / 10px, the floor the type scale declares) and
// the value is the body step (text-md / 14px). The `mono` variant steps the
// VALUE down one step to text-sm: it renders the LIB-AR-XXXXXXXX token, whose
// fixed-advance glyphs are materially wider than the sans face at the same
// nominal size, and the grid cell is half of a two-column layout at 390px.
// That is an optical fit for one variant of the value role, not a second role.
// ---------------------------------------------------------------------------

function CredField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="m-0 font-ln-mono text-xs uppercase tracking-[.06em] text-ln-faint">{label}</p>
      <p
        className={`mt-px break-words font-medium text-ln-ink ${
          mono ? "font-ln-mono text-sm" : "font-ln-sans text-md"
        }`}
      >
        {value}
      </p>
    </div>
  );
}
