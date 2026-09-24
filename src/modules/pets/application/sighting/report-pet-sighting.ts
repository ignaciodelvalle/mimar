// Use-case: reportPetSighting — anonymous pet sighting report (strangler migration 29/61).
//
// Anonymous "I saw the pet near here" report — Tier 1 (lost mode) only.
// Trilogy unification handoff §3 PR-025.
//
// Distinct from notifyOwnerOfFoundPetAction: the finder does NOT have the
// pet, they just spotted it. We capture lat/lng + an optional description
// and emit:
//   - pet_event note_added (category=otro, kind="sighting", raw description
//     text) so the owner sees the sighting in the timeline and sightingsCount
//     can be derived from payload->>'kind' = 'sighting'.
//   - notification (pet_sighting, severity=warning) to everyone
//     `resolveLostPetAlertRecipients` ranks for this pet — titular first, then
//     the institution holding custody, then whoever is caring for it, with
//     active caretakers as concurrent recipients. A sighting
//     is NOT a hallazgo: it gets its own notification type and a high-but-
//     distinct severity so the Bandeja never styles "someone saw the pet" like
//     "someone HAS the pet" (external tester fix list #1, ciclo perdido).
//
// Rate-limited by (IP, publicToken) per 5 minutes to mitigate abuse. The
// matching limiter for the "I found her" form lives in app/actions/public.ts.
//
// P0d additions: optional photo upload, finderName, finderContact.
// Photo is uploaded to the "event-attachments" bucket via uploadAttachmentIfPresent.
// A failed upload is non-fatal — the sighting is still recorded without the photo.
// P0g: EXIF metadata (including GPS) is stripped from finder photos via sharp
// before upload. Non-fatal: falls back to original if sharp throws.
// P0g: photo also inserted into the attachments table (linked to the event) so
// the historial / eventos / EventTimeline surfaces can render it for free.
//
// @no-auth-required: anonymous sighting submission via /p/[token]/sighting.
// Rate-limited by (IP + publicToken) via the persistent DB-backed limiter so
// the limit holds cross-worker / cross cold-start. Limit: 1/min, 10/hour per key.
// And by the token alone (`sighting_token`, lib/infra/anonymous-report-limits.ts),
// so the number of addresses a sender controls no longer multiplies what
// reaches the owner.
//
// Capability-enforcement is not applicable: this use-case is anonymous.
// The thin shim (app/actions/pet-sighting.ts) delegates here directly with
// the full set of raw arguments.
//
// ARCH-P: the notification write goes through createNotificationsBulk, which
// dead-letters instead of throwing, so a notification failure never surfaces an
// error to the reporter (the sighting was already recorded successfully at that
// point) and never silently disappears either.

import { and, eq } from "drizzle-orm";
import { headers } from "next/headers";

import { attachments, cases, db, pets } from "@/db";
import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import { SYNTHETIC_PET_WRITE_REFUSED, isSyntheticPet } from "@/lib/domain/synthetic-pet";
import { insertEventIdempotent } from "@/lib/events/event-idempotency";
import { validateEventPayload } from "@/lib/events/event-schemas";
import {
  ANONYMOUS_REPORT_TOKEN_BUSY,
  ANONYMOUS_REPORT_TOKEN_LIMIT,
} from "@/lib/infra/anonymous-report-limits";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { resolveLostPetAlertRecipients } from "@/lib/infra/pet-alert-recipients";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { createAdminClient } from "@/lib/supabase/admin";
import { DISPUTE_TIP_NOTICE } from "@/lib/ui/dispute-copy";
import { parseArDatetimeLocal } from "@/lib/utils/format";

import type { SightingActionState } from "./types";

export async function reportPetSighting(
  publicToken: string,
  _previous: SightingActionState,
  formData: FormData,
): Promise<SightingActionState> {
  if (!publicToken) return { ok: false, error: "Token de mascota inválido." };

  const loc = parseLocationFromFormData(formData);
  const description = String(formData.get("description") ?? "").trim();
  const sightedAtIso = String(formData.get("sightedAt") ?? "").trim();

  // panorama-event-points Slice 1: how the coordinate was captured (LocationFields
  // emits a `locationSource` hidden field). Only the three known enum values are
  // honored; anything else (absent / legacy form) leaves it undefined so the zod
  // optional passes and the payload simply omits it.
  const rawLocationSource = String(formData.get("locationSource") ?? "").trim();
  const locationSource =
    rawLocationSource === "gps" ||
    rawLocationSource === "pin_manual" ||
    rawLocationSource === "geocodificada"
      ? (rawLocationSource as "gps" | "pin_manual" | "geocodificada")
      : undefined;

  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  // P0d: optional finder identity + photo.
  const rawFinderName = String(formData.get("finderName") ?? "").trim();
  const rawFinderContact = String(formData.get("finderContact") ?? "").trim();
  const finderName = rawFinderName ? rawFinderName.slice(0, 80) : null;
  const finderContact = rawFinderContact ? rawFinderContact.slice(0, 120) : null;
  const photoFile = formData.get("photo") instanceof File ? (formData.get("photo") as File) : null;

  // requireCoords:true + locality:"none" — coords required and range-checked; no locality
  // lookup (sighting behavior unchanged, now routed through the shared gate).
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "none", requireCoords: true });
  } catch (err) {
    if (err instanceof CoordError) {
      return {
        ok: false,
        error:
          err.code === "COORD_REQUIRED"
            ? "Marcá un punto en el mapa para indicar dónde la viste."
            : "La ubicación está fuera de rango.",
      };
    }
    throw err;
  }
  const lat = normalizedLoc.lat as number;
  const lng = normalizedLoc.lng as number;

  // The sightedAt input is a datetime-local defaulted to AR wall clock — read
  // it back as AR wall clock (offset-less `new Date(...)` would parse it in
  // the server's zone, i.e. UTC → 3h early). Pure input validation, so it stays
  // ABOVE the limiter: a mistyped date must not burn the finder's budget.
  const occurredAt = sightedAtIso ? parseArDatetimeLocal(sightedAtIso) : new Date();
  if (!occurredAt) {
    return { ok: false, error: "Fecha y hora del avistaje inválida." };
  }

  // ORDER: pure input validation → limiter → token lookup.
  //
  // Rate limit — consumed only after PURE INPUT validation (tester fix #6): a
  // validation-rejected submission (missing pin, invalid date) used to burn the
  // (IP, token) budget and block the immediate retry. Nothing above this line
  // touches the database, so nothing above it can be asked a question about a
  // token.
  //
  // AND IT RUNS BEFORE THE LOOKUP (fixed 2026-08-21). It used to sit after the
  // pet row, the lost-status gate and the owner read, which made this an
  // unbounded ORACLE: the page hosting the form 404s for an unknown token, but
  // the action is hand-postable and nothing requires the page load. The
  // refusals are DISTINCT strings ("Mascota no encontrada." vs "Esta mascota no
  // está marcada como perdida."), so a caller could enumerate which DIM tokens
  // exist AND which of those animals are currently lost — a live map of
  // unattended animals — at whatever rate Postgres would serve. The limiter is
  // what makes that finite, and a limiter consulted after the read it was meant
  // to prevent bounds nothing.
  const reqHeaders = await headers();
  const ip = callerIp(reqHeaders);
  try {
    await enforceRateLimit(`sighting:${publicToken}`, ip, {
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

  const [pet] = await db
    .select({
      id: pets.id,
      name: pets.name,
      status: pets.status,
      inCustodyDispute: pets.inCustodyDispute,
      seedTag: pets.seedTag,
    })
    .from(pets)
    // PO-4: a soft-deleted pet resolves nowhere public. The page hosting this
    // form already 404s — this is the hand-rolled-POST half of the same gate.
    .where(publicPetByToken(publicToken))
    .limit(1);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };
  // A seeded pet records no real act (lib/domain/synthetic-pet.ts).
  if (isSyntheticPet(pet)) return { ok: false, error: SYNTHETIC_PET_WRITE_REFUSED };
  if (pet.status !== "lost") {
    // Only meaningful while the pet is in lost mode.
    return { ok: false, error: "Esta mascota no está marcada como perdida." };
  }

  // D2 hardening (red-team 2026-07): the sighting flow ends in an owner
  // notification AND an owner-visible timeline payload that can carry the
  // finder's contact — it cannot be cleanly separated from the relay, so a
  // disputed pet blocks the whole submission server-side.
  //
  // The finder is NOT left without a channel (PO decision 2026-07-30): both
  // the credential and the two standalone finder routes now render the
  // neutral tip form, whose submission lands on the dispute case for the
  // reviewing authority only (report-dispute-tip.ts). This refusal is what a
  // hand-rolled POST hits — no UI points at it anymore.
  if (pet.inCustodyDispute) {
    return {
      ok: false,
      error: `${DISPUTE_TIP_NOTICE} Enviá tu aviso desde la credencial de la mascota.`,
    };
  }

  // THE ANIMAL'S OWN CEILING (audit A03-2). The bucket above is per ADDRESS,
  // so N addresses meant 10 × N sightings an hour on this pet's spine and in
  // its owner's inbox. This one is keyed on the token alone. It sits here —
  // after every refusal that writes nothing, before the photo upload and the
  // event — for the reasons in lib/infra/anonymous-report-limits.ts.
  try {
    await enforceRateLimit("sighting_token", publicToken, ANONYMOUS_REPORT_TOKEN_LIMIT);
  } catch (err) {
    if (err instanceof RateLimitError) return { ok: false, error: ANONYMOUS_REPORT_TOKEN_BUSY };
    throw err;
  }

  // NOBODY IS RESOLVED HERE ANY MORE, AND THAT IS THE POINT. This is where the
  // titular used to be looked up, and the lookup was a PRECONDITION FOR
  // RECORDING THE FACT: `if (!owner?.userId) return { ok: false, … }`, twenty
  // lines above the event insert and the photo upload. Who can be told about a
  // sighting is a routing question; whether the sighting happened is not, and
  // this repo's own invariant says facts are event-sourced and append-only.
  // Gating the fact on the audience inverted that.
  //
  // It threw real reports away. 381 pets on staging are held ONLY by an
  // organisation, with no person on any live ownerships row (one of them lost
  // right now), and every one of those resolves to zero notifiable recipients.
  // Somebody scans that animal's QR, types what they saw, and the report is
  // discarded under a message that is not even true — there IS an active
  // holder, it just is not a person. Pre-existing, not new: the bare `limit(1)`
  // could return the org row with a null `userId` and hit the same early
  // return. The recipient read now sits below the event write, where it belongs.
  const safeDescription = description.slice(0, 500);

  const noteText = safeDescription
    ? safeDescription
    : `Alguien reportó haber visto a ${pet.name} cerca de este punto.`;

  // P0d/P0g: upload photo if present. Non-fatal — sighting is recorded even when upload fails.
  // Uses the service-role admin client because this action is anonymous (@no-auth-required)
  // and the event-attachments bucket's RLS grants INSERT only to authenticated roles.
  // The admin client bypasses RLS so anonymous finders can attach photos.
  // P0g: stripMetadata:true strips EXIF GPS + camera metadata via sharp before upload.
  let photoStoragePath: string | null = null;
  let photoMimeType: string | null = null;
  let photoSize: number | null = null;
  let photoWarning: string | null = null;
  if (photoFile && photoFile.size > 0) {
    const supabase = createAdminClient();
    const uploadResult = await uploadAttachmentIfPresent(supabase, photoFile, "event-attachments", {
      stripMetadata: true,
    });
    if (uploadResult.error) {
      console.warn("[pet-sighting] Photo upload failed (non-fatal):", uploadResult.error);
      photoWarning = "No se pudo subir la foto, pero el avistaje fue registrado igual.";
    } else {
      photoStoragePath = uploadResult.uploadedPath;
      photoMimeType = uploadResult.mimeType;
      photoSize = uploadResult.size;
    }
  }

  const payload = validateEventPayload("note_added", {
    category: "otro" as const,
    text: noteText,
    kind: "sighting" as const,
    finderName: finderName ?? undefined,
    finderContact: finderContact ?? undefined,
    photoStoragePath: photoStoragePath ?? undefined,
    location_source: locationSource,
  });

  // Resolve the open lost_pet_episode case so the sighting event is associated
  // with it. This scopes sightingsCount by caseId and prevents counting sightings
  // from a prior lost episode if the pet was lost→found→lost again.
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

  // P4 item 3 (2026-07-08): insertEventIdempotent's advisory lock requires an
  // active transaction (pg_advisory_xact_lock is tx-scoped) — this call site
  // used to pass no executor (defaulting to the bare `db`), so the lock would
  // acquire-and-release inside its own auto-committed statement and never
  // actually hold across the insert. Wrapping in db.transaction() closes that.
  const { event: insertedEvent, wasNoop } = await db.transaction((tx) =>
    insertEventIdempotent(
      {
        petId: pet.id,
        eventType: "note_added",
        occurredAt,
        recordedAt: new Date(),
        recordedByUserId: null,
        authorRole: "scanner",
        authorVerified: false,
        payload,
        locationLat: lat.toString(),
        locationLng: lng.toString(),
        // Associate with the open case when available (pet is in active lost mode).
        // caseId stays null if no open case exists (guard above already blocked
        // non-lost pets, but we keep the null path for safety).
        caseId: openCase?.id ?? null,
        clientIdempotencyKey,
      },
      tx,
    ),
  );

  // Idempotency guards the EVENT. It used to guard the notification too, by
  // returning here, and that made a retry unable to heal a half-finished first
  // attempt — the worse shape of the two finder flows, because the insert below
  // was wrapped in a catch that SWALLOWED. Attempt 1 could return the success
  // screen having written no notification at all, and the retry then refused to
  // try again. The owner of a lost animal is simply never told it was seen.
  //
  // The notification now runs on both paths, carrying its own idempotency
  // (dedupeKey), which is what makes re-attempting safe rather than noisy.

  // P0g: also insert into the attachments table so the historial/eventos/EventTimeline
  // surfaces render the photo for free (they read attachments, not the payload JSONB).
  // uploadedByUserId is null: anonymous sighting — no authenticated user.
  // Mirror pattern from app/actions/events.ts (checkin, vaccination, etc.).
  if (!wasNoop && photoStoragePath && insertedEvent) {
    await db.insert(attachments).values({
      petId: pet.id,
      eventId: insertedEvent.id,
      uploadedByUserId: null,
      storagePath: photoStoragePath,
      mimeType: photoMimeType ?? "image/jpeg",
      fileSize: photoSize ?? 0,
    });
  }

  const bodyParts = [
    `Alguien reportó haber visto a ${pet.name} cerca de un punto.`,
    safeDescription ? `Mensaje: "${safeDescription}".` : null,
    // No emoji. This body is a push notification and an in-app alert, so it
    // lands on a lock screen and in a screen reader, where a phone glyph is
    // read aloud as "telephone receiver" ahead of the name and the number that
    // actually matter. The words carry it: the line already says someone left
    // contact details.
    finderName && finderContact
      ? `${finderName} dejó su contacto: ${finderContact}.`
      : finderContact
        ? `Contacto de quien la vio: ${finderContact}.`
        : finderName
          ? `Reportado por ${finderName}.`
          : null,
    "Mirá el detalle en su perfil.",
  ].filter(Boolean);

  // WHO HEARS IT — resolved here, AFTER the fact is on the spine, so an empty
  // answer costs the reporter nothing.
  //
  // This used to be a bare `(pet_id, ended_at IS NULL)` + `limit(1)` — heap
  // order — so a pet with an accepted temporary caretaker could deliver the
  // sighting, and a stranger's contact with it, to the caretaker while the
  // titular was never told their pet had been seen.
  //
  // THE FIRST REMEDY WAS WORSE THAN THE BUG, AND THIS FILE IS WHY THE SHELF
  // SAYS SO. Adding `role = 'owner'` (afd01fb3c) turned the read into a gate no
  // pet in shelter custody can pass: that pet has a shelter_custody org row and
  // a foster user row and NO owner row at all. pet-alert-recipients.ts had
  // written that argument down on 2026-08-04, in this file's own words: "a role
  // FILTER would have been worse than the bug… Ranking is the fix".
  //
  // So the sighting flow migrates onto the shared ranking. That module named it
  // a deliberate non-caller — "migrating it is a decision, not a tidy-up" — and
  // this IS that decision, taken rather than drifted into: the recipient set of
  // a sighting is the same question as the recipient set of a found report, one
  // notch lower in stakes, and a second copy of the rule would drift from the
  // promise the caretaker UI makes.
  //
  // It preserves what afd01fb3c genuinely repaired, and that half must not be
  // "restored" away: under the rehome-by-titular sponsorship a pet holds a live
  // owner row AND a live org shelter_custody row, and the org row winning used
  // to return a null userId and a false "no active owner". Ranking prefers the
  // owner row and never lets an org row block — org rows carry no user id, so
  // the helper's `isNotNull(ownerUserId)` keeps them from occupying a rank at
  // all. Same repair, without the new hole.
  //
  // An EMPTY set is now a normal outcome, not a failure: an org-held pet has
  // nobody notifiable, and the sighting is still recorded and still visible on
  // the pet's timeline. Whether a shelter's MEMBERS should receive sighting
  // alerts for animals in their custody is a product question, deliberately
  // left open.
  const recipients = await resolveLostPetAlertRecipients(pet.id);

  // Insert notification — best-effort; a failure must not surface an error to the
  // reporter (the sighting was already recorded successfully).
  // Taxonomy: a sighting is its own notification type ("pet_sighting"), never
  // "pet_found_report" — the finder does NOT have the pet. Severity "warning"
  // keeps it elevated in the Bandeja while visually distinct from the urgent
  // possession/found alerts (red bar vs amber bar).
  // One notification per recipient, IDENTICAL BODY — the same call the found
  // report makes, and for the same reason: an active caretaker is the person
  // physically minding the animal, and a redacted copy would make the second
  // recipient useless at the only thing they are there for. The titular loses
  // nothing; ranking puts them first in any surface that orders by
  // responsibility.
  //
  // Through the canonical write path. The try/catch that used to sit here
  // SWALLOWED — a failed insert was logged to the console and the reporter got
  // the success screen anyway, so the owner of a lost animal was never told it
  // had been seen and nobody found out. createNotificationsBulk cannot throw
  // either, but it dead-letters instead of discarding, and its dedupe key lets
  // a retry land the alert the first attempt lost. The Web Push leg lives
  // inside it and fires only for genuinely new rows, so a retry cannot
  // double-push.
  //
  // The dedupe key keeps the event id AND gains the recipient, so two
  // recipients of one sighting are two rows rather than one row and a swallowed
  // conflict.
  await createNotificationsBulk(
    recipients.map((recipient) => ({
      userId: recipient.userId,
      notificationType: "pet_sighting",
      title: `Avistaje de ${pet.name}`,
      body: bodyParts.join(" "),
      severity: "warning" as const,
      category: "perdidas",
      relatedPetId: pet.id,
      ctaLabel: "Ver mascota",
      // Land on the cockpit (/mis-mascotas/{token}) which now surfaces sighting
      // and possession reports while the pet is lost (UI-4 fix 7).
      ctaUrl: `/mis-mascotas/${publicToken}`,
      relatedEventId: insertedEvent?.id ?? null,
      dedupeKey: `event:${insertedEvent?.id ?? pet.id}:${recipient.userId}:pet_sighting`,
    })),
  );

  return { ok: true, error: null, warning: photoWarning };
}
