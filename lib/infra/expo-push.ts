import "server-only";

import { createHash } from "node:crypto";

import {
  Expo,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from "expo-server-sdk";

import { PUSH_ANDROID_CHANNEL_ID, PUSH_ANDROID_HEALTH_CHANNEL_ID } from "@dim/contract/input";

import { isPushEligible } from "@/lib/infra/push-eligibility";
import {
  type PendingReceipt,
  activePushTargetsForUser,
  clearPendingPushReceipt,
  markPushTargetUsed,
  pendingPushReceipts,
  revokePushTargetById,
} from "@/lib/infra/push-target-store";
import { reportError } from "@/lib/infra/report-error";

/**
 * The NATIVE delivery leg — Expo Push Service — sibling of `web-push.ts`.
 *
 * WHY EXPO AND NOT FCM/APNs DIRECTLY. The app is Expo-managed with EAS builds,
 * and Expo's service brokers to both stores: one server code path instead of
 * two, no APNs `.p8` to handle, no FCM service-account JSON in the server
 * environment. The design documents that say "FCM/APNs" were written before the
 * Expo app existed; they are not being overridden, they simply never considered
 * this.
 *
 * THIS FILE INHERITS WEB PUSH'S FRAGILITY ON PURPOSE. It runs on the request
 * path, awaited, with no retry beyond the revoke case below — exactly the
 * posture the web leg already has. That is a known and accepted shape, not a new
 * risk, and building the durable outbox instead would be a multi-week workstream
 * that swallowed this one.
 *
 * NOTHING HERE THROWS TO ITS CALLER. `createNotification` awaits the push seam
 * and must not fail because a lock screen did not light up (ARCH-P).
 */

/** Read once per call, not at module load, so a test can stub the env. */
function accessToken(): string | undefined {
  const raw = process.env.EXPO_ACCESS_TOKEN?.trim();
  return raw ? raw : undefined;
}

/**
 * True when this leg is configured.
 *
 * A MISSING TOKEN IS A NO-OP, NOT A THROW, exactly as `isWebPushEnabled()` makes
 * a missing VAPID key one. Most environments that run this code — a local stack,
 * a preview deploy, a test — have no Expo project credential and must not fail a
 * notification write because of it.
 *
 * IT DOES NOT READ THE WEB'S FLAG. `NEXT_PUBLIC_PUSH_ENABLED` gates the web leg
 * and only the web leg; a deployment that turns web push off has said nothing
 * about phones.
 */
export function isExpoPushEnabled(): boolean {
  return accessToken() !== undefined;
}

/** The subset of a notifications row this leg needs. Structurally compatible
 *  with `PushCandidateRow`, and deliberately not imported from the web leg. */
export type ExpoPushCandidateRow = {
  userId: string;
  severity?: "info" | "success" | "warning" | "urgent" | null;
  notificationType?: string | null;
  title: string;
  body?: string | null;
  ctaUrl?: string | null;
  dedupeKey?: string | null;
};

/** One message, and the row it must be reconciled against when tickets return. */
type Addressed = { targetId: string; message: ExpoPushMessage };

/**
 * Deliver every eligible row to every live device its addressee has.
 *
 * THE TICKETS COME BACK POSITIONALLY, which is the one thing about this API that
 * will bite somebody: `sendPushNotificationsAsync` answers an array whose nth
 * ticket belongs to the nth message, and the tickets carry no token of their own
 * on the success path. So the target id has to be carried alongside the message
 * and zipped back afterwards — reading the token out of a ticket works only for
 * errors and would silently stop bumping `last_used_at` the day it is relied on.
 *
 * CHUNKED THROUGH THE SDK'S OWN SPLITTER rather than a number chosen here. Expo
 * caps a request's message count and the cap is the SDK's to know; hardcoding
 * one would be a second copy of a limit that can move under us.
 */
/**
 * Build one message per (live device × eligible row), carrying the target id so
 * the tickets can be zipped back afterwards.
 *
 * ONE LOOKUP PER DISTINCT ADDRESSEE, not per row: a flush that wrote three
 * urgent rows for one person would otherwise read their device list three times
 * on the request path.
 */
async function addressMessages(rows: ExpoPushCandidateRow[]): Promise<Addressed[]> {
  const byUser = new Map<string, ExpoPushCandidateRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.userId);
    if (list) list.push(row);
    else byUser.set(row.userId, [row]);
  }

  const addressed: Addressed[] = [];
  for (const [userId, userRows] of byUser) {
    const targets = await activePushTargetsForUser(userId);
    for (const target of targets) {
      // A token the SDK does not recognise never reaches the network. It is
      // also not an error worth reporting: the contract already refuses a
      // malformed one at the endpoint, so reaching here means the shape changed
      // under us — revoke it and let the device re-register rather than
      // retrying it nightly forever.
      if (!Expo.isExpoPushToken(target.expoPushToken)) {
        await revokePushTargetById(target.id);
        continue;
      }
      for (const row of userRows) {
        addressed.push({ targetId: target.id, message: messageFor(target.expoPushToken, row) });
      }
    }
  }
  return addressed;
}

/**
 * The notification types whose title AND body may be rendered VERBATIM on a
 * lock screen, and therefore handed in plaintext to Expo.
 *
 * WHY THIS LIST EXISTS, AND WHY IT IS AN ALLOWLIST
 * ------------------------------------------------
 * Expo Push is a third-party processor in the United States, and the title and
 * body of a message travel through it in the clear: they sit in Expo's
 * infrastructure, they reach APNs/FCM, and they land on a LOCK SCREEN that
 * anybody holding the phone can read without unlocking it. The web leg has no
 * equivalent exposure — a Web Push payload is end-to-end encrypted to the
 * browser's own keys, so `web-push.ts` can send the row as written and this
 * file cannot. That asymmetry is why the declaration lives here and not in the
 * channel-neutral `push-eligibility.ts`: it is a property of the TRANSPORT, not
 * of the row. If the web leg ever stops being end-to-end encrypted, this moves.
 *
 * Some notification bodies are built from a third party's personal data. The
 * worst is `pet_in_possession`, whose body carries the finder's NAME, PHONE,
 * the LOCATION they are holding the animal at and their free-text message
 * (app/(public)/p/[publicToken]/encontre/action.ts:406-433). Under Ley 25.326
 * art. 12 that is an international transfer of personal data, and it is not the
 * kind of thing that may happen because nobody looked.
 *
 * THE DEFAULT IS CLOSED, AND THAT IS THE WHOLE POINT. A denylist of leaky types
 * would be a fence that enumerates FORMS, and this repo has already learned what
 * those cost: the one spelling nobody thought of is the one that ships. The
 * subject here is "may this text leave the building", so the answer defaults to
 * NO and a type earns `true` only by being read and argued. A notification type
 * invented next month — or an existing type whose body grows a new interpolated
 * variable — is generic until somebody comes back here, which is the failure
 * mode we want: a duller lock screen, not a leak.
 *
 * A TYPE IS ONLY AS SAFE AS ITS LEAST SAFE CREATION SITE. `vaccine_due` is the
 * worked example and the reason this list is short: one of its two writers
 * (lib/infra/outreach-reminders.ts:196-206) builds a body from the pet's name
 * and a day count, which is fine, and the other (lib/infra/notifications.ts:242)
 * passes `row.title` straight off a reminder the person typed themselves. Free
 * text cannot be argued about, so the TYPE is unsafe even though one of its
 * sites is not. Every entry below was checked against EVERY site that creates
 * it, not against the first one found.
 *
 * TWO EXCLUSION RULES DID MOST OF THE WORK, and they are written down so the
 * next person extends the list the same way rather than re-deciding:
 *
 *   1. FREE TEXT IS NEVER SAFE. A field somebody typed cannot be argued about,
 *      only read, and the next person to type in it has not read this comment.
 *      This is what disqualifies `pet_in_possession`, `pet_sighting` and
 *      `pet_found_report` (a finder's message), the two `closureNotes` rabies
 *      types, `decomiso_owner_lost_custody` (`judicialProceedingReference`,
 *      validated nowhere), `rabies_observation_completed_dead_authority` (the
 *      `facility` field, likewise) and `vaccine_due` — whose scheduled-scan
 *      writer passes `reminders.title` straight through
 *      (lib/infra/notifications.ts:244), a column a person can write.
 *
 *   2. AN ORGANISATION'S DISPLAY NAME COUNTS AS A NAME. A refugio or a
 *      veterinaria can be, and often is, one natural person trading under their
 *      own name, and the row's context — a seizure, a maltreatment report, a
 *      custody handover — is exactly what makes the pairing sensitive. So
 *      `welfare_org_side_critical_received`, `decomiso_handoff_proposed_receiver`,
 *      `chip_match_notification_owner`, `bite_reported_authority` and
 *      `custody_transfer_proposal_owner` stay off, even though each has at
 *      least one writer that names nobody. Cheap to give up; expensive to be
 *      wrong about.
 *
 * A PET'S NAME IS FREE TEXT, AND RULE 1 EATS SIX ENTRIES THIS LIST USED TO
 * CARRY. This is the correction, written out rather than quietly applied,
 * because the mistake is the interesting part: the list was drawn up reading
 * every writer for a THIRD PARTY'S data, found none, and admitted the type —
 * while `${pet.name}` sat in the title of six of them. A pet name is not a
 * third party's name, which is true and was never the question rule 1 asks.
 * The question rule 1 asks is whether somebody TYPED it, and nothing validates
 * this one: `PET_NAME_MAX` is 80 characters
 * (packages/contract/src/input/pet-profile-edit.ts) and registration takes the
 * field as `requiredText("NAME_REQUIRED")` — non-empty, trimmed, and otherwise
 * anything at all. A pet registered as `miMAR: verificá tu cuenta en
 * bit.ly/xY7` fits in 39 of those characters, and the day that animal gets an
 * ENO diagnosis the string renders verbatim on a government official's lock
 * screen and is transferred in the clear to Expo, to FCM and to APNs. That is
 * the exact transfer this list exists to prevent.
 *
 * So `rabies_observation_pending_review`, `microchip_fraud_detected`,
 * `microchip_updated_by_institution`, `eno_disease_diagnosis`,
 * `eno_pet_disease_diagnosis` and `disease_public_alert` are OFF, each for the
 * one reason: it renders a pet's name. Six separate excuses would read like six
 * separate judgements; there is one rule and they all break it.
 *
 * SUBSTITUTING THE PUBLIC TOKEN FOR THE NAME WAS CONSIDERED AND REJECTED. It
 * needs a token on rows that do not all carry one, and it buys back a duller
 * lock screen by trading a rule everybody can apply for a special case somebody
 * has to remember. The honest outcome is two entries. A list of eight that
 * admitted free text was a wish, not an allowlist — and a two-entry allowlist
 * that is TRUE is worth more than an eight-entry one that is aspirational.
 *
 * Verified 2026-09-15 against every writer of every type named here, by two
 * independent passes. Each entry names the site(s) read to justify it.
 */
const LOCK_SCREEN_SAFE_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  // Static title, static body — no interpolation at all. The one type on this
  // list whose safety needs no argument beyond reading it. Sole writer.
  // src/modules/events/application/surveillance/symptom-observed-use-case.ts:279-292
  "rabies_observation_escalation_owner",

  // Title and body are built from a disease label, a species label, a
  // jurisdiction (locality/province — a PLACE, not an address) and two integer
  // match counts. No person, no organisation, and no pet is named. Sole writer.
  // src/modules/events/application/clinical/route-outbreak-signal-notifications.ts:86-118
  "outbreak_signal_detected",
]);

/**
 * What a notification looks like when its type has not earned a verbatim
 * render. Neutral enough to say nothing, specific enough to be worth tapping.
 *
 * "miMAR" is the public brand, and the casing the whole product is fenced on
 * (scripts/check-brand-casing.ts). The web leg's service worker falls back to
 * the same word for a payload with no title (public/sw.js:37) — though it still
 * spells it "MiMAR", which is a pre-existing casing bug in a file the fence's
 * globs do not reach, and NOT a licence to copy it here.
 */
const GENERIC_PUSH_TITLE = "miMAR";
const GENERIC_PUSH_BODY = "Tenés un aviso nuevo";

/**
 * A STATIC SENTENCE PER TYPE, for a lock screen that says WHAT happened without
 * saying WHO it happened to.
 *
 * WHY THIS IS NOT A HOLE IN THE ALLOWLIST ABOVE. That list decides which rows
 * render VERBATIM — the server's own title and body, which interpolate a pet's
 * name, a person, an address. The rule it enforces is that nothing somebody
 * TYPED may reach a lock screen, and these strings are not typed by anybody:
 * they are written here, they take no arguments, and adding a type to this map
 * cannot leak a field because there is no field. A type may appear here and
 * stay off the allowlist, which is exactly the common case.
 *
 * WHY IT IS WORTH THE TROUBLE (PO decision 2026-09-16, after reading his own
 * lock screen on a real phone). The fallback said "miMAR · Tenés un aviso
 * nuevo" under a row where Android had already written "miMAR" — the brand
 * twice, and no information. The notification that prompted it was somebody
 * reporting they had found his lost animal, which is the most urgent message
 * this product sends, rendered indistinguishable from every other. A person who
 * cannot tell an urgent notice from a routine one at a glance opens neither.
 *
 * "Encontraron a tu mascota" names a CATEGORY. It does not identify the animal,
 * the place, or the person, so a stranger glancing at the phone learns that its
 * owner has a pet — which the app's own icon on that screen already told them.
 *
 * EACH ENTRY NAMES THE WRITER IT WAS READ AGAINST, the same discipline the
 * allowlist above holds itself to. A type with no entry falls back to
 * GENERIC_PUSH_BODY: the map grows one verified reading at a time, and an
 * unread type is never guessed at. It is deliberately NOT exhaustive over the
 * 152 notification types — most never reach a citizen's phone.
 */
/** The second line when the title already carries the category. Says where to
 * go, not what happened — the "what" is one line up. */
const GENERIC_PUSH_BODY_HINT = "Abrí miMAR para ver los detalles";

/**
 * Which types ride the interrupting channel.
 *
 * DELIBERATELY THE SAME TWO AS THE LOCK-SCREEN ALLOWLIST, and the coincidence is
 * not one: both lists ask a version of "is this a public-health message whose
 * content was written by us rather than typed by somebody". A type earns a place
 * here by having a deadline a person can miss, not by feeling important — the
 * rabies observation has a legal window, the outbreak signal is what a health
 * authority acts on. Everything else can wait on the shade.
 *
 * SAME DISCIPLINE AS ITS NEIGHBOURS: the set grows one verified reading at a
 * time. A type not listed lands on the ordinary channel, which is the closed
 * default.
 */
const HEALTH_CHANNEL_NOTIFICATION_TYPES: ReadonlySet<string> = new Set([
  "rabies_observation_escalation_owner",
  "outbreak_signal_detected",
]);

const GENERIC_BODY_BY_TYPE: ReadonlyMap<string, string> = new Map([
  // app/(public)/p/[publicToken]/encontre/action.ts — title is
  // `Alguien tiene a ${pet.name}`, or the URGENTE variant when the finder
  // flagged that the animal needs a vet. Both collapse to the same category:
  // somebody physically has the animal. The urgency survives on unlock.
  ["pet_in_possession", "Alguien tiene a tu mascota"],

  // src/modules/pets/application/sighting/report-pet-sighting.ts:402 —
  // `Avistaje de ${pet.name}`. A sighting is not possession, and the two must
  // not read alike: one means somebody saw it, the other means somebody has it.
  ["pet_sighting", "Alguien vio a tu mascota"],

  // src/modules/transfers/application/initiate-pet-transfer.ts:165 —
  // `Te ofrecen la titularidad de ${pet.name}`.
  ["pet_transfer_received", "Te ofrecen la titularidad de una mascota"],
]);

/**
 * How much of the digest rides on the wire.
 *
 * 32 hex characters is 128 bits, which is far past the point where two distinct
 * dedupe keys collide by accident and comfortably inside APNs's 64-byte
 * collapse-id limit. The number is a budget, not a security parameter: the
 * property that matters is that DIFFERENT keys stay different, and a truncated
 * SHA-256 keeps that at this width for any corpus this system will ever have.
 */
const COLLAPSE_KEY_HEX_LENGTH = 32;

/**
 * The collapse key, as something Expo may hold.
 *
 * WHY THE RAW DEDUPE KEY MAY NOT GO. A dedupe key in this system is a sentence:
 * `event:${eventId}:${userId}:pet_in_possession`,
 * `caretaker-death:${eventId}:${userId}`, `ppp-flip:${pet.id}:${userId}`
 * (perro potencialmente peligroso), `caretaker:invitation_rejected:${grant.id}:
 * ${grant.grantedByUserId}`. It names a CATEGORY and it carries a USER ID. So a
 * message whose title and body were genericised precisely so that Expo, Apple
 * and Google learn nothing was still handing all three a stable pseudonymous
 * identifier joined to "this person has a dangerous-dog determination" or "this
 * person's caretaker died". Genericising the text and shipping the label in the
 * next field along is not a policy, it is an oversight with a comment on it.
 *
 * WHY A HASH IS ENOUGH, AND WHY NOTHING IS LOST. The collapse key has exactly
 * two requirements and neither of them is legibility: it must be STABLE, so a
 * retried write replaces the first notification instead of stacking a second,
 * and it must be DISTINCT per subject, so two unrelated notifications do not
 * eat each other. A digest preserves both exactly — same input, same key;
 * different input, different key — and nothing anywhere reads a collapse key
 * back. Not this file, not the app, not the stores: it is compared, never
 * parsed.
 *
 * IT IS NOT A SECRET AND THIS IS NOT ENCRYPTION. An unsalted digest of a
 * guessable string is guessable, and anybody who already knows an event id and
 * a user id can confirm a match. What it removes is the part that was actually
 * being given away for free — a readable label and an identifier handed to
 * three foreign processors who were not asked to hold either.
 */
function collapseKeyFor(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex").slice(0, COLLAPSE_KEY_HEX_LENGTH);
}

/**
 * What one notification looks like on the wire.
 *
 * THE DEEP LINK SURVIVES GENERICISATION, and it has to: `data.url` is not
 * rendered by the OS, the app reads it after the tap and then fetches the real
 * notification over an authenticated request. So the generic payload costs the
 * person one tap, not the content — the lock screen stops being a reading
 * surface and goes back to being a doorbell.
 *
 * `data.url` IS NOT GIVEN THE COLLAPSE KEY'S TREATMENT, and the reason is that
 * it cannot be: the app NAVIGATES to this string, so a digest of it is a dead
 * link. That is the whole difference between the two fields — one is compared
 * and never read, the other is read and never compared — and it is why hashing
 * was the right answer for one and is not available for the other. What it
 * carries is a public token (public by design: it is the QR anybody can scan)
 * or a static route like `/gob/vigilancia`. Those routes do tell Expo something
 * coarse about the recipient's role, which is a real but much smaller
 * disclosure than a user id joined to a category, and shrinking it would mean
 * inventing an indirection the app would have to resolve. Left as is,
 * deliberately, rather than by omission.
 */
function messageFor(token: string, row: ExpoPushCandidateRow): ExpoPushMessage {
  // `?? ""` rather than a truthiness test: a null type is a row that declared
  // nothing, which is exactly the case the closed default is for.
  const verbatim = LOCK_SCREEN_SAFE_NOTIFICATION_TYPES.has(row.notificationType ?? "");

  // The typed sentence for this category, when one has been written and
  // verified. `null` means "not in the map", which is the closed default.
  const categoryBody = GENERIC_BODY_BY_TYPE.get(row.notificationType ?? "") ?? null;

  return {
    to: token,
    // THE TITLE STOPS SAYING "miMAR" WHEN THERE IS SOMETHING BETTER TO SAY.
    // Android and iOS both print the app's name above the notification already,
    // so a title of "miMAR" spent the most legible line on a word the person
    // had just read. With a category sentence it carries the sentence; with
    // nothing to say it falls back to the brand, which is still better than an
    // empty line.
    title: verbatim ? row.title : (categoryBody ?? GENERIC_PUSH_TITLE),
    body: verbatim
      ? (row.body ?? undefined)
      : categoryBody
        ? GENERIC_PUSH_BODY_HINT
        : GENERIC_PUSH_BODY,
    // The deep link the notification opens, carried as data rather than in the
    // body: the OS renders title and body, the app reads this when the person
    // taps.
    data: row.ctaUrl ? { url: row.ctaUrl } : undefined,
    // `collapseId` is the cross-platform one — it becomes APNs's collapse-id
    // and FCM's collapse_key — and it plays the role the web leg gives `tag`: a
    // second notification carrying the same key REPLACES the first on the shade
    // instead of stacking, so a retried write does not double somebody's lock
    // screen. The Android-only `tag` field exists too and is deliberately not
    // used: one key, both stores.
    //
    // HASHED, NEVER RAW — see `collapseKeyFor`. The dedupe key names a
    // notification CATEGORY and carries a USER ID, and a message genericised so
    // the lock screen says nothing must not hand that to Expo in the field next
    // to it.
    collapseId: row.dedupeKey ? collapseKeyFor(row.dedupeKey) : undefined,
    // THE ANDROID CHANNEL, NAMED HERE BECAUSE A CHANNEL THE SERVER DOES NOT
    // ADDRESS IS A CHANNEL THAT DOES NOTHING.
    //
    // This file used to say — and the adapter's header still explained at
    // length — that creating a channel in the app "would be decoration unless
    // the server addressed it". That was true and it was half a design: the app
    // now creates `PUSH_ANDROID_CHANNEL_ID` and this line is the other half.
    // Without it every message lands in expo-notifications' unnamed fallback
    // channel, where the app's declaration of name, importance and vibration
    // applies to nothing and the person sees a channel called "Miscellaneous"
    // in their system settings.
    //
    // It does NOT raise anything. The channel is created at DEFAULT importance,
    // which is the Android analog of the `priority` decision immediately below
    // and is left at exactly the same conservative setting for exactly the same
    // reason. What it buys is that the setting is OURS to have made, and the
    // person's own override of it survives.
    //
    // iOS ignores the field.
    channelId: HEALTH_CHANNEL_NOTIFICATION_TYPES.has(row.notificationType ?? "")
      ? PUSH_ANDROID_HEALTH_CHANNEL_ID
      : PUSH_ANDROID_CHANNEL_ID,
    // NO `priority`, and that is a decision rather than an omission. Expo's
    // default maps to a normal-priority push, which Android's Doze can defer —
    // and these rows are urgent by definition, so "high" is tempting. It is
    // left alone because the WEB leg sets no urgency header either, and §3.3's
    // whole argument is that two channels disagreeing about what is urgent is
    // worse than both being conservative. Raising it is a product decision
    // about battery, taken once, for both legs.
  };
}

/**
 * Reconcile one chunk's tickets against the targets they were addressed to.
 *
 * THE TICKETS COME BACK POSITIONALLY, which is the one thing about this API that
 * will bite somebody: the nth ticket belongs to the nth message, and a SUCCESS
 * ticket carries no token of its own. So the target id travels alongside the
 * message and is zipped back here — reading the token out of a ticket works only
 * for errors and would silently stop bumping `last_used_at` the day it is
 * relied on.
 */
async function reconcileTickets(slice: Addressed[], tickets: ExpoPushTicket[]): Promise<void> {
  for (const [index, ticket] of tickets.entries()) {
    const target = slice[index];
    if (!target) continue;

    if (ticket.status === "ok") {
      // THE RECEIPT ID RIDES ALONG, and this line is the whole reason the send
      // path knows anything about receipts. `status: "ok"` means Expo ACCEPTED
      // the message, not that a phone got it — Expo has not talked to FCM or
      // APNs yet. What happened downstream, `DeviceNotRegistered` above all,
      // arrives only in the receipt this id fetches, hours later and from a
      // cron. Dropping it here is what used to make that answer unreachable.
      await markPushTargetUsed(target.targetId, ticket.id);
      continue;
    }

    if (ticket.details?.error === "DeviceNotRegistered") {
      // The analog of web's 404/410: the app was uninstalled or the token was
      // invalidated. NOT reported — this is the ordinary end of an install's
      // life, and logging it would make every uninstall an incident.
      await revokePushTargetById(target.targetId);
      continue;
    }

    // Everything else — MessageTooBig, MessageRateExceeded, ProviderError,
    // InvalidCredentials — leaves the row alone. Only the first of those is
    // about this message; the rest are about us or about the store, and
    // revoking somebody's device because our credential expired would be the
    // worst possible reading of a server-side problem.
    reportError("expo-push/ticket", new Error(ticket.message), {
      expoError: ticket.details?.error ?? null,
      targetId: target.targetId,
    });
  }
}

/**
 * Deliver every eligible row to every live device its addressee has.
 *
 * CHUNKED THROUGH THE SDK'S OWN SPLITTER rather than a number chosen here. Expo
 * caps a request's message count and the cap is the SDK's to know; hardcoding
 * one would be a second copy of a limit that can move under us.
 */
export async function sendExpoPushForNotifications(rows: ExpoPushCandidateRow[]): Promise<void> {
  if (!isExpoPushEnabled()) return;

  const pushable = rows.filter(isPushEligible);
  if (pushable.length === 0) return;

  try {
    const addressed = await addressMessages(pushable);
    if (addressed.length === 0) return;

    const expo = new Expo({ accessToken: accessToken() });
    const chunks = expo.chunkPushNotifications(addressed.map((a) => a.message));

    let consumed = 0;
    for (const chunk of chunks) {
      const slice = addressed.slice(consumed, consumed + chunk.length);
      consumed += chunk.length;

      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        await reconcileTickets(slice, tickets);
      } catch (err) {
        // The whole chunk failed to POST — a network blip, a 5xx from Expo. No
        // row is revoked: nothing here says any of these devices is gone, and
        // revoking on a transport failure would silence a working phone.
        reportError("expo-push/send", err, { messages: chunk.length });
      }
    }
  } catch (err) {
    // Includes the device lookups and the revoke/bump writes: a DB blip in the
    // push leg must never surface to the action that wrote the notification.
    reportError("expo-push/send-all", err);
  }
}

// ---------------------------------------------------------------------------
// THE SECOND HALF OF A SEND, WHICH IS NOT ON THE REQUEST PATH
// ---------------------------------------------------------------------------

/**
 * How long Expo keeps a receipt. Anything older is unanswerable.
 *
 * Expo's documentation says receipts are retained for "at least" 24 hours and
 * does not promise more, so this is the floor treated as the ceiling. The number
 * is used only to STOP ASKING: a pending id past this age is cleared rather than
 * carried forever, because a queue whose head can never be answered is a queue
 * that eventually contains nothing else.
 */
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How many devices one reconciliation run will look at.
 *
 * SIZED AGAINST THE CRON BUDGET, not against the corpus. The job runs inside the
 * daily dispatcher's shared 55 s budget, and the work per device is one entry in
 * a batched HTTP request plus at most one UPDATE. 1000 is several Expo receipt
 * requests' worth (the SDK's own chunker decides the actual split) and far more
 * than a fleet this size produces in a day; a backlog beyond it is drained by
 * the next night's run, which is exactly the posture every purge in
 * `data-lifecycle.ts` already takes.
 */
const RECEIPT_BATCH_SIZE = 1000;

/** What one reconciliation run did, for the cron row that records it. */
export type ExpoReceiptReconciliation = {
  /** Receipt ids Expo answered for. */
  checked: number;
  /** Devices revoked because the receipt said the token is dead. */
  revoked: number;
  /** Pending ids dropped unasked because Expo no longer holds the receipt. */
  expired: number;
};

/**
 * Ask Expo what actually happened to the messages it accepted, and revoke the
 * devices whose answer says they are gone.
 *
 * WHY THIS EXISTS AT ALL — THE GAP IT CLOSES
 * ---------------------------------------------------------------------------
 * `reconcileTickets` above reads the answer Expo gives IMMEDIATELY, and that
 * answer is only "did Expo accept this message". The answer to "did a phone get
 * it" is a RECEIPT, fetched afterwards by the id the ticket handed back — and
 * `DeviceNotRegistered`, the one error that means a delivery address is dead,
 * arrives there in the ordinary case. Expo has not spoken to FCM or APNs when it
 * writes a ticket, so it cannot possibly know yet.
 *
 * Without this, the revocation the ticket handler already implements was mostly
 * unreachable: dead rows accumulated in `push_targets` with nothing ever marking
 * them, `push_targets_user_active_idx` grew with the corpse count, and every
 * notification for that person paid to address a phone that no longer exists.
 * What this adds is not a new policy — it is feeding the SAME revocation from
 * the channel the signal actually arrives on.
 *
 * IT RUNS FROM THE NIGHTLY FAN-IN AND NOT FROM A SCHEDULE OF ITS OWN. Nothing a
 * person sees depends on when a dead token is noticed; only the cost of
 * addressing it does. The daily dispatcher is where every other periodic
 * reconciliation in this system already lives — and Vercel's plan allows two
 * scheduled entries in total, both already spent, so a third schedule was never
 * an option to weigh.
 *
 * NOTHING HERE THROWS, and the reason differs in kind from the send path's. A
 * throw there would reach the action that wrote a notification; here it would
 * reach a cron route, which handles it perfectly well. It still does not throw,
 * because a run that dies halfway leaves its unread ids pending — the correct
 * resting state, since the next night re-reads them — and a caller that gets a
 * count is a caller that can record one.
 */
export async function reconcileExpoPushReceipts(): Promise<ExpoReceiptReconciliation> {
  const result: ExpoReceiptReconciliation = { checked: 0, revoked: 0, expired: 0 };
  if (!isExpoPushEnabled()) return result;

  try {
    const pending = await pendingPushReceipts(RECEIPT_BATCH_SIZE);
    if (pending.length === 0) return result;

    // AGED-OUT IDS ARE DROPPED WITHOUT ASKING. Expo answers nothing for a
    // receipt it no longer holds, so spending a request on one buys an empty
    // answer and a row that stays pending forever. `pendingPushReceipts` reads
    // oldest first, so these are at the head of what came back.
    const cutoff = Date.now() - RECEIPT_RETENTION_MS;
    const fresh: PendingReceipt[] = [];
    for (const item of pending) {
      if (item.pendingSince !== null && item.pendingSince.getTime() < cutoff) {
        await clearPendingPushReceipt(item.targetId, item.receiptId);
        result.expired += 1;
        continue;
      }
      fresh.push(item);
    }
    if (fresh.length === 0) return result;

    const expo = new Expo({ accessToken: accessToken() });
    const byReceiptId = new Map(fresh.map((item) => [item.receiptId, item.targetId]));
    // The SDK's own chunker again, for the SDK's own reason: Expo caps how many
    // receipt ids one request may carry, and that cap is its to know.
    const chunks = expo.chunkPushNotificationReceiptIds(fresh.map((item) => item.receiptId));

    for (const chunk of chunks) {
      let receipts: { [id: string]: ExpoPushReceipt };
      try {
        receipts = await expo.getPushNotificationReceiptsAsync(chunk);
      } catch (err) {
        // The whole request failed — a network blip, a 5xx from Expo. Nothing
        // is cleared: these ids are still owed an answer, and the next run asks
        // again. That retry is the one thing this shape buys over reading
        // receipts inline, and it costs nothing to keep.
        reportError("expo-push/receipts", err, { receiptIds: chunk.length });
        continue;
      }

      for (const [receiptId, receipt] of Object.entries(receipts)) {
        const targetId = byReceiptId.get(receiptId);
        // An id we did not ask about. Unreachable through this SDK, and skipped
        // rather than trusted: the map is what ties an answer back to a row, and
        // acting without it would be revoking a device chosen by the response.
        if (targetId === undefined) continue;
        result.checked += 1;

        if (receipt.status === "error" && receipt.details?.error === "DeviceNotRegistered") {
          // THE SAME REVOCATION THE TICKET PATH USES, reached from the channel
          // the signal actually arrives on. Not reported, for the reason
          // `reconcileTickets` records: an uninstall is the ordinary end of an
          // install's life, and logging it would make every one an incident.
          await revokePushTargetById(targetId);
          result.revoked += 1;
        } else if (receipt.status === "error") {
          // Everything else leaves the row alone and is reported, exactly as on
          // the ticket path. `MessageTooBig` is about the message;
          // `InvalidCredentials`, `ProviderError` and `MessageRateExceeded` are
          // about us or about the store. Revoking somebody's device over any of
          // them would silence a working phone for a problem that is not its.
          reportError("expo-push/receipt", new Error(receipt.message), {
            expoError: receipt.details?.error ?? null,
            targetId,
          });
        }

        // Answered either way — delivered, revoked, or failed for a reason that
        // is not this device's fault. The id has done its job.
        await clearPendingPushReceipt(targetId, receiptId);
      }
    }
  } catch (err) {
    // The reads and the writes. A run that dies here leaves its unread ids
    // pending, which is the right resting state.
    reportError("expo-push/receipts-all", err);
  }

  return result;
}
