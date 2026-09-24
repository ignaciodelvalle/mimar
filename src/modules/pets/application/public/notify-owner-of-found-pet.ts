// Use-case: notifyOwnerOfFoundPet — anonymous found-pet notification (strangler migration 44/61).
//
// Public, anon-callable server action for /p/[publicToken].
//
// These are reachable without auth — anyone scanning a QR can invoke them.
// Each action verifies its input by public_token + status. No PII is returned
// to the caller; the notification path uses Drizzle (bypasses RLS) to write
// a notification row scoped to the pet's current owner.
//
// Rate limiting: notifyOwnerOfFoundPetAction uses the persistent DB-backed
// enforceRateLimit (rate_limit_buckets) keyed by (IP, publicToken) so the
// limit is enforced cross-worker / cross cold-start on Vercel's multi-instance
// serverless runtime. Limit: 1/min, 10/hour per (IP, token).
//
// @no-auth-required: anonymous finder submits the form via the public-finder
// page. Rate-limited by (IP + publicToken) via the persistent DB-backed limiter
// to mitigate abuse across all Vercel workers. Limit: 1/min, 10/hour per key.
// And by the token alone (`found_notify_token`, lib/infra/anonymous-report-
// limits.ts), so the addresses a sender controls no longer multiply the alerts.
//
// ARCH-P: a notification failure never surfaces an error to the anonymous
// finder (they already submitted successfully at that point). What that
// contract does NOT license is losing the report — see below.
//
// THIS ACTION IS THE WHOLE CIRCUIT (H6, review 2026-08-22)
// ---------------------------------------------------------------------------
// It writes no event, no case, no sighting. The notification IS the only place
// the finder's phone number goes. So the write used to be a bare
// `db.insert(notifications)` inside a swallowing try/catch — no dedupe key, no
// dead-letter — and a 200 ms hiccup in the pool (a deploy, a pooler restart)
// meant the insert failed, the error was logged, and the action returned
// "listo". The person who has the animal walked away certain the owner had been
// told. Nothing had been written anywhere.
//
// It now goes through `createNotificationsBulk`, the canonical write path,
// which supplies the two things a raw insert here could not: a dead-letter, so
// a failure becomes "delayed but recoverable" and the retry cron can replay it;
// and idempotency, so that replay cannot produce a second alert. The finder
// STILL reads "listo" on a failure, and that is deliberate (PO/skeptic call):
// a stranger doing a favour must not be handed a scary error, and an error
// invites a resend that the dedupe key would then swallow. The honesty lives in
// the dead-letter, not in the copy.
//
// AND THE RECIPIENT WAS UNRANKED. The owner used to be picked with a `.limit(1)`
// over every active ownership row, with no role filter and no ORDER BY. On a pet
// with an active foster Postgres was free to return the foster, and the finder's
// phone went to them instead of the titular — on the recovery path, which is
// exactly where mis-routing hurts. That bug was found and fixed in the SIBLING
// flow (ROUTE-1, audit 2026-08-04) and the fix never reached here. A row held by
// an ORGANISATION made it worse: those carry a null user id, and when one came
// back first this action answered "No se encontró un dueño activo" over a
// perfectly notifiable titular. `resolveLostPetAlertRecipients` is that fix,
// shared rather than copied.

import { randomUUID } from "node:crypto";

import { db, pets } from "@/db";
import { SYNTHETIC_PET_WRITE_REFUSED, isSyntheticPet } from "@/lib/domain/synthetic-pet";
import {
  ANONYMOUS_REPORT_TOKEN_HARD_LIMIT,
  ANONYMOUS_REPORT_TOKEN_HARD_REFUSAL,
  ANONYMOUS_REPORT_TOKEN_LIMIT,
  OVER_CEILING_REPORT_DELIVERY,
  anonymousReportOverflowNotices,
} from "@/lib/infra/anonymous-report-limits";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { resolveLostPetAlertRecipients } from "@/lib/infra/pet-alert-recipients";
import { publicPetByToken } from "@/lib/infra/public-pet-lookup";
import { RateLimitError, callerIp, enforceRateLimit } from "@/lib/infra/rate-limit";
import { DISPUTE_TIP_NOTICE } from "@/lib/ui/dispute-copy";
import { headers } from "next/headers";

import type { PublicActionState } from "./types";

export async function notifyOwnerOfFoundPet(
  publicToken: string,
  _previous: PublicActionState,
  formData: FormData,
): Promise<PublicActionState> {
  if (!publicToken) return { ok: false, error: "Token de mascota inválido." };

  // PO 2026-07-24: name and contact are OPTIONAL — an anonymous found-report
  // still tells the owner their pet was found, which beats a finder bouncing
  // off a mandatory form. The UI explains why leaving a contact helps.
  const finderName = String(formData.get("finderName") ?? "").trim();
  const finderContact = String(formData.get("finderContact") ?? "").trim();
  const message = String(formData.get("message") ?? "").trim();

  // Rate limit FIRST — before the token resolves to anything.
  //
  // It used to sit after the lookup, justified as "a rejected submission (bad
  // token, unknown pet, disputed pet) must not burn the (IP, token) budget".
  // That reading was superseded for every other public POST in 967a1f3c: a door
  // that resolves a token before it charges for the attempt IS an existence
  // oracle — the refusal you get for an unknown token differs from the one you
  // get for a known one, and it is free. Paying for a typo is the accepted cost
  // of not answering that question for free; the two siblings under the same
  // fence (report-pet-sighting.ts, report-dispute-tip.ts) already charge first.
  //
  // The order was invisible to lint until now: this file resolved the token with
  // a hand-rolled `eq(pets.publicToken, …)` that matched no lookup marker, so the
  // fence had nothing to say about the block. Moving to the canonical
  // `publicPetByToken` predicate (the erasure fix) is what made it visible.
  //
  // callerIp() reads the trusted edge IP — prefers x-real-ip, falls back to the
  // LAST x-forwarded-for segment; never the first (client-spoofable).
  const reqHeaders = await headers();
  const ip = callerIp(reqHeaders);
  try {
    await enforceRateLimit(`found_notify:${publicToken}`, ip, {
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
      publicToken: pets.publicToken,
      inCustodyDispute: pets.inCustodyDispute,
      seedTag: pets.seedTag,
    })
    .from(pets)
    // PO-4: the ONE public predicate, never a hand-rolled token equality. An
    // erased subject's pet 404s at /p/{token}, so a form post that still
    // resolved here would answer a page that no longer exists.
    .where(publicPetByToken(publicToken))
    .limit(1);
  if (!pet) return { ok: false, error: "Mascota no encontrada." };
  // A seeded pet records no real act (lib/domain/synthetic-pet.ts).
  if (isSyntheticPet(pet)) return { ok: false, error: SYNTHETIC_PET_WRITE_REFUSED };

  // D2 hardening (red-team 2026-07): while titularidad is under review the
  // system must not relay the finder's name/contact to the contested owner —
  // that takes sides in a legal dispute. Server-side gate, not just UI: the
  // credential page hides the form, but the action is anon-callable.
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

  // The form is part of Tier 0 per AGENTS.md:376 — anyone scanning the QR can
  // notify the owner regardless of pet status. The notification is the
  // owner-side projection; there is no public broadcast and no PII exposure
  // back to the finder.

  // Who hears it. The ROUTE-1 ranking lives in lib/infra/pet-alert-recipients.ts
  // — titular first, else the institution holding custody, else whoever is
  // caring for the animal, with active caretakers joining as CONCURRENT
  // recipients. Empty means nobody is notifiable at all (every holder is an
  // organisation, or there is no live holder), which is the only case that is
  // still an honest refusal.
  const recipients = await resolveLostPetAlertRecipients(pet.id);
  if (recipients.length === 0) return { ok: false, error: "No se encontró un dueño activo." };

  // THE ANIMAL'S OWN CEILING (audit A03-2). The bucket above is per ADDRESS,
  // and this action writes nothing but urgent notifications — so N addresses
  // meant 10 × N "alguien encontró a tu mascota" an hour. This one is keyed on
  // the token alone, and placed after every refusal that writes nothing; the
  // derivation and the placement are in lib/infra/anonymous-report-limits.ts.
  //
  // OVER THE (FIRST) CEILING THIS DEGRADES, IT DOES NOT REFUSE. The sender may be holding
  // the animal, and the ceiling can be filled by a handful of addresses in six
  // minutes — a refusal here would let whoever filled it decide that no real
  // finder reaches the owner for the rest of the hour. So an over-ceiling
  // report is still written, contact and all; it just stops ringing, and the
  // owner is pushed once an hour that reports are piling up.
  //
  // BUT NOT WITHOUT END: past the degrade ceiling the only bound left was the
  // per-/64 bucket, which a /48 multiplies by 65 536. The hard bucket (300/h,
  // derivation in anonymous-report-limits.ts) refuses, and runs first so a
  // refused report does not also spend the degrade bucket.
  try {
    await enforceRateLimit(
      "found_notify_token_hard",
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
    await enforceRateLimit("found_notify_token", publicToken, ANONYMOUS_REPORT_TOKEN_LIMIT);
  } catch (err) {
    if (!(err instanceof RateLimitError)) throw err;
    overAnimalCeiling = true;
  }

  // Truncate finder-supplied strings so a notification cannot be used as a
  // payload-size vector. Plenty of room for a useful message.
  const safeName = finderName.slice(0, 80);
  const safeContact = finderContact.slice(0, 120);
  const safeMessage = message.slice(0, 500);

  // Anonymous-safe body: never render an empty name slot, and be honest when
  // there is no way to call back (the owner should not hunt for a contact
  // that was never left).
  const who = safeName || "Alguien";
  const contactLine = safeContact
    ? ` Te podés contactar al ${safeContact}.`
    : " No dejó datos de contacto.";
  const body = safeMessage
    ? `${who} dejó un mensaje: "${safeMessage}".${contactLine}`
    : `${who} encontró a ${pet.name}.${contactLine}`;

  // ONE REPORT, ONE ID — and this is what makes the dedupe key correct rather
  // than merely present. There is no event to key on (this action writes none),
  // and a content hash would collapse two different finders who typed the same
  // words. A per-submission id is STABLE across the only retry that exists here
  // — the dead-letter replay, which carries the key inside the stored payload —
  // and DISTINCT across every genuine second report. It deliberately does NOT
  // dedupe a human pressing send twice: the (IP, token) limiter above already
  // refuses that, and swallowing a real second sighting would be worse than a
  // duplicate row.
  const reportId = randomUUID();

  // One notification per recipient, IDENTICAL BODY — including the finder's
  // contact. An active caretaker is the person physically minding the animal;
  // a redacted copy would make the second recipient useless at the only thing
  // they are there for. The titular loses nothing: they are ranked first.
  //
  // `createNotificationsBulk` never throws — it dead-letters — so there is no
  // try/catch here. The one that used to wrap this was the bug: it turned a
  // failed write into a logged line and a success screen.
  await createNotificationsBulk(
    recipients.map((recipient) => ({
      userId: recipient.userId,
      notificationType: "pet_found_report",
      title: `Alguien encontró a ${pet.name}`,
      body,
      severity: "urgent" as const,
      category: "perdidas",
      relatedPetId: pet.id,
      ctaLabel: "Ver mascota",
      ctaUrl: `/mis-mascotas/${pet.publicToken}`,
      dedupeKey: `found_report:${reportId}:${recipient.userId}`,
      // Over the animal's ceiling: same row, same contact, no push.
      ...(overAnimalCeiling ? OVER_CEILING_REPORT_DELIVERY : {}),
    })),
  );

  // Once per animal per clock hour, by dedupe key — every over-ceiling report
  // asks, the first one of the hour writes it.
  if (overAnimalCeiling) {
    await createNotificationsBulk(
      anonymousReportOverflowNotices({
        publicToken,
        petId: pet.id,
        petName: pet.name,
        recipientUserIds: recipients.map((recipient) => recipient.userId),
        nowMs: Date.now(),
      }),
    );
  }

  // The Web Push leg used to be a separate dynamic import here. It lives inside
  // the service now, which fires it only for rows that were genuinely new — so
  // a replayed dead-letter cannot re-push "alguien encontró a tu mascota" to an
  // owner who already got it.
  return { ok: true, error: null };
}
