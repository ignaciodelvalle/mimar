"use server";

// Anonymous "I physically have the pet, come get it" action — Tier 1 (lost mode).
// Heavier sibling of /sighting: the finder claims physical custody of the pet
// and the owner needs to arrange pickup.
//
// Emits:
//   - pet_events row: note_added, kind="finder_in_possession", full payload
//   - notifications row: pet_in_possession, severity=urgent, category=perdidas
//     (warning + no push once the animal's own ceiling is full — the report is
//     still written, without its photo; past the hard ceiling it is refused;
//     see lib/infra/anonymous-report-limits.ts)
//
// Rate-limited by (IP, publicToken): 1/min, 10/hr, consumed AFTER pure form
// validation and BEFORE the token is resolved — see the block comment at the
// limiter for why both halves of that sentence matter. Idempotency guard skips
// double-insert when (petId, finderContact) already has a finder_in_possession
// event within the last 5 minutes.
//
// Photo upload uses service-role admin client (anonymous action, bucket RLS
// requires authenticated; same pattern as /sighting P0d).
// P0g: EXIF metadata (including GPS) is stripped from finder photos via sharp
// before upload. Non-fatal: falls back to original if sharp throws.
// P0g: photo also inserted into the attachments table (linked to the event) so
// the historial / eventos / EventTimeline surfaces can render it for free.

import { deepLinkPath } from "@dim/contract/links";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { headers } from "next/headers";

import { attachments, cases, db, organizationMemberships, petEvents, pets } from "@/db";
import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import { SYNTHETIC_PET_WRITE_REFUSED, isSyntheticPet } from "@/lib/domain/synthetic-pet";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  ANONYMOUS_REPORT_TOKEN_HARD_LIMIT,
  ANONYMOUS_REPORT_TOKEN_HARD_REFUSAL,
  ANONYMOUS_REPORT_TOKEN_LIMIT,
  OVER_CEILING_PHOTO_DROPPED_WARNING,
  OVER_CEILING_REPORT_DELIVERY,
  anonymousReportOverflowNotices,
} from "@/lib/infra/anonymous-report-limits";
import { createNotification } from "@/lib/infra/notification-service";
import { resolveOriginShelterOrgId } from "@/lib/infra/origin-shelter-alert";
import { resolveLostPetAlertRecipients } from "@/lib/infra/pet-alert-recipients";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { createAdminClient } from "@/lib/supabase/admin";
import { DISPUTE_TIP_NOTICE } from "@/lib/ui/dispute-copy";
import { CONTACT_SEPARATOR } from "@/lib/utils/contact-parts";
import { AR_TIME_ZONE, parseArDatetimeLocal } from "@/lib/utils/format";

export type FinderInPossessionState = {
  ok: boolean;
  error: string | null;
  /** Non-fatal warning shown when photo upload failed but event was saved. */
  warning?: string | null;
};

// @no-auth-required: anonymous finder submits via /p/[token]/encontre.
// Rate-limited by (IP + publicToken) via the persistent DB-backed limiter so
// the limit holds cross-worker / cross cold-start. Limit: 1/min, 10/hour per key.
// And by the token alone (`finder_possession_token`, lib/infra/anonymous-report-
// limits.ts), so the addresses a sender controls no longer multiply the alerts.
export async function reportFinderInPossessionAction(
  publicToken: string,
  _previous: FinderInPossessionState,
  formData: FormData,
): Promise<FinderInPossessionState> {
  if (!publicToken) return { ok: false, error: "Token de mascota inválido." };

  // Parse form fields.
  const rawFinderName = String(formData.get("finderName") ?? "").trim();
  const rawFinderPhone = String(formData.get("finderPhone") ?? "").trim();
  const rawFinderEmail = String(formData.get("finderEmail") ?? "").trim();
  // Exact point (L2): the finder drops a pin so the owner knows where to pick up.
  // localityName/provinceName are still emitted by LocationFields (derived from the
  // pin's reverse geocode) and kept as human-readable context — but the required
  // location is now the coordinate pair, not a locality string.
  const loc = parseLocationFromFormData(formData);
  const localityName = loc.locality ?? "";
  const provinceCode = loc.provinceCode ?? "";
  const provinceName = loc.province ?? "";
  const petCondition = String(formData.get("petCondition") ?? "").trim();
  const canKeepUntilRaw = String(formData.get("canKeepUntil") ?? "").trim();
  const canKeepIndefinite = String(formData.get("canKeepIndefinite") ?? "") === "true";
  const message = String(formData.get("message") ?? "").trim();
  const photoFile =
    formData.get("photoNow") instanceof File ? (formData.get("photoNow") as File) : null;

  // Validation. PO 2026-07-24: name and contact are OPTIONAL — an anonymous
  // handoff report is still a report (the pet is safe somewhere, at a known
  // point). The form explains why leaving a contact helps, without forcing it.
  const finderName = rawFinderName ? rawFinderName.slice(0, 80) : null;
  const finderPhone = rawFinderPhone ? rawFinderPhone.slice(0, 40) : null;
  const finderEmail = rawFinderEmail ? rawFinderEmail.slice(0, 120) : null;

  // requireCoords:true + locality:"none" — coords required and range-checked; no locality
  // lookup (finder possession behavior unchanged, now routed through the shared gate).
  let normalizedLocObj: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLocObj = await normalizeLocationForWrite(loc, {
      locality: "none",
      requireCoords: true,
    });
  } catch (err) {
    if (err instanceof CoordError) {
      return {
        ok: false,
        error:
          err.code === "COORD_REQUIRED"
            ? "Marcá en el mapa dónde tenés a la mascota."
            : "La ubicación está fuera de rango.",
      };
    }
    throw err;
  }
  const lat = normalizedLocObj.lat as number;
  const lng = normalizedLocObj.lng as number;

  const VALID_CONDITIONS = ["bien", "herida", "asustada", "necesita_vet_urgente"] as const;
  if (!VALID_CONDITIONS.includes(petCondition as (typeof VALID_CONDITIONS)[number])) {
    return { ok: false, error: "Seleccioná el estado de la mascota." };
  }

  if (!canKeepIndefinite && !canKeepUntilRaw) {
    return {
      ok: false,
      error: "Indicá hasta cuándo podés cuidarla o marcá que podés tenerla indefinidamente.",
    };
  }

  let canKeepUntil: Date | null = null;
  if (!canKeepIndefinite && canKeepUntilRaw) {
    // datetime-local string typed as AR wall clock — parse it as such
    // (offset-less `new Date(...)` reads it in the server's zone → 3h early).
    canKeepUntil = parseArDatetimeLocal(canKeepUntilRaw);
    if (!canKeepUntil) {
      return { ok: false, error: "La fecha hasta cuándo podés cuidarla es inválida." };
    }
  }

  const safeMessage = message.slice(0, 500);

  // ---------------------------------------------------------------------------
  // LIMITER, THEN LOOKUP. Everything above this line is pure validation of what
  // the caller typed; everything below reads the database.
  // ---------------------------------------------------------------------------
  //
  // The order used to be the other way round, and the two halves of the reason
  // pull against each other, so both are written down:
  //
  //   • AFTER VALIDATION (tester fix #6, kept): a rejected form — no pin, bad
  //     date, missing condition — must not burn the (IP, token) budget and block
  //     the immediate retry. Those refusals are about the FORM and say nothing
  //     about the pet, so serving them for free costs nothing.
  //   • BEFORE THE LOOKUP (2026-08-21, this change): a hand-rolled POST reaches
  //     this action with no page load, so a token resolution that runs first is
  //     an unbounded existence-and-status oracle. Its three refusals are
  //     DISTINGUISHABLE — "Mascota no encontrada." vs "Esta mascota no está
  //     marcada como perdida." vs the dispute notice — which is a free read of
  //     whether a token exists, whether that animal is lost, and whether its
  //     titularidad is under review, at whatever rate anyone cares to ask.
  //
  // This is the same inversion `report-pet-sighting.ts` and
  // `report-dispute-tip.ts` carried, and the same fix; those two were EXEMPT
  // from __tests__/public-token-throttle-coverage.test.ts on the written claim
  // that their limiter already ran first, and nothing checked. This file was the
  // third, tracked in that commit as "not fixed here". It is fixed here, and its
  // exemption is gone, so the fence now watches the order positionally.
  const reqHeaders = await headers();
  const ip = callerIp(reqHeaders);
  try {
    await enforceRateLimit(`finder_possession:${publicToken}`, ip, {
      maxPerMinute: 1,
      maxPerHour: 10,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return {
        ok: false,
        error: "Ya enviaste un aviso hace poco. Probá de nuevo en unos minutos.",
      };
    }
    throw err;
  }

  // Resolve pet.
  const [pet] = await db
    .select({
      id: pets.id,
      name: pets.name,
      status: pets.status,
      inCustodyDispute: pets.inCustodyDispute,
      seedTag: pets.seedTag,
    })
    .from(pets)
    // PO-4: a soft-deleted pet resolves nowhere public, including this
    // hand-postable action — the page that hosts the form already 404s.
    .where(publicPetByToken(publicToken))
    .limit(1);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };
  // A seeded pet records no real act (lib/domain/synthetic-pet.ts).
  if (isSyntheticPet(pet)) return { ok: false, error: SYNTHETIC_PET_WRITE_REFUSED };
  if (pet.status !== "lost") {
    return { ok: false, error: "Esta mascota no está marcada como perdida." };
  }

  // D2 hardening (red-team 2026-07): a disputed pet's finder flow relays the
  // finder's contact to the contested owner (event payload + urgent
  // notification) — blocked server-side while titularidad is under review.
  if (pet.inCustodyDispute) {
    return {
      ok: false,
      error: `${DISPUTE_TIP_NOTICE} Enviá tu aviso desde la credencial de la mascota.`,
    };
  }

  // Who to notify. The ROUTE-1 ranking (audit 2026-08-04) moved verbatim into
  // lib/infra/pet-alert-recipients.ts when custodia-temporal made this a SET
  // rather than a single winner — see that file's header for why it lives on
  // that shelf and which flows deliberately do NOT call it.
  //
  // With no active caretaker the answer is byte-identical to what these six
  // lines used to compute, which is what makes the extraction safe;
  // __tests__/pet-alert-recipients.test.ts pins that parity case by case.
  const recipients = await resolveLostPetAlertRecipients(pet.id);
  if (recipients.length === 0) return { ok: false, error: "No se encontró un dueño activo." };

  // THE ANIMAL'S OWN CEILING (audit A03-2). The bucket above is per ADDRESS,
  // so N addresses meant 10 × N urgent "alguien tiene a tu mascota" alerts and
  // spine rows an hour. This one is keyed on the token alone, placed after every
  // refusal that writes nothing and before the upload and the event; derivation
  // and placement in lib/infra/anonymous-report-limits.ts. Its own bucket, so a
  // flood of fake sightings cannot silence this report.
  //
  // OVER THE (FIRST) CEILING THIS DEGRADES, IT DOES NOT REFUSE. The sender says they are
  // holding the animal, and a handful of addresses can fill the ceiling in six
  // minutes — a refusal here would hand whoever filled it the power to keep
  // every real finder away from the owner for the rest of the hour. So an
  // over-ceiling report is written as below (event, contact in the owner's
  // notification) MINUS its photo; the owner's alert stops ringing, and the
  // owner is pushed once an hour that reports are piling up.
  //
  // BUT NOT WITHOUT END. Past the degrade ceiling the only bound on spine rows
  // was the per-/64 bucket, which a /48 multiplies by 65 536. The hard bucket
  // (300/h, derivation in anonymous-report-limits.ts) refuses, with copy that
  // says what still works without us. It runs first so a refused report does
  // not also spend the degrade bucket.
  try {
    await enforceRateLimit(
      "finder_possession_token_hard",
      publicToken,
      ANONYMOUS_REPORT_TOKEN_HARD_LIMIT,
    );
  } catch (err) {
    if (err instanceof RateLimitError) {
      return { ok: false, error: ANONYMOUS_REPORT_TOKEN_HARD_REFUSAL };
    }
    throw err;
  }
  let overAnimalCeiling = false;
  try {
    await enforceRateLimit("finder_possession_token", publicToken, ANONYMOUS_REPORT_TOKEN_LIMIT);
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    overAnimalCeiling = true;
  }

  // Build the canonical contact string: phone takes precedence; append email
  // when both are provided. The schema's finderContact is a single text field;
  // null = anonymous handoff (PO 2026-07-24).
  //
  // THE SEPARATOR IS A NAMED CONSTANT because two consumers split on it — the
  // web feed (`lib/utils/contact-parts.ts`) and the native lost screen
  // (`apps/mobile/src/ui/contact-link.ts`, which cannot import from this tree
  // and holds its own copy of the literal). Every one of them turned this joined
  // string into a single `tel:` href with an e-mail inside it until 2026-09.
  const finderContact =
    finderPhone && finderEmail
      ? `${finderPhone}${CONTACT_SEPARATOR}${finderEmail}`
      : (finderPhone ?? finderEmail);

  // Idempotency: skip the INSERT when an identical finder_in_possession event
  // for (petId, finderContact) already exists in the last 5 minutes. Only keyed
  // when a contact WAS left — two distinct anonymous finders within 5 minutes
  // must not swallow each other's report (the per-IP 1/min limiter already
  // covers double-taps from the same person).
  //
  // IT GUARDS THE EVENT, AND ONLY THE EVENT. This block used to `return ok`
  // outright, and that was a hole a retry could not climb out of. The event is
  // written first and the owner's notification second; if the second half
  // failed, the finder saw an error and pressed the button again — and the
  // retry found the event from attempt 1, returned the success screen, and
  // never notified anybody. The person who has the animal believes the owner
  // was told. The owner was never told. Both halves of the only circuit that
  // reunites a lost animal with its family fail silently, together.
  //
  // A retry is EVIDENCE that attempt 1 may have failed, not proof that it
  // succeeded. So the notification below now runs on both paths and carries its
  // own idempotency (dedupeKey), which is the only thing that makes a retry
  // able to heal a half-finished first attempt. The general rule this is an
  // instance of: skipping side effects on a duplicate is safe only when those
  // side effects share the event's transaction — and notifications deliberately
  // do not (ARCH-P).
  let existingEventId: string | null = null;
  if (finderContact) {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const [existingEvent] = await db
      .select({ id: petEvents.id })
      .from(petEvents)
      .where(
        and(
          eq(petEvents.petId, pet.id),
          eq(petEvents.eventType, "note_added"),
          gt(petEvents.recordedAt, fiveMinutesAgo),
          sql`${petEvents.payload}->>'kind' = 'finder_in_possession'`,
          sql`${petEvents.payload}->>'finderContact' = ${finderContact}`,
        ),
      )
      .limit(1);

    existingEventId = existingEvent?.id ?? null;
  }

  // Optional photo upload. Non-fatal on failure.
  // Uses service-role admin client: anonymous action, RLS grants INSERT only to
  // authenticated; admin client bypasses RLS.
  // P0g: stripMetadata:true strips EXIF GPS + camera metadata via sharp before upload.
  let photoStoragePath: string | null = null;
  let photoMimeType: string | null = null;
  let photoSize: number | null = null;
  let photoWarning: string | null = null;
  // Not on a retry: the first attempt already uploaded and linked it, and a
  // second copy would be an orphan blob nothing renders.
  //
  // Not over the animal's ceiling either: a degraded report is written, but
  // its photo is not stored. That is what bounds finder photos to 30 per animal
  // per hour — the rows are kept because a row carries the finder's contact,
  // and the contact is the rescue; the photo is not worth an unbounded bucket.
  // The finder is told, because a finder who believes the owner saw the photo
  // will not think to describe the animal or leave a contact.
  const hasPhoto = photoFile !== null && photoFile.size > 0;
  if (existingEventId === null && hasPhoto && overAnimalCeiling) {
    photoWarning = OVER_CEILING_PHOTO_DROPPED_WARNING;
  } else if (existingEventId === null && photoFile && hasPhoto) {
    const adminSupabase = createAdminClient();
    const uploadResult = await uploadAttachmentIfPresent(
      adminSupabase,
      photoFile,
      "event-attachments",
      {
        stripMetadata: true,
      },
    );
    if (uploadResult.error) {
      reportError("public-encontre/photo-upload", uploadResult.error, { publicToken });
      photoWarning = "No se pudo subir la foto, pero el aviso fue registrado igual.";
    } else {
      photoStoragePath = uploadResult.uploadedPath;
      photoMimeType = uploadResult.mimeType;
      photoSize = uploadResult.size;
    }
  }

  // Resolve the open lost case for caseId association.
  const [openCase] = await db
    .select({ id: cases.id })
    .from(cases)
    .where(
      and(
        eq(cases.primaryPetId, pet.id),
        eq(cases.caseKind, "lost_pet_episode"),
        eq(cases.status, "open"),
      ),
    )
    .limit(1);

  // Finder anonymity invariant (privacy hardening 2026-07-04): public finder
  // flows NEVER link the report to a DIM account, even when the finder happens
  // to be logged in — mirroring the sighting (report-pet-sighting.ts) and scan
  // (log-scan.ts) contracts. recordedByUserId stays NULL and authorVerified
  // stays false; the finder's identity lives ONLY in the payload fields they
  // typed themselves (finderName / finderContact).

  // Build and validate the full payload in one pass through the strict Zod schema.
  // The schema now includes the possession-specific fields (location, petCondition,
  // canKeepUntil, canKeepIndefinite, message) alongside the base note_added fields.
  // validateEventPayload returns the parsed value (with payload_version filled in);
  // that returned object — not the raw input — is persisted to the JSONB column.
  // Human-readable location: prefer the reverse-geocoded locality/province; fall
  // back to the raw coordinates when the pin didn't resolve to a place name.
  const locationLabel =
    [localityName, provinceName].filter(Boolean).join(", ") ||
    `el punto marcado (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
  const noteText = `${finderName ?? "Alguien"} tiene a ${pet.name}. Condición: ${petCondition}. Ubicación: ${locationLabel}.`;
  const payload = validateEventPayload("note_added", {
    category: "otro" as const,
    text: noteText,
    kind: "finder_in_possession" as const,
    finderName,
    finderContact,
    photoStoragePath: photoStoragePath ?? undefined,
    location: {
      localityName,
      provinceCode: provinceCode || null,
      provinceName: provinceName || null,
    },
    petCondition: petCondition as "bien" | "herida" | "asustada" | "necesita_vet_urgente",
    canKeepUntil: canKeepIndefinite ? null : (canKeepUntil?.toISOString() ?? null),
    canKeepIndefinite,
    message: safeMessage || null,
  });

  // The write the idempotency guard protects, and the only thing it skips.
  let eventId: string;
  if (existingEventId !== null) {
    eventId = existingEventId;
  } else {
    const [insertedEvent] = await db
      .insert(petEvents)
      .values({
        petId: pet.id,
        eventType: "note_added",
        occurredAt: new Date(),
        recordedAt: new Date(),
        // Hard-anonymized: never link a public finder report to a user account.
        recordedByUserId: null,
        authorRole: "finder",
        authorVerified: false,
        payload,
        locationLat: lat.toString(),
        locationLng: lng.toString(),
        caseId: openCase?.id ?? null,
      })
      .returning({ id: petEvents.id });
    if (!insertedEvent) {
      // Unreachable while the insert either returns a row or throws. Refused
      // rather than narrowed with a `!`: eventId is about to become part of a
      // dedupe key, and a null in there would collapse every future report on
      // this pet into one notification.
      reportError("encontre:event-insert-no-row", new Error("insert returned no rows"), {
        petId: pet.id,
      });
      return { ok: false, error: "No pudimos registrar el aviso. Volvé a intentarlo." };
    }
    eventId = insertedEvent.id;

    // P0g: also insert into the attachments table so the historial/eventos/EventTimeline
    // surfaces render the photo for free (they read attachments, not the payload JSONB).
    // uploadedByUserId is always null — same finder-anonymity invariant as the event row.
    if (photoStoragePath) {
      await db.insert(attachments).values({
        petId: pet.id,
        eventId,
        uploadedByUserId: null,
        storagePath: photoStoragePath,
        mimeType: photoMimeType ?? "image/jpeg",
        fileSize: photoSize ?? 0,
      });
    }
  }

  // Notification to owner. Anonymous-safe: never render an empty name slot,
  // and be honest when the finder left no way to call back.
  const locationDisplay = locationLabel;

  const isUrgent = petCondition === "necesita_vet_urgente";

  const notifBody = [
    `${finderName ?? "Alguien"} dice que tiene a ${pet.name} en ${locationDisplay}.`,
    isUrgent ? "URGENTE: necesita atención veterinaria." : `Estado: ${petCondition}.`,
    finderContact ? `Contactalo/a al ${finderContact}.` : "No dejó datos de contacto.",
    safeMessage ? `Mensaje: "${safeMessage}".` : null,
    canKeepIndefinite
      ? "Puede cuidarlo indefinidamente."
      : canKeepUntil
        ? `Puede cuidarlo hasta ${canKeepUntil.toLocaleDateString("es-AR", { timeZone: AR_TIME_ZONE })}.`
        : null,
  ]
    .filter(Boolean)
    .join(" ");

  // One notification per recipient, IDENTICAL BODY — including the finder's
  // contact details (proposal D2, privacy checklist run for custodia-temporal).
  // An active caretaker is the person who physically has the animal's routine;
  // giving them a redacted version of the alert would make the second recipient
  // useless at the only thing they are there for. The titular loses nothing:
  // they still receive the full alert, ranked first.
  const possessionNotifications = recipients.map((recipient) => ({
    userId: recipient.userId,
    notificationType: "pet_in_possession",
    title: isUrgent
      ? `URGENTE: Alguien tiene a ${pet.name} y necesita vet`
      : `Alguien tiene a ${pet.name}`,
    body: notifBody,
    severity: "urgent" as const,
    category: "perdidas",
    relatedPetId: pet.id,
    ctaLabel: "Ver mascota",
    // When the pet is lost the cockpit IS /mis-mascotas/{token} and now surfaces
    // possession/sighting reports — land the owner there so they can act (UI-4 fix 7).
    ctaUrl: `/mis-mascotas/${publicToken}`,
    // Over the animal's ceiling: same row, same contact, no push.
    ...(overAnimalCeiling ? OVER_CEILING_REPORT_DELIVERY : {}),
  }));
  // THE HEALING HALF OF THE RETRY. Through the canonical write path, which
  // supplies the two things a raw insert here could not: idempotency, so a
  // retry that finds the event already written does not produce a second alert;
  // and durability, so a failure lands in notification_dead_letter instead of
  // vanishing. A raw `db.insert` that threw is exactly how the finder ended up
  // retrying into a success screen the owner never heard about.
  for (const notification of possessionNotifications) {
    await createNotification({
      ...notification,
      relatedEventId: eventId,
      dedupeKey: `event:${eventId}:${notification.userId}:pet_in_possession`,
    });
  }

  // Once per animal per clock hour, by dedupe key — every over-ceiling report
  // asks, the first one of the hour writes it.
  if (overAnimalCeiling) {
    for (const notice of anonymousReportOverflowNotices({
      publicToken,
      petId: pet.id,
      petName: pet.name,
      recipientUserIds: recipients.map((recipient) => recipient.userId),
      nowMs: Date.now(),
    })) {
      await createNotification(notice);
    }
  }

  // A5 — the origin shelter also hears about it (PO decision 2026-08-04).
  //
  // A shelter that placed this pet has territorial reach and motivation the
  // titular may not: it is a real second chance at recovery. The PO chose
  // ALWAYS over opt-in, knowing the cost, and the cost is worth naming here
  // because the code is where it becomes real: the shelter learns that an
  // animal it no longer owns turned up, and roughly where — without the titular
  // having asked for that. The mitigation is disclosure, not suppression: the
  // pet's own profile states that the origin shelter is alerted, so the titular
  // is never surprised by it.
  //
  // "Origin shelter" = the organization whose shelter_custody row was closed
  // most recently. That is the handoff that produced the current titular
  // (adoption, or a return to owner), and it is derived rather than stored so a
  // pet that passed through two shelters credits the one that placed it.
  //
  // Deliberately does NOT carry the finder's contact details — only that the
  // pet appeared and where. The finder shared their phone with the TITULAR, not
  // with an institution they never chose.
  // The predicate itself lives in lib/infra/origin-shelter-alert.ts so the
  // titular's profile disclosure can promise EXACTLY the pets this notifies.
  const originShelterOrgId = await resolveOriginShelterOrgId(pet.id);

  if (originShelterOrgId) {
    const shelterAdmins = await db
      .select({ userId: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, originShelterOrgId),
          isNull(organizationMemberships.leftAt),
        ),
      );

    if (shelterAdmins.length > 0) {
      const shelterNotifications = shelterAdmins.map((m) => ({
        userId: m.userId,
        notificationType: "origin_shelter_pet_found",
        title: `Apareció ${pet.name}, que salió de tu refugio`,
        body: `Alguien reportó tenerla en su poder${
          locationLabel ? ` en ${locationLabel}` : ""
        }. El titular ya fue avisado.`,
        severity: "info" as const,
        category: "perdidas",
        relatedPetId: pet.id,
        ctaLabel: "Ver mascota",
        // A notification CTA is the shape the native router will have to
        // resolve first (a push tap has no browser to fall back on), so the
        // path comes from the deep-link table rather than from a literal here.
        ctaUrl: deepLinkPath("credential", { publicToken }),
      }));
      // Best-effort: the finder's report is already recorded and the titular
      // already notified. A failure here must never surface to the finder —
      // and createNotification cannot throw (it dead-letters), so the try/catch
      // that used to wrap this is gone rather than kept as decoration.
      for (const notification of shelterNotifications) {
        await createNotification({
          ...notification,
          relatedEventId: eventId,
          dedupeKey: `event:${eventId}:${notification.userId}:origin_shelter_pet_found`,
        });
      }
    }
  }

  // The Web Push leg used to be a separate call here. It moved INTO
  // createNotification, which fires it only for rows that were genuinely new —
  // so a retry that dedupes no longer re-pushes "alguien tiene a tu mascota" to
  // an owner who already got it.

  return { ok: true, error: null, warning: photoWarning };
}
