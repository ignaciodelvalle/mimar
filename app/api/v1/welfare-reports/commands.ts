// Filing a citizen denuncia from the phone: the act, and its refusals.
//
// IT IS AN ADAPTER OVER THE WEB'S OWN WRITER, AND IT RE-DERIVES NOTHING
// ---------------------------------------------------------------------------
// `createWelfareReport` (src/modules/welfare/application) is the use-case
// `/denuncias/nueva` drives through `createWelfareReportAction`. This file does
// what that action does around it — resolve the jurisdiction, insert the row,
// call the use-case — and NOTHING that action does not. Every guard below is a
// copy of a call site, not a re-derivation:
//
//   • the per-user rate-limit budget is `welfare_auth`, the SAME bucket and the
//     SAME 10/hr the browser spends. A ceiling a caller escapes by opening a
//     browser is not a ceiling.
//   • the jurisdiction is resolved through `resolveRoutableJurisdiction`, so a
//     phone denuncia lands in the same queue with the same `unverified` mark the
//     web's D.11 geocoder-down fallback produces.
//   • no `audit_log` row. Spec R1: the public create writes none, on either
//     door, and this one does not become the exception because it authenticated.
//   • the geocoder's three throwing paths are CAUGHT, which is what
//     `components/LocationFields.tsx` does around the same action. This one was
//     the sentence above being false: the call had been copied without the
//     try/catch that the web wraps it in, so a nominatim outage escaped the
//     handler as a bare 500. Fixed at `resolve_location` with the reasoning
//     beside it.
//
// THE ANONYMITY RULE, WHICH IS THE ONE THING THIS FILE OWNS
// ---------------------------------------------------------------------------
// `reporterUserId` is `null` for the whole anonymous branch, and the branch is
// taken from the DISCRIMINATOR rather than from a boolean beside the data. That
// null then propagates, by construction rather than by remembering:
//
//   welfare_reports.reporter_user_id  → null   (nothing links the row to the account)
//   cases.opened_by_user_id           → null   (the case names no opener)
//   pet_events.recorded_by_user_id    → null   (unreachable here, see below)
//
// PO decision 2026-07-08 is the reason a LOGGED-IN person may be anonymous at
// all: "honor 'Enviar anónima' completely — a logged-in user who chooses
// anonymous is NOT linked to the report", consistent with the
// finder-in-possession precedent. This door is the same decision on a transport
// where the caller is ALWAYS logged in, so it is the only mode that matters
// here.
//
// AND HERE IS WHAT THIS TRANSPORT CANNOT PROMISE, SAID PLAINLY. The bearer token
// identifies the caller to the SERVER on every request. What "anonymous" means
// on this door is that the RECORD does not carry them — not that the request was
// unattributable in flight. The web can be both (a signed-out browser sends no
// session at all); a `/api/v1` door cannot, because every one of them
// authenticates before it does anything. A person who needs the stronger
// property has the browser, and the screen says so.
//
// THE ONE RESIDUAL WRITE, NAMED RATHER THAN LEFT TO BE FOUND
// ---------------------------------------------------------------------------
// "Nothing links the row to the account" is true of the four tables above and it
// is NOT true of the whole database, because `spendUserBudget` writes the
// caller's uuid on the anonymous path too. It is declared here with its exact
// reach rather than glossed, since anonymity is the axis this endpoint exists
// on. See `spendUserBudget` at the bottom of this file for the full derivation;
// in one line: `rate_limit_buckets` gets a row keyed
// `welfare_auth:{userId}:hour:{window}`, that table is deny-all under RLS with no
// policy and no product reader, and the row deletes itself within the hour.
//
// It is also NOT this door's channel. `src/modules/welfare/actions.ts` branches
// on whether a `user` exists, never on `contactMode`, so a logged-in person who
// picks "Enviar anónima" in the BROWSER spends the identical bucket under the
// identical key. Same table, same shape, one implementation.
//
// THERE WAS A SECOND ONE AND IT WAS THIS DOOR'S. The integration review of
// 2026-08-30 found that the limiter's driver-glitch error carries the bucket KEY
// in its message — so the uuid — and that `spendUserBudget` handed it straight
// to `reportError`, which writes `error.message` verbatim to the function logs.
// That sink has none of the three properties the paragraph above rests on. It is
// closed at the call site rather than declared; see `redactCallerId`. The lesson
// is the shape of the miss: an enumeration titled "its exact reach" was written
// carefully, was correct about the table it was looking at, and did not look at
// the catch block eight lines below it.
//
// WHY THERE IS NO `registered_pet` SUBJECT, AND WHY THAT ALSO REMOVES A LOG
// ---------------------------------------------------------------------------
// `@dim/contract/input`'s `welfare-report.ts` drops that member: naming a
// registered animal means sending its public token, which is printed on the tag
// and published for every lost animal on `/perdidas`. Two consequences here:
// `subjectPetId` is always null, so the pet-event bridge inside the use-case
// never fires — and `isOwnerOfSubjectPet` is always false, which means this door
// cannot even ASK whether the caller owns the animal. On the web that question
// is asked and then deliberately suppressed for anonymous reporters; here there
// is nothing to suppress.
//
// FLAG HEURISTICS: THREE OF FIVE, AND THE TWO MISSING ONES ARE MISSING HONESTLY
// ---------------------------------------------------------------------------
// `computeFlagReasons` runs for anonymous submissions only — the web's rule,
// copied — and it is fed no `dwellTimeMs` and no honeypot value, because both
// measure a browser and a native client would have to invent them. It keeps
// `trivial_description`, `critical_without_evidence` and `duplicate_within_24h`,
// all derived from the submission itself. `critical_without_evidence` fires on
// every `critical` denuncia from this door, since `attachmentCount` is
// structurally 0 — that is correct rather than a false positive: a critical
// report with no evidence IS the thing that rule flags for a human to look at,
// and the phone genuinely cannot attach any.

import { db } from "@/db";
import { signalWelfareReport } from "@/lib/domain/authority";
import { writePoint } from "@/lib/domain/location";
import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { openCase } from "@/lib/infra/case-helpers";
import { resolveRoutableJurisdiction } from "@/lib/infra/jurisdiction-from-text";
import { RateLimitError, enforceRateLimit } from "@/lib/infra/rate-limit";
import { reportError } from "@/lib/infra/report-error";
import { computeFlagReasons } from "@/lib/infra/welfare-moderation";
import { geocodeAddressPublicOrThrow } from "@/src/modules/localities/application/geocoding/geocoding";
import { createWelfareReport } from "@/src/modules/welfare/application/create-welfare-report";
import { generateReferenceCode } from "@/src/modules/welfare/domain/reference-code";
import { WELFARE_REPORT_KINDS } from "@/src/modules/welfare/domain/types";
import { WelfareRepository } from "@/src/modules/welfare/infrastructure/welfare-repository";
import type { WelfareReportCommandInput, WelfareReportInput } from "@dim/contract/input";

import { buildWelfareLocationResolvedAck, buildWelfareReportFiledAck } from "./payload";

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers when the write cannot be attempted. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

/**
 * The per-USER budget, and it is the WEB'S.
 *
 * `createWelfareReportAction` spends `enforceRateLimit("welfare_auth", user.id,
 * { maxPerHour: 10 })` for an authenticated submission. The same bucket name and
 * the same ceiling are spent here so the browser and the phone share ONE budget
 * for one act — the rule `me/pet-claims` states about `claim_lookup` and
 * `me/privacy` states about the two ARCO rights.
 *
 * IT IS NOT ONE OF `api-v1-limits.ts`'s FAMILIES, deliberately. Those constants
 * size a ceiling against "how many app-holders sit behind one carrier gateway";
 * this one is keyed on a user id, it predates this surface, and it belongs to the
 * ACT. Adding `API_V1_AUTHENTICATED_WRITE_USER_LIMIT` (10/min) on top would make
 * the phone six times looser per minute and four times tighter per hour than the
 * browser, for the same denuncia.
 */
const WELFARE_AUTH_USER_LIMIT = { maxPerHour: 10 } as const;

export type WelfareReportCommandContext = {
  userId: string;
  input: WelfareReportCommandInput;
};

const repo = new WelfareRepository();

/**
 * How many candidate points `resolve_location` hands back.
 *
 * The geocoder returns up to five; the web's field renders all of them in a
 * list. This takes the same five rather than one, and the difference from the
 * web is what happens with a SINGLE match: `LocationFields` auto-picks it and
 * says "Ajustá el pin si no es el punto exacto" — an escape hatch that needs a
 * map. With no map, auto-picking would be choosing a point on somebody's behalf
 * and giving them no way to disagree, on a filing routed to an authority. So one
 * match is still a list of one, and it is still tapped.
 */
const MAX_LOCATION_MATCHES = 5;

/** Route the two commands. */
export async function runWelfareReportCommand(ctx: WelfareReportCommandContext) {
  if (ctx.input.command === "resolve_location") {
    // NO `welfare_auth` HERE. That budget is ten denuncias an hour and this is
    // not a denuncia — spending it on address lookups would let somebody who
    // mistyped a street four times find themselves unable to REPORT. What bounds
    // this command is the web's own `geocode_public` bucket (60/min + 400/hr per
    // IP), spent inside `geocodeAddressPublicOrThrow`, plus the route's per-IP
    // bucket that already ran.
    //
    // THE GEOCODER THROWS AND THIS IS WHERE IT IS CAUGHT. `geocodeAddress` has
    // three throwing paths — `rate_limited` (its own token bucket, which is NOT
    // the `geocode_public` one above), `fetch_failed` (the nominatim timeout) and
    // `provider_error` (any non-2xx) — and `geocodeAddressPublicOrThrow` re-throws
    // all three. Uncaught, they escape `route.ts`, which does not wrap this call
    // either, and Next answers a bare 500 with no `{ error }` envelope at all:
    // the one shape every `/api/v1` failure is required to have, missing on the
    // only path this phone can turn an address into a point.
    //
    // A FAILURE IS NOT AN EMPTY LIST, and collapsing the two would be the more
    // tempting fix. It is the wrong one: the screen renders `matches: []` as "no
    // encontramos esa dirección", so a nominatim outage would tell somebody
    // standing in front of an injured animal that the street they are looking at
    // does not exist, and they would retype it until they gave up. That is an
    // infrastructure failure wearing the costume of a user error. 503 says the
    // true thing, the mobile client already has es-AR copy for it ("El servidor
    // no pudo responder. Volvé a intentar en unos segundos."), and it carries a
    // `retry-after`.
    //
    // IT IS ALSO WHAT THE WEB'S CALL SITE DOES, which is the rule this file's
    // header states about every other guard on it: `components/LocationFields.tsx`
    // wraps the same action and sets `geocodeMessage` to `"failed"`, a state it
    // keeps DISTINCT from the `"empty"` it sets for a zero-length result. This
    // door had copied the call and not the try/catch around it.
    // A5-ciudadanas-04 — THE SAME ARGUMENT ONE LAYER DOWN, and the half
    // CANON-433 did not reach. `geocodeAddressPublicAction` spends the shared
    // `geocode_public` bucket and answers a REFUSED one with `[]`, which is
    // right for the web's debounced autocomplete and wrong here: this door
    // renders an empty list as "No pudimos encontrar esa dirección. Probá
    // escribirla de otra forma". Behind a carrier gateway where the neighbours
    // are filing web sightings, that sentence tells somebody standing in front
    // of an injured animal that their street does not exist — and each retype
    // spends more of the same budget. `…OrThrow` is the same act, the same
    // bucket and the same IP; only the refusal's SHAPE differs.
    let matches: Awaited<ReturnType<typeof geocodeAddressPublicOrThrow>>;
    try {
      matches = await geocodeAddressPublicOrThrow(ctx.input.addressText);
    } catch (err) {
      // A SPENT BUDGET IS NOT AN INCIDENT. It is the limiter working, so it is
      // answered rather than reported — and answered with the code the mobile
      // client already has es-AR copy for ("Demasiadas consultas. Esperá un
      // momento y volvé a intentar."), which is the only sentence here that
      // names a wait instead of blaming the address.
      if (err instanceof RateLimitError) return apiV1Error("rate_limited", 429);
      // NO ADDRESS IN THE SINK. Spec D10 forbids logging what the person typed,
      // and a geocoder failure is the one place it would be most tempting to
      // attach for debugging.
      reportError("api-v1-welfare-reports/geocode", err);
      return unavailable();
    }
    return apiV1Json(buildWelfareLocationResolvedAck(matches.slice(0, MAX_LOCATION_MATCHES)), {
      status: 200,
    });
  }
  return fileWelfareReport(ctx.userId, ctx.input);
}

/**
 * File the denuncia.
 *
 * The order matches the web's action exactly and the order is load-bearing:
 * budget → jurisdiction → insert the row (outside the tx, so the reference code
 * exists before anything can reference it) → the atomic case/link tx. A failure
 * of the last step leaves a `welfare_reports` row with no case, which is the
 * state the web already produces and which `/gob/denuncias` already handles.
 */
async function fileWelfareReport(userId: string, input: WelfareReportInput) {
  if (!(await spendUserBudget(userId))) return apiV1Error("rate_limited", 429);

  // THE RULE IS THE DOMAIN'S, and the schema's copy is the client's convenience.
  // `@dim/contract` may not import `@/src`, so the nine kinds exist in both
  // places; this re-check is what makes the SERVER's answer come from the
  // domain catalogue rather than from the wire vocabulary. Same arrangement as
  // `me/pet-claims`, where the 15-digit rule is checked in the schema AND in
  // both use-cases, and the use-case's copy is the one that governs.
  if (!(WELFARE_REPORT_KINDS as readonly string[]).includes(input.kind)) {
    return apiV1Error("invalid_request", 400);
  }

  // ANONYMOUS IS THE DEFAULT DIRECTION OF THIS TERNARY, and it reads off the
  // discriminator rather than off a flag. There is no branch below in which an
  // anonymous submission can pick up a user id.
  const reporterUserId = input.contactMode === "anonymous" ? null : userId;
  const reporterContactEmail =
    input.contactMode === "with_contact" ? input.reporterContactEmail : null;
  const reporterContactPhone =
    input.contactMode === "with_contact" ? input.reporterContactPhone : null;

  const point = writePoint({ lat: input.locationLat, lng: input.locationLng });

  // D.11, copied from both of the web's intakes: a null province makes the row
  // invisible to every govt queue, so recover one from the address text and MARK
  // IT UNVERIFIED. The mark is not bookkeeping — the triage row renders it.
  //
  // The phone now echoes the jurisdiction of the `resolve_location` candidate
  // the person PICKED (walkthrough 2026-08-31 §2: this handler used to hardcode
  // nulls, so the pair the server had geocoded moments earlier was discarded
  // and 100% of the mobile channel landed "sin verificar" — the badge stopped
  // separating a careful address from a vague one, its only job). With the
  // pair present the gate marks the row verified only when the coordinates
  // sent with it corroborate it (A11-G1: the echo is the client's word, and a
  // client can send any pair next to any pin); absent — the person typed an
  // address no geocoder confirmed — the inference path below earns the mark
  // honestly.
  //
  // THE ECHO IS RAW NOMINATIM AND THE GATE'S VERIFIED ARM IS A PASS-THROUGH.
  // `resolve_location` hands the phone `address.state` as the geocoder spells
  // it — "Ciudad Autónoma de Buenos Aires" for every point inside CABA — while
  // the catalog, and the 24-name CHECK on `welfare_reports.jurisdiction_province`
  // (migration 0055), hold "CABA". The web never hands the gate a raw pair:
  // both of its intakes run `normalizeLocationForWrite` first, which resolves
  // the province to its catalog name and the locality to its catalog row —
  // with the FK a hardcoded `localityId: null` here used to discard. Same
  // normalizer, same gate, same order. Without it a CABA denuncia from the
  // phone would not even land unrouted: it would fail the CHECK and answer 500.
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(
      {
        province: input.locationProvince ?? null,
        provinceCode: null,
        locality: input.locationLocality ?? null,
        localityIndecId: null,
        lat: input.locationLat,
        lng: input.locationLng,
        address: input.locationAddress,
      },
      { locality: "soft" },
    );
  } catch (err) {
    // Under "soft" only the coordinate range can throw, and the schema already
    // bounds it — this is the same rule read twice, not a second rule.
    if (err instanceof CoordError) return apiV1Error("invalid_request", 400);
    throw err;
  }
  const routable = await resolveRoutableJurisdiction({
    province: normalizedLoc.province,
    locality: normalizedLoc.locality,
    localityId: normalizedLoc.localityId,
    addressText: input.locationAddress,
    lat: normalizedLoc.lat,
    lng: normalizedLoc.lng,
  });

  let inserted: { id: string; referenceCode: string };
  try {
    inserted = await repo.insertReportWithRetry(
      {
        reporterUserId,
        reporterContactEmail,
        reporterContactPhone,
        kind: input.kind as Parameters<typeof repo.insertReportWithRetry>[0]["kind"],
        severity: input.severity as Parameters<typeof repo.insertReportWithRetry>[0]["severity"],
        description: input.description,
        subjectKind: input.subjectKind as Parameters<
          typeof repo.insertReportWithRetry
        >[0]["subjectKind"],
        subjectPetId: null,
        subjectDescription: input.subjectDescription,
        locationAddress: input.locationAddress,
        jurisdictionProvince: routable.province,
        jurisdictionLocality: routable.locality,
        localityId: routable.localityId,
        jurisdictionUnverified: routable.unverified,
        locationLat: point.locationLat,
        locationLng: point.locationLng,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
        // Stored since migration 0209. The wire field came BACK with the
        // column — it was removed while the server had nowhere to put it.
        observedSymptoms: input.observedSymptoms,
        referenceCode: generateReferenceCode(),
      },
      undefined,
      generateReferenceCode,
    );
  } catch (err) {
    // NO `err` IN THE LOG LINE'S SUBJECT, and no report id — there is none yet.
    // `reportError` is the shared sink; what it must never receive from this
    // file is the caller's id or their free text.
    reportError("api-v1-welfare-reports/insert", err);
    return apiV1Error("welfare_report_failed", 500);
  }

  const result = await createWelfareReport(
    {
      reportId: inserted.id,
      referenceCode: inserted.referenceCode,
      kind: input.kind,
      severity: input.severity,
      description: input.description,
      subjectKind: input.subjectKind,
      // Both null on every request this door can make — see the header.
      subjectPetId: null,
      isOwnerOfSubjectPet: false,
      subjectDescription: input.subjectDescription,
      locationAddress: input.locationAddress,
      jurisdictionProvince: routable.province,
      jurisdictionLocality: routable.locality,
      locationLat: point.locationLat,
      locationLng: point.locationLng,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : null,
      reporterContactEmail,
      reporterContactPhone,
      // Forwarded since migration 0209 gave it a column (the row insert above
      // is what STORES it). Inside the use-case its only consumer is still the
      // `symptom_observed` bridge, which needs a registered pet this door
      // never passes — so forwarding it here changes no event, and the honest
      // value beats a hardcoded null that would read as "this door has none".
      observedSymptoms: input.observedSymptoms,
      // NO ATTACHMENTS. Not "none were sent" — none can be. See the contract.
      attachments: [],
      uploadedPaths: [],
      reporterUserId,
      // The two browser instruments this transport refuses to fake.
      dwellTimeMs: undefined,
      honeypotValue: "",
      clientIdempotencyKey: input.clientIdempotencyKey,
    },
    {
      repo,
      openCase: async (args) => openCase(args as Parameters<typeof openCase>[0]),
      computeFlagReasons,
      signal: async (opts) => {
        await signalWelfareReport(opts);
      },
      transaction: db.transaction.bind(db),
    },
  );

  if (!result.ok) {
    // The use-case's failure arm is es-AR PROSE about attachments — the only
    // sentence it can return, and it is written for a form. It is deliberately
    // NOT forwarded: this door sends no attachments, so the sentence would be
    // false, and `me/appointments/commands.ts` already records what matching on
    // prose costs. The report row EXISTS at this point (the insert is outside
    // the tx, matching the web); what failed is the case that should have been
    // opened over it.
    reportError("api-v1-welfare-reports/case", new Error("welfare case tx failed"));
    return apiV1Error("welfare_report_failed", 500);
  }

  // THE ACK IS BUILT FROM THE REFERENCE CODE AND NOTHING ELSE, and the builder
  // takes no other argument so a later edit cannot widen it without changing a
  // signature somebody has to look at.
  return apiV1Json(buildWelfareReportFiledAck(result.referenceCode), { status: 201 });
}

/**
 * Spend the shared per-user denuncia budget. `true` → proceed.
 *
 * FAILS OPEN on limiter infrastructure failure, like every sibling on this
 * surface, and the direction is the one this act demands: the limiter is itself
 * a database write, and a `rate_limit_buckets` outage must not stand between a
 * person watching an animal being hurt and the report of it. The abuse this
 * bounds is a flood of low-quality denuncias, which the moderation queue is the
 * real instrument against — `computeFlagReasons` and `/admin/moderacion` — and a
 * limiter outage does not disable either.
 *
 * THE CONTRAST IS `me/privacy`'s EXPORT, which fails CLOSED because a limiter
 * outage there would be an unbounded PII dump. Nothing leaves the server here.
 *
 * THIS IS THE RESIDUAL DE-ANONYMIZATION CHANNEL, AND HERE IS ITS EXACT REACH
 * ---------------------------------------------------------------------------
 * This function runs on the anonymous branch too — `userId` is the caller's,
 * unconditionally, while `reporterUserId` above is null. So an anonymous
 * denuncia DOES write the caller's uuid to the database, and pretending
 * otherwise is worse than the channel itself.
 *
 *   WHAT IS WRITTEN. `enforceRateLimit` upserts `rate_limit_buckets` with the
 *   PRIMARY KEY `welfare_auth:{userId}:hour:{windowStartMs}`, plus `count` and
 *   `first_seen_at`. The uuid is in the key, not in a column.
 *
 *   WHAT IT DISCLOSES TO SOMEBODY WHO CAN READ IT. `welfare_auth` has exactly
 *   two spenders and both are denuncia creation (this door and
 *   `createWelfareReportAction`), so the key's mere existence asserts "this user
 *   filed at least one denuncia in this hour" and `count` says how many. Against
 *   a `welfare_reports` row whose `reporter_user_id` is null but whose
 *   `created_at` falls in that window, a reader could re-attach a name — and in
 *   a quiet hour with one anonymous filing, unambiguously.
 *
 *   WHO CAN READ IT. Not `anon` and not `authenticated`: RLS is enabled on the
 *   table (migrations 0113 and 0165) and NO policy and NO grant has ever been
 *   written for it, so PostgREST denies every request. Migration 0139 cites this
 *   table as the precedent for exactly that shape. What reaches it is the
 *   service role, which bypasses RLS — the server's own Drizzle client, and
 *   whoever holds the service key or a psql connection. No product surface reads
 *   it at all: `lib/infra/rate-limit.ts` writes it and
 *   `lib/infra/data-lifecycle.ts` deletes it, and nothing selects it for a
 *   screen, an export or an analytic.
 *
 *   HOW LONG IT LIVES. The hour bucket carries `expires_at = window + 1h`, and
 *   the first of the five purges behind `/api/cron/data-lifecycle` deletes rows
 *   past expiry. One hour plus the cron's cadence, not indefinite retention.
 *
 *   DOES IT BREAK THE PROMISE. No — because of how narrowly the promise is
 *   written, and that narrowness is now load-bearing rather than decorative.
 *   This file and the screen both say anonymity here is a property of the
 *   RECORD, not unattributability in flight. A deny-all counter with no reader
 *   that erases itself within the hour is on the "in flight" side of that line.
 *   What it is not is ZERO, which is why it is written down instead of implied.
 *
 *   WHY IT IS NOT SIMPLY CLOSED. Keying this bucket on anything but the user
 *   would mean either no per-user ceiling on the anonymous path — which is the
 *   flood control PO decision 2026-07-08 assumes — or a per-IP one, and the
 *   web's own anonymous door shows that price: `welfare_anon` is 1/min and 3/hr
 *   on an IP, which behind a CGNAT gateway is one denuncia per carrier per
 *   minute for everybody on it. That trade is the PO's, not an agent's.
 */
async function spendUserBudget(userId: string): Promise<boolean> {
  try {
    await enforceRateLimit("welfare_auth", userId, WELFARE_AUTH_USER_LIMIT);
    return true;
  } catch (err) {
    if (err instanceof RateLimitError) return false;
    // THE UUID COMES OUT OF THE MESSAGE BEFORE THE LINE IS WRITTEN, and this is
    // a SECOND residual channel that the enumeration above did not have. Found
    // by the integration review, 2026-08-30, and closed here rather than added
    // to the list, because it has none of the four properties that list leans
    // on.
    //
    // `lib/infra/rate-limit.ts` throws `enforceRateLimit: UPSERT returned no
    // rows for key "welfare_auth:{userId}:hour:{window}"` on its driver-glitch
    // path — a plain `Error`, so it lands in this arm — and `reportError` writes
    // `error.message` VERBATIM to `console.error`. On the ANONYMOUS branch that
    // is the caller's uuid in Vercel's function logs: a sink with no RLS, no
    // one-hour TTL, and a reader population of "anybody with dashboard access".
    // The declared `rate_limit_buckets` channel is defensible precisely because
    // it has all three; this one had none of them, and unlike that one it is
    // this door's own — the web path (`src/modules/welfare/actions.ts`) rethrows
    // and never reports.
    //
    // The stack is dropped with the message on purpose: it is a driver frame
    // list from inside `enforceRateLimit`, the context string already says which
    // bucket failed, and a `stack` field would carry the same string back in.
    reportError("api-v1-welfare-reports/welfare_auth", redactCallerId(err, userId));
    return true;
  }
}

/**
 * The caller's uuid, out of whatever was thrown, before it reaches a log line.
 *
 * REPLACED RATHER THAN DROPPED. `"…for key \"welfare_auth:«caller»:hour:…\""`
 * still says which bucket and which window failed, which is the whole
 * diagnostic; only the identity goes. A message with the id cut out entirely
 * would read as a different failure.
 *
 * IT RETURNS A STRING AND NOT AN `Error`. `reportError` takes `unknown`
 * and stringifies a non-Error through `String(err)`, so what is emitted is
 * exactly this string and nothing carries a stack that could hold the id again.
 */
function redactCallerId(err: unknown, userId: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return userId.length === 0 ? message : message.replaceAll(userId, "«caller»");
}
