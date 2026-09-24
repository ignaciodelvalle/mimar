import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import Script from "next/script";

import { Icon } from "@/components/Icon";
import { type Pet, attachments, db, organizations, ownerships, petEvents, pets } from "@/db";
import { ageBucketLabel, energyLabel, sizeLabel } from "@/lib/infra/adoption-listing";
import { withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { hasActiveMicrochip } from "@/lib/infra/pet-identifiers";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { isPublicTokenReadThrottled } from "@/lib/infra/public-token-throttle";
import { reportError } from "@/lib/infra/report-error";
import { resolveSiteUrl } from "@/lib/infra/site-url";
import { petPhotoUrl } from "@/lib/infra/storage";
import {
  type PermanentCondition,
  isPermanentCondition,
  permanentConditionLabel,
} from "@/lib/reference/permanent-conditions";
import { createClient } from "@/lib/supabase/server";
import { formatDate, sexLabel, speciesLabel, sterilizedLabel } from "@/lib/utils/format";
import { serializeJsonLd } from "@/lib/utils/json-ld";
import { livesWithFamilyUnder } from "@/src/modules/adoption/domain/listing-rules";
import { findOpenSponsorship } from "@/src/modules/adoption/infrastructure/rehome-sponsorship-writer";
import { and, desc, eq, isNull } from "drizzle-orm";

import { AdoptionShareRow } from "./AdoptionShareRow";
import { ApplyButton } from "./ApplyButton";

const SITE_URL = resolveSiteUrl();

// Individual adoption ficha — mirrors the listing-visibility guards so a
// pet that's gone unlisted, paused, fell into a custody dispute, etc.,
// returns 404 instead of leaking. The exception (D7.2) is a gentle
// "ya fue adoptada" message when the pet has a recent adoption_finalized
// event, instead of a cold 404.
//
// Cache policy: ALWAYS LIVE. force-dynamic + `Cache-Control: no-store` (stamped
// in middleware for the /adoptar subtree — see lib/infra/public-cache-policy.ts)
// so an unlisted/paused/adopted pet stops resolving to the public ficha promptly.
export const dynamic = "force-dynamic";

// DB time budget for generateMetadata, at parity with /p/[publicToken], which
// bounds its own metadata read at the same number for the same reason: one HTTP
// request runs this function AND the component, so an unbounded read here hangs
// or 500s a page whose body already knows how to degrade. The generic title is
// the honest fallback — the share card loses the pet's name, nothing else.
const METADATA_BUDGET_MS = 2500;

/** The fallback title, used for "no such listing" and for a degraded read alike. */
const GENERIC_METADATA_TITLE = "Adopción — miMAR";

/**
 * Open Graph metadata for the adoption ficha.
 *
 * NOT BEHIND THE THROTTLE, AND THAT IS THE SAME JUDGEMENT /p MADE (2026-08-25).
 * One HTTP request runs both this and the component below; `enforceRateLimit` is
 * a counter INCREMENT, so consulting it twice would bill a single visit twice
 * and halve the effective ceiling for every legitimate visitor. The residual —
 * metadata as a thin existence side-channel past a throttled caller — is the one
 * /p accepts and documents, and closing it needs a check-without-increment mode
 * on the limiter rather than a second call here. See the note in
 * `__tests__/public-token-throttle-coverage.test.ts` ("SCOPED TO THE PAGE
 * COMPONENT, DELIBERATELY") and the residual in lib/infra/public-token-throttle.ts.
 *
 * What it does NOT accept, and did until now, is being UNBUDGETED. /p wraps its
 * metadata read in METADATA_BUDGET_MS and degrades to a generic title; this one
 * ran naked, so a slow or failing DB turned a share-preview read into a hung or
 * 500'd public page — on the surface whose body is written to degrade gracefully.
 * Same budget, same fail-soft, same reasoning.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ petToken: string }>;
}) {
  const { petToken } = await params;
  let row:
    | {
        name: string;
        species: Pet["species"];
        story: string | null;
        jurisdictionLocality: string | null;
        primaryPhotoStoragePath: string | null;
      }
    | undefined;
  try {
    [row] = await withDbBudgetOrThrow(
      (async () =>
        db
          .select({
            name: pets.name,
            species: pets.species,
            story: pets.adoptionStory,
            jurisdictionLocality: pets.jurisdictionLocality,
            primaryPhotoStoragePath: attachments.storagePath,
          })
          .from(pets)
          .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
          .where(publicPetByToken(petToken))
          .limit(1))(),
      METADATA_BUDGET_MS,
      "GET /adoptar/[petToken] metadata",
    );
  } catch (err) {
    reportError("adoption-ficha/metadata", err, { petToken });
    return { title: GENERIC_METADATA_TITLE };
  }
  if (!row) return { title: GENERIC_METADATA_TITLE };
  const title = `Adoptá a ${row.name} — miMAR`;
  const desc =
    row.story?.slice(0, 150) ??
    `Conocé a ${row.name}, ${speciesLabel(row.species).toLowerCase()} en adopción${
      row.jurisdictionLocality ? ` en ${row.jurisdictionLocality}` : ""
    }.`;
  const ogImage = petPhotoUrl(row.primaryPhotoStoragePath) ?? undefined;
  return {
    title,
    description: desc,
    openGraph: { title, description: desc, images: ogImage ? [ogImage] : [] },
  };
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export default async function AdoptarFichaPage({
  params,
}: {
  params: Promise<{ petToken: string }>;
}) {
  const { petToken } = await params;

  // THE FIFTH ANONYMOUS PUBLIC-TOKEN SURFACE (added 2026-08-25).
  //
  // It was exempt, with a reason that read well and was half an argument:
  // "resolves only pets that are adoption-LISTED, and listed pets are already
  // enumerable from the public /adoptar catalog, so this surface reveals nothing
  // the catalog does not." True about DISCLOSURE. It says nothing about the
  // other two things a limiter is for on this surface:
  //
  //   · it is still a TOKEN ORACLE. A caller walking the 31^8 space learns, per
  //     request, whether a token exists AND is listed — the catalog answers
  //     "which pets are listed", never "is DIM-XXXX-XXXX one of them";
  //   · it is still unbounded WORK. Two joined queries plus an ownership lookup
  //     plus a sponsorship read, on `force-dynamic`, for anyone who cares to
  //     ask, at any rate. Rate limiting here is a cost control as much as a
  //     privacy one, which is exactly what the four siblings' limiter is.
  //
  // Same bucket shape and the same default ceiling as those four: its own bucket
  // so a scraper of THIS page cannot spend a lost-pet finder's budget on /p, and
  // PUBLIC_TOKEN_READ_LIMIT because the caller is the same person on the same
  // carrier NAT. Fails open on limiter infrastructure failure, like its
  // siblings — see lib/infra/public-token-throttle.ts.
  //
  // BEFORE the lookup, not after: the three surfaces that got this wrong
  // (report-pet-sighting, report-dispute-tip, encontre/action) each resolved the
  // token first and consulted the limiter afterwards, which is an unbounded
  // oracle with a limiter bolted to the far side of it.
  if (await isPublicTokenReadThrottled("public_token_adoptar")) {
    return (
      <main className="mx-auto max-w-lg px-4 py-10">
        <h1 className="text-title font-semibold text-ln-ink">Demasiadas consultas</h1>
        <p className="mt-2 text-md text-ln-mute">
          Recibimos muchas consultas desde tu conexión. Esperá un momento y volvé a intentarlo.
        </p>
      </main>
    );
  }

  // Pet first, custody second — two lookups on purpose. The old single query
  // inner-joined ownerships on petId alone, so for a pet transferred between
  // orgs `.limit(1)` returned one ARBITRARY ownership row — in the wild, the
  // ORIGINAL shelter's ended row: the public detail credited "Refugio Patitas
  // del Norte · en custodia desde 7/7" while the catalog card, the receiving
  // org's profile, and the transfer hub all said Puerto Madero had accepted
  // custody on 8/7 (found live by the 9-role external run, 2026-08-18). The
  // card that exists to say who answers for this animal named an org that no
  // longer does. Splitting the lookup also keeps the D7.2 "ya encontró hogar"
  // branch reachable after an adoption ends the shelter_custody row — a
  // current-custody inner join alone would have turned that stale-link soft
  // page into a hard 404.
  const [petRow] = await db
    .select({
      pet: pets,
      primaryPhotoStoragePath: attachments.storagePath,
    })
    .from(pets)
    .leftJoin(attachments, eq(attachments.id, pets.primaryPhotoId))
    // PO-4: soft-deleted pets do not resolve on any public surface.
    .where(publicPetByToken(petToken))
    .limit(1);

  if (!petRow) notFound();
  const row = petRow;
  const { pet } = petRow;

  // CURRENT custody only — same predicate pair queryAdoptionListing uses
  // (role='shelter_custody' AND ended_at IS NULL), so detail and catalog can
  // never disagree about who holds the animal.
  const [custodyRow] = await db
    .select({
      org: organizations,
      ownerStartedAt: ownerships.startedAt,
    })
    .from(ownerships)
    .innerJoin(organizations, eq(organizations.id, ownerships.ownerOrganizationId))
    .where(
      and(
        eq(ownerships.petId, pet.id),
        eq(ownerships.role, "shelter_custody"),
        isNull(ownerships.endedAt),
      ),
    )
    // Deterministic tiebreak: two open custody rows should not exist, but a
    // bare `.limit(1)` deciding by heap order is exactly the shape that
    // caused the original stale-custodian bug — if the invariant ever
    // breaks, the MOST RECENT custody wins, consistently.
    .orderBy(desc(ownerships.startedAt))
    .limit(1);
  const org = custodyRow?.org ?? null;
  const ownerStartedAt = custodyRow?.ownerStartedAt ?? null;

  // Where the animal LIVES (rehome-by-titular, spec REQ-12). The custody row
  // above says who answers for the listing; it does not say who holds the
  // animal. A rehome sponsorship gives the org that row while the animal stays
  // with its family, so the "refugio responsable / org locality / en custodia
  // desde" card would state three things that are only true of an intake.
  // Decided on the SPINE — an unmatched `rehome_sponsorship_started` naming
  // this very custody row — never on the owner+shelter_custody shape, which
  // also describes a decomiso. ONE predicate with the catalog card (design
  // R5): `livesWithFamilyUnder`, which also requires the sponsor to be THIS
  // custodian.
  const openSponsorship = org ? await findOpenSponsorship(pet.id, db) : null;
  const livesWithFamily = livesWithFamilyUnder(openSponsorship, org?.id);

  // D7.2 — if a recent adoption_finalized exists, render a soft "ya
  // encontró hogar" instead of 404. Captures the case of someone clicking
  // a stale share link.
  const [recentFinalize] = await db
    .select({ recordedAt: petEvents.recordedAt })
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "adoption_finalized")))
    .orderBy(desc(petEvents.recordedAt))
    .limit(1);
  const recentlyAdopted =
    recentFinalize && Date.now() - recentFinalize.recordedAt.getTime() < SEVEN_DAYS_MS;

  // Paused by org — soft "no disponible" screen instead of 404 so a visitor
  // with a stale share link gets a meaningful message (spec §2.1 CTA variants).
  // Mirrors EVERY isListable suppression guard except the pause itself:
  // custody disputes and rabies observations must keep returning 404, and a
  // recent finalization wins over the paused view (spec D7.2).
  // Both gates require a CURRENT custodian org — a pet with no active
  // shelter_custody row (adopted out, or returned to a private owner) can be
  // neither listed nor "paused", only recently-adopted or gone.
  const isPausedByOrg =
    org !== null &&
    pet.adoptionListedAt !== null &&
    pet.adoptionListingPausedAt !== null &&
    pet.status !== "deceased" &&
    pet.status !== "lost" &&
    pet.adoptionEligible === true &&
    pet.inCustodyDispute !== true &&
    pet.rabiesObservationStatus !== "in_progress" &&
    org.verified &&
    (org.orgType === "shelter" || org.orgType === "rescue_network");

  // Same listability guards as queryAdoptionListing. If any fails, fall
  // through to recently-adopted, then paused, else 404.
  const isListable =
    org !== null &&
    pet.adoptionListedAt !== null &&
    pet.adoptionListingPausedAt === null &&
    pet.status !== "deceased" &&
    pet.status !== "lost" &&
    pet.adoptionEligible === true &&
    pet.inCustodyDispute !== true &&
    pet.rabiesObservationStatus !== "in_progress" &&
    org.verified &&
    (org.orgType === "shelter" || org.orgType === "rescue_network");

  if (!isListable || org === null) {
    if (recentlyAdopted) {
      return <RecentlyAdopted name={pet.name} />;
    }
    if (isPausedByOrg && org !== null) {
      return <PausedView name={pet.name} orgName={org.displayName} />;
    }
    notFound();
  }

  // Auth check — to surface the correct CTA label for anonymous visitors.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const isAuthenticated = user !== null;

  const photoUrl = petPhotoUrl(row.primaryPhotoStoragePath);

  // Gallery: any additional pet-scoped attachments that aren't the primary.
  // We don't sign these URLs — pet-photos bucket is public per the v1 setup.
  const extraPhotos = await db
    .select({ id: attachments.id, storagePath: attachments.storagePath })
    .from(attachments)
    .where(and(eq(attachments.petId, pet.id), isNull(attachments.eventId)))
    .limit(8);
  const galleryUrls = [photoUrl, ...extraPhotos.map((a) => petPhotoUrl(a.storagePath))]
    .filter((u): u is string => u !== null)
    .filter((u, i, arr) => arr.indexOf(u) === i);

  // Health rollup — booleans only; the full libreta is not exposed on the
  // adoption ficha.
  const [vaccinationsRow] = await db
    .select({ count: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "vaccination_administered")))
    .limit(1);
  const hasVaccinations = Boolean(vaccinationsRow);
  const [sterilizationRow] = await db
    .select({ count: petEvents.id })
    .from(petEvents)
    .where(and(eq(petEvents.petId, pet.id), eq(petEvents.eventType, "sterilization_performed")))
    .limit(1);
  const isSterilized = Boolean(sterilizationRow);
  // PO-1 (2026-08-05): the ficha states THAT the animal is chipped and nothing
  // more. It used to render a masked form of the canonical microchip (dots
  // plus its last four digits) to an anonymous visitor — the only one of the
  // 16 canonical-identifier read sites that was not gated by role. The
  // boolean-only fetch
  // is the point: the full code no longer even reaches server memory on this
  // ungated route, so no future render can leak it by accident.
  const hasMicrochip = await hasActiveMicrochip(pet.id);

  const facts: string[] = [];
  if (pet.adoptionAgeBucket) facts.push(ageBucketLabel(pet.adoptionAgeBucket, pet.sex));
  if (pet.adoptionSizeEstimate) facts.push(sizeLabel(pet.adoptionSizeEstimate));
  if (pet.adoptionEnergyLevel) facts.push(energyLabel(pet.adoptionEnergyLevel, pet.sex));

  const convivencia: Array<{ label: string; value: boolean | null }> = [
    { label: "Con chicos", value: pet.adoptionGoodWithKids },
    { label: "Con otros perros", value: pet.adoptionGoodWithDogs },
    { label: "Con gatos", value: pet.adoptionGoodWithCats },
    { label: "Necesita patio", value: pet.adoptionNeedsYard },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Animal",
    name: pet.name,
    description:
      pet.adoptionStory ??
      `Conocé a ${pet.name}, ${speciesLabel(pet.species).toLowerCase()} en adopción${
        pet.jurisdictionLocality ? ` en ${pet.jurisdictionLocality}` : ""
      }.`,
    image: petPhotoUrl(row.primaryPhotoStoragePath) ?? undefined,
    additionalType: speciesLabel(pet.species),
    gender: sexLabel(pet.sex),
    url: `${SITE_URL}/adoptar/${petToken}`,
  };

  // Per-request CSP nonce (set by middleware, Item #64) so this inline JSON-LD
  // script is allowed under script-src 'nonce-…' / 'strict-dynamic'.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <main
      className="min-h-screen pb-32 md:pb-10"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      <Script
        id="adoptar-jsonld"
        type="application/ld+json"
        nonce={nonce}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: SEO JSON-LD needs raw <script> content; serializeJsonLd() neutralises <, >, & and U+2028/U+2029 so user-supplied pet fields (name, adoptionStory) cannot break out of the script.
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
      />

      {/* Guilloché accent bar */}
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />

      <div className="max-w-3xl mx-auto px-6 py-7 space-y-[18px]">
        {/* Back link — mono eyebrow style */}
        <Link
          href="/adoptar"
          className="inline-block font-ln-mono text-sm uppercase tracking-[.06em] no-underline hover:text-[var(--color-ln-ink-2)]"
          style={{ color: "var(--color-ln-mute)" }}
        >
          ← Volver al listado
        </Link>

        {/* Gallery */}
        {galleryUrls.length > 0 ? (
          <div className="space-y-[8px]">
            {/* Hero — 4:3 aspect ratio */}
            <div
              className="relative overflow-hidden rounded-[var(--radius-input)] border"
              style={{
                aspectRatio: "4/3",
                borderColor: "var(--color-ln-line)",
                background:
                  "repeating-linear-gradient(135deg,var(--pattern-no-photo-a) 0 12px,var(--pattern-no-photo-b) 12px 24px)",
              }}
            >
              <Image
                src={galleryUrls[0]}
                alt={pet.name}
                fill
                sizes="(max-width: 480px) 100vw, 480px"
                className="object-cover"
                priority
              />
              {/* "En adopción" status chip */}
              <span
                className="absolute top-[12px] left-[12px] inline-flex items-center gap-1.5 rounded-full border px-3 py-[5px] text-sm font-semibold"
                style={{
                  background: "var(--color-ln-ok-050)",
                  color: "var(--color-ln-ok)",
                  borderColor: "var(--color-ln-ok-100)",
                  boxShadow: "0 2px 6px rgba(0,0,0,.08)",
                }}
              >
                <span
                  aria-hidden="true"
                  className="inline-block h-[6px] w-[6px] rounded-full"
                  style={{ background: "var(--color-ln-ok)" }}
                />
                En adopción
              </span>
              {/* Health rollup chips overlay */}
              <div className="absolute bottom-[12px] left-[12px] flex gap-1.5 flex-wrap">
                {hasVaccinations && (
                  <span
                    className="inline-flex items-center gap-[5px] rounded-[var(--radius-sm)] px-2.5 py-1 text-sm font-semibold"
                    style={{ background: "rgba(255,255,255,.95)", color: "var(--color-ln-ink)" }}
                  >
                    <Icon name="check" size="sm" decorative /> Vacunas al día
                  </span>
                )}
                {isSterilized && (
                  <span
                    className="inline-flex items-center gap-[5px] rounded-[var(--radius-sm)] px-2.5 py-1 text-sm font-semibold"
                    style={{ background: "rgba(255,255,255,.95)", color: "var(--color-ln-ink)" }}
                  >
                    {/* Was a hardcoded "Castrada" for every pet — a male dog
                        read "Castrada" on the public adoption ficha, two lines
                        below ageBucketLabel(…, pet.sex), which agrees. */}
                    <Icon name="check" size="sm" decorative /> {sterilizedLabel(pet.sex)}
                  </span>
                )}
                {hasMicrochip && (
                  <span
                    className="inline-flex items-center gap-[5px] rounded-[var(--radius-sm)] px-2.5 py-1 text-sm font-semibold"
                    style={{
                      background: "rgba(255,255,255,.95)",
                      color: "var(--color-ln-azul)",
                    }}
                  >
                    Con chip
                  </span>
                )}
              </div>
            </div>
            {/* Thumbnails row */}
            {galleryUrls.length > 1 && (
              <div className="grid grid-cols-4 gap-1.5">
                {galleryUrls.slice(1, 5).map((url, idx) => (
                  <div
                    key={url}
                    className="overflow-hidden rounded-[var(--radius-md)] border"
                    style={{
                      aspectRatio: "1/1",
                      borderColor: idx === 0 ? "var(--color-ln-azul)" : "var(--color-ln-line)",
                      borderWidth: idx === 0 ? "2px" : "1px",
                    }}
                  >
                    <img
                      src={url}
                      alt={`${pet.name} foto ${idx + 2}`}
                      className="w-full h-full object-cover"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className="overflow-hidden rounded-[var(--radius-input)] border flex items-center justify-center"
            style={{
              aspectRatio: "4/3",
              maxWidth: 480,
              borderColor: "var(--color-ln-line)",
              background:
                "repeating-linear-gradient(135deg,var(--pattern-no-photo-a) 0 12px,var(--pattern-no-photo-b) 12px 24px)",
            }}
          >
            <span
              className="font-ln-serif text-hero font-semibold"
              style={{ color: "var(--color-ln-mute)" }}
            >
              {pet.name.charAt(0).toUpperCase()}
            </span>
          </div>
        )}

        {/* Identity card */}
        <div
          className="rounded-[var(--radius-lg)] border px-[22px] py-5"
          style={{
            background: "var(--color-ln-card)",
            borderColor: "var(--color-ln-line)",
          }}
        >
          <h1
            className="m-0 font-ln-serif font-semibold leading-[1.04] tracking-[-0.025em]"
            style={{ fontSize: 34, color: "var(--color-ln-ink)" }}
          >
            {pet.name}
          </h1>
          {pet.breed && (
            <p
              className="mt-1 mb-2.5 text-md font-medium"
              style={{ color: "var(--color-ln-ink-2)" }}
            >
              {pet.breed}
            </p>
          )}
          {/* Meta chips */}
          <div className="flex flex-wrap gap-1.5">
            <span
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-sm"
              style={{
                color: "var(--color-ln-ink-2)",
                background: "var(--color-ln-stripe)",
                borderColor: "var(--color-ln-line-2)",
              }}
            >
              {speciesLabel(pet.species)}
            </span>
            <span
              className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-sm"
              style={{
                color: "var(--color-ln-ink-2)",
                background: "var(--color-ln-stripe)",
                borderColor: "var(--color-ln-line-2)",
              }}
            >
              {sexLabel(pet.sex)}
            </span>
            {facts.map((f) => (
              <span
                key={f}
                className="rounded-[var(--radius-sm)] border px-2.5 py-1 text-sm"
                style={{
                  color: "var(--color-ln-ink-2)",
                  background: "var(--color-ln-stripe)",
                  borderColor: "var(--color-ln-line-2)",
                }}
              >
                {f}
              </span>
            ))}
          </div>
          {(pet.color || pet.distinguishingFeatures) && (
            <p className="mt-2.5 text-sm" style={{ color: "var(--color-ln-mute)" }}>
              {[pet.color, pet.distinguishingFeatures].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>

        {/* Story — accent left-border card */}
        {pet.adoptionStory && (
          <div
            className="rounded-[var(--radius-lg)] border border-l-[3px] px-5 py-[18px]"
            style={{
              background: "var(--color-ln-card)",
              borderColor: "var(--color-ln-line)",
              borderLeftColor: "var(--color-ln-azul)",
            }}
          >
            <p
              className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.12em]"
              style={{ color: "var(--color-ln-mute)" }}
            >
              Su historia
            </p>
            <h2
              className="m-0 mb-3 font-ln-serif font-semibold text-lg tracking-[-0.01em]"
              style={{ color: "var(--color-ln-ink)" }}
            >
              Sobre {pet.name}
            </h2>
            <p
              className="m-0 text-md leading-[1.6] whitespace-pre-wrap"
              style={{ color: "var(--color-ln-ink-2)" }}
            >
              {pet.adoptionStory}
            </p>
          </div>
        )}

        {/* Health section */}
        <div
          className="rounded-[var(--radius-lg)] border px-5 py-[18px]"
          style={{ background: "var(--color-ln-card)", borderColor: "var(--color-ln-line)" }}
        >
          <p
            className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.12em]"
            style={{ color: "var(--color-ln-mute)" }}
          >
            Estado médico
          </p>
          <h2
            className="m-0 mb-3.5 font-ln-serif font-semibold text-lg tracking-[-0.01em]"
            style={{ color: "var(--color-ln-ink)" }}
          >
            Salud
          </h2>
          <ul
            className="grid grid-cols-1 sm:grid-cols-2 gap-1"
            style={{ listStyle: "none", padding: 0, margin: 0 }}
          >
            {/* "Vacunación al día" was a claim the boolean cannot support: like
                its two siblings below, `hasVaccinations` is the PRESENCE OF A
                RECORD, so an animal with one 2019 dose showed a green "al día"
                to someone deciding whether to adopt. The S1-F13 note below
                already named this for the absent case and stopped there; the
                positive case kept the claim. Wording matched to the credential
                (`app/(public)/p/[publicToken]/page.tsx`), which renders the same
                field as "Con registros", and to the mobile twin. */}
            <HealthRow
              label="Vacunación"
              ok={hasVaccinations}
              detail={hasVaccinations ? "Con registros" : undefined}
            />
            {/* `detail` era `isSterilized ? undefined : undefined` — las dos
                ramas iguales, o sea codigo muerto. El estado ausente ahora lo
                dice HealthRow. */}
            <HealthRow label="Castración" ok={isSterilized} />
            <HealthRow label="Microchip miMAR" ok={hasMicrochip} />
          </ul>
          <p className="mt-3.5 text-sm" style={{ color: "var(--color-ln-mute)" }}>
            El detalle clínico completo se comparte al finalizar la adopción.
          </p>
        </div>

        {/* Requirements + convivencia */}
        {(pet.adoptionRequirements || convivencia.some((c) => c.value !== null)) && (
          <div
            className="rounded-[var(--radius-lg)] border px-5 py-[18px]"
            style={{ background: "var(--color-ln-card)", borderColor: "var(--color-ln-line)" }}
          >
            <p
              className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.12em]"
              style={{ color: "var(--color-ln-mute)" }}
            >
              Cómo es en el día a día
            </p>
            <h2
              className="m-0 mb-3 font-ln-serif font-semibold text-lg tracking-[-0.01em]"
              style={{ color: "var(--color-ln-ink)" }}
            >
              Qué necesita su nuevo hogar
            </h2>
            {pet.adoptionRequirements && (
              <p
                className="mb-3 text-md leading-[1.6] whitespace-pre-wrap"
                style={{ color: "var(--color-ln-ink-2)" }}
              >
                {pet.adoptionRequirements}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {convivencia
                .filter((c) => c.value !== null)
                .map((c) => (
                  <ConvivenciaChip key={c.label} label={c.label} value={c.value} />
                ))}
            </div>
          </div>
        )}

        {/* Permanent conditions */}
        {pet.discloseConditionsPublicly && pet.permanentConditions.length > 0 && (
          <div
            className="rounded-[var(--radius-lg)] border px-5 py-[18px]"
            style={{ background: "var(--color-ln-card)", borderColor: "var(--color-ln-line)" }}
          >
            <p
              className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.12em]"
              style={{ color: "var(--color-ln-mute)" }}
            >
              A tener en cuenta
            </p>
            <h2
              className="m-0 mb-2 font-ln-serif font-semibold text-lg tracking-[-0.01em]"
              style={{ color: "var(--color-ln-ink)" }}
            >
              Necesidades especiales
            </h2>
            <p className="mb-3 text-sm" style={{ color: "var(--color-ln-mute)" }}>
              {pet.name} convive con condiciones permanentes que es importante que conozcas antes de
              postularte. El refugio puede contarte cómo cuidarla.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {pet.permanentConditions
                .filter(isPermanentCondition)
                .map((code: PermanentCondition) => (
                  <span
                    key={code}
                    className="inline-flex rounded-full border px-2.5 py-1 text-sm font-semibold"
                    style={{
                      background: "var(--color-ln-celeste-050)",
                      color: "var(--color-ln-azul-700)",
                      borderColor: "var(--color-ln-celeste-100)",
                    }}
                  >
                    {permanentConditionLabel(code)}
                  </span>
                ))}
            </div>
            {pet.permanentConditions.includes("otra") && pet.permanentConditionsOther && (
              <p className="mt-2.5 text-md italic" style={{ color: "var(--color-ln-ink-2)" }}>
                {pet.permanentConditionsOther}
              </p>
            )}
          </div>
        )}

        {/* Who answers for the listing — and, when that is not who holds the
            animal, where it lives (REQ-12). Sponsored: the org accompanies,
            the locality is the PET's (what the search filters on), the date
            is when the accompaniment started. Surrendered: unchanged. */}
        <div
          className="rounded-[var(--radius-lg)] border px-5 py-[18px]"
          style={{ background: "var(--color-ln-card)", borderColor: "var(--color-ln-line)" }}
        >
          <p
            className="mb-1.5 font-ln-mono text-xs font-semibold uppercase tracking-[.12em]"
            style={{ color: "var(--color-ln-mute)" }}
          >
            {livesWithFamily ? "Organización que acompaña" : "Refugio responsable"}
          </p>
          <div className="flex items-flex-start gap-3.5">
            <div
              className="flex-shrink-0 w-[56px] h-[56px] rounded-[var(--radius-lg)] grid place-items-center font-ln-serif text-2xl font-semibold text-white"
              style={{ background: "var(--color-ln-azul)" }}
            >
              {org.displayName.charAt(0).toUpperCase()}
            </div>
            <div>
              <p
                className="font-ln-serif text-lg font-semibold"
                style={{ color: "var(--color-ln-ink)" }}
              >
                {org.displayName}
              </p>
              {livesWithFamily ? (
                <>
                  {(pet.jurisdictionLocality || pet.jurisdictionProvince) && (
                    <p className="mt-1 text-sm" style={{ color: "var(--color-ln-mute)" }}>
                      {[pet.jurisdictionLocality, pet.jurisdictionProvince]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                  <p className="mt-1.5 text-sm" style={{ color: "var(--color-ln-ink-2)" }}>
                    {pet.name} vive con su familia actual. {org.displayName} publica la búsqueda de
                    hogar y evalúa a quienes se postulan.
                  </p>
                  <p
                    className="mt-1.5 font-ln-mono text-sm"
                    style={{ color: "var(--color-ln-mute)" }}
                  >
                    Acompaña la adopción desde {ownerStartedAt ? formatDate(ownerStartedAt) : "—"}
                  </p>
                  <Link
                    href={`/refugios/${org.publicToken}`}
                    className="mt-2 inline-block text-sm font-semibold no-underline hover:underline"
                    style={{ color: "var(--color-ln-azul)" }}
                  >
                    Ver perfil de la organización →
                  </Link>
                </>
              ) : (
                <>
                  {(org.jurisdictionLocality || org.jurisdictionProvince) && (
                    <p className="mt-1 text-sm" style={{ color: "var(--color-ln-mute)" }}>
                      {[org.jurisdictionLocality, org.jurisdictionProvince]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  )}
                  <p
                    className="mt-1.5 font-ln-mono text-sm"
                    style={{ color: "var(--color-ln-mute)" }}
                  >
                    En custodia desde {ownerStartedAt ? formatDate(ownerStartedAt) : "—"}
                  </p>
                  <Link
                    href={`/refugios/${org.publicToken}`}
                    className="mt-2 inline-block text-sm font-semibold no-underline hover:underline"
                    style={{ color: "var(--color-ln-azul)" }}
                  >
                    Ver perfil del refugio →
                  </Link>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Share row — WhatsApp + copy link */}
        <AdoptionShareRow fichaUrl={`${SITE_URL}/adoptar/${petToken}`} petName={pet.name} />

        {/* Fee */}
        {pet.adoptionFeeArs != null && pet.adoptionFeeArs > 0 && (
          <div
            className="rounded-[var(--radius-lg)] border px-5 py-4 space-y-[4px]"
            style={{
              background: "var(--color-ln-stripe)",
              borderColor: "var(--color-ln-line-2)",
            }}
          >
            <p className="text-md font-semibold" style={{ color: "var(--color-ln-ink)" }}>
              Adopción solidaria: ${pet.adoptionFeeArs.toLocaleString("es-AR")}
            </p>
            <p className="text-sm" style={{ color: "var(--color-ln-mute)" }}>
              Este aporte ayuda al refugio a cubrir vacunación, castración y atención veterinaria.
            </p>
          </div>
        )}

        {/* CTA — sticky on mobile, inline on desktop */}
        <section>
          <ApplyButton petToken={petToken} petName={pet.name} isAuthenticated={isAuthenticated} />
        </section>
      </div>
    </main>
  );
}

function HealthRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <li className="grid gap-2.5 py-2" style={{ gridTemplateColumns: "22px 1fr" }}>
      <span
        className="w-[22px] h-[22px] rounded-full grid place-items-center text-sm font-bold flex-shrink-0"
        style={
          ok
            ? { background: "var(--color-ln-ok-050)", color: "var(--color-ln-ok)" }
            : // NOT the err family (UI review M1, PO 2026-08-06). "Sin dato" is
              // an absence, not a fault: a shelter that has not yet loaded a
              // castration record was painting a salmon alarm dot next to a pet
              // it is trying to place. Neutral paper tokens — the same combo
              // LnBadge `neutral` and LnVstamp `unknown` already use for
              // "no sabemos".
              { background: "var(--color-ln-stripe)", color: "var(--color-ln-mute)" }
        }
      >
        {ok ? <Icon name="check" size="sm" decorative /> : "—"}
      </span>
      <div>
        <span className="text-md font-semibold" style={{ color: "var(--color-ln-ink)" }}>
          {label}
        </span>
        {/* S1-F13 — EL ESTADO SE NOMBRA, NO SE DIBUJA.
            `ok` es un booleano y los tres valores que lo alimentan son
            `Boolean(fila)`: PRESENCIA DE REGISTRO. Así que `false` no significa
            "no", significa "no hay registro" — y el guión representaba las dos
            cosas sin decir ninguna. Un refugio que todavía no cargó la
            castración se veía idéntico a una mascota que seguro no está
            castrada, y quien decide si adopta necesita esa diferencia.
            Escribirlo también vuelve innecesaria la leyenda que el glifo pedía.
            El tono neutro es decisión del PO (2026-08-06): es una ausencia, no
            una falta. */}
        {!ok && (
          <span className="block text-sm" style={{ color: "var(--color-ln-mute)" }}>
            Sin dato
          </span>
        )}
        {detail && (
          <span className="block text-sm" style={{ color: "var(--color-ln-mute)" }}>
            {detail}
          </span>
        )}
      </div>
    </li>
  );
}

function ConvivenciaChip({ label, value }: { label: string; value: boolean | null }) {
  if (value === null) return null;
  const tone = value === true ? "pos" : "warn";
  const style =
    tone === "pos"
      ? {
          background: "var(--color-ln-ok-050)",
          color: "var(--color-ln-ok)",
          borderColor: "var(--color-ln-ok-100)",
        }
      : {
          background: "var(--color-ln-warn-050)",
          color: "var(--color-ln-warn)",
          borderColor: "var(--color-ln-warn-100)",
        };
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm font-semibold"
      style={style}
    >
      {value ? (
        <Icon name="check" size="sm" decorative />
      ) : (
        <Icon name="close" size="sm" decorative />
      )}
      {label}
    </span>
  );
}

function RecentlyAdopted({ name }: { name: string }) {
  return (
    <main
      className="min-h-screen"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />
      <div className="max-w-md mx-auto px-6 py-16 text-center space-y-[16px]">
        <h1
          className="font-ln-serif font-semibold text-3xl tracking-[-0.02em]"
          style={{ color: "var(--color-ln-ink)" }}
        >
          ¡{name} ya encontró su hogar!
        </h1>
        <p className="text-md" style={{ color: "var(--color-ln-ink-2)" }}>
          Esta mascota fue adoptada hace pocos días. Hay muchas otras buscando su familia.
        </p>
        <Link
          href="/adoptar"
          className="inline-block px-5 py-[11px] rounded-[var(--radius-md)] text-md font-semibold text-white no-underline"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Ver otras en adopción
        </Link>
      </div>
    </main>
  );
}

function PausedView({ name, orgName }: { name: string; orgName: string }) {
  return (
    <main
      className="min-h-screen"
      style={{ background: "var(--color-ln-paper)", fontFamily: "var(--font-ln-sans)" }}
    >
      <div
        aria-hidden="true"
        className="h-[4px]"
        style={{
          background:
            "repeating-linear-gradient(90deg,var(--color-ln-azul) 0 2px,transparent 2px 4px),var(--color-ln-celeste)",
        }}
      />
      <div className="max-w-md mx-auto px-6 py-16 text-center space-y-[16px]">
        <div
          className="inline-block rounded-full px-4 py-[7px] text-md font-semibold"
          style={{
            background: "var(--color-ln-warn-050)",
            color: "var(--color-ln-warn)",
            border: "1px solid var(--color-ln-warn-100)",
          }}
        >
          No disponible por ahora
        </div>
        <h1
          className="font-ln-serif font-semibold text-3xl tracking-[-0.02em]"
          style={{ color: "var(--color-ln-ink)" }}
        >
          {name} no está disponible en este momento
        </h1>
        <p className="text-md" style={{ color: "var(--color-ln-ink-2)" }}>
          {orgName} pausó temporalmente la adopción de {name}. Podés volver más adelante o explorar
          otras mascotas en adopción.
        </p>
        <Link
          href="/adoptar"
          className="inline-block px-5 py-[11px] rounded-[var(--radius-md)] text-md font-semibold text-white no-underline"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Ver otras en adopción
        </Link>
      </div>
    </main>
  );
}
