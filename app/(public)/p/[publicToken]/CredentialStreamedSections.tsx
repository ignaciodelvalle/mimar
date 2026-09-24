// Streamed (Suspense) sections of the PUBLIC credential page (/p/[publicToken]).
//
// #16a — the credential card's SHELL (guilloché frame, header/tier chip, pet
// photo LCP, name, identity + confidence rollups from the cheap Stage-1 reads)
// is emitted by page.tsx on the FIRST flush. The two remaining regions are the
// HEAVY event/vaccination projections — they must NOT block the photo, so they
// are extracted here as async server components rendered behind <Suspense> in
// page.tsx:
//
//   • CredentialTier2Medical — the owner-opt-in Tier-2 medical summary. Runs the
//     full vaccination history + medications + sterilization queries and folds
//     event_amended corrections (WAVE D1) exactly as the inline block did, then
//     renders <Tier2MedicalView>. Only mounted when tier2Active (a pet-row flag
//     resolved in the shell), so the skeleton never flashes for Tier-0 pets.
//
//   • CredentialOriginOrg — the origin-shelter badge. resolveOriginOrg walks up
//     to three rows (custody → adoption → org); below the fold, so it streams
//     with a null fallback.
//
// Byte-for-byte the same rendered output as the previous inline code — only the
// await boundary moved. This file is a sibling of page.tsx (page.tsx exports
// only its default component; the streamed pieces live here so they stay
// import-testable without adding page exports).

import { and, eq, sql } from "drizzle-orm";

import { Skeleton } from "@/components/ui/Skeleton";
import { db, petEvents } from "@/db";
import type { Pet } from "@/db";
import { loadWithTimeout } from "@/lib/analytics/analytics-load";
import { deriveActiveMedications } from "@/lib/domain/credential-badges";
import { computeVaccinationSummary, hasAnyVaccineRecord } from "@/lib/domain/libreta-health-status";
import { overlayAmendments } from "@/lib/infra/amendment";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { resolveOriginOrg, shouldShowOriginOrgBadge } from "@/lib/infra/origin-org";
import { reportError } from "@/lib/infra/report-error";
import { Tier2MedicalView } from "./Tier2MedicalView";

// ---------------------------------------------------------------------------
// CredentialTier2Medical — Tier 2 medical summary (streamed).
// Mirrors the former page.tsx tier2 block: FULL vaccination history feeds the
// SAME computeVaccinationSummary the owner libreta uses (bug 3), with the pet's
// event_amended rows overlaid so a corrected dose/medication supersedes on the
// public credential too. Wrapper <div className="border-t border-ln-line-2">
// is preserved so the section keeps its exact card seam.
// ---------------------------------------------------------------------------

export async function CredentialTier2Medical({
  petId,
  sex,
  species,
  jurisdictionProvince,
  jurisdictionLocality,
  enabledUntil,
  permanentConditions,
  permanentConditionsOther,
}: {
  petId: string;
  /** Carried so the sterilization line can agree in gender (sterilizedLabel). */
  sex: Pet["sex"];
  species: Pet["species"];
  jurisdictionProvince: string | null;
  jurisdictionLocality: string | null;
  enabledUntil: Date | null;
  permanentConditions: readonly string[];
  permanentConditionsOther: string | null;
}) {
  // Run the tier2 queries concurrently — none depends on the others. Each
  // clinical query selects the full overlay shape (id/eventType/occurredAt/
  // payload) and is folded with the pet's event_amended rows (WAVE D1).
  //
  // Fail-soft (public-surface resilience): this section streams AFTER the
  // shell flushed — an uncaught throw here would swap the WHOLE page for the
  // error boundary client-side. A DB failure instead renders an honest
  // degraded strip; the credential shell the finder needs stays up.
  //
  // BOUNDED as well as caught (2026-08-09). The try/catch covered the axis that
  // throws and left the one that HANGS wide open — which is the axis the
  // staging outage actually used. A hung await here never reaches the catch: it
  // just leaves the Suspense skeleton spinning forever on the single most
  // important public surface in the product, and writes nothing to the logs.
  // 6s: a finder who scanned a collar in the street is the reader here.
  const tier2Load = await loadWithTimeout(
    runTier2Queries(petId, jurisdictionProvince, jurisdictionLocality),
    6_000,
  );
  if (!tier2Load.ok) {
    if (tier2Load.reason === "error") {
      reportError("public-credential/tier2-medical", new Error("tier2 queries failed"), { petId });
    }
    return (
      <output
        data-section="tier2-degraded"
        className="block border-t border-ln-line-2 bg-ln-warn-050 px-4 py-3"
      >
        <p className="m-0 font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-ln-warn">
          Datos incompletos
        </p>
        <p className="mt-1 text-sm text-ln-ink-2">
          No pudimos cargar la libreta médica. Reintentá en unos segundos.
        </p>
      </output>
    );
  }
  const [vaccineEvents, sterilRows, medRows, amendmentEvents, dueSoonWindowRule] = tier2Load.value;

  // SINGLE SHARED DERIVATION (bug 3): the exact function + inputs the owner
  // libreta uses — corrections folded first, then catalog/due-date classification.
  const summary = computeVaccinationSummary(
    overlayAmendments([...vaccineEvents, ...amendmentEvents]),
    species,
    new Date(),
    dueSoonWindowRule.payload.days,
  );

  return (
    <div className="border-t border-ln-line-2">
      <Tier2MedicalView
        enabledUntil={enabledUntil}
        vaccineSummary={{
          active: summary.active,
          expired: summary.expired,
          dueSoon: summary.dueSoon,
          missing: summary.missing,
        }}
        hasVaccineRecords={hasAnyVaccineRecord(summary)}
        isSterilized={sterilRows.length > 0}
        sex={sex}
        activeMedications={deriveActiveMedications([...medRows, ...amendmentEvents])}
        permanentConditions={permanentConditions ?? []}
        permanentConditionsOther={permanentConditionsOther}
      />
    </div>
  );
}

// runTier2Queries — the five concurrent tier2 reads, extracted so the section
// body can bound them with ONE try/catch (fail-soft above).
function runTier2Queries(
  petId: string,
  jurisdictionProvince: string | null,
  jurisdictionLocality: string | null,
) {
  return Promise.all([
    // FULL vaccination history — same input the owner's libreta feeds into
    // computeVaccinationSummary. Type-narrowed, so it stays cheap at scale.
    db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "vaccination_administered"))),
    db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "sterilization_performed")))
      .limit(1),
    // Active medications: started without a referencing stop.
    db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, petId),
          sql`${petEvents.eventType} IN ('medication_started','medication_stopped')`,
        ),
      ),
    db
      .select({
        id: petEvents.id,
        eventType: petEvents.eventType,
        occurredAt: petEvents.occurredAt,
        payload: petEvents.payload,
      })
      .from(petEvents)
      .where(and(eq(petEvents.petId, petId), eq(petEvents.eventType, "event_amended"))),
    // Same jurisdiction-resolved window the owner's libreta uses — the two
    // surfaces MUST share the whole derivation, thresholds included.
    resolveBusinessRule("due_soon_window", {
      country: "AR",
      province: jurisdictionProvince,
      locality: jurisdictionLocality,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// CredentialTier2MedicalSkeleton — Suspense fallback for the section above.
// Reserves the height of the always-present base (eyebrow + heading + 2 stat
// cards) so the sections below it do not jump when the medical summary streams
// in. Only ever shown for tier2-enabled pets (content is guaranteed to follow),
// so there is no skeleton-then-nothing flash.
// aria-busy + sr-only "Cargando…" mirrors the repo loading.tsx idiom.
// ---------------------------------------------------------------------------

export function CredentialTier2MedicalSkeleton() {
  return (
    <output
      aria-busy="true"
      aria-label="Cargando…"
      className="block border-t border-ln-line-2 px-4 py-3.5"
    >
      <span className="sr-only">Cargando…</span>
      <Skeleton w="62%" h="10px" radius="3px" className="mb-1.5" />
      <Skeleton w="48%" h="16px" radius="3px" className="mb-1" />
      <Skeleton w="34%" h="11px" radius="3px" className="mb-3" />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
        <Skeleton w="100%" h="64px" radius="var(--radius-sm)" />
        <Skeleton w="100%" h="64px" radius="var(--radius-sm)" />
      </div>
    </output>
  );
}

// ---------------------------------------------------------------------------
// CredentialOriginOrg — T-4.3 origin-shelter badge (streamed).
// Same resolver + gate (verified AND tier0ShowOriginOrg) and same markup as the
// former inline block; returns null when no org resolves or the gate is closed.
// The avatar stays a raw <img> on purpose: organizations.avatar_url is a
// free-text column (uncertain host), the image is a 28px decorative avatar below
// the fold, and next/image would add a host-allowlist failure mode on the hot
// path for no byte or LCP benefit.
// The label/value pair below used to carry raw 9px/13px arbitrary sizes, moved
// here verbatim from the inline block and grandfathered in the design-token
// ratchet. They now use the credential's shared role scale: text-xs (10px) for
// the mono micro-label, text-md (14px) for the value — the same two steps every
// other label/value row on this document uses.
// ---------------------------------------------------------------------------

export async function CredentialOriginOrg({ petId }: { petId: string }) {
  // Fail-soft: streamed after the shell — a throw would swap the whole page
  // for the error boundary. The badge is optional decoration (absent for most
  // pets), so on DB failure it logs and stays absent; nothing real is faked.
  //
  // BOUNDED too, and tightly: resolveOriginOrg walks up to three rows for a
  // decorative badge below the fold. There is no version of this credential
  // where waiting on it is worth a held stream. 3s, then it is simply absent —
  // which is what it already is for most pets.
  const originLoad = await loadWithTimeout(resolveOriginOrg(petId), 3_000);
  if (!originLoad.ok) {
    if (originLoad.reason === "error") {
      reportError("public-credential/origin-org", new Error("origin org lookup failed"), { petId });
    }
    return null;
  }
  const originOrg = originLoad.value;
  if (!shouldShowOriginOrgBadge(originOrg) || !originOrg) return null;

  return (
    <div
      data-section="origin-org-badge"
      className="flex items-center gap-2.5 border-t border-ln-line-2 px-4 py-3"
    >
      {originOrg.avatarUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={originOrg.avatarUrl}
          alt=""
          aria-hidden="true"
          className="h-[28px] w-[28px] flex-shrink-0 rounded-full object-cover"
        />
      )}
      <div className="min-w-0">
        <p className="m-0 font-ln-mono text-xs uppercase tracking-[.06em] text-ln-mute">
          Refugio de origen
        </p>
        <p className="m-0 truncate text-md font-medium text-ln-ink">{originOrg.displayName}</p>
      </div>
    </div>
  );
}
