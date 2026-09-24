"use server";

// Thin action controllers for the surveillance domain — WU-3 bite + rabies + WU-4 ENO + outbreak.
//
// Each action:
//   1. AUTH GUARD at the edge (EXACT scope per action — see spec §AUTH SCOPE).
//   2. Parse/validate raw input.
//   3. Build deps (repo, openCase, transaction, etc.) and call the use-case.
//   4. Handle UseCaseResult — on error, return the error string.
//   5. Flush pendingNotifications post-tx best-effort.
//   6. revalidatePath or redirect.
//
// AUTH SCOPE CONTRACT:
//   reportBiteAction:                    requireAlivePetAccess (owner+alive)
//   reportBiteFromOrgAction:             requireCapabilityForOrgToken("bite.report", orgToken)
//                                        + verified org + relation to the pet
//                                          (surveillance/domain/bite-authority.ts)
//   professionalCloseRabiesObservation:  requireAdminOrGovtOrRedirect + jurisdiction scope
//
// ownerCloseRabiesObservationAction was DELETED on 2026-08-17 (PO decision,
// engram roadmap/decisiones-legales-flujos-2026-08-17 item 1). It let the owner
// of the animal that bit somebody write outcome='negative' on the State's own
// record, gated only on the window having elapsed and on that same owner not
// having self-reported a symptom. Only professionalCloseRabiesObservationAction
// may assert a clinical outcome now.
//   openOutbreakInvestigationAction:     requireAdminOrGovtOrRedirect + isInScope (via use-case)
//   addInvestigationNoteAction:          requireAdminOrGovtOrRedirect + isInScope (via use-case)
//   escalateInvestigationAction:         requireAdminOrGovtOrRedirect + isInScope (via use-case)
//   closeInvestigationAction:            requireAdminOrGovtOrRedirect + isInScope (via use-case)
//
// NO business logic. NO direct Drizzle queries (beyond db.transaction).
// AUDIT_LOG: the ORG bite report writes `bite_reported_by_org` inside its tx
// (H1, 2026-08-22 — it wrote nothing until then); the professional close writes
// `rabies_observation_closed_professional`; outbreak: all 4 write inside tx.
// The OWNER-side bite report writes none — a self-report is not an operator act.
// Every one of these writes is owned by its use-case, never by this file.

import { revalidatePath } from "next/cache";

import { db, type notifications } from "@/db";
import { notifyOutbreakInvestigationOpened } from "@/lib/domain/authority";
import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import { assertOccurredAtPlausible } from "@/lib/events/plausibility";
import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { requireAdminOrGovtOrRedirect } from "@/lib/infra/auth-guards";
import { resolveBusinessRule } from "@/lib/infra/business-rules-resolver";
import { closeCase, escalateCase, openCase } from "@/lib/infra/case-helpers";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";
import {
  type CreateNotificationInput,
  createNotificationsBulk,
} from "@/lib/infra/notification-service";
import { requireAlivePetAccess } from "@/lib/infra/pet-access";
import { reportError } from "@/lib/infra/report-error";
import { resolveSignerProvenance } from "@/lib/infra/signer-provenance";
import { checkboxOn } from "@/lib/ui/form-checkbox";
import { parseDateInput } from "@/lib/utils/format";
import { requireCapabilityForOrgToken } from "@/src/modules/organizations/infrastructure/authz-resolver";

import type { OpenedReason } from "@/src/modules/cases/domain/opened-reason";
import {
  type InvestigationNoteEntryType,
  addInvestigationNote,
  closeInvestigation,
  escalateInvestigation,
  openOutbreakInvestigation,
} from "./application/outbreak-investigation";
import { professionalCloseObservation } from "./application/professional-close-observation";
import { reportBite } from "./application/report-bite";
import { reportBiteFromOrg } from "./application/report-bite-from-org";
import {
  RABIES_OBSERVATION_DAYS,
  type RabiesObservationOutcome,
  isObservationOpen,
} from "./domain/rabies-observation";
import { SurveillanceRepository } from "./infrastructure/surveillance-repository";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const repo = new SurveillanceRepository();

/**
 * panorama-event-points Slice 2: read the coordinate-capture origin from the bite
 * form (`locationSource` hidden field emitted by LocationFields l2 / the org map
 * picker). Only the three known enum values are honored; anything else (absent /
 * legacy form) → null so the schema's nullable-optional passes.
 */
function parseLocationSource(fd: FormData): "gps" | "pin_manual" | "geocodificada" | null {
  const raw = String(fd.get("locationSource") ?? "").trim();
  return raw === "gps" || raw === "pin_manual" || raw === "geocodificada" ? raw : null;
}

/**
 * Flush notifications post-tx, through the canonical write path.
 *
 * WHAT THIS USED TO BE, AND WHY IT MATTERED (fixed 2026-08-21)
 * ---------------------------------------------------------------------------
 * A raw `db.insert(notifications).values(pending)` inside a try/catch that
 * SWALLOWED — it logged "(action did succeed)" and returned. So any failure
 * silently discarded EVERY notification for that bite: the owner never learned
 * a rabies observation had opened on their animal, the sanitary authority never
 * learned a bite was reported, and the action still returned success. No trace,
 * no retry, nothing to drain. On a Ley 14.346 / SENASA observation that is not
 * a lost message, it is a lost legal notification.
 *
 * It compounded with the duplicate-submission path: `report-bite.ts` returns
 * early inside its transaction on `biteNoop`, so a retry rebuilds only the
 * post-tx authority fan-out. Attempt 1's owner notice was gone and the retry
 * could not recreate it. Now it does not need to — a failed write lands in
 * `notification_dead_letter` and the existing drain cron replays it.
 *
 * THE DEDUPE KEY IS DERIVED, NOT HAND-WRITTEN PER CALL SITE.
 * Every notification these use-cases emit is anchored on the incident CASE, so
 * `${type}:${caseId}:${userId}` is stable across a retry of the same report and
 * distinct across reports that must coexist. Deriving it here rather than
 * spelling it at four call sites means the next notification added to this
 * module inherits idempotency instead of having to remember it.
 *
 * A row WITHOUT a case anchor is refused rather than keyed on the pet: two
 * separate bites on the same animal would otherwise collapse into one alert to
 * the authority, which is a worse failure than a duplicate.
 *
 * ONLY FOR THE BITE REPORTS, whose use-cases open the case inside their own
 * transaction, so every row they emit carries it. The professional close does
 * NOT come through here: a close may have no open case, and this refusal used
 * to drop its owner notice and its urgent rabies alert (fixed 2026-09-18 — see
 * professionalCloseRabiesObservationAction, which keys on the ended event).
 */
async function flushNotifications(
  pending: Array<typeof notifications.$inferInsert>,
): Promise<void> {
  if (pending.length === 0) return;

  const anchored: CreateNotificationInput[] = [];
  for (const n of pending) {
    if (!n.relatedCaseId) {
      // Loud, not silent: this is a programming error in a caller, and the
      // whole point of the change is that notifications stop vanishing quietly.
      //
      // NOTE the import above is load-bearing. Written without it, `reportError`
      // resolves to the DOM global of the same name (lib.dom.d.ts), which takes
      // ONE argument — in a "use server" module. It only failed to compile here
      // because the arity differed; a one-argument call would have shipped,
      // bound to the wrong function.
      reportError(
        "surveillance/flush-notifications",
        new Error(`notification ${n.notificationType} has no relatedCaseId to key on`),
        { notificationType: String(n.notificationType), userId: String(n.userId) },
      );
      continue;
    }
    anchored.push({
      ...(n as CreateNotificationInput),
      dedupeKey: `${n.notificationType}:${n.relatedCaseId}:${n.userId}`,
    });
  }

  // Never throws: it dead-letters instead, which is the entire upgrade.
  await createNotificationsBulk(anchored);
}

// ---------------------------------------------------------------------------
// Re-exported types (matches original app/actions/bite.ts public surface)
// ---------------------------------------------------------------------------

export type BiteFormState = {
  error: string | null;
  /** N3 post-action destination — see the note on ProfessionalCloseResult below. */
  redirectTo?: string;
};
export type ReportBiteFromOrgFormState = {
  error: string | null;
  ok?: boolean;
  petToken?: string;
  /** N3 post-action destination — see the note on ProfessionalCloseResult below. */
  redirectTo?: string;
  /** CAS-XXXX-XXXX code of the opened bite-incident case (receipt reference). */
  casePublicCode?: string;
};
// `redirectTo` carries the post-success destination back to the client instead
// of the action calling redirect() itself — the App Router drops a server
// action's own redirect in production (see lib/ui/full-page-action-nav.ts).
export type ProfessionalCloseResult = { error: string | null; redirectTo?: string };

// ---------------------------------------------------------------------------
// reportBiteAction — owner path (spec §A)
// ---------------------------------------------------------------------------

export async function reportBiteAction(
  publicToken: string,
  _prev: BiteFormState,
  formData: FormData,
): Promise<BiteFormState> {
  // 1. Auth + pet access (alive pets only).
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { pet, user, eventAuthorship } = access;

  // 2. Refuse if an observation is already open — including one whose window
  // expired without a professional closure. That one is unresolved, not over:
  // opening a second observation on top of it would bury the first.
  if (isObservationOpen(pet.rabiesObservationStatus)) {
    return {
      error: "Esta mascota ya está en observación antirrábica por otra mordedura activa.",
    };
  }

  // 3. Parse + validate form input.
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  if (!occurredAtRaw) return { error: "Indicá la fecha del incidente." };
  // Anchor the bare YYYY-MM-DD at NOON UTC (parseDateInput) so the bite is
  // recorded on the reporter's AR calendar day — NOT midnight UTC, which is the
  // previous AR day (UTC−3) and would shift the legal 10-day rabies-observation
  // anchor one day early (RO-HIGH, tier-3 event-sourcing critique).
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) {
    return { error: "Fecha del incidente inválida." };
  }
  // Date-only guard (shared with the events edge): compare AR calendar days,
  // not the noon-UTC anchor against the wall clock — the previous instant
  // compare rejected a same-day bite reported before 09:00 AR.
  if (!assertOccurredAtPlausible({ occurredAt, isDateOnly: true }).ok) {
    return { error: "La fecha no puede ser futura." };
  }

  const victimKindRaw = String(formData.get("victimKind") ?? "");
  if (!["human", "animal", "unknown"].includes(victimKindRaw)) {
    return { error: "Indicá el tipo de víctima." };
  }
  const victimKind = victimKindRaw as "human" | "animal" | "unknown";

  const severityRaw = String(formData.get("severity") ?? "");
  if (!["minor", "moderate", "severe"].includes(severityRaw)) {
    return { error: "Indicá la severidad." };
  }
  const severity = severityRaw as "minor" | "moderate" | "severe";

  const confirmed = checkboxOn(formData, "confirmObservation");
  if (!confirmed) {
    return {
      error:
        "Tenés que confirmar que entendés que esto inicia una observación antirrábica obligatoria.",
    };
  }

  const locationDescription = String(formData.get("locationDescription") ?? "").trim() || null;
  const context = String(formData.get("context") ?? "").trim() || null;
  const victimContactName = String(formData.get("victimContactName") ?? "").trim() || null;
  const victimContactPhone = String(formData.get("victimContactPhone") ?? "").trim() || null;
  const victimAgeEstimate = String(formData.get("victimAgeEstimate") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;
  const loc = parseLocationFromFormData(formData);
  // locality:"soft" (localidad plan L2·1, PO 2026-09-08). The locality is
  // resolved against the INDEC catalog: a match stores the canonical name AND
  // its ar_localities id (carried onto the bite case below, even when the
  // capture came from the map pin, which has a name but no id); a miss keeps
  // the raw text and still saves. NEVER "strict" — a bite report must not be
  // blocked by how a geocoder spells a place.
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "soft" });
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  const eventJurisdictionProvince = normalizedLoc.province;
  const eventJurisdictionLocality = normalizedLoc.locality;
  const locationSource = parseLocationSource(formData);

  // 4. Call use-case.
  const result = await reportBite(
    {
      pet,
      user,
      eventAuthorship: eventAuthorship as {
        authorRole: string;
        authorOrganizationId: string | null;
        authorVerified: boolean;
      },
      occurredAt,
      victimKind,
      severity,
      locationDescription,
      context,
      victimContactName,
      victimContactPhone,
      victimAgeEstimate,
      clientIdempotencyKey,
      eventJurisdictionProvince,
      eventJurisdictionLocality,
      eventLocalityId: normalizedLoc.localityId,
      // panorama-event-points Slice 2: the map-pin coordinate (may be null).
      locationLat: normalizedLoc.lat,
      locationLng: normalizedLoc.lng,
      locationSource,
    },
    {
      repo,
      openCase: async (input, tx) =>
        openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
      transaction: db.transaction.bind(db),
      // Route label supplied at the composition root — see the org-side reporter
      // below for why the use-case does not carry it.
      findAuthoritiesForJurisdiction: (jurisdiction) =>
        findAuthoritiesForJurisdiction(jurisdiction, { route: "bite_reported_authority" }),
      resolveObservationWindow: async (jurisdiction) => {
        // Review F3/F6: a rules-table read hiccup must not turn bite reporting
        // into an outage — fall back to the statutory national baseline. And a
        // hand-patched rule row can never shrink the window below 1 day (the
        // write path validates 1..60; the read path re-clamps).
        try {
          const r = await resolveBusinessRule("rabies_observation_window", {
            country: "AR",
            ...jurisdiction,
          });
          return { days: Math.max(1, r.payload.days) };
        } catch (err) {
          console.error(
            "[surveillance] rabies_observation_window resolve failed — statutory fallback:",
            err,
          );
          return { days: RABIES_OBSERVATION_DAYS };
        }
      },
    },
  );

  if (!result.ok) return { error: result.error };

  // 5. Flush notifications post-tx best-effort.
  await flushNotifications(result.notifications as (typeof notifications.$inferInsert)[]);

  revalidatePath(`/mis-mascotas/${publicToken}`);
  // Wave 2 Item 9: trámite-style flows MUST end on SuccessScreen (Rule 4).
  // Redirect to the dedicated success page so the owner sees the observation-
  // period details and next steps, not a silent pet-profile redirect.
  // Carry the opened bite-incident case code so the receipt can quote it.
  // N3, like professionalCloseAction below: hand the destination back. This
  // file already carried that contract — and this call, on the OWNER's bite
  // report, never adopted it.
  return {
    error: null,
    redirectTo: `/mis-mascotas/${publicToken}/eventos/nuevo/mordedura/exito?caso=${encodeURIComponent(result.value.casePublicCode)}`,
  };
}

// ---------------------------------------------------------------------------
// reportBiteFromOrgAction — org path (spec §B)
// ---------------------------------------------------------------------------

export async function reportBiteFromOrgAction(
  orgToken: string,
  _prev: ReportBiteFromOrgFormState,
  formData: FormData,
): Promise<ReportBiteFromOrgFormState> {
  // 1. Capability gate, pinned to the org in the URL.
  //
  // This was bare `requireCapability("bite.report")` until 2026-08-22 (H1). Two
  // things were wrong with it and the second is the one the finding missed:
  // bare requireCapability resolves the caller's MOST-RECENTLY-JOINED
  // membership and ignores `orgToken` entirely, so a member of several orgs
  // acting under /org/{A} was authorized — and attributed — against whichever
  // org they happened to join last. That is the confused-deputy shape this
  // action used to sit in the allowlist for; the entry is gone with this fix.
  const cap = await requireCapabilityForOrgToken("bite.report", orgToken);
  if (cap.error !== null) return { error: cap.error };
  const { user, organization } = cap;

  // 2. Locate the target pet.
  const petPublicTokenRaw = String(formData.get("petPublicToken") ?? "").trim();
  if (!petPublicTokenRaw) return { error: "Indicá el token público de la mascota." };

  const pet = await repo.findPetByToken(petPublicTokenRaw);
  if (!pet) return { error: "No encontramos una mascota con ese token." };
  if (pet.status === "deceased") {
    return { error: "Esta mascota está registrada como fallecida." };
  }
  // Same guard as the owner path: an expired-unclosed observation is still open.
  if (isObservationOpen(pet.rabiesObservationStatus)) {
    return {
      error: "Esta mascota ya está en observación antirrábica por otra mordedura activa.",
    };
  }

  // 3. Parse bite-specific fields.
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  if (!occurredAtRaw) return { error: "Indicá la fecha del incidente." };
  // Anchor at NOON UTC (parseDateInput) so the bite lands on the reporter's AR
  // calendar day, not the previous one — see the owner path above (RO-HIGH).
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) {
    return { error: "Fecha del incidente inválida." };
  }
  // Date-only guard (shared with the events edge): compare AR calendar days,
  // not the noon-UTC anchor against the wall clock — the previous instant
  // compare rejected a same-day bite reported before 09:00 AR.
  if (!assertOccurredAtPlausible({ occurredAt, isDateOnly: true }).ok) {
    return { error: "La fecha no puede ser futura." };
  }

  const victimKindRaw = String(formData.get("victimKind") ?? "");
  if (!["human", "animal", "unknown"].includes(victimKindRaw)) {
    return { error: "Indicá el tipo de víctima." };
  }
  const victimKind = victimKindRaw as "human" | "animal" | "unknown";

  const severityRaw = String(formData.get("severity") ?? "");
  if (!["minor", "moderate", "severe"].includes(severityRaw)) {
    return { error: "Indicá la severidad." };
  }
  const severity = severityRaw as "minor" | "moderate" | "severe";

  if (!checkboxOn(formData, "confirmObservation")) {
    return {
      error:
        "Tenés que confirmar que entendés que esto inicia una observación antirrábica obligatoria.",
    };
  }

  const locationDescription = String(formData.get("locationDescription") ?? "").trim() || null;
  const context = String(formData.get("context") ?? "").trim() || null;
  const victimContactName = String(formData.get("victimContactName") ?? "").trim() || null;
  const victimContactPhone = String(formData.get("victimContactPhone") ?? "").trim() || null;
  const victimAgeEstimate = String(formData.get("victimAgeEstimate") ?? "").trim() || null;
  const injuriesSummary = String(formData.get("injuriesSummary") ?? "").trim() || null;
  const vetInvolved = checkboxOn(formData, "vetInvolved");
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;
  const loc = parseLocationFromFormData(formData);
  // locality:"soft" (localidad plan L2·1, PO 2026-09-08). The locality is
  // resolved against the INDEC catalog: a match stores the canonical name AND
  // its ar_localities id (carried onto the bite case below, even when the
  // capture came from the map pin, which has a name but no id); a miss keeps
  // the raw text and still saves. NEVER "strict" — a bite report must not be
  // blocked by how a geocoder spells a place.
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "soft" });
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  const eventJurisdictionProvince = normalizedLoc.province;
  const eventJurisdictionLocality = normalizedLoc.locality;
  const locationSource = parseLocationSource(formData);
  const noRedirect = String(formData.get("noRedirect") ?? "") === "1";

  // 4. Call use-case.
  const result = await reportBiteFromOrg(
    {
      pet,
      user: { id: user.id },
      organization: {
        id: organization.id,
        displayName: organization.displayName,
        orgType: organization.orgType,
        verified: organization.verified,
        jurisdictionProvince: organization.jurisdictionProvince ?? null,
        // D1: the owner's route back to whoever opened the observation. The
        // capability resolver hands us the full organizations row, so this is
        // already loaded — no extra query.
        email: organization.email,
        phone: organization.phone ?? null,
      },
      occurredAt,
      victimKind,
      severity,
      locationDescription,
      context,
      victimContactName,
      victimContactPhone,
      victimAgeEstimate,
      injuriesSummary,
      vetInvolved,
      clientIdempotencyKey,
      eventJurisdictionProvince,
      eventJurisdictionLocality,
      eventLocalityId: normalizedLoc.localityId,
      // panorama-event-points Slice 2: the map-pin coordinate (may be null).
      locationLat: normalizedLoc.lat,
      locationLng: normalizedLoc.lng,
      locationSource,
      noRedirect,
      orgToken,
    },
    {
      repo,
      openCase: async (input, tx) =>
        openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
      transaction: db.transaction.bind(db),
      // The route label is supplied HERE, at the composition root, so an empty
      // fan-out's audit row names the notification that went nowhere. The
      // use-case keeps a one-argument dep and stays ignorant of audit plumbing.
      findAuthoritiesForJurisdiction: (jurisdiction) =>
        findAuthoritiesForJurisdiction(jurisdiction, { route: "bite_reported_authority_org" }),
      // The same resolver the walk-in and scheduled-attendance paths use, so
      // all three stamp a clinical signature from one place. Passed at the
      // composition root because the use case owns no DB handle.
      resolveSignerProvenance,
      // H1 — the two facts the authority gate reads (attendance/custody with
      // THIS animal, and where this org works). One repository call, resolved
      // here so the use case stays free of `@/db`.
      loadOrgPetAuthority: (organizationId, petId) =>
        repo.loadOrgPetAuthority(organizationId, petId),
      resolveObservationWindow: async (jurisdiction) => {
        // Review F3/F6: a rules-table read hiccup must not turn bite reporting
        // into an outage — fall back to the statutory national baseline. And a
        // hand-patched rule row can never shrink the window below 1 day (the
        // write path validates 1..60; the read path re-clamps).
        try {
          const r = await resolveBusinessRule("rabies_observation_window", {
            country: "AR",
            ...jurisdiction,
          });
          return { days: Math.max(1, r.payload.days) };
        } catch (err) {
          console.error(
            "[surveillance] rabies_observation_window resolve failed — statutory fallback:",
            err,
          );
          return { days: RABIES_OBSERVATION_DAYS };
        }
      },
    },
  );

  if (!result.ok) return { error: result.error };

  await flushNotifications(result.notifications as (typeof notifications.$inferInsert)[]);

  revalidatePath(`/org/${orgToken}`);
  if (noRedirect) {
    return {
      error: null,
      ok: true,
      petToken: String(formData.get("petPublicToken") ?? "").trim(),
      casePublicCode: result.value.casePublicCode,
    };
  }
  // No `ok` here on purpose: `ok` is what makes the form render its inline
  // SuccessScreen (the noRedirect branch above). This branch NAVIGATES, so it
  // reports only where to go — setting both would ask the form to do two
  // different things with one state.
  return { error: null, redirectTo: `/org/${orgToken}?evento=mordedura_reportada` };
}

// ---------------------------------------------------------------------------
// professionalCloseRabiesObservationAction — admin/govt (spec §D)
// ---------------------------------------------------------------------------

export async function professionalCloseRabiesObservationAction(
  petPublicToken: string,
  formData: FormData,
): Promise<ProfessionalCloseResult> {
  const { profile, jurisdictions } = await requireAdminOrGovtOrRedirect();

  const outcomeRaw = String(formData.get("outcome") ?? "").trim();
  const PROFESSIONAL_OUTCOMES: RabiesObservationOutcome[] = [
    "negative",
    "positive_rabies",
    "dead",
    "lost_to_followup",
  ];
  if (!PROFESSIONAL_OUTCOMES.includes(outcomeRaw as RabiesObservationOutcome)) {
    return { error: "Outcome inválido." };
  }
  const outcome = outcomeRaw as RabiesObservationOutcome;
  const closureNotes = String(formData.get("closureNotes") ?? "").trim() || null;

  const result = await professionalCloseObservation(
    {
      petPublicToken,
      outcome,
      closureNotes,
      actor: { profile, jurisdictions },
    },
    {
      repo,
      closeCase: async (args, tx) => {
        await closeCase(args, tx as Parameters<typeof closeCase>[1]);
      },
      transaction: db.transaction.bind(db),
      findAuthoritiesForJurisdiction: (jurisdiction) =>
        findAuthoritiesForJurisdiction(jurisdiction, {
          route: "rabies_observation_positive_authority",
        }),
      // A lookup that THROWS still reaches a human with a positive.
      findNationalAdminIds: () => activeHumanInstitutionalAdminIds(),
    },
  );

  if (!result.ok) return { error: result.error };

  // THROUGH THE DURABLE SERVICE, KEYED ON THE ENDED EVENT — not flushNotifications.
  //
  // flushNotifications keys on the bite CASE and refuses a row without one. A
  // close is not guaranteed a case: an observation can outlive its bite case,
  // or predate the case system. Until 2026-09-18 that meant a State close with
  // no open case dropped EVERY notification it produced — the owner's result
  // AND the urgent confirmed-rabies alert to the health authority — while the
  // operator saw success. The ended event always exists (the close just wrote
  // it), so it is the anchor, in the service's `event:${id}:${user}:${type}`
  // shape. It is the same key the veterinary door derives
  // (app/org/[orgToken]/atender/actions.ts), so both doors of one act dedupe
  // alike. A failed insert dead-letters and the drain cron replays it.
  const { endedEventId } = result.value;
  await createNotificationsBulk(
    result.notifications.map((n) => ({
      ...(n as CreateNotificationInput),
      relatedEventId: endedEventId,
      dedupeKey: `event:${endedEventId}:${n.userId}:${n.notificationType}`,
    })),
  );

  // Mark the list stale, then hand the destination back to the client instead
  // of calling redirect() here. The action's own redirect() rides the App
  // Router transition machinery that Next 15.5.x silently drops in production:
  // the close COMMITS but the operator stays on the form, so it reads as a
  // no-op. QA ronda 5 (2026-07-16) hit exactly this — closed an observation,
  // saw the form still sitting there, and only found "CERRADA NEGATIVA" after
  // a manual reload. See lib/ui/full-page-action-nav.ts.
  revalidatePath("/admin/observaciones");
  revalidatePath(`/admin/observaciones/${petPublicToken}`);
  return { error: null, redirectTo: "/admin/observaciones" };
}

// ---------------------------------------------------------------------------
// Cron use-case (spec §E): closeEligibleObservations lives in
// ./application/close-eligible-observations and is invoked by the cron route via
// the lib/rabies-observation-closer shim. It is intentionally NOT re-exported here —
// a "use server" file may only export locally-declared async actions.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Outbreak investigation actions — admin/govt (spec §H, §I)
// Auth: requireAdminOrGovtOrRedirect + isInScope enforced inside use-case.
// AUDIT_LOG: all 4 write inside tx with v1_noop:true (use-case handles it).
// ---------------------------------------------------------------------------

export type OutbreakInvestigationActionResult =
  | { ok: true; publicCode: string }
  | { error: string };

export type OutbreakInvestigationNoteResult = { ok: true } | { error: string };

export type { InvestigationNoteEntryType };

/** Build shared outbreak deps (repo + case ops + tx + notif + revalidate). */
function makeOutbreakDeps(revalidateFn: (path: string) => void) {
  return {
    repo,
    openCase: async (
      input: {
        kind: string;
        primarySubjectKind: string;
        primaryPetId: null;
        jurisdictionCountry: string;
        jurisdictionProvince: string | null;
        jurisdictionLocality: string | null;
        openedByUserId: string;
        openedReason: OpenedReason;
      },
      tx: unknown,
    ) => openCase(input as Parameters<typeof openCase>[0], tx as Parameters<typeof openCase>[1]),
    closeCase: async (
      args: { caseId: string; reason: "resolved" | "cancelled"; closedByUserId: string },
      tx: unknown,
    ): Promise<void> => {
      await closeCase(args, tx as Parameters<typeof closeCase>[1]);
    },
    escalateCase: async (caseId: string, tx: unknown): Promise<void> => {
      await escalateCase(caseId, tx as Parameters<typeof escalateCase>[1]);
    },
    transaction: db.transaction.bind(db),
    notifyOutbreakOpened: async (
      ...args: Parameters<typeof notifyOutbreakInvestigationOpened>
    ): Promise<void> => {
      await notifyOutbreakInvestigationOpened(...args);
    },
    revalidate: revalidateFn,
  };
}

export async function openOutbreakInvestigationAction(input: {
  diseaseCode: string;
  reason: string;
  linkedSignalEventId?: string | null;
}): Promise<OutbreakInvestigationActionResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const { profile, jurisdictions } = session;

  const result = await openOutbreakInvestigation(
    {
      diseaseCode: input.diseaseCode ?? "",
      reason: input.reason ?? "",
      linkedSignalEventId: input.linkedSignalEventId,
      actor: { profile, jurisdictions },
    },
    makeOutbreakDeps(revalidatePath),
  );

  if (!result.ok) return { error: result.error };
  return { ok: true, publicCode: result.value.publicCode };
}

export async function addInvestigationNoteAction(input: {
  casePublicCode: string;
  entryType: InvestigationNoteEntryType;
  notes: string;
  payload?: Record<string, unknown>;
}): Promise<OutbreakInvestigationNoteResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const { profile, jurisdictions } = session;

  const result = await addInvestigationNote(
    {
      casePublicCode: input.casePublicCode,
      entryType: input.entryType,
      notes: input.notes ?? "",
      payload: input.payload,
      actor: { profile, jurisdictions },
    },
    makeOutbreakDeps(revalidatePath),
  );

  if (!result.ok) return { error: result.error };
  return { ok: true };
}

export async function escalateInvestigationAction(input: {
  casePublicCode: string;
  reason: string;
}): Promise<OutbreakInvestigationNoteResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const { profile, jurisdictions } = session;

  const result = await escalateInvestigation(
    {
      casePublicCode: input.casePublicCode,
      reason: input.reason ?? "",
      actor: { profile, jurisdictions },
    },
    makeOutbreakDeps(revalidatePath),
  );

  if (!result.ok) return { error: result.error };
  return { ok: true };
}

export async function closeInvestigationAction(input: {
  casePublicCode: string;
  outcome: "resolved" | "dismissed";
  finalReportText?: string | null;
  reason: string;
}): Promise<OutbreakInvestigationNoteResult> {
  const session = await requireAdminOrGovtOrRedirect();
  const { profile, jurisdictions } = session;

  const result = await closeInvestigation(
    {
      casePublicCode: input.casePublicCode,
      outcome: input.outcome,
      reason: input.reason ?? "",
      finalReportText: input.finalReportText,
      actor: { profile, jurisdictions },
    },
    makeOutbreakDeps(revalidatePath),
  );

  if (!result.ok) return { error: result.error };
  return { ok: true };
}
