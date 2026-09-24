// The IP-less ceiling on the anonymous reports a stranger can file about ONE
// animal (audit A03-2, re-filed from the prior audit as still open):
//
//   src/modules/pets/application/sighting/report-pet-sighting.ts    `sighting_token`
//   src/modules/pets/application/public/notify-owner-of-found-pet.ts `found_notify_token`
//   app/(public)/p/[publicToken]/encontre/action.ts                  `finder_possession_token`
//   src/modules/custody-disputes/application/report-dispute-tip.ts   `dispute_tip_token`
//
// WHAT WAS MISSING. Each is keyed `(surface:token, ip)` at 1/min + 10/hr and
// nothing else. A lost pet's token is public on purpose — posters, WhatsApp,
// the /perdidas board — so anyone with N addresses could send its owner 10 × N
// urgent notifications an hour and append 10 × N rows to the animal's
// append-only spine, with no ceiling keyed on the animal itself. The shape that
// closes it was already in the repo: submit-org-contact.ts pairs its per-IP
// bucket with an IP-less `org_contact_org:<org>` one.
//
// ---------------------------------------------------------------------------
// WHY A PER-TOKEN CAP IS RIGHT HERE WHEN IT WAS REJECTED FOR THE CREDENTIAL
// ---------------------------------------------------------------------------
// app/api/v1/pets/[publicToken]/credential/limits.ts considered a token-only
// cap on the credential READ and rejected it twice, for two reasons. Both were
// weighed again for these WRITES:
//
//   · It cannot tell abuse from the success case. For a read, the viral poster
//     IS one token from thousands of addresses. For a report it is not: a
//     report is somebody who saw the animal typing a form, and thirty distinct
//     reports about one animal inside one hour is already a crowd around it.
//   · It is a griefing primitive. Still true — and cheaper than this file first
//     claimed. It used to say "silencing an animal for an hour takes three
//     addresses working the whole hour". The windows are FIXED CLOCK WINDOWS
//     (lib/infra/rate-limit.ts, `Math.floor(now / 3_600_000)`), not sliding
//     ones, and the per-address bucket allows 1/min, so the real arithmetic is:
//
//       five addresses × 1/min each = 5/min, which is also the token's minute
//       cap → 30 reports land in 30 / 5 = 6 minutes. Fired at hh:00, that
//       leaves ~54 minutes of the hour with the animal's bucket full. Three
//       addresses need 10 minutes (3/min; 10 each is exactly their hourly
//       cap). Neither needs to work the whole hour.
//
//     And addresses are cheap: before callerIp() grouped IPv6 by /64 one host
//     had effectively unlimited ones, and even grouped, a hosting account
//     hands out a /48 — 65 536 /64s. So a HARD refusal on the token bucket is a
//     denial of rescue: a stranger who read the token off /perdidas posts ~30
//     fake "la tengo conmigo" at the top of each hour, every REAL finder is
//     refused for the rest of it, and the owner receives only the fakes.
//     Before the cap the same flood buried the real report, but the real report
//     still ARRIVED, with the finder's contact on it.
//
//     So the cap does two different things depending on what silencing costs:
//
//       1. SIGHTINGS AND DISPUTE TIPS REFUSE. A sighting is one of many ("vi un
//          perro así en la plaza"), and a tip goes to a reviewing authority, not
//          to the family; losing one for the rest of an hour costs little, and
//          the refusal copy says so honestly (ANONYMOUS_REPORT_TOKEN_BUSY).
//       2. THE TWO "I HAVE THE ANIMAL" REPORTS DEGRADE, NEVER REFUSE
//          (`found_notify_token`, `finder_possession_token`). Over the ceiling
//          the report is still accepted and written — the event on the spine,
//          the notification with the finder's contact — but WITHOUT its photo,
//          and the owner's copy stops ringing: it is written at
//          OVER_CEILING_REPORT_DELIVERY (no push), and the owner gets ONE
//          notice per animal per clock hour, pushed, saying reports are piling
//          up (anonymousReportOverflowNotices, below). The finder sees the
//          normal success screen, plus one line when a photo they attached was
//          not kept. Past a second, much higher ceiling (300/h, below) even
//          these surfaces refuse. What the cap bounds here is the INTERRUPTIONS —
//          thirty pushes an hour — not the reports, because the one real
//          report inside a flood is the whole reason the surface exists.
//
//     What is still true from the original list: the per-address bucket runs
//     FIRST and still refuses one noisy address outright, and every surface has
//     its own token bucket, so a flood of fake sightings cannot touch a
//     "la tengo conmigo".
//
// ---------------------------------------------------------------------------
// THE NUMBERS — anchored on the per-(address, token) bucket all four spend
// ---------------------------------------------------------------------------
//   per minute    5 = five different people reporting the same animal inside
//                     the same sixty seconds, at their own 1/min each
//   per hour     30 = 3 × one address's hourly 10 — the fewest addresses that
//                     can exhaust it together is three
//
// So what an owner can be INTERRUPTED by from anonymous reporters, per surface,
// is at most thirty pushes an hour, instead of 10 × however many addresses
// somebody can rent. For sightings and dispute tips that is also the ceiling on
// rows written. For the two degrading surfaces it is not: rows past the ceiling
// still land (quietly, plus one overflow notice an hour), because a ceiling on
// rows there is a ceiling on rescue.
//
// ---------------------------------------------------------------------------
// AND THE DEGRADING SURFACES STILL HAVE A HARD CEILING — just a much higher one
// ---------------------------------------------------------------------------
// "Rows past the ceiling still land" left ONE bound on those rows: the
// per-address bucket. That is 10/h per address, and callerIp() groups IPv6 by
// /64, so a /48 from any hosting account is 65 536 addresses × 10 = 655 360
// permanent `note_added` rows (and, before this change, as many photos) on one
// lost animal's append-only spine in an hour. A spine nobody can prune is not a
// place to leave a ceiling open.
//
// So each degrading surface also spends a SECOND token bucket that refuses:
//
//   per hour    300 = 10 × the degrade ceiling of 30 = thirty addresses at their
//                     full 10/h each, all reporting the same animal. No real
//                     rescue produces three hundred "la tengo conmigo" for one
//                     animal in one hour; a flood does.
//
// What that buys: at most 300 spine rows per animal per hour (7 200 a day)
// instead of 655 360 an hour, and — because a DEGRADED report no longer stores
// its photo (the actions skip the upload over the degrade ceiling) — at most 30
// finder photos per animal per hour. What it costs, stated plainly: this bucket
// IS a griefing primitive again. With no minute window, 300 addresses can fill
// it in one minute and every real finder is refused for the rest of that hour.
// That is the trade the review asked for: an unbounded permanent spine is worse,
// and the refusal (ANONYMOUS_REPORT_TOKEN_HARD_REFUSAL) says what still works
// without us — the phone on the credential, a microchip read at a vet.
//
// NO MINUTE WINDOW on it, deliberately: a per-minute cap would not slow a
// griefer (they refill it at the top of every minute) and would refuse real
// finders inside every one of those minutes instead of once.
//
// NO DAY WINDOW, deliberately. It would bound a sustained campaign harder, and
// it would stretch a griefer's silence from an hour to a day, on the surface
// whose whole point is that a report arrives while the animal is still there.
//
// WHERE IT RUNS IN EACH ACTION: after the lookup and the refusals that do not
// write anything (unknown token, not lost, under dispute, nobody to notify),
// immediately before the first write. Two reasons. A submission that is going
// to be refused anyway must not spend the animal's budget. And a caller walking
// random tokens must not double the limiter's write amplification: the
// per-address bucket already writes a fresh pair of rows for every token it is
// handed, and a second bucket ahead of the lookup would write another pair for
// tokens that do not exist. The per-address bucket stays where it is — first,
// before the lookup — because it is what bounds the existence oracle.

import type { CreateNotificationInput } from "@/lib/infra/notification-service";
import type { RateLimitConfig } from "@/lib/infra/rate-limit";

/** Per token, no address. One bucket per surface; derivation above. */
export const ANONYMOUS_REPORT_TOKEN_LIMIT: RateLimitConfig = {
  maxPerMinute: 5,
  maxPerHour: 30,
};

/**
 * The hard per-token ceiling on the two DEGRADING surfaces
 * (`found_notify_token_hard`, `finder_possession_token_hard`): 300/h = 10 × the
 * degrade ceiling of 30. Derivation and cost above. Hour only, on purpose.
 */
export const ANONYMOUS_REPORT_TOKEN_HARD_LIMIT: RateLimitConfig = {
  maxPerHour: 10 * 30,
};

/**
 * Refusal once the hard ceiling is full. The sender may be holding the animal,
 * so it has to say what still works without us.
 */
export const ANONYMOUS_REPORT_TOKEN_HARD_REFUSAL =
  "Recibimos demasiados avisos sobre esta mascota en la última hora y no podemos registrar otro ahora. " +
  "Si la credencial muestra un teléfono, llamá directamente; si no, una veterinaria o un refugio " +
  "puede leer su microchip. Probá de nuevo cuando empiece la próxima hora.";

/**
 * What a finder is told when their report went through over the degrade
 * ceiling but the photo they attached was NOT stored (degraded reports store no
 * photo — that is what bounds the photos to 30 per animal per hour). Only shown
 * when a photo was actually attached: a finder who believes the owner saw their
 * photo will not think to describe the animal or leave a contact.
 */
export const OVER_CEILING_PHOTO_DROPPED_WARNING =
  "El aviso fue registrado, pero la foto no se guardó porque llegaron muchos avisos sobre esta mascota en la última hora.";

/**
 * Refusal when the ANIMAL's ceiling is full — sightings and dispute tips only.
 * Says nothing about the caller, who may have sent nothing. The two "I have the
 * animal" surfaces never show a refusal for this bucket; see above.
 */
export const ANONYMOUS_REPORT_TOKEN_BUSY =
  "Recibimos muchos avisos sobre esta mascota en la última hora. Probá de nuevo más tarde.";

/**
 * How the owner's copy of a report is delivered once the animal's bucket is
 * full, on the two degrading surfaces. Still written, still carrying the
 * finder's contact, still in the Bandeja under Perdidas — but `warning` rather
 * than `urgent`, which is what keeps it off both push legs
 * (lib/infra/push-eligibility.ts pushes `urgent` and `pet_sighting` only), and
 * `suppressPush` so that stays true even if eligibility later widens.
 */
export const OVER_CEILING_REPORT_DELIVERY = {
  severity: "warning",
  suppressPush: true,
} as const satisfies Pick<CreateNotificationInput, "severity" | "suppressPush">;

/** Notification type of the once-an-hour "reports are piling up" notice. */
export const ANONYMOUS_REPORT_OVERFLOW_NOTIFICATION_TYPE = "anonymous_reports_overflow";

const HOUR_MS = 3_600_000;

/**
 * The owner-side notice that the animal's ceiling was crossed, one row per
 * recipient. Called on EVERY over-ceiling report; the dedupe key is what makes
 * it once per animal per clock hour: `found_overflow:{token}:{hourStart}:{user}`
 * with `hourStart` floored exactly as rate-limit.ts floors the hour bucket, so
 * the notice's hour is the bucket's hour. Shared by both degrading surfaces on
 * purpose — the owner needs to hear "look at the list" once, not once per form.
 *
 * IT PUSHES (`urgent`, no suppressPush), unlike the reports it summarises. It
 * used to ride OVER_CEILING_REPORT_DELIVERY on the theory that a thirty-first
 * push adds nothing — but it is the ONLY signal that the reports after the
 * thirtieth exist at all, and those are exactly the ones that no longer ring.
 * A notice nobody is told to look at leaves the one real finder inside a flood
 * sitting silently in the Bandeja. The dedupe key already bounds it to one push
 * per recipient per clock hour, so pushing costs one interruption an hour.
 */
export function anonymousReportOverflowNotices(input: {
  publicToken: string;
  petId: string;
  petName: string;
  recipientUserIds: readonly string[];
  nowMs: number;
}): CreateNotificationInput[] {
  const hourStart = new Date(Math.floor(input.nowMs / HOUR_MS) * HOUR_MS).toISOString();
  const body = [
    `Llegaron muchos avisos sobre ${input.petName} en la última hora.`,
    "Para no llenarte de alertas, los que sigan llegando hasta que termine la hora se guardan sin sonar y sin foto:",
    `revisá tus notificaciones de Perdidas y el historial de ${input.petName} para verlos todos.`,
  ].join(" ");
  return input.recipientUserIds.map((userId) => ({
    userId,
    notificationType: ANONYMOUS_REPORT_OVERFLOW_NOTIFICATION_TYPE,
    title: `Muchos avisos sobre ${input.petName}`,
    body,
    severity: "urgent" as const,
    category: "perdidas",
    relatedPetId: input.petId,
    ctaLabel: "Ver mascota",
    ctaUrl: `/mis-mascotas/${input.publicToken}`,
    dedupeKey: `found_overflow:${input.publicToken}:${hourStart}:${userId}`,
  }));
}
