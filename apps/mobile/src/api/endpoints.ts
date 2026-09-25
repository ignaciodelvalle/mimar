// Every `/api/v1` call this app makes, in one file.
//
// Not because a file per endpoint would be wrong, but because the set is small
// enough that seeing it whole is worth more than seeing it sorted: a reader
// asking "what can this app do to my account" should get the answer in one
// screen rather than by walking a directory.
//
// THE COUNT OF WRITES USED TO LIVE IN THIS HEADER AND IT NO LONGER DOES, which
// is worth recording rather than quietly deleting. The sentence read "THREE of
// them are writes, and the count is kept in this sentence on purpose … if a
// fourth write appears, this line is where a reviewer notices." Two more
// appeared — `sendLostCommand` and `sendShareCommand` — and each announced
// itself in its OWN docblock as "the fourth write" and "the fifth" while this
// paragraph went on saying three. A number in prose has to be edited every time
// something crosses, nothing fails when it is not, and by the time a sixth
// arrived the header was contradicting three separate comments below it.
//
// What the header keeps instead is the CLAIM the count was standing in for, and
// this one is checkable by reading the file rather than by trusting a number:
//
//   NOT EVERY WRITE HERE IS ABOUT AN ANIMAL. `signup` creates an ACCOUNT — the
//   only call on this surface that mutates something before there is a session
//   to mutate it with, and the only one whose success may legitimately hand
//   back nothing to sign in with (see its own docblock). It sits beside
//   `login` at the top for that reason: the two pre-authentication calls are
//   the ones a reader asking "what can this app do before I trust it" needs
//   first.
//
//   THE PET WRITES ARE NOT ALL APPENDS, AND A READER MUST NOT ASSUME THEY ARE.
//   `registerPet`, `recordPetEvent` and `amendPetEvent` are pure INSERTs onto
//   the append-only spine — a correction is a new event, never an edit. The
//   other three are not: `sendLostCommand` moves `pets.status` and opens and
//   closes a case, `sendShareCommand` mints and revokes bearer tokens and moves
//   two columns, and `sendTransferCommand` can change WHO OWNS AN ANIMAL. The
//   append-only invariant holds where it applies; it is not a description of
//   this whole file.
//
// HOW MANY ASIENTOS `recordPetEvent` CAN WRITE IS NOT COUNTED ANYWHERE HERE,
// and it used to be — "one of the six", while the union held ten. A number in
// prose has to be edited every time a kind crosses and nothing fails when it is
// not, so it drifts silently and then misleads the next reader. The union in
// `@dim/contract/input` is the count; this file's business is that there is ONE
// call for all of them.
//
// Everything here is a thin wrapper over `apiRequest` / `performRequest`. No
// endpoint may add its own retry, its own error copy, or its own session
// handling — those live in `client.ts` exactly once, and a second copy is how
// two screens end up disagreeing about what a 401 means.

import {
  ADOPTION_CATALOGUE_PAYLOAD_VERSION,
  ADOPTION_DETAIL_PAYLOAD_VERSION,
  APPOINTMENT_SEARCH_PAYLOAD_VERSION,
  type AdoptionApplicationSubmittedV1,
  type AdoptionCatalogueV1,
  type AdoptionDetailV1,
  type AppointmentCommandAckV1,
  type AppointmentSearchV1,
  type BookableOfferingDetailV1,
  type CaretakerCommandAckV1,
  type EventAmendedV1,
  type EventRecordedV1,
  type FosterCommandAckV1,
  type GeocodingAckV1,
  type IdentityCompletedV1,
  LOCALITIES_PAYLOAD_VERSION,
  type LocalitiesV1,
  type LoginV1,
  type LostCommandAckV1,
  ME_PAYLOAD_VERSION,
  MY_ADOPTION_APPLICATIONS_PAYLOAD_VERSION,
  MY_APPOINTMENTS_PAYLOAD_VERSION,
  MY_CARETAKER_GRANTS_PAYLOAD_VERSION,
  MY_CASES_PAYLOAD_VERSION,
  MY_CASE_DETAIL_PAYLOAD_VERSION,
  MY_FOSTER_PAYLOAD_VERSION,
  MY_NOTIFICATIONS_PAYLOAD_VERSION,
  MY_PETS_PAYLOAD_VERSION,
  MY_PRIVACY_PAYLOAD_VERSION,
  MY_PROFILE_PAYLOAD_VERSION,
  MY_TRANSFERS_PAYLOAD_VERSION,
  type MeV1,
  type MyAdoptionApplicationsV1,
  type MyAppointmentsV1,
  type MyCaretakerGrantsV1,
  type MyCaseDetailV1,
  type MyCasesV1,
  type MyFosterV1,
  type MyNotificationsV1,
  type MyPetsV1,
  type MyProfileUpdatedV1,
  type MyProfileV1,
  type MySubjectDataExportV1,
  type MyTransfersV1,
  type NotificationCommandAckV1,
  OWNER_PET_DETAIL_PAYLOAD_VERSION,
  type OwnerPetDetailV1,
  PET_EVENT_DETAIL_PAYLOAD_VERSION,
  PET_LIBRETA_PAYLOAD_VERSION,
  PET_LOST_PAYLOAD_VERSION,
  PET_POSTER_PAYLOAD_VERSION,
  PET_PROFILE_EDIT_PAYLOAD_VERSION,
  PET_REHOME_PAYLOAD_VERSION,
  PET_RETURN_PAYLOAD_VERSION,
  PET_SHARES_PAYLOAD_VERSION,
  type PasswordResetRequestedV1,
  type PetClaimCommandAckV1,
  type PetEventDetailV1,
  type PetLibretaV1,
  type PetLostV1,
  type PetMoveRecordedV1,
  type PetPhotoTicketV1,
  type PetPhotoUpdatedV1,
  type PetPosterV1,
  type PetProfileEditAckV1,
  type PetProfileEditV1,
  type PetRegisteredV1,
  type PetRehomeV1,
  type PetReturnCommandAckV1,
  type PetReturnV1,
  type PetSharesV1,
  type RehomeCommandAckV1,
  type ShareCommandAckV1,
  type SignupV1,
  type SubjectDataErasedV1,
  type TransferCommandAckV1,
  type VaccineReminderCommandAckV1,
  type WelfareReportCommandAckV1,
} from "@dim/contract/api";
import type {
  AdoptionApplicationInput,
  AmendEventInput,
  AppointmentCommandInput,
  CaretakerCommandInput,
  CompleteIdentityInput,
  FosterCommandInput,
  GeocodingCommandInput,
  LostCommandInput,
  MyProfileEditInput,
  NotificationCommandInput,
  PetClaimCommandInput,
  PetMoveCommandInput,
  PetPhotoContentType,
  PetProfileCommandInput,
  PetReturnCommandInput,
  RecordEventInput,
  RegisterPetInput,
  RehomeCommandInput,
  ShareCommandInput,
  SubjectRightsCommandInput,
  TransferCommandInput,
  VaccineReminderCommandInput,
  WelfareReportCommandInput,
} from "@dim/contract/input";

import { type ApiResult, type SessionPort, apiRequest, performRequest } from "./client";
import { apiV1ErrorCode } from "./error-copy";

/**
 * `POST /auth/login`. NOT a bearer call — it is what produces the bearer.
 *
 * It therefore uses `performRequest` directly and interprets its own result:
 * routing it through `apiRequest` would ask the session port for a token that
 * by definition does not exist yet, and would end a session nobody has.
 */
export async function login(input: {
  email: string;
  password: string;
}): Promise<ApiResult<LoginV1>> {
  const raw = await performRequest({
    path: "/api/v1/auth/login",
    method: "POST",
    body: { email: input.email, password: input.password },
  });

  if (raw.transport === "unreachable") return { outcome: "unreachable", detail: raw.detail };
  if (raw.transport === "malformed") return { outcome: "malformed", detail: raw.detail };
  if (raw.status !== 200) {
    return {
      outcome: "api-error",
      code: apiV1ErrorCode(raw.body) ?? "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }
  return { outcome: "ok", payload: raw.body as LoginV1 };
}

/**
 * `POST /auth/signup` — step 1 of the two-step signup, and the second call on
 * this surface that is not a bearer call because it is what MAKES one.
 *
 * `performRequest` directly, for `login`'s reason: routing it through
 * `apiRequest` would ask the session port for a token that by definition does
 * not exist yet, and would end a session nobody has.
 *
 * 201 IS THE ONLY SUCCESS, AND IT MAY CARRY NO SESSION. `SignupV1.session` is
 * nullable and BOTH cases are normal — a genuine new account (email
 * confirmations OFF, PO decision 2026-07-10) gets one, and the
 * account-enumeration masquerade for an email that already exists returns this
 * same 201 with `session: null`. A caller MUST read the null as "go to the
 * login screen", never as an error, and must never turn it into copy that says
 * the account exists: that copy would rebuild on the phone the oracle audit
 * 28-#3 closed on the web form.
 *
 * NO `Idempotency-Key`, AND THE ENDPOINT ASKS FOR NONE. What protects a double
 * submit is GoTrue's unique email: the second POST cannot mint a second
 * account. It is NOT the same promise the write endpoints make, and the
 * difference is visible to the caller — the second response is the masquerade,
 * `session: null`, indistinguishable from a duplicate-email refusal. So a
 * client that retries a signup after a timeout may be handed "go sign in" for
 * an account it just created a second ago. That is the correct instruction in
 * both readings, which is why the endpoint needs no key; it is stated here
 * because "no idempotency key" usually means "retry freely" and here it means
 * "retry and then sign in".
 */
export async function signup(input: {
  email: string;
  password: string;
  confirmPassword: string;
  tosAccepted: boolean;
  /** The legal version whose consent sentence this bundle displayed. */
  legalVersion?: string;
}): Promise<ApiResult<SignupV1>> {
  const raw = await performRequest({
    path: "/api/v1/auth/signup",
    method: "POST",
    body: input,
  });

  if (raw.transport === "unreachable") return { outcome: "unreachable", detail: raw.detail };
  if (raw.transport === "malformed") return { outcome: "malformed", detail: raw.detail };
  if (raw.status !== 201) {
    return {
      outcome: "api-error",
      code: apiV1ErrorCode(raw.body) ?? "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }
  return { outcome: "ok", payload: raw.body as SignupV1 };
}

/**
 * `POST /auth/password-reset` — ask for a recovery credential by e-mail.
 *
 * THE THIRD CALL ON THIS SURFACE THAT IS NOT A BEARER CALL, and the only one
 * that does not make a bearer either. `performRequest` directly, for `login`'s
 * reason: routing it through `apiRequest` would ask the session port for a token
 * that by definition does not exist — somebody using this is locked out.
 *
 * 202 IS THE ONLY SUCCESS AND IT MEANS NOTHING ABOUT THE ADDRESS. The body is a
 * constant, identical for an e-mail that has an account and one that does not,
 * because the server never learns which it was (see `PasswordResetRequestedV1`).
 * A caller MUST NOT branch on it, must not "helpfully" report that no account was
 * found, and must not treat the absence of a mail as an error — doing any of
 * those rebuilds on the phone the enumeration oracle the server refuses to be.
 *
 * THE PAYLOAD IS RETURNED AND NOTHING READS IT, deliberately. Dropping it to
 * `ApiResult<void>` would be a truthful description of today and a trap
 * tomorrow: the field that gets added to make it useful is the field that makes
 * it an oracle. Keeping the type is what makes that visible in a diff.
 *
 * WHAT COMES NEXT IS NOT AN ENDPOINT. The redemption goes to GoTrue directly —
 * `verifyOtp` then `updateUser` — because the loop cannot close through a link on
 * a device with no verified App Links. `session-store.ts`'s `resetPasswordWithCode`
 * is where that is written out.
 */
export async function requestPasswordReset(input: {
  email: string;
}): Promise<ApiResult<PasswordResetRequestedV1>> {
  const raw = await performRequest({
    path: "/api/v1/auth/password-reset",
    method: "POST",
    body: { email: input.email },
  });

  if (raw.transport === "unreachable") return { outcome: "unreachable", detail: raw.detail };
  if (raw.transport === "malformed") return { outcome: "malformed", detail: raw.detail };
  if (raw.status !== 202) {
    return {
      outcome: "api-error",
      code: apiV1ErrorCode(raw.body) ?? "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }
  return { outcome: "ok", payload: raw.body as PasswordResetRequestedV1 };
}

/** `GET /me` — the four-field shell. No email, no DNI, no pets. */
export function fetchMe(session: SessionPort): Promise<ApiResult<MeV1>> {
  return apiRequest<MeV1>(
    { path: "/api/v1/me", expectedPayloadVersion: ME_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `POST /me/identity` — signup step 2, finished in the app.
 *
 * THE ONE BEARER CALL A `profilePending` SESSION MAY MAKE. Every other
 * authenticated door refuses that state — `/pets` with `identity_pending`,
 * `/me/profile` with `not_found` — and this one exists to end it. See the route's
 * own header for why copying either gate here would be an endpoint that refuses
 * the only callers it has.
 *
 * IT RETURNS THE FRESH USER AND THE CALLER MUST STORE IT. That is the difference
 * between this and `saveMyProfile` below, and it is deliberate: the response IS
 * the new session state (`profilePending: false`), so a screen that discarded it
 * and called `fetchMe` instead would spend a second round trip to learn what it
 * already holds — and would leave a window in which its own gate still refuses.
 *
 * NO `idempotencyKey`: completing an identity is a VALUE, not an append. Sending
 * the same two names twice sets them once and answers the same user.
 */
export function completeIdentity(
  session: SessionPort,
  input: CompleteIdentityInput,
): Promise<ApiResult<IdentityCompletedV1>> {
  return apiRequest<IdentityCompletedV1>(
    { path: "/api/v1/me/identity", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /me/pets` — the owner's list, possibly truncated.
 *
 * `cursor` (D5) IS OPAQUE AND OPTIONAL, same rule as `fetchMyNotifications`'s
 * `cat`: omit it for page one, and pass back exactly the `nextCursor` string
 * the previous page returned — never one this app constructs. A build that
 * predates D5 simply never sends it and keeps seeing one page, `total`,
 * `truncated`, same as always.
 */
export function fetchMyPets(
  session: SessionPort,
  cursor?: string | null,
): Promise<ApiResult<MyPetsV1>> {
  const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiRequest<MyPetsV1>(
    { path: `/api/v1/me/pets${suffix}`, expectedPayloadVersion: MY_PETS_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `GET /pets/{publicToken}` — the OWNER face of one animal.
 *
 * NOT the credential. `/pets/{token}/credential` is anonymous and renders the
 * same for the owner and for a stranger who scanned the QR; this is what the
 * person responsible for the animal sees, and it needs a bearer. The two live
 * side by side on the screen for exactly that reason.
 */
export function fetchOwnerPetDetail(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<OwnerPetDetailV1>> {
  return apiRequest<OwnerPetDetailV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}`,
      expectedPayloadVersion: OWNER_PET_DETAIL_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/libreta` — the pet's health record.
 *
 * THE THIRD FACE. `/pets/{token}` is the owner's chrome, `/credential` is the
 * public front, and this is the back: the ledger of asientos, what is coming
 * due, and the vaccination summary. The web calls them "Credencial · frente"
 * and "Libreta · dorso" in the band above the card.
 *
 * NO ATTACHMENT URLS COME BACK, by design — an entry says whether it carries a
 * file. `fetchPetEventDetail` is what hands one over, with an expiry.
 */
export function fetchPetLibreta(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetLibretaV1>> {
  return apiRequest<PetLibretaV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/libreta`,
      expectedPayloadVersion: PET_LIBRETA_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /geocoding` — find an address, or name the point under the map pin
 * (M17). Server-side Nominatim on the web's own shared budget; the phone never
 * talks to the geocoder and never reads a device location.
 */
export function sendGeocodingCommand(
  session: SessionPort,
  input: GeocodingCommandInput,
): Promise<ApiResult<GeocodingAckV1>> {
  return apiRequest<GeocodingAckV1>(
    { path: "/api/v1/geocoding", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/poster` — the printable lost-pet poster (M13).
 *
 * FINISHED HTML, NOT FIELDS. The server resolves the titular's contact through
 * the disclosure filter the web's cartel page uses and lays the poster out;
 * this app only turns it into a PDF (`lost/poster-share.ts`). `available:
 * false` means the animal is not marked lost — a state, not a failure.
 */
export function fetchPetPoster(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetPosterV1>> {
  return apiRequest<PetPosterV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/poster`,
      expectedPayloadVersion: PET_POSTER_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/events/{eventId}` — one asiento, in full.
 *
 * THE ONE READ WHOSE ANSWER EXPIRES. Its attachments carry short-lived signed
 * URLs, each stamped with the instant it stops working. A caller must not stash
 * this payload past that instant, and this app does not: it lives in a screen's
 * state and dies with the screen.
 */
export function fetchPetEventDetail(
  session: SessionPort,
  publicToken: string,
  eventId: string,
): Promise<ApiResult<PetEventDetailV1>> {
  return apiRequest<PetEventDetailV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/events/${encodeURIComponent(eventId)}`,
      expectedPayloadVersion: PET_EVENT_DETAIL_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/events` — record one asiento.
 *
 * ONE CALL FOR EVERY KIND, because the endpoint is one: `pet_events` is a
 * single append-only table discriminated by `event_type`, and
 * `RecordEventInput` is a discriminated union over exactly that. A wrapper per
 * kind would be a pile of functions that differ only in a string.
 *
 * `idempotencyKey` is REQUIRED by the type because the server requires it, and
 * it is scoped to one form MOUNT — see `pets/idempotency.ts` for why a fresh key
 * per HTTP attempt would opt out of the failure the header exists for, and for
 * what that scoping costs when someone edits and resends.
 */
export function recordPetEvent(
  session: SessionPort,
  publicToken: string,
  input: RecordEventInput,
  idempotencyKey: string,
): Promise<ApiResult<EventRecordedV1>> {
  return apiRequest<EventRecordedV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/events`,
      method: "POST",
      body: input,
      headers: { "idempotency-key": idempotencyKey },
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/events/{eventId}/amend` — correct a record.
 *
 * IT CORRECTS BY APPENDING. The original stays in the ledger forever; this adds
 * a new event that supersedes it, and every reader projects the corrected value.
 * There is no edit and no delete, here or anywhere.
 *
 * `idempotencyKey` is REQUIRED by the type because the server requires it: a
 * missing or malformed header is a 400 `idempotency_key_required`. It is scoped
 * to one correction ATTEMPT and reused across every retry of that attempt — see
 * `pets/idempotency.ts`, which explains why a fresh key per HTTP attempt would
 * opt out of the exact failure the header exists for.
 */
export function amendPetEvent(
  session: SessionPort,
  target: { publicToken: string; eventId: string },
  input: AmendEventInput,
  idempotencyKey: string,
): Promise<ApiResult<EventAmendedV1>> {
  return apiRequest<EventAmendedV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(target.publicToken)}/events/${encodeURIComponent(
        target.eventId,
      )}/amend`,
      method: "POST",
      body: input,
      headers: { "idempotency-key": idempotencyKey },
    },
    session,
  );
}

/**
 * `GET /localities` — public typeahead.
 *
 * The server answers `results: []` for a query under two characters rather than
 * refusing, so this wrapper does NOT pre-filter: a client that decides for
 * itself when a query is "long enough" has forked the rule, and the day the
 * server relaxes it the app would still be enforcing the old one. The screen
 * skips the CALL for short input (a network round trip per keystroke is its own
 * problem), which is a different decision and lives at the call site.
 *
 * Public, so no bearer and no session port — the same reasoning as `login`.
 */
export async function searchLocalities(query: {
  q: string;
  province?: string;
}): Promise<ApiResult<LocalitiesV1>> {
  const params = new URLSearchParams({ q: query.q });
  if (query.province) params.set("province", query.province);

  const raw = await performRequest({ path: `/api/v1/localities?${params.toString()}` });
  if (raw.transport === "unreachable") return { outcome: "unreachable", detail: raw.detail };
  if (raw.transport === "malformed") return { outcome: "malformed", detail: raw.detail };
  if (raw.status !== 200) {
    return {
      outcome: "api-error",
      code: apiV1ErrorCode(raw.body) ?? "temporarily_unavailable",
      retryAfterSeconds: raw.retryAfterSeconds,
    };
  }
  const payload = raw.body as LocalitiesV1;
  if (payload?.payloadVersion !== LOCALITIES_PAYLOAD_VERSION) {
    return {
      outcome: "unsupported-version",
      received: typeof payload?.payloadVersion === "number" ? payload.payloadVersion : null,
    };
  }
  return { outcome: "ok", payload };
}

/**
 * `POST /pets` — the one write this app makes.
 *
 * `idempotencyKey` is REQUIRED by the type because it is required by the server:
 * a missing or malformed header is a 400 `idempotency_key_required`, not a
 * best-effort. The key is generated once per attempt-session and reused across
 * every retry of the same attempt — see `pets/idempotency.ts` for why that
 * matters more here than on most write endpoints.
 */
export function registerPet(
  session: SessionPort,
  input: RegisterPetInput,
  idempotencyKey: string,
): Promise<ApiResult<PetRegisteredV1>> {
  return apiRequest<PetRegisteredV1>(
    {
      path: "/api/v1/pets",
      method: "POST",
      body: input,
      headers: { "idempotency-key": idempotencyKey },
    },
    session,
  );
}

/**
 * `POST /me/revoke-sessions`.
 *
 * A 200 MEANS THE CALLER IS SIGNED OUT TOO, and that is not obvious from the
 * name. GoTrue rejects the access token immediately and the refresh comes back
 * `refresh_token_not_found` — measured, not assumed. So the caller must drop its
 * tokens and go to sign-in; it must NOT try to refresh, because the refresh is
 * guaranteed to fail and its failure would be reported as "your session
 * expired", which reads like a bug instead of like the thing the user just
 * asked for.
 */
export function revokeAllSessions(session: SessionPort): Promise<ApiResult<{ revoked: true }>> {
  return apiRequest<{ revoked: true }>(
    { path: "/api/v1/me/revoke-sessions", method: "POST" },
    session,
  );
}

/**
 * `GET /me/profile` — what the "Editar mis datos" form pre-fills with.
 *
 * NOT A RICHER `/me`. That endpoint is the shell every cold launch fetches and
 * it carries no phone by design; this one carries exactly the six fields the
 * POST below writes back, and is fetched only when somebody opens the form. The
 * full argument, and what breaks if a seventh field is ever added, is in
 * `@dim/contract/api`'s `my-profile.ts` — read it before widening this payload.
 */
export function fetchMyProfile(session: SessionPort): Promise<ApiResult<MyProfileV1>> {
  return apiRequest<MyProfileV1>(
    { path: "/api/v1/me/profile", expectedPayloadVersion: MY_PROFILE_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `POST /me/profile` — save the person's own data.
 *
 * THE THREE-WAY FIELD RULE IS THE CALLER'S TO HONOUR and it is not decoration:
 * an omitted key leaves the stored value alone, `""` CLEARS the column, and a
 * string stores as given. A screen that sent `""` for a field it never rendered
 * would silently erase a phone number the person entered on the web.
 *
 * NO `idempotencyKey`: a profile update is a value, not an append. Saving the
 * same six fields twice is saving them once.
 */
export function saveMyProfile(
  session: SessionPort,
  input: MyProfileEditInput,
): Promise<ApiResult<MyProfileUpdatedV1>> {
  return apiRequest<MyProfileUpdatedV1>(
    { path: "/api/v1/me/profile", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /me/privacy` — derecho de acceso (Ley 25.326 art. 14).
 *
 * THE ONE READ ON THIS SURFACE A CLIENT MUST NOT CACHE. Every other payload
 * here carries a `staleAfter` worth honouring; this one comes back with
 * `staleAfter === issuedAt` because `MY_PRIVACY_STALE_AFTER_MS` is 0 — the body
 * is the caller's whole PII record, and there is no situation in which reusing a
 * copy of it is better than asking again. Nothing in this file persists a
 * payload, so honouring that costs nothing; what it forbids is a future screen
 * deciding to keep one "so the back button is fast".
 *
 * `subject` is deliberately `Record<string, unknown>` — see `my-privacy.ts` for
 * why the contract refuses to model the export's tree.
 */
export function fetchMySubjectDataExport(
  session: SessionPort,
): Promise<ApiResult<MySubjectDataExportV1>> {
  return apiRequest<MySubjectDataExportV1>(
    { path: "/api/v1/me/privacy", expectedPayloadVersion: MY_PRIVACY_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `POST /me/privacy` — derecho de supresión (art. 16). THE ONE IRREVERSIBLE
 * WRITE THIS APP CAN MAKE.
 *
 * Every other write here changes a value, appends an entry, or opens and closes
 * an exposure — all of them survivable, most of them correctable by a second
 * write. This one ends the account, deletes the `auth.users` row and purges the
 * subject's objects out of three Storage buckets. There is no command that
 * undoes it and no support flow that restores it.
 *
 * A 200 MEANS THE CALLER IS SIGNED OUT TOO, and for a harder reason than
 * `revokeAllSessions`: there is no longer an account for the token to belong to.
 * So the caller must drop its keychain entry and go to sign-in, and it must NOT
 * refresh — the refresh will fail and its failure would be reported as "tu
 * sesión venció", which reads like a bug instead of like the thing the person
 * just asked for. That is why the body is `{ erased: true }` rather than empty:
 * one unambiguous signal to act on.
 *
 * NO `idempotencyKey`, and that is the contract rather than a shortcut. The
 * server takes no key here: a supresión has no duplicate to create, and after a
 * successful one the token a retry would carry is already dead, so the retry
 * lands on 401 instead of on a second erasure.
 */
export function eraseMyAccount(
  session: SessionPort,
  input: SubjectRightsCommandInput,
): Promise<ApiResult<SubjectDataErasedV1>> {
  return apiRequest<SubjectDataErasedV1>(
    { path: "/api/v1/me/privacy", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/lost` — the owner's lost-mode cockpit.
 *
 * ONE READ FOR A FEATURE THE WEB SPREADS ACROSS TWO PLACES: the mark-lost /
 * update page and the `LostCaseBlock` on the profile. It carries the episode,
 * the sightings feed, the disclosure settings, and — the part a client must not
 * recompute — WHICH of the state commands this caller may send.
 *
 * THE FEED IT CARRIES IS ALREADY FILTERED. An item somebody reported is simply
 * absent; there is no moderation flag on the wire and nothing for a client to
 * reconcile, because the reported row is never modified — see `pet-lost.ts`.
 */
export function fetchPetLostMode(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetLostV1>> {
  return apiRequest<PetLostV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/lost`,
      expectedPayloadVersion: PET_LOST_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/lost` — run one lost-mode command.
 *
 * THE FOURTH WRITE ON THIS SURFACE, which the count in this file's header
 * deliberately no longer states — but it is worth saying what KIND of write it
 * is, because it is the first one that is not an append: these six move
 * `pets.status`, open and close a case, publish or unpublish an owner's own
 * contact details, and take a stranger's message off the owner's feed. The
 * append-only invariant still holds where it applies — the spine gets
 * `status_changed`, `note_added` and `content_reported` rows, and NOTHING is
 * edited, the reported item least of all — but a reader should not read "write"
 * here and assume "asiento".
 *
 * `idempotencyKey` IS NULLABLE, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * Only `report_last_seen`'s writer takes a `clientIdempotencyKey`, because two
 * sightings minutes apart are two facts. The endpoint requires the header for
 * that one and does not read it for the other five, whose writers are idempotent
 * on the STATE — including `report_content`, which appends and still needs none,
 * since an item already reported is not reported twice. Sending a key the server
 * would ignore is not harmless: it is a client believing it holds a guarantee it
 * does not.
 */
export function sendLostCommand(
  session: SessionPort,
  publicToken: string,
  input: LostCommandInput,
  idempotencyKey: string | null,
): Promise<ApiResult<LostCommandAckV1>> {
  return apiRequest<LostCommandAckV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/lost`,
      method: "POST",
      body: input,
      headers: idempotencyKey === null ? undefined : { "idempotency-key": idempotencyKey },
    },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/shares` — who else can see this animal's record.
 *
 * THE ONE READ ON THIS SURFACE THAT CARRIES BEARER SECRETS. Each active share
 * link comes back with its `shareToken`, which reads the animal's medical record
 * for whoever holds it. The contract's `pet-shares.ts` states the rules at
 * length; the one that binds a CALLER is: this payload is not cached, not
 * logged, and not echoed into an error. It belongs in a screen's state and dies
 * with the screen — the line `LibretaScreen` already draws, with a credential on
 * top.
 */
export function fetchPetShares(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetSharesV1>> {
  return apiRequest<PetSharesV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/shares`,
      expectedPayloadVersion: PET_SHARES_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/shares` — run one sharing command.
 *
 * THE FIFTH WRITE ON THIS SURFACE, and the first that touches no spine at all.
 * `create_libreta_share` inserts into `libreta_share_tokens`;
 * `revoke_libreta_share` flips `revoked_at`; the two Tier-2 commands move two
 * columns on `pets`. Nothing is appended and nothing is edited that was ever a
 * FACT — an exposure is not an asiento — so the append-only invariant is
 * untouched rather than bent.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * None of the four writers takes a `clientIdempotencyKey`; all four are
 * idempotent on the STATE instead, and three of them recognise a replay and
 * report it as `changed: false`. Requiring a header the server would ignore is
 * a client believing it holds a guarantee it does not — the same refusal
 * `writers.ts` makes for atestación PPP and embarazo.
 */
export function sendShareCommand(
  session: SessionPort,
  publicToken: string,
  input: ShareCommandInput,
): Promise<ApiResult<ShareCommandAckV1>> {
  return apiRequest<ShareCommandAckV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/shares`,
      method: "POST",
      body: input,
    },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/profile` — what the "Editar datos" form pre-fills with.
 *
 * NOT A SIXTH FACE OF THE PET. `/pets/{token}` is what an owner READS about
 * their animal; this is the narrow set a form WRITES, plus the two capability
 * flags that decide which halves of the form exist at all. They are separate
 * reads because they answer to different rules — the owner face is every current
 * holder, the emergency-contact half of this one is the legal owner alone — and
 * folding the editable fields into the read face would have put the titular's
 * own vet and phone number into the payload a caretaker's device caches.
 */
export function fetchPetProfileEdit(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetProfileEditV1>> {
  return apiRequest<PetProfileEditV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/profile`,
      expectedPayloadVersion: PET_PROFILE_EDIT_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/profile` — run one of the two edit commands.
 *
 * THE ONE WRITE ON THIS SURFACE THAT CORRECTS A FACT ALREADY RECORDED. Every
 * other one appends (an asiento, a sighting), moves a status, or opens and
 * closes an exposure. `edit_identity` overwrites `pets.name`/`breed`/`color` —
 * and does NOT bend the append-only invariant while doing it: the previous
 * values leave in a bundled `pet_profile_updated` event carrying the diff, so
 * the correction is itself a new entry in the ledger and nothing in the spine is
 * edited. `set_emergency_contacts` appends nothing at all, because the four
 * columns it moves are preferences and not facts about the animal.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * Neither writer takes a `clientIdempotencyKey`; both are idempotent on the
 * STATE, and the identity edit recognises a replay and reports it as
 * `changed: false`. Requiring a header the server would ignore is a client
 * believing it holds a guarantee it does not.
 */
export function sendPetProfileCommand(
  session: SessionPort,
  publicToken: string,
  input: PetProfileCommandInput,
): Promise<ApiResult<PetProfileEditAckV1>> {
  return apiRequest<PetProfileEditAckV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/profile`,
      method: "POST",
      body: input,
    },
    session,
  );
}

/**
 * `GET /me/transfers` — THE ONE READ ON THIS SURFACE THAT IS NOT ABOUT A PET.
 *
 * Every other authenticated read here takes a `publicToken`, because it is about
 * one animal. This one takes none, and it cannot: half of what it returns is
 * about animals this caller does NOT own — a transfer proposal is an offer from
 * somebody else's pet. There is no token that would name the read.
 *
 * It is also the read that feeds the deep link `mimar://transferencias/{token}`.
 * The detail screen selects its row out of these three lists rather than calling
 * a second endpoint: the union of `incoming` and `outgoing` is exactly the set a
 * caller is authorized to see, so a proposal that is not in it is one this
 * person may not read, and the screen says so without a round trip.
 */
export function fetchMyTransfers(session: SessionPort): Promise<ApiResult<MyTransfersV1>> {
  return apiRequest<MyTransfersV1>(
    { path: "/api/v1/me/transfers", expectedPayloadVersion: MY_TRANSFERS_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `POST /me/transfers` — run one of the four transfer commands.
 *
 * THE SIXTH WRITE ON THIS SURFACE, and the first that can change WHO OWNS AN
 * ANIMAL. `accept` closes the sender's `ownerships` row, opens the caller's,
 * appends a `custody_transferred` asiento to the spine and ends any live
 * caretaker arrangement — one transaction, four tables. The append-only
 * invariant holds where it applies; a reader should not read "write" here and
 * assume "asiento".
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * None of the four writers takes a `clientIdempotencyKey`. What they have —
 * a partial unique index for `initiate`, an `expectedStatus` guard for the other
 * three — REFUSES a replay instead of absorbing one, which is a different
 * promise: after a timeout, `transfer_already_resolved` may mean the first
 * attempt landed OR that the other party moved first. A caller must re-read;
 * `@dim/contract/input`'s `transfer.ts` states it at length.
 */
export function sendTransferCommand(
  session: SessionPort,
  input: TransferCommandInput,
): Promise<ApiResult<TransferCommandAckV1>> {
  return apiRequest<TransferCommandAckV1>(
    { path: "/api/v1/me/transfers", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /me/caretaker-grants` — the SECOND read on this surface that is not about
 * a pet this caller holds, and the reason is the same shape as the first's.
 *
 * Half of what it returns is invitations to look after somebody ELSE'S animal, so
 * there is no token that would name the read. It feeds two screens: the titular's
 * per-pet cockpit, which filters `outgoing` down to one animal, and the deep-link
 * destination `mimar://cuidado/{CG-…}`, which selects its row out of the union.
 *
 * IT CARRIES OPEN GRANTS ONLY — `pending` and `accepted`. A token that is not in
 * the payload is NOT proof the token is fake: an invitation that was answered,
 * withdrawn or swept is absent for the same reason. The screen's copy says both
 * possibilities out loud rather than picking one.
 */
export function fetchMyCaretakerGrants(
  session: SessionPort,
): Promise<ApiResult<MyCaretakerGrantsV1>> {
  return apiRequest<MyCaretakerGrantsV1>(
    {
      path: "/api/v1/me/caretaker-grants",
      expectedPayloadVersion: MY_CARETAKER_GRANTS_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /me/caretaker-grants` — run one of the five cuidador-temporal commands.
 *
 * FIVE AND NOT SEVEN, and the two that are missing are worth knowing about here:
 * `withdraw` (a caretaker stepping down) and `return` are not reachable from the
 * web, so they are not on this surface either. A phone that could end an
 * arrangement a browser cannot is not parity.
 *
 * NOT ALL FIVE ARE APPENDS. `accept` opens an `ownerships` row and appends
 * `caretaker_designated`; `revoke` closes that row and appends `caretaker_ended`.
 * The other three move workflow state and touch the spine not at all — a pending
 * invitation is not a fact about the animal.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * None of the five writers takes a `clientIdempotencyKey`. What they have — two
 * partial unique indexes for `designate`, a locked re-read or an `expectedStatus`
 * guard for the rest — REFUSES a replay instead of absorbing one, which is a
 * different promise: after a timeout, `caretaker_already_resolved` may mean the
 * first attempt landed OR that the other party moved first. A caller must
 * re-read; `@dim/contract/input`'s `caretaker.ts` states it at length.
 */
export function sendCaretakerCommand(
  session: SessionPort,
  input: CaretakerCommandInput,
): Promise<ApiResult<CaretakerCommandAckV1>> {
  return apiRequest<CaretakerCommandAckV1>(
    { path: "/api/v1/me/caretaker-grants", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /me/foster` — a volunteer's own tránsito inbox: proposals awaiting an
 * answer, and every foster (active or ended) that came of one.
 *
 * THE THIRD READ ON THIS SURFACE THAT IS NOT ABOUT A PET THIS CALLER HOLDS,
 * for `me/caretaker-grants`'s own reason: a proposal is an offer to care for
 * an animal the caller does not yet have. `proposals` carries only
 * `status: "pending"` rows; `fosters` carries the ones that came of an
 * accept, active or ended.
 */
export function fetchMyFoster(session: SessionPort): Promise<ApiResult<MyFosterV1>> {
  return apiRequest<MyFosterV1>(
    { path: "/api/v1/me/foster", expectedPayloadVersion: MY_FOSTER_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `GET /me/cases` — the owner's casos: every open cycle plus the most recent
 * closed ones, the web's "Casos abiertos" and "Historial" blocks.
 *
 * Each row carries the in-app `route` the server resolved for it, or `null`
 * when the app has no screen for it. The client never derives one from `kind`.
 */
export function fetchMyCases(session: SessionPort): Promise<ApiResult<MyCasesV1>> {
  return apiRequest<MyCasesV1>(
    { path: "/api/v1/me/cases", expectedPayloadVersion: MY_CASES_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `GET /me/cases/{publicCode}` — one case, as the web's `/casos/{publicCode}`
 * shows it to this signed-in person. A case they may not read is `not_found`,
 * the same answer as a code that does not exist.
 */
export function fetchMyCase(
  publicCode: string,
  session: SessionPort,
): Promise<ApiResult<MyCaseDetailV1>> {
  return apiRequest<MyCaseDetailV1>(
    {
      path: `/api/v1/me/cases/${encodeURIComponent(publicCode)}`,
      expectedPayloadVersion: MY_CASE_DETAIL_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /me/foster` — accept or decline a proposal.
 *
 * TWO COMMANDS, NOT FOURTEEN. `src/modules/foster` has fourteen use-cases on
 * the web and the great majority are the ORG's (proponer, asignar, buscar el
 * pool). This surface carries only the two a volunteer sends about a
 * proposal addressed to them.
 *
 * NO `idempotencyKey` PARAMETER, for the same reason `sendCaretakerCommand`
 * has none: neither writer takes a `clientIdempotencyKey`. Both re-read the
 * proposal and refuse unless it is still `pending`, so a replay is REFUSED
 * rather than absorbed — after a timeout, `foster_already_resolved` may mean
 * the first attempt landed. A caller must re-read.
 */
export function sendFosterCommand(
  session: SessionPort,
  input: FosterCommandInput,
): Promise<ApiResult<FosterCommandAckV1>> {
  return apiRequest<FosterCommandAckV1>(
    { path: "/api/v1/me/foster", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /me/appointments` — every turno this person booked.
 *
 * THE FOURTH READ ON THIS SURFACE THAT TAKES NO PET TOKEN, and the one where the
 * reason is different from the other three. `/me/transfers`,
 * `/me/caretaker-grants` and `/me/notifications` CANNOT name a pet. This one
 * could — every row names an animal — and does not, because the question it
 * answers is not per-pet: somebody opening it is asking "what do I have booked",
 * across every animal they are responsible for, ordered by time. Per-pet would
 * make this app ask N times to answer it.
 *
 * It also carries rows for animals this caller does not own: a foster or a
 * co-owner books under their own id, and the turno is theirs even when the animal
 * is not.
 *
 * THREE FACTS ON EVERY ROW ARE THE SERVER'S CLOCK AND MUST NOT BE RECOMPUTED —
 * `section`, `capabilities.canCancel`, `capabilities.canCheckIn`. The contract's
 * `my-appointments.ts` states it at length; the short version is that a phone
 * whose clock is wrong takes the check-in QR away from somebody standing at the
 * clinic desk.
 */
export function fetchMyAppointments(session: SessionPort): Promise<ApiResult<MyAppointmentsV1>> {
  return apiRequest<MyAppointmentsV1>(
    { path: "/api/v1/me/appointments", expectedPayloadVersion: MY_APPOINTMENTS_PAYLOAD_VERSION },
    session,
  );
}

/**
 * `POST /me/appointments` — take a turno (`book`) or give one back (`cancel`).
 *
 * TWO COMMANDS SINCE 2026-08-30, AND NO SECOND FUNCTION FOR THE SECOND ONE. The
 * input is a discriminated union and this wrapper takes the union, so `book`
 * arrived as a contract widening and nothing here changed. A `sendBookingCommand`
 * beside this one would be a second door onto one endpoint — which is the whole
 * argument for discriminating the input, arriving on time.
 *
 * THE THREE THAT ARE MISSING ARE STILL THE POINT. Three of the web's booking
 * writes (asistió, no asistió, cancelar por la organización) are the PROVIDER'S,
 * behind `/org/{token}/agenda`. A citizen wallet that could run one would be
 * doing something the owner's browser cannot. *Booking used to
 * be a fourth absence and is no longer one* — this paragraph said it was "absent
 * for a different reason … which is scope, not a rule", and that reason expired
 * when `buscar` landed. The distinction it was drawing survives the correction:
 * the three that remain are absent by RULE, and nothing about this app growing a
 * search brings them any closer.
 *
 * WHAT `cancel` MUTATES IS NOT AN ASIENTO. `appointments.status`, three timestamps, and
 * a DECREMENT of `time_slots.bookings_count` that frees the place for somebody
 * else. Nothing on the spine: a turno nobody attended produced no fact about the
 * animal.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * The writer takes no `clientIdempotencyKey`. What it has — an UPDATE conditional
 * on `status = 'confirmed'` — REFUSES a replay instead of absorbing one, which is
 * a different promise: after a timeout, `appointment_already_resolved` may mean
 * the first attempt landed OR that the clinic moved first. A caller must re-read.
 */
export function sendAppointmentCommand(
  session: SessionPort,
  input: AppointmentCommandInput,
): Promise<ApiResult<AppointmentCommandAckV1>> {
  return apiRequest<AppointmentCommandAckV1>(
    { path: "/api/v1/me/appointments", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /appointments` — the service picker, or one service's results.
 *
 * TWO SHAPES ON ONE URL, and this wrapper does not split them: called with no
 * `serviceKind` the payload carries the twelve-row catalogue and no results,
 * which is what the picker screen draws. The web does the same on one URL and for
 * the same reason — a second endpoint for a twelve-item constant is a route, a
 * bucket and a payload version.
 *
 * A BEARER CALL, unlike `searchLocalities`, and that is not an oversight of the
 * "it is public on the web" kind. The endpoint requires a session (its own header
 * argues why: this app has no anonymous shell and an anonymous `/api/v1` read is
 * a different rate-limit derivation rather than a smaller one), so a
 * `performRequest` here would send a call the server refuses.
 *
 * THE PARAM NAMES ARE THE WEB'S, EXACTLY — `service_kind`, `province`,
 * `locality`, `fecha_desde`, `solo_gratis`. `snake_case` and one of them in
 * Spanish is not this file's taste; it is `/turnos/buscar`'s query string, and a
 * person who shares a search from the browser and one who shares it from the
 * phone should be describing the same thing.
 *
 * AN OMITTED FILTER IS NOT AN EMPTY ONE. A key is set only when it has a value,
 * because `?province=` is a request to search the empty-string province and
 * `?solo_gratis=false` is a string the server reads as "not true" — the same
 * three-way rule `saveMyProfile` states for its fields.
 */
export function fetchAppointmentSearch(
  session: SessionPort,
  query: {
    serviceKind?: string | null;
    province?: string | null;
    locality?: string | null;
    fechaDesde?: string | null;
    freeOnly?: boolean;
  } = {},
): Promise<ApiResult<AppointmentSearchV1>> {
  const params = new URLSearchParams();
  if (query.serviceKind) params.set("service_kind", query.serviceKind);
  if (query.province) params.set("province", query.province);
  if (query.locality) params.set("locality", query.locality);
  if (query.fechaDesde) params.set("fecha_desde", query.fechaDesde);
  if (query.freeOnly) params.set("solo_gratis", "true");
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;

  return apiRequest<AppointmentSearchV1>(
    {
      path: `/api/v1/appointments${suffix}`,
      expectedPayloadVersion: APPOINTMENT_SEARCH_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `GET /appointments/{offeringToken}` — one offering, its slot grid, and which of
 * the caller's animals may take a place.
 *
 * `pets[].canBook` AND `blockedReason` ARE THE SERVER'S AND MUST NOT BE
 * RECOMPUTED. The rule behind them is the writer's — one confirmed appointment per
 * (pet, offering), re-checked inside the booking transaction and backed by a
 * partial unique index — and it is invisible in a slot grid. A screen that derived
 * eligibility from the slots alone would draw a button the write throws away.
 *
 * `pets` MAY BE EMPTY and that is not an error: it is a person with no animal
 * registered yet, and the screen sends them to the alta form. It must NOT be
 * rendered as "no encontramos tus mascotas".
 *
 * A 404 COVERS "NOT APPROVED" as well as "no such token", deliberately, so this
 * URL is not an oracle for which offerings exist and which are merely switched
 * off. A caller must not turn the two into different sentences.
 */
export function fetchBookableOffering(
  session: SessionPort,
  offeringToken: string,
): Promise<ApiResult<BookableOfferingDetailV1>> {
  return apiRequest<BookableOfferingDetailV1>(
    {
      path: `/api/v1/appointments/${encodeURIComponent(offeringToken)}`,
      expectedPayloadVersion: APPOINTMENT_SEARCH_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /me/pet-claims` — buscar una mascota por su chip, y reclamarla.
 *
 * ONE CALL FOR BOTH COMMANDS, and they are two halves of one act rather than a
 * read and a write that happen to share a URL. `lookup` answers which animal a
 * private identifier resolves to and whether it may be claimed; `claim_free`
 * takes it. Both spend the SAME per-user budget on the server (`claim_lookup`,
 * 30/min + 200/hr) precisely so that alternating between them buys a prober
 * nothing — which is also why this app must not "helpfully" re-lookup after
 * every keystroke.
 *
 * THE THIRD STEP THE WEB HAS IS NOT MISSING, IT IS REFUSED. When the animal
 * already has a custody, the browser offers a disputa — and that writer requires
 * at least one evidence FILE, absolutely, because raising one notifies the
 * registered owner, appends an uneditable row to the animal's spine, flips
 * `pets.in_custody_dispute` (which strips the owner's phone off the public
 * credential) and opens a case a local authority has to adjudicate. This app
 * cannot attach a file — a picker is a native module, which is an EAS build —
 * so the contract's input union has two members and a screen meeting
 * `variant: "active_owner"` sends the person to the browser. Do not add a
 * `dispute` command here without the bytes to back it.
 *
 * `canClaim` IS THE SERVER'S. It looks like `variant === "free"` and it is not
 * a client's to derive: the rule behind it is "no active custody of ANY role",
 * re-checked inside the claiming transaction under a row lock, plus three status
 * gates. Drawing the button from the variant would be keeping a second copy of
 * an authorization rule, on the most consequential act this app can perform.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * The writer takes none. What it has — `SELECT … FOR UPDATE` plus a re-check of
 * active custody inside the transaction — SERIALIZES two concurrent claims and
 * REFUSES the second rather than absorbing it, so a retry after a timeout
 * answers `claim_not_claimable` whether this caller's own first attempt landed
 * or somebody else claimed the animal meanwhile. Re-run `lookup`; do not
 * re-send.
 *
 * DO NOT PERSIST THE IDENTIFIER. Not to AsyncStorage, not to a log, not into a
 * crash report. The 15-digit chip is the evidence that authorizes a claim, and
 * `/p/{token}` deliberately renders "Microchip: Sí/No" and never the number.
 */
export function sendPetClaimCommand(
  session: SessionPort,
  input: PetClaimCommandInput,
): Promise<ApiResult<PetClaimCommandAckV1>> {
  return apiRequest<PetClaimCommandAckV1>(
    { path: "/api/v1/me/pet-claims", method: "POST", body: input },
    session,
  );
}

/**
 * `GET /me/notifications` — the inbox, one page of it plus the tab counts.
 *
 * THE THIRD READ ON THIS SURFACE THAT IS NOT ABOUT A PET, and the one where the
 * reason is plainest: a notification is addressed to a PERSON. Many are about an
 * animal, several are about an animal the caller no longer holds — that is what
 * `pet_transfer_accepted` IS — and some are about no animal at all.
 *
 * THE ARRAY IS NOT IN DISPLAY ORDER and must not be rendered as it arrives. It
 * comes back chronological, because that is the order the server's cursor is
 * derived from; the severity-first order a reader sees is
 * `@dim/contract/notifications`, the same function the web page calls. See
 * `notifications-view-model.ts`, which is the only place in this app that sorts.
 *
 * `cat` IS THE WEB'S OWN PARAMETER and an unknown value falls back to the whole
 * inbox rather than erroring — a filter is a view, not an assertion.
 *
 * `cursor` (D5) IS OPAQUE AND OPTIONAL, echoing exactly the `nextCursor` the
 * previous call for this SAME `category` returned — see the contract's own
 * note on why a cursor minted under one tab and replayed under another still
 * answers (both conditions apply together) rather than refusing.
 */
export function fetchMyNotifications(
  session: SessionPort,
  category?: string | null,
  cursor?: string | null,
): Promise<ApiResult<MyNotificationsV1>> {
  const params = new URLSearchParams();
  if (category) params.set("cat", category);
  if (cursor) params.set("cursor", cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return apiRequest<MyNotificationsV1>(
    {
      path: `/api/v1/me/notifications${suffix}`,
      expectedPayloadVersion: MY_NOTIFICATIONS_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /me/notifications` — run one of the three inbox commands.
 *
 * THE CHEAPEST WRITE ON THIS SURFACE, and the only one that touches no domain
 * fact at all: `read_at` and `archived_at` on the caller's own rows. Nothing is
 * appended, nothing is derived from it, and no re-derivation could reconstruct
 * it — a read receipt is a fact about a person's inbox, not about an animal.
 *
 * NO `idempotencyKey` PARAMETER, AND HERE THAT IS A STRONGER PROMISE RATHER THAN
 * A WEAKER ONE. All three commands are idempotent on the STATE — a row already
 * read is not read twice — and each says so through `changed`. There is nothing
 * a key would add, and sending one the server ignores is a client believing it
 * holds a guarantee nobody made.
 *
 * `unreadCount` CAN COME BACK `null` ON A SUCCESS. The badge is re-read after
 * the write commits, so a pooler that degrades in between leaves the endpoint
 * holding a write that landed and a count it cannot compute. A caller must read
 * `null` as "your tap worked, the badge is stale" and NOT retry the command.
 */
export function sendNotificationCommand(
  session: SessionPort,
  input: NotificationCommandInput,
): Promise<ApiResult<NotificationCommandAckV1>> {
  return apiRequest<NotificationCommandAckV1>(
    { path: "/api/v1/me/notifications", method: "POST", body: input },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/photo` — step 1 of 3. Ask for an upload ticket.
 *
 * THE FIRST WRITE ON THIS SURFACE THAT DOES NOT END WITH THE SERVER HOLDING THE
 * DATA. It hands back a bearer capability to write ONE object into a private
 * staging bucket; `uploadPetPhotoBytes` spends it, and `confirmPetPhoto` is what
 * turns the result into the animal's photo. Until that third call succeeds
 * NOTHING has changed — a client that shows "listo" after this one is lying.
 *
 * DO NOT PERSIST THE TICKET. Not to AsyncStorage, not to a log, not into a
 * crash report. The rule `pet-shares.ts` states for share tokens applies here
 * for the same reason: it is a credential, and it belongs in the upload call it
 * was minted for.
 */
export function requestPetPhotoTicket(
  session: SessionPort,
  publicToken: string,
  contentType: PetPhotoContentType,
): Promise<ApiResult<PetPhotoTicketV1>> {
  return apiRequest<PetPhotoTicketV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/photo`,
      method: "POST",
      body: { command: "request_ticket", contentType },
    },
    session,
  );
}

/**
 * Step 2 of 3. PUT the bytes to the ticket's URL — NOT to `/api/v1`.
 *
 * THE ONE CALL IN THIS FILE THAT DOES NOT GO THROUGH `apiRequest`, and the
 * exception is deliberate rather than a shortcut. Everything `apiRequest` does
 * is wrong here: there is no bearer to attach (the capability is in the URL),
 * there is no `{ error }` envelope to interpret (Supabase Storage speaks its
 * own), there is no `payloadVersion` to gate, and a 401 from the object store
 * means the ticket expired — NOT that the account's session is over. Routing
 * this through the session layer would sign a user out because a two-hour-old
 * upload URL went stale, which is the exact class of bug `client.ts`'s header
 * describes for `session_shift_expired`.
 *
 * So it reports its own outcome, in four arms, and the caller decides:
 *   · `ok`        — the bytes are staged. Call `confirmPetPhoto` next.
 *   · `expired`   — the TICKET is no longer usable. Re-ticket; do not sign out.
 *   · `rejected`  — the FILE was refused. A new ticket cures nothing.
 *   · `failed`    — anything else, including no signal. Retry with the same
 *                   ticket is safe (nothing has been claimed).
 *
 * ===================================================================
 * WHY THE STATUS CODE IS NOT THE ANSWER, AND THE BODY IS.
 * ===================================================================
 * This function used to read `400 | 401 | 403` as "this ticket is done" and
 * throw the response body away. The comment that justified it said 400 "is
 * what the Storage API answers for an expired or already-spent signed upload
 * token", and that sentence is TRUE AND USELESS: 400 is also what it answers
 * for three other things, and the caller's advice — "volvé a intentar: pedimos
 * uno nuevo" — cannot cure two of them. A person following it retries forever.
 *
 * Measured against the live project on 2026-09-11, one fresh ticket per case.
 * EVERY ROW IS HTTP 400; only the body tells them apart:
 *
 *   token is garbage            InvalidJWT          "Invalid Compact JWS"
 *   token minted for another key InvalidSignature   "Invalid signature"
 *   ticket already spent        KeyAlreadyExists    (statusCode 409)
 *   content-type not allowlisted InvalidMimeType    (statusCode 415)
 *   over the bucket's 5 MiB     EntityTooLarge      (statusCode 413)
 *
 * The first three mean the ticket is done and a new one is the cure. The last
 * two mean the BYTES are the problem and a thousand new tickets will each be
 * refused exactly the same way. Collapsing them into one sentence is not a
 * rounding error in the copy — it is advice that cannot work, which is the one
 * thing an error message must never be.
 *
 * `detail` carries the status and the server's own words, so a tester on a
 * device we cannot attach a debugger to can read the cause off the screen and
 * repeat it. No ticket, token or URL goes into it — the Storage error bodies
 * above carry none, and this only ever forwards them.
 *
 * `body` IS A `Uint8Array` AND NOT A `Blob`, AND THAT DISTINCTION IS THIS
 * FUNCTION'S SECOND BUG FIX. An earlier version of this very comment claimed
 * "the content-type header does reach the wire on Android" for a blob body.
 * It does not — measured on a real Android device on 2026-09-12, a signed PUT
 * with a Blob body arrives at Supabase Storage as
 * `content-type: application/octet-stream`, whatever header the caller sets,
 * and the bucket refuses it with `InvalidMimeType`. The screen was then told
 * the file was rejected (thanks to the fix above), which was honest but not the
 * whole story: the file was fine, the transport mislabelled it.
 *
 * The app's ordinary JSON calls set `content-type: application/json` and work,
 * which proves the header survives for NON-blob bodies — so the loss is
 * specific to React Native's blob request path. A `Uint8Array` is carried by
 * `convertRequestBody` as `{base64: …}`, whose native branch USES the
 * content-type header (and raises a visible error rather than silently
 * defaulting to octet-stream if it is ever absent). The bytes are produced as a
 * Uint8Array at the source — see `readAsBytes` in the picker adapter — so
 * nothing re-reads a blob here.
 */
export type PetPhotoUploadOutcome =
  | { outcome: "ok" }
  | { outcome: "expired"; detail: string }
  | { outcome: "rejected"; detail: string }
  | { outcome: "failed"; detail: string };

/** Storage codes that mean the TICKET is done. A new ticket is the cure. */
const STORAGE_TICKET_IS_DONE = new Set([
  "KeyAlreadyExists",
  "InvalidJWT",
  "InvalidSignature",
  "ExpiredToken",
]);

/** Storage codes that mean the FILE was refused. A new ticket cures nothing. */
const STORAGE_FILE_WAS_REFUSED = new Set(["InvalidMimeType", "EntityTooLarge"]);

export async function uploadPetPhotoBytes(
  ticket: PetPhotoTicketV1,
  body: Uint8Array,
  contentType: PetPhotoContentType,
): Promise<PetPhotoUploadOutcome> {
  let response: Response;
  try {
    response = await fetch(ticket.uploadUrl, {
      method: "PUT",
      headers: { "content-type": contentType },
      // `as BodyInit`: React Native's `fetch` accepts a `Uint8Array` body at
      // runtime — that is the whole point of this change — but the DOM `lib`
      // types this tsconfig pulls model the web `BodyInit`, which does not name
      // a bare typed array. The cast asserts the runtime contract the ambient
      // types cannot see; it is not widening anything the code does.
      body: body as unknown as BodyInit,
    });
  } catch (error) {
    // No signal at all — airplane mode, a dropped connection, a DNS failure.
    // Nothing was sent, so the ticket is still good.
    return { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
  }
  if (response.ok) return { outcome: "ok" };

  const { code, detail } = await readStorageError(response);
  if (code !== null && STORAGE_TICKET_IS_DONE.has(code)) return { outcome: "expired", detail };
  if (code !== null && STORAGE_FILE_WAS_REFUSED.has(code)) return { outcome: "rejected", detail };
  // An unrecognised refusal. NOT quietly filed as one of the two above: a code
  // this build has never seen is exactly the case where guessing produced the
  // defect this function was rewritten to remove.
  return { outcome: "failed", detail };
}

/** The most a Storage error body may contribute to a sentence on a phone. */
const STORAGE_DETAIL_MAX = 160;

/**
 * The `code` Storage named, and a line a person can read and repeat.
 *
 * Every arm survives a body that is empty, truncated, HTML from a proxy, or
 * absent because the stream was already consumed. A diagnostic that can throw
 * would replace the failure being diagnosed with its own.
 */
async function readStorageError(response: Response): Promise<{
  code: string | null;
  detail: string;
}> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return { code: null, detail: `HTTP ${response.status}` };
  }

  let code: string | null = null;
  let message: string | null = null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const fields = parsed as { code?: unknown; message?: unknown };
      if (typeof fields.code === "string") code = fields.code;
      if (typeof fields.message === "string") message = fields.message;
    }
  } catch {
    // Not JSON. `raw` is still the best thing we have to show.
  }

  const said = message ?? (raw.length > 0 ? raw : null);
  const detail = [`HTTP ${response.status}`, code, said].filter((part) => part != null).join(" ");
  return { code, detail: detail.slice(0, STORAGE_DETAIL_MAX) };
}

/**
 * Step 3 of 3. Ask the server to accept the staged bytes as the animal's photo.
 *
 * THE SERVER RE-AUTHORIZES AND RE-VALIDATES HERE, which is why `stagedPath` may
 * be sent back as-is: it is a claim, not a capability. The server refuses any
 * key that does not belong to the pet in the URL, refuses bytes that are not a
 * JPEG/PNG/WebP by their magic bytes rather than by what the ticket declared,
 * and re-encodes what survives before it reaches the public bucket.
 *
 * NO IDEMPOTENCY KEY, and none is needed: this sets a value rather than
 * appending a row, so a retry after a timeout that in fact landed sets the same
 * photo again. That makes it the one write on this surface a client may retry
 * blind.
 */
export function confirmPetPhoto(
  session: SessionPort,
  publicToken: string,
  stagedPath: string,
): Promise<ApiResult<PetPhotoUpdatedV1>> {
  return apiRequest<PetPhotoUpdatedV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/photo`,
      method: "POST",
      body: { command: "confirm", stagedPath },
    },
    session,
  );
}

/**
 * `GET /adoptions` — one page of the public adoption catalogue.
 *
 * A BEARER CALL, unlike `searchLocalities`, and that is not an oversight of the
 * "it is public on the web" kind. The endpoint requires a session (its own
 * header argues why: this app has no anonymous shell, the funnel ends at a
 * session anyway, and an anonymous `/api/v1` read is a different rate-limit
 * derivation rather than a smaller one), so a `performRequest` here would send a
 * call the server refuses.
 *
 * `cursor` is the server's OWN string, echoed back verbatim. A client that
 * parsed it would fork the keyset encoding the web already publishes in a URL.
 */
export function fetchAdoptionCatalogue(
  session: SessionPort,
  query: { cursor?: string | null; species?: string | null; province?: string | null } = {},
): Promise<ApiResult<AdoptionCatalogueV1>> {
  const params = new URLSearchParams();
  if (query.species) params.set("species", query.species);
  if (query.province) params.set("province", query.province);
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size === 0 ? "" : `?${params.toString()}`;
  return apiRequest<AdoptionCatalogueV1>(
    {
      path: `/api/v1/adoptions${suffix}`,
      expectedPayloadVersion: ADOPTION_CATALOGUE_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `GET /adoptions/{petToken}` — one ficha.
 *
 * ITS ANSWER HAS FOUR SHAPES AND ONLY ONE IS A 404. `detail.state` is `listed`,
 * `recently_adopted` or `paused`; a caller that treated the last two as errors
 * would tell somebody who followed a shared link that the animal never existed,
 * which is the exact case those states were added for.
 *
 * `canApply` AND `applyBlockedReason` ARE THE SERVER'S ANSWER AND MUST NOT BE
 * RECOMPUTED. Both refusals need state this app does not hold — the account's
 * type, and whether an unresolved application already exists for this pet — so a
 * screen that derived either would draw a form the write throws away.
 */
export function fetchAdoptionDetail(
  session: SessionPort,
  petToken: string,
): Promise<ApiResult<AdoptionDetailV1>> {
  return apiRequest<AdoptionDetailV1>(
    {
      path: `/api/v1/adoptions/${encodeURIComponent(petToken)}`,
      expectedPayloadVersion: ADOPTION_DETAIL_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /adoptions/{petToken}` — postularse.
 *
 * THE ONE WRITE ON THIS SURFACE THAT LANDS IN SOMEBODY ELSE'S QUEUE. Every other
 * write here changes the caller's own records, their animal's, or an exposure
 * they control; this one appends a letter about the caller to a shelter's review
 * list and notifies its members. It is also the only write whose per-user ceiling
 * lives in the use-case rather than in a route, so the web form and this call
 * spend ONE budget — see `adoption-application-limits.ts`.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * The server refuses a second unresolved application for the same (pet,
 * applicant) pair on its own, so a retry after a timeout that in fact landed
 * comes back as a refusal rather than a duplicate letter. That is a stronger
 * promise than a key buys; sending a header the server would ignore is a client
 * believing it holds a guarantee nobody made.
 *
 * A 409 `adoption_application_refused` COVERS EVERY DOMAIN REFUSAL and a caller
 * cannot tell them apart — which is why the screen re-reads the ficha rather
 * than guessing: `applyBlockedReason` is where "you already applied" is said.
 */
export function submitAdoptionApplication(
  session: SessionPort,
  petToken: string,
  input: AdoptionApplicationInput,
): Promise<ApiResult<AdoptionApplicationSubmittedV1>> {
  return apiRequest<AdoptionApplicationSubmittedV1>(
    {
      path: `/api/v1/adoptions/${encodeURIComponent(petToken)}`,
      method: "POST",
      body: input,
    },
    session,
  );
}

/**
 * `GET /me/adoption-applications` — THE FOURTH READ ON THIS SURFACE THAT IS NOT
 * ABOUT A PET THIS PERSON HOLDS.
 *
 * A postulación is a thing a PERSON did, to somebody else's animal, so there is
 * no token that would name the read — the same reason `/me/transfers` and
 * `/me/notifications` hang off `/me`.
 *
 * IT CARRIES NOTHING ABOUT ANYBODY ELSE (D17): no count of other applications
 * for the same pet, no names, no queue position. A screen must not invent one
 * from the status either — "En revisión" says what the shelter is doing, not
 * where the reader sits in a line.
 */
export function fetchMyAdoptionApplications(
  session: SessionPort,
): Promise<ApiResult<MyAdoptionApplicationsV1>> {
  return apiRequest<MyAdoptionApplicationsV1>(
    {
      path: "/api/v1/me/adoption-applications",
      expectedPayloadVersion: MY_ADOPTION_APPLICATIONS_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /welfare-reports` — DENUNCIAR MALTRATO. Ley 14.346.
 *
 * THE ONLY CALL ON THIS SURFACE THAT IS NOT ABOUT AN ANIMAL SOMEBODY HOLDS, and
 * not about an animal at all in the ordinary case: a denuncia names a place, a
 * situation and an animal nobody has registered. It is also the only one whose
 * whole point is that the RECORD may not name the person making it.
 *
 * THE PATH HAS NO `/me`, and that is not tidiness. `/me/…` asserts that what it
 * writes belongs to the caller, and an anonymous denuncia deliberately does not:
 * `reporter_user_id` is null and the case names no opener. A URL that said
 * otherwise would be a URL contradicting its own body.
 *
 * TWO COMMANDS, AND THE FIRST ONE EXISTS BECAUSE THIS APP HAS NO MAP.
 * `resolve_location` hands the server a typed address and gets candidate points
 * back — the server calls the same geocoder the web's address field calls. `file`
 * then sends coordinates the PERSON picked from that list. Do not skip the first
 * step and invent a point: the intake requires an exact one because the authority
 * routes on it, and a coordinate this app made up would send an inspector to the
 * wrong street.
 *
 * ANONYMOUS IS A `contactMode`, AND IT IS NOT THE SAME AS UNTRACEABLE. The bearer
 * token identifies this caller to the server before the body is read; what
 * `contactMode: "anonymous"` buys is that nothing is WRITTEN DOWN — not the row,
 * not the case, not the log, not the response. A person who needs the stronger
 * property files from a browser with no session, and the screen tells them so.
 *
 * NO ATTACHMENTS, AND DO NOT ADD ONE HERE. Evidence goes to a private bucket
 * behind a signed upload; this transport is JSON. There is a second reason
 * specific to this door: the web's denuncia form accepts HEIC, so an iPhone
 * photo carries the GPS EXIF of where it was taken — often an anonymous
 * reporter's own home. That leak is declared and deferred, it needs server-side
 * transcoding, and a door that carries no bytes cannot widen it.
 *
 * WHAT COMES BACK IS A RECEIPT NUMBER, NOT A CASE. `DEN-XXXX-XXXX` opens
 * `/denuncias/codigo/{code}` in a browser, which confirms the denuncia exists,
 * shows the date, and offers to prove you are the denunciante. It is not a
 * credential: the reporter's own view lives behind a separate, expiring token
 * minted into an address already on the record.
 */
export function sendWelfareReportCommand(
  session: SessionPort,
  input: WelfareReportCommandInput,
): Promise<ApiResult<WelfareReportCommandAckV1>> {
  return apiRequest<WelfareReportCommandAckV1>(
    { path: "/api/v1/welfare-reports", method: "POST", body: input },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/move` — MUDANZA: this animal now lives somewhere else.
 *
 * THE WRITE WITH NO READ OF ITS OWN, and the absence is the contract rather
 * than a gap. What a mudanza form needs, it already has: `fetchOwnerPetDetail`
 * carries the animal's current jurisdiction (it is on the credential face) and
 * `searchLocalities` is the same public typeahead the alta form spends. A third
 * endpoint would be a route, a per-IP bucket and a payload version bought to
 * re-send two fields the caller is holding.
 *
 * IT IS A SEPARATE DOOR FROM `sendPetProfileCommand` BECAUSE THE SERVER SAYS SO.
 * Jurisdiction is FULL-LOCK on the editar path — `updatePetProfile` omits the
 * column from its `SET` — and the contract's `pet-profile-edit.ts` states that
 * an "editar" endpoint accepting it "would be a second, ungoverned door onto
 * legally load-bearing state". Legally load-bearing is literal: those columns
 * decide the animal's compliance cards, the PPP gate and which authority
 * answers for it.
 *
 * WHAT COMES BACK IS THE CANONICAL PAIR AND A CALLER MUST RENDER THAT ONE. The
 * destination is resolved against the INDEC catalog before it is stored, so
 * `provinceCode: "AR-R"` comes back as `"Río Negro"` and a locality picked by
 * name comes back in the catalog's spelling. Echoing the request would tell
 * somebody their animal is registered in a place that does not exist.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * The writer takes none. What it has instead is a REFUSAL: a replay finds the
 * animal already living at the destination and answers `move_same_locality`
 * (409), so a second identical POST cannot append a second `movement_recorded`.
 * That is a stronger promise than absorbing one — and it means a 409 after a
 * timeout may be this caller's own first attempt having landed. Re-read the pet
 * rather than re-sending.
 */
export function sendPetMoveCommand(
  session: SessionPort,
  publicToken: string,
  input: PetMoveCommandInput,
): Promise<ApiResult<PetMoveRecordedV1>> {
  return apiRequest<PetMoveRecordedV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/move`,
      method: "POST",
      body: input,
    },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/return` — DEVOLUCIÓN: what may be done about this
 * animal going back, right now.
 *
 * THE ONE PET-SCOPED READ WHOSE ANSWER IS ABOUT SOMEBODY ELSE'S NEXT MOVE, and
 * that is why it exists rather than being derived from the pet payload. The
 * three writers behind this feature disagree about whom they serve, and none of
 * the disagreements is visible from anything else on the wire: accepting needs a
 * pending proposal ADDRESSED to the caller, proposing needs an organisation the
 * server derives from an `adoption_finalized` payload or an open custody row.
 *
 * `capabilities` IS THE SERVER'S AND MUST NOT BE RECOMPUTED, and `state.kind` is
 * NOT a substitute for it. The two answer different questions — what is going on
 * versus what this caller may do about it — and the arm that separates them is
 * `awaiting_org`: the caller's OWN outgoing proposal, which looks pending and
 * offers nothing. The web's page derives its buttons from the state alone and
 * gets exactly that case wrong, drawing an "Aceptar" its own writer refuses.
 *
 * THE STALENESS WINDOW IS TEN SECONDS, the shortest on this surface, because the
 * subject is a proposal another person can cancel or supersede at any moment
 * while the animal is physically in their house.
 */
export function fetchPetReturn(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetReturnV1>> {
  return apiRequest<PetReturnV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/return`,
      expectedPayloadVersion: PET_RETURN_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/return` — run one of the three devolución commands.
 *
 * THE SECOND WRITE ON THIS SURFACE THAT CAN CHANGE WHO HOLDS AN ANIMAL, and
 * unlike `sendTransferCommand` it can do it in the direction of ENDING somebody
 * else's custody: `accept_return` closes the actor's `ownerships` row, appends
 * `custody_transferred` and `status_changed`, moves `pets.status` back to
 * `active` and closes two cases — one transaction, four tables.
 *
 * A 200 ON `accept_return` DOES NOT MEAN THE ANIMAL CAME BACK. Read
 * `ack.autoCancelled`: the writer has a success arm in which the proposal's
 * preconditions no longer held — the proposer lost custody, or the animal is no
 * longer `lost` — and it then CANCELS instead of transferring, notifies the
 * proposer and reports success. `ack.reason` is the server's own sentence saying
 * which precondition failed, and it is the one place on this surface where a
 * sentence crosses the wire on purpose.
 *
 * NO `idempotencyKey` PARAMETER, AND THAT IS THE CONTRACT AND NOT A SHORTCUT.
 * None of the three writers takes a `clientIdempotencyKey`. What they have is
 * different and stronger: each takes `pg_advisory_xact_lock` on the pet and
 * re-reads the pending proposal UNDER the lock, so a replay is REFUSED rather
 * than absorbed — `return_no_proposal` for the two answers,
 * `return_already_pending` for the proposal. After a timeout a refusal may mean
 * this caller's own first attempt landed OR that the other side moved first, so
 * the move is always to re-read, never to re-send.
 */
export function sendPetReturnCommand(
  session: SessionPort,
  publicToken: string,
  input: PetReturnCommandInput,
): Promise<ApiResult<PetReturnCommandAckV1>> {
  return apiRequest<PetReturnCommandAckV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/return`,
      method: "POST",
      body: input,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/reminders` — VACUNAS: schedule a vaccine reminder,
 * or cancel one.
 *
 * THE OTHER HALF OF A CAPABILITY THIS APP COULD ONLY READ. `fetchOwnerPetDetail`
 * has carried `OwnerPetRemindersSection` since the face was built; nothing here
 * could act on it. Both commands reach the IDENTICAL use-cases the web's two
 * actions reach (`createVaccineReminder`, `deleteVaccineReminder`), so a phone
 * and a browser scheduling the same booster agree on what counts as a duplicate.
 *
 * NO READ OF ITS OWN, like `sendPetMoveCommand`: the list is on the face
 * already, and a second GET would be a route and a per-IP bucket bought to
 * re-send it. A screen that wants the list after a write re-reads the pet.
 *
 * NEITHER COMMAND TAKES AN `idempotencyKey`, and each is safe to replay for
 * its own reason. `create_vaccine_reminder` is absorbed by the writer's own
 * guard (same vaccine + same due date → the SAME `reminderId` back, no second
 * row). `cancel_vaccine_reminder` is idempotent on the STATE: a reminder that
 * is already gone answers 200 with `changed: false` — a SUCCESS a caller must
 * render as one, never as "no hay recordatorio que cancelar".
 */
export function sendVaccineReminderCommand(
  session: SessionPort,
  publicToken: string,
  input: VaccineReminderCommandInput,
): Promise<ApiResult<VaccineReminderCommandAckV1>> {
  return apiRequest<VaccineReminderCommandAckV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/reminders`,
      method: "POST",
      body: input,
    },
    session,
  );
}

/**
 * `GET /pets/{publicToken}/rehome` — ACOMPAÑAMIENTO DE ADOPCIÓN: where the
 * titular's arrangement stands, the orgs they may ask, and what they may do.
 *
 * THE OTHER HALF OF A BANNER THIS APP COULD ONLY READ. The face has said "hay
 * una propuesta pendiente con X" / "X está buscándole un nuevo hogar" since it
 * was built; this read is what a screen that can ACT on it needs — the same
 * three states the web's `buscar-hogar` page derives from the spine, plus the
 * picker's list and the server's three capability flags.
 *
 * A 403 `rehome_forbidden` IS THE ORDINARY ANSWER FOR ANYBODY BUT THE LEGAL
 * OWNER — a co-owner included, which is narrower than every other pet-scoped
 * read here. The face's `canSeeAdoptionSupport` gate never sends them, so a
 * refusal reaching a screen means a stale gate, and the sentence says whose the
 * decision is.
 */
export function fetchPetRehome(
  session: SessionPort,
  publicToken: string,
): Promise<ApiResult<PetRehomeV1>> {
  return apiRequest<PetRehomeV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/rehome`,
      expectedPayloadVersion: PET_REHOME_PAYLOAD_VERSION,
    },
    session,
  );
}

/**
 * `POST /pets/{publicToken}/rehome` — pedir un acompañamiento, cancelar el
 * pedido, o dar de baja el acompañamiento.
 *
 * THE THIRD WRITE ON THIS SURFACE THAT CAN CHANGE WHO HOLDS AN ANIMAL:
 * `withdraw_sponsorship` ENDS the org's custody row, clears the public listing
 * and closes every application on it — one transaction, signed by the titular.
 * `request_sponsorship` puts a consent case in a shelter's inbox; `withdraw_request`
 * closes it. All three reach the web's own use-cases.
 *
 * `idempotencyKey` IS NULLABLE, AND THE SPLIT IS THE CONTRACT'S. The two
 * withdraws REQUIRE it and honour it: each one's success invalidates its own
 * precondition, so the server keeps the key on the closing fact and a retry
 * that lost its response answers `replayed: true` — a success a caller renders
 * as done, never as "no hay nada que dar de baja". The ask takes none; its
 * replay answers `rehome_already_open`, and the move is to re-read. See
 * `@dim/contract/input`'s `rehome.ts`.
 */
export function sendRehomeCommand(
  session: SessionPort,
  publicToken: string,
  input: RehomeCommandInput,
  idempotencyKey: string | null,
): Promise<ApiResult<RehomeCommandAckV1>> {
  return apiRequest<RehomeCommandAckV1>(
    {
      path: `/api/v1/pets/${encodeURIComponent(publicToken)}/rehome`,
      method: "POST",
      body: input,
      headers: idempotencyKey === null ? undefined : { "idempotency-key": idempotencyKey },
    },
    session,
  );
}
