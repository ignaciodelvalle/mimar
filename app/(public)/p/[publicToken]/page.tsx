// Public credential page — Tier 0 view by default. When pet.status === 'lost'
// the page promotes to Tier 1: owner contact info governed by the five
// disclose_*_when_lost preference columns on the pets row, per spec §7 and
// AGENTS.md → "Privacy tiers".
//
// Three public levels of ONE card (PO 2026-10-03, cell rule 2026-10-04).
// Same paper, band, photo · name · right-hand cell. The card is the document;
// finder verbs sit BELOW it (same law as the owner PetActionRow).
//
// The right-hand cell is `resolveCredentialRightCell`:
//   qr    the pet's own /p/ URL, drawn server-side. Default, and also Tier 2.
//   ping  lost, last location disclosed, and a coordinate exists.
//   none  deceased — no mount; the name stays centred.
// Never an empty box. Tier 2's "Nivel 2 · Datos médicos" is a chip beside
// the situation pill, not the cell.
//
//   0  default scan — breed/age; Microchip only if Sí; Color if set; QR.
//      Found tile under the card.
//   1  lost on top of 0 — situation chip + PublicLostSections (facts only).
//      Ping when last-seen coords are disclosed; otherwise the QR.
//      Lo tengo · Lo vi · Llamar under the card. No map, no Google Maps.
//   2  owner opt-in (`tier2Public*`) — the same single face as 0/1 plus the
//      "Nivel 2 · Datos médicos" chip and the AGGREGATE medical summary
//      (Tier2MedicalView). Lost + nivel 2 keeps the nivel-1 lost body, and a
//      disclosed point still takes the cell (ping) while the chip stays.
//
// No level flips, prints an MRZ, lists per-event history or shows trips. Those
// were parked by the privacy review of 2026-10-06 (dim-interno
// docs/plans/parked/p-libreta-viajes-mrz-cursor-2026-10.patch): the per-row
// history carried the previous microchip number, vet and clinic names and
// clinical free text to anonymous viewers, and the MRZ encodes the birth month.
//
// Privacy posture (active pets): NO owner PII, NO microchip number, NO scan
// history, NO locality (that is a lost-mode disclosure, gated by
// discloseLastLocationWhenLost inside PublicLostSections). Medical data is the
// aggregate Tier-2 summary only.
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
import { PublicDocumentBand } from "@/components/credential/PublicDocumentBand";
import { PublicLostSections, formatLostSince } from "@/components/pet-profile/PublicLostSections";
import { DegradedFallback } from "@/components/ui/DegradedFallback";
import { LnVstamp } from "@/components/ui/StatusFlag";
import { deriveRabiesSemaphore, isRabiesAtRisk } from "@/lib/domain/credential-badges";
import { publicPlaceReference } from "@/lib/domain/public-place-reference";
import { publicTokenThrottle } from "@/lib/infra/public-token-throttle";
import { credentialQrUrl } from "@/lib/infra/site-url";
import { resolveLostSpecialConditions } from "@/lib/reference/permanent-conditions";
import { BRANDING } from "@/lib/ui/branding";
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
} from "@/lib/utils/format";
import { lookupPublicCredential } from "@/src/modules/pets/application/read/lookup-public-credential";
import { isObservationOpen } from "@/src/modules/surveillance/domain/rabies-observation";
import {
  chromeForSurface,
  credentialSituationKey,
  fieldSlots,
  mayAnnounceSituation,
  resolveCredentialRightCell,
} from "@dim/contract/credential";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { Suspense } from "react";
import {
  CredentialActionBar,
  type CredentialActionBarProps,
  MEDICAL_SECTION_ID,
} from "./CredentialActionBar";
import { CredentialPhoto } from "./CredentialPhoto";
import {
  CredentialOriginOrg,
  CredentialTier2Medical,
  CredentialTier2MedicalSkeleton,
} from "./CredentialStreamedSections";
import { DegradedCredentialCard } from "./DegradedCredentialCard";
import { PublicCredentialActions } from "./PublicCredentialActions";
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
    openCustodyEpisodeRows,
    rabiesEvents,
    serviceDog,
    lostContext,
    lostTattooPhotoUrl,
    registryClaim,
  } = data;

  // Tri-state antirrábica vigencia (pet-state-header R4). One boolean of the
  // single legally-mandated vaccine — no dates, no vet, no other vaccine
  // (privacy proportionality argued in the spec). Every render, and the LOST
  // one above all: a finder bitten while catching the animal needs it for the
  // bite protocol. Cursor's redesign dropped it; restored 2026-10-06.
  const rabiesSemaphore = deriveRabiesSemaphore(rabiesEvents, new Date());

  const hasMicrochip = canonicalIds.microchip !== null;

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
  // Nivel 2 wins over 1: a lost pet whose owner opened the medical face is
  // still the locked nivel-2 card, with the lost body on the front.
  const publicLevel: 0 | 1 | 2 = tier2Active ? 2 : isLost ? 1 : 0;

  const rightCell = resolveCredentialRightCell({
    status: pet.status,
    discloseLastLocation: pet.discloseLastLocationWhenLost,
    lastLocation: lostContext ? { lat: lostContext.lostLat, lng: lostContext.lostLng } : null,
  });
  // Same absolute-URL + inline-SVG pattern as the landing hero. Only the QR
  // cell needs it; a ping or a memorial does not encode a code.
  const qrSvg =
    rightCell === "qr"
      ? await QRCode.toString(credentialQrUrl(pet.publicToken), {
          type: "svg",
          margin: 1,
          width: 160,
          errorCorrectionLevel: "Q",
        })
      : null;
  const tier2ChipTitle = !tier2Active
    ? null
    : pet.tier2PublicPermanent
      ? "El dueño habilitó la libreta médica de forma permanente"
      : tier2EnabledUntil
        ? `Habilitada hasta el ${tier2EnabledUntil.toLocaleString("es-AR", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: AR_TIME_ZONE })}`
        : "Libreta médica visible";

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
  const situationKey = credentialSituationKey(publicSituationRaw.key);
  const publicSituation =
    situationKey && !publicSituationRaw.isDefault && mayAnnounceSituation("public", situationKey)
      ? publicSituationRaw
      : null;
  const publicChrome = chromeForSurface("public");

  // ---------------------------------------------------------------------------
  // Credential — LN "warm libreta / document credential" render (single card
  // for active AND lost pets; the masthead carries the situation).
  // ---------------------------------------------------------------------------

  const breedLine = [speciesLabel(pet.species), pet.breed, sexLabel(pet.sex)]
    .filter(Boolean)
    .join(" · ");
  const ageLabel = ageYears !== null ? `${ageYears} ${pluralizeEs(ageYears, "año")}` : null;

  // PROVENANCE RIDES WITH THE CLAIM (2026-08-17, restored 2026-10-06). A dose
  // the owner typed in must not wear the same green VIGENTE seal as one a
  // matriculated vet signed: a declared dose keeps its factual word but takes
  // the neutral tone, and the `detail` suffix says which of the two it is, so
  // the qualifier never rides on colour alone. Never "Validado" for a
  // self-declared record.
  const rabiesStampValue =
    rabiesSemaphore.estado === "vigente" ? (
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
    );
  // The same claim as text — the slot value. Never "", so the antirrábica
  // stamp is always drawn.
  const rabiesStampText =
    rabiesSemaphore.estado === "vigente" || rabiesSemaphore.estado === "vencida"
      ? `${rabiesSemaphore.estado === "vigente" ? "Vigente" : "Vencida"} · ${rabiesSemaphore.respaldo === "profesional" ? "firmada" : "declarada"}`
      : rabiesSemaphore.estado === "sin-vencimiento"
        ? rabiesSemaphore.respaldo === "profesional"
          ? "Con registro firmado"
          : "Con registro declarado"
        : "Sin registro";

  // Identity stamps come from the contract's public catalogue (PUBLIC_FIELDS
  // in packages/contract/src/credential/document.ts) — the page fills values,
  // it does not choose fields. A slot with no value is not drawn: Microchip
  // only when Sí (presence, never the number), Color only when set.
  const identitySlots = fieldSlots("public", {
    rabies: rabiesStampText,
    microchipPresence: hasMicrochip ? "Sí" : "",
    color: pet.color ?? "",
  }).filter((slot) => slot.value !== "");

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
      {/* Passive scan floor only — no location prompt of any kind. The scan
          carries just the coarse IP-derived area computed server-side; W8
          (PO 2026-09-24) retired device location everywhere, so a finder's
          sighting point is placed by hand in the sighting flow. */}
      <ScanLogger publicToken={publicToken} />

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
        <div className="pc-cred" data-level={publicLevel} data-situation={publicSituation?.key}>
          {(() => {
            const credentialFront = (
              <>
                {/* LOST: the photo goes back to full width, as it was on main.
                    A finder standing over an animal matches it by its face; a
                    156px tile is not enough (PO default, review 2026-10-06).
                    Every other situation keeps the tile in the identity row. */}
                {isLost ? (
                  <div className="pc-photo-hero" data-section="lost-photo">
                    <CredentialPhoto src={photoUrl ?? null} petName={pet.name} variant="hero" />
                  </div>
                ) : null}
                <div className="pc-id" data-cell={rightCell} data-photo={isLost ? "hero" : "tile"}>
                  {isLost ? null : (
                    <div className="pc-photo-mount">
                      <CredentialPhoto src={photoUrl ?? null} petName={pet.name} />
                    </div>
                  )}
                  <div className="pc-id-copy">
                    <h1>{pet.name}</h1>
                    <p className="pc-id-token">{pet.publicToken}</p>
                  </div>
                  {rightCell === "qr" && qrSvg ? (
                    <div
                      className="pc-qr-mount"
                      data-slot="qr"
                      role="img"
                      aria-label={`Código QR de la credencial de ${pet.name}`}
                    >
                      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: server-generated QR SVG from the qrcode package, no user input. */}
                      <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                    </div>
                  ) : rightCell === "ping" ? (
                    <div className="pc-qr-mount" data-slot="ping" aria-hidden="true">
                      <div className="pc-ping">
                        <span className="pc-ping-grid" />
                        <span className="pc-ping-dot" />
                        <span className="pc-ping-ring" />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="pc-name">
                  <p className="pc-name-meta">
                    {breedLine}
                    {ageLabel && ` · ${ageLabel}`}
                  </p>
                </div>

                {publicSituation || tier2ChipTitle ? (
                  <div className="pc-chips">
                    {publicSituation ? (
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
                    ) : null}
                    {tier2ChipTitle ? (
                      <span className="pc-tier2-chip" title={tier2ChipTitle}>
                        Nivel 2 · Datos médicos
                      </span>
                    ) : null}
                  </div>
                ) : null}

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
                    lastSeenCoords={
                      pet.discloseLastLocationWhenLost ? lostContext.lastSeenCoords : null
                    }
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

                {/* Identity stamps. The heading is the ADR-7 claim tier (CT1/CT2,
                    lib/domain/credential-claims.ts): the unqualified
                    "registrada" only where a registry rule backs it AND the
                    animal carries an identifier. The antirrábica stamp leads
                    and is on every render (bite protocol). */}
                <section
                  className="pc-ident"
                  data-section="identity"
                  aria-labelledby="pc-ident-heading"
                >
                  <p id="pc-ident-heading" className="pc-ident-head">
                    {registryClaim.identityHeading}
                  </p>
                  <dl className="pc-stamps">
                    {identitySlots.map((slot) => (
                      <div
                        key={slot.id}
                        data-section={slot.id === "rabies" ? "rabies-semaphore" : undefined}
                      >
                        <dt>{slot.label}</dt>
                        <dd>{slot.id === "rabies" ? rabiesStampValue : slot.value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>

                {/* Nivel 2 — the AGGREGATE medical summary (vaccine counts,
                    sterilization, active drug names, disclosed conditions).
                    Streamed behind Suspense (#16a) so it never blocks the
                    shell / LCP photo. Never per-event rows. */}
                {publicLevel === 2 ? (
                  <div id={MEDICAL_SECTION_ID} className="scroll-mt-24">
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
                        // A permanent Nivel 2 has no window: a stale bounded
                        // date left on the row must never print "Visible hasta".
                        enabledUntil={pet.tier2PublicPermanent ? null : tier2EnabledUntil}
                        permanentConditions={pet.permanentConditions ?? []}
                        permanentConditionsOther={pet.permanentConditionsOther}
                      />
                    </Suspense>
                  </div>
                ) : null}

                {/* T-4.3: Origin-org badge — STREAMED (#16a). Every public level.
              Below the fold; resolveOriginOrg walks up to three rows. null
              fallback — the badge is absent for most pets. */}
                <Suspense fallback={null}>
                  <CredentialOriginOrg petId={pet.id} />
                </Suspense>
              </>
            );
            return (
              <>
                <PublicDocumentBand subtitle={publicChrome.subtitleFront} />
                {credentialFront}
              </>
            );
          })()}
        </div>
        {/* END CREDENTIAL CARD — finder verbs sit below the paper. */}
        {pet.status === "deceased" ? null : pet.inCustodyDispute ? (
          <PublicCredentialActions mode="dispute" publicToken={publicToken} />
        ) : isLost ? (
          <PublicCredentialActions
            mode="lost"
            petSex={pet.sex}
            finderFormHref={
              pet.allowFinderFormWhenLost && !pet.inCustodyDispute
                ? `/p/${publicToken}/encontre`
                : null
            }
            sightingFormHref={pet.inCustodyDispute ? null : `/p/${publicToken}/sighting`}
            ownerPhoneE164={
              pet.disclosePhoneWhenLost && !pet.inCustodyDispute
                ? (lostContext?.phone ?? null)
                : null
            }
            ownerEmail={
              pet.discloseEmailWhenLost && !pet.inCustodyDispute
                ? (lostContext?.email ?? null)
                : null
            }
            ownerFirstName={
              pet.discloseFirstNameWhenLost && !pet.inCustodyDispute
                ? (lostContext?.ownerFirstName ?? null)
                : null
            }
            caretakerContact={lostContext?.caretakerContact ?? null}
          />
        ) : (
          <PublicCredentialActions mode="found" publicToken={publicToken} petSex={pet.sex} />
        )}
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
    <div className="min-h-screen bg-ln-paper font-ln-sans">
      <div className="mx-auto max-w-[460px] px-4 py-6 pb-14">
        <div className="pc-cred">
          <PublicDocumentBand compact subtitle={chromeForSurface("public").subtitleFront} />
          <div className="px-5 pb-6">
            <h1 className="mb-3 font-ln-serif text-lg font-semibold text-ln-ink">
              Demasiadas consultas
            </h1>
            <p className="text-md leading-[1.6] text-ln-ink-2">
              Estás realizando demasiadas consultas desde esta conexión. Esperá unos minutos y volvé
              a intentarlo.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
