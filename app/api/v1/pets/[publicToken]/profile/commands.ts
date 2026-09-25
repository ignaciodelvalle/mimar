// The three commands behind `POST /api/v1/pets/{publicToken}/profile`.
//
// Split out of `route.ts` the way lost mode and compartir split theirs: that
// file asks "is this request well formed", this one asks "may this command run,
// and what exactly does it do".
//
// WHO MAY RUN EACH ONE — VERIFIED AGAINST THE WEB, AND NOT ONE RULE
// ---------------------------------------------------------------------------
// The three booleans are derived in `./payload.ts` and used by BOTH the read and
// this file, so a screen can never be offered a control this file refuses. The
// rules themselves are cited by SYMBOL and not by line — a line number in a
// comment is a fact about a file's length and rots on the next edit above it:
//
//   editar identidad   `updatePetAction`                src/modules/pets/actions.ts
//                      `EditPetPage`                    …/[publicToken]/editar/page.tsx
//   contactos          `updateEmergencyContactsForPet`  …/profile/update-emergency-contacts.ts
//   corregir especie   `correctPetSpeciesAction`        src/modules/pets/actions.ts
//                      `CorrectSpeciesPage`             …/[publicToken]/corregir-especie/page.tsx
//   perro de asistencia `upsertServiceDogAction` and its three siblings
//                      app/actions/service-dog.ts
//                      `AsistenciaPage`                 …/[publicToken]/asistencia/page.tsx
//
// THE SPECIES CORRECTION CLOSES `unjoined:correctPetSpeciesAction` in
// `scripts/check-owner-surface-parity.ts`: the web action used to run its
// transaction inline, with no application module for a second door to reach,
// so the fence could not even join on it. `correctPetSpecies` is that module
// now, and this file calls the IDENTICAL use-case the web action calls — the
// join the fence makes — rather than a parallel implementation.
//
// and the second is NOT a narrowing this endpoint invented: the writer's own
// `ownerships` join says `role = 'owner'`, so it refuses a co-owner, a foster
// and the whole org path by itself. This file checks it FIRST anyway, and the
// duplication is deliberate belt-and-braces: checked here the refusal carries a
// 403 a client can switch on, checked there it is true regardless of which door
// called. Without the first check the writer's refusal arrives as `NOT_FOUND`,
// which would tell a foster their animal does not exist.
//
// WHAT THE SERVER DECIDES AND THE CLIENT MAY NOT
// ---------------------------------------------------------------------------
//   · THE SPECIES AND THE JURISDICTION, on the IDENTITY edit. Neither is a
//     field of that request, and `updatePetProfile` omits both columns from its
//     `SET` (FULL-LOCK, PO decision #40). The 2026-08-14 adversarial finding on
//     `updatePetAction` was that a crafted `species=cat` POST passed the BREED
//     GATE against the wrong catalog while the column itself stayed locked;
//     here there is no species field on that command to craft — every gate in
//     `editIdentity` is fed `access.pet.species`, the persisted value. The
//     species moves ONLY through `correct_species`, its own governed command.
//   · THE BREED, canonically. `resolveBreedForWrite` folds and aliases against
//     the persisted species' catalog and refuses anything else, with one
//     exception it grants on purpose: the animal's CURRENT stored breed passes
//     unchanged even when off-catalog (QA A5), so a legacy value survives a name
//     correction instead of being wiped by a picker that never offered it.
//   · THE PPP FLAG. Re-resolved on every write against the animal's own
//     jurisdiction, from the persisted species and the resolved breed. It is
//     legally load-bearing (Ley CABA 4078 / Ley Prov 14.107) and no request
//     field reaches it.
//   · WHETHER ANYTHING CHANGED, and therefore whether the spine gets an event.
//
// NO `Idempotency-Key`, AND THAT IS A CONTRACT RATHER THAN AN OMISSION. All
// three commands are idempotent on the STATE: an identity edit is a value, so
// sending it twice is sending it once, the second one short-circuits before the
// transaction opens (`updatePet`'s `isNoOp`) and appends nothing; a species
// correction whose success invalidates its own precondition (the animal now IS
// the species asked for) answers the replay as `changed: false` before any I/O
// (`correctPetSpecies`' own rule). Requiring a header no writer honours would be
// this endpoint promising a guarantee it does not have — the refusal
// `events/writers.ts` makes for atestación PPP.

import { db } from "@/db";
import { resolveBreedForWrite } from "@/lib/domain/breed-validation";
import { apiV1Error, apiV1Json } from "@/lib/infra/api-v1";
import { DbBudgetExceededError, withDbBudgetOrThrow } from "@/lib/infra/db-budget";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import {
  OWNER_AUTHORSHIP,
  type PetHolderAccess,
  resolvePetHolderAccess,
} from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { resolvePppClassificationForJurisdiction } from "@/lib/infra/ppp-classification";
import { reportError } from "@/lib/infra/report-error";
import { togglePhysicalTagInterest } from "@/src/modules/pets/application/physical-tag-interest/toggle-physical-tag-interest";
import { correctPetSpecies } from "@/src/modules/pets/application/profile/correct-species";
import { updateEmergencyContactsForPet } from "@/src/modules/pets/application/profile/update-emergency-contacts";
import { retireServiceDog } from "@/src/modules/pets/application/service-dog/retire-service-dog";
import { setServiceDogVisibility } from "@/src/modules/pets/application/service-dog/set-service-dog-visibility";
import { submitServiceDogVerificationRequest } from "@/src/modules/pets/application/service-dog/submit-verification-request";
import { upsertServiceDog } from "@/src/modules/pets/application/service-dog/upsert-service-dog";
import { updatePet } from "@/src/modules/pets/application/update-pet";
import { diffPet } from "@/src/modules/pets/domain/pet-diff";
import { composePetIdentityEdit } from "@/src/modules/pets/domain/pet-identity-edit";
import type { NewNotification } from "@/src/modules/pets/domain/types";
import { PetsRepository } from "@/src/modules/pets/infrastructure/pets-repository";
import type { PetProfileEditAckV1 } from "@dim/contract/api";
import { type PetProfileCommandInput, resolvePetIdentityLengths } from "@dim/contract/input";

import { type ResolvedProfileAccess, petProfileCapabilities } from "./payload";

/**
 * The pre-write reads: the access query, the canonical-chip probe, the PPP rule.
 *
 * The WRITES are deliberately outside any budget, for the reason lost mode
 * records: `withDbBudgetOrThrow` races a promise against a timer and rejects,
 * which does not abort a Postgres transaction. Wrapping the write would produce
 * a 503 for a transaction that then COMMITS — the client sees failure, the
 * ledger has the event, and the two disagree forever.
 */
const RESOLVE_BUDGET_MS = 8_000;

const UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** The 503 this endpoint answers for every degraded pre-write read. */
export function unavailable() {
  return apiV1Error("temporarily_unavailable", 503, {
    "retry-after": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
  });
}

export type CommandContext = {
  publicToken: string;
  userId: string;
  input: PetProfileCommandInput;
};

/** Everything from the access guard to the command. */
export async function runPetProfileCommand(ctx: CommandContext) {
  let access: PetHolderAccess;
  try {
    access = await withDbBudgetOrThrow(
      resolvePetHolderAccess(ctx.publicToken, ctx.userId),
      RESOLVE_BUDGET_MS,
      "api-v1-profile-access",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // A pet this caller may not touch and a pet that does not exist answer
  // IDENTICALLY, as every other endpoint on this surface does.
  if (access.kind === "none") return apiV1Error("not_found", 404);

  const capabilities = petProfileCapabilities(access);

  if (ctx.input.command === "edit_identity") {
    if (!capabilities.canEditIdentity) return apiV1Error("profile_forbidden", 403);
    return editIdentity(ctx, access, ctx.input);
  }

  if (ctx.input.command === "correct_species") {
    if (!capabilities.canCorrectSpecies) return apiV1Error("profile_forbidden", 403);
    return correctSpecies(ctx, access, ctx.input);
  }

  if (ctx.input.command === "toggle_physical_tag_interest") {
    if (!capabilities.canTogglePhysicalTagInterest) return apiV1Error("profile_forbidden", 403);
    return runToggle(ctx, access);
  }

  if (
    ctx.input.command === "save_service_dog" ||
    ctx.input.command === "request_service_dog_verification" ||
    ctx.input.command === "set_service_dog_visibility" ||
    ctx.input.command === "retire_service_dog"
  ) {
    if (!capabilities.canManageServiceDog) return apiV1Error("profile_forbidden", 403);
    return runServiceDogCommand(ctx, ctx.input);
  }

  if (!capabilities.canEditEmergencyContacts) return apiV1Error("profile_forbidden", 403);
  return setEmergencyContacts(ctx, access, ctx.input);
}

/**
 * D2 — TOGGLE PHYSICAL-TAG INTEREST, through the web's own use-case verbatim.
 *
 * `togglePhysicalTagInterest` is the IDENTICAL function
 * `togglePhysicalTagInterestAction` calls (`app/actions/physical-tag-interest.ts`)
 * — this is the join `check-owner-surface-parity.ts` makes, and calling it
 * unchanged is what closes that fence's `write:togglePhysicalTagInterestAction→
 * togglePhysicalTagInterest` entry rather than moving the divergence one file
 * over. It takes no input beyond the two ids: the toggle's direction (interested
 * → cancelled → interested) is a fact the existing row holds, never something a
 * client states, which is why the contract's `toggle_physical_tag_interest`
 * command carries no fields.
 *
 * NO SEPARATE FAILURE CODE IS MAPPED. The use-case's `{ error }` arm exists in
 * its type for the SHIM's own guard failures (the message this door already
 * answers with `profile_forbidden` above) — reading the function itself, it
 * never returns that arm on its own; an insert or an update failing is the same
 * infrastructure failure `event_failed`-style codes on sibling commands answer.
 */
async function runToggle(ctx: CommandContext, access: ResolvedProfileAccess) {
  const result = await togglePhysicalTagInterest(ctx.userId, access.pet.id, ctx.publicToken);
  if ("error" in result) {
    reportError("api-v1-profile/toggle_physical_tag_interest", new Error(result.error), {
      userId: ctx.userId,
    });
    return apiV1Error("profile_failed", 500);
  }
  return ack({ command: "toggle_physical_tag_interest", state: result.state });
}

type ServiceDogCommandInput = Extract<
  PetProfileCommandInput,
  {
    command:
      | "save_service_dog"
      | "request_service_dog_verification"
      | "set_service_dog_visibility"
      | "retire_service_dog";
  }
>;

/**
 * D3 — THE SERVICE-DOG DESIGNATION, through the web's four owner use-cases
 * verbatim (`app/actions/service-dog.ts`: `upsertServiceDogAction`,
 * `submitServiceDogVerificationRequestAction`, `setServiceDogVisibilityAction`,
 * `retireServiceDogAction`). Each of those is `requireUserOrRedirect` + the
 * use-case; this door's `requireLiveUser` is the first half and
 * `canManageServiceDog` a stricter restatement of what the second half checks
 * again on its own (`loadOwnedPetWithServiceDog`, `role = 'owner'`).
 * `revokeServiceDogCredentialAction` is admin/govt and is not reachable here.
 *
 * ONE CODE FOR EVERY DOMAIN REFUSAL — `service_dog_refused`, 409 — on the bar
 * `adoption_application_refused` set: the use-cases answer es-AR PROSE ("El
 * perro ya está retirado del servicio.", "Ya tenés una solicitud pendiente…"),
 * written for the web form's inline error, and a route that mapped sentences
 * onto codes would be parsing copy. The sentence is not forwarded either. Two
 * of those `{ error }` arms are infrastructure failures the use-case caught
 * itself (the upsert's and the request's own `try`), and they arrive under the
 * same code — the client's instruction for both is the same: re-read, try
 * again. A THROWN failure (the visibility and retire writes have no `try`) is
 * `profile_failed`, 500.
 *
 * NO `Idempotency-Key`: the upsert and the visibility are values; a replayed
 * retire meets "ya está retirado" and a replayed request meets the use-case's
 * own duplicate-pending refusal, so neither can double-append.
 */
async function runServiceDogCommand(ctx: CommandContext, input: ServiceDogCommandInput) {
  const petPublicToken = ctx.publicToken;
  let result: { ok: true } | { approvalRequestPublicToken: string } | { error: string };
  try {
    switch (input.command) {
      case "save_service_dog":
        // THE FIELDS THE WEB FORM POSTS, and not `publicVisibility` — see the
        // contract's `saveServiceDog`: on the web an upsert keeps the stored
        // visibility, and so does this.
        result = await upsertServiceDog(ctx.userId, {
          petPublicToken,
          serviceType: input.serviceType,
          trainingCenter: input.trainingCenter,
          trainingCertDate: input.trainingCertDate,
          rupgaCredential: input.rupgaCredential,
          credentialIssueDate: input.credentialIssueDate,
          credentialExpiryDate: input.credentialExpiryDate,
          notes: input.notes,
        });
        break;
      case "request_service_dog_verification":
        result = await submitServiceDogVerificationRequest(ctx.userId, { petPublicToken });
        break;
      case "set_service_dog_visibility":
        result = await setServiceDogVisibility(ctx.userId, {
          petPublicToken,
          publicVisibility: input.publicVisibility,
        });
        break;
      case "retire_service_dog":
        result = await retireServiceDog(ctx.userId, { petPublicToken });
        break;
    }
  } catch (err) {
    reportError(`api-v1-profile/${input.command}`, err, { userId: ctx.userId });
    return apiV1Error("profile_failed", 500);
  }

  if ("error" in result) return apiV1Error("service_dog_refused", 409);
  if (input.command === "request_service_dog_verification") {
    if (!("approvalRequestPublicToken" in result)) return apiV1Error("profile_failed", 500);
    return ack({
      command: "request_service_dog_verification",
      approvalRequestPublicToken: result.approvalRequestPublicToken,
    });
  }
  return ack({ command: input.command });
}

/**
 * CORREGIR ESPECIE — the FULL-LOCK path, through the web's own use-case.
 *
 * Everything a correction drags along — the `pet_profile_updated` it appends,
 * the breed it clears when the new species' catalog does not carry it, the PPP
 * flag it re-resolves — is decided inside `correctPetSpecies`, and this door
 * hands it the same PPP resolver the cookie door hands it. `changed: false` is
 * the use-case's own replay answer: the animal already IS this species, nothing
 * was written, and a retry that lost its response reads the same as the first.
 */
async function correctSpecies(
  ctx: CommandContext,
  access: ResolvedProfileAccess,
  input: Extract<PetProfileCommandInput, { command: "correct_species" }>,
) {
  const result = await correctPetSpecies(
    {
      pet: access.pet,
      newSpecies: input.species,
      actor: {
        userId: ctx.userId,
        // The bearer door stamps what the cookie door stamps — see `editIdentity`.
        eventAuthorship: access.kind === "owner" ? OWNER_AUTHORSHIP : access.eventAuthorship,
      },
    },
    {
      repo: PetsRepository,
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
      resolvePpp: resolvePppClassificationForJurisdiction,
    },
  );

  if (!result.ok) {
    // `species_invalid` cannot reach here through the schema (`z.enum` over the
    // same list); it is answered anyway, as the request's fault, because a
    // use-case rule the wire cannot see must not fall through to a 500.
    if (result.code === "species_invalid") return apiV1Error("invalid_request", 400);
    reportError("api-v1-profile/correct_species", result.error);
    return apiV1Error("profile_failed", 500);
  }

  return ack({ command: "correct_species", changed: result.changed });
}

/**
 * EDITAR IDENTIDAD — name, breed and colour, through the web's own use-case.
 *
 * `composePetIdentityEdit` is why this can reuse `updatePet` at all: the
 * repository writes seventeen columns from `parsed` unconditionally, so a
 * three-field request has to be laid over the animal's current state before it
 * goes anywhere near the writer. Its own header says what that prevents.
 */
async function editIdentity(
  ctx: CommandContext,
  access: ResolvedProfileAccess,
  input: Extract<PetProfileCommandInput, { command: "edit_identity" }>,
) {
  const pet = access.pet;

  // The catalog gate, against the PERSISTED species and with the stored breed
  // grandfathered. See the header.
  const breedResolution = resolveBreedForWrite(pet.species, input.breed, {
    storedBreed: pet.breed,
  });
  if (!breedResolution.ok) return apiV1Error("profile_breed_invalid", 400);

  // THE LENGTH GATE, and it is HERE rather than on the schema for the same
  // reason the breed gate is: both need the animal's current row. `pets.name`
  // and `pets.color` are `text` and the web's parser caps neither, so an
  // over-long value ALREADY EXISTS on some animals — and a cap applied to it on
  // the way back out would refuse the whole request, colour correction included,
  // leaving the owner unable to edit their own record from the phone. Only NEW
  // values are gated; what the animal already carries passes at any length.
  //
  // `invalid_request` and not a code of its own: the client holds the same
  // payload this compares against and says so per field before posting, so
  // reaching here means a client out of step with the contract — the case the
  // route's own schema backstop already answers with one key and no field
  // detail.
  const lengths = resolvePetIdentityLengths(
    { name: input.name, color: input.color },
    { name: pet.name, color: pet.color },
  );
  if (!lengths.ok) return apiV1Error("invalid_request", 400);

  const parsed = composePetIdentityEdit(pet, {
    name: input.name,
    breed: breedResolution.breed,
    color: input.color,
  });

  let existingCanonicalIds: Awaited<ReturnType<typeof fetchActiveIdentifications>>;
  let potentiallyDangerousBreed: boolean;
  try {
    existingCanonicalIds = await withDbBudgetOrThrow(
      fetchActiveIdentifications(pet.id),
      RESOLVE_BUDGET_MS,
      "api-v1-profile-chip",
    );
    potentiallyDangerousBreed = await withDbBudgetOrThrow(
      resolvePppClassificationForJurisdiction(
        pet.species,
        parsed.breed,
        parseEstimatedWeightKg(pet.estimatedWeightKg),
        {
          country: "AR",
          province: pet.jurisdictionProvince,
          locality: pet.jurisdictionLocality,
        },
      ),
      RESOLVE_BUDGET_MS,
      "api-v1-profile-ppp",
    );
  } catch (err) {
    if (err instanceof DbBudgetExceededError) return unavailable();
    throw err;
  }

  // `changed` is decided by the SAME pure diff `updatePet` uses to decide
  // whether to open a transaction at all. Recomputing it here rather than
  // reading a flag off the result is the honest shape available today: the
  // use-case answers `{ ok: true, notifications: [] }` for a no-op and for a
  // real write alike, and an ack that said `true` for both would tell a person
  // their correction landed when the writer had already decided it was the same
  // value. The other three inputs to `isNoOp` are CONSTANTS on this door — there
  // is no photo, `emergencyInfoVisible` is carried over unchanged by the
  // composer, and `microchipId` is null so no chip can be newly added — so an
  // empty diff is exactly the no-op condition and nothing wider.
  const changed = diffPet(pet, parsed, potentiallyDangerousBreed).length > 0;

  const result = await updatePet(
    {
      petId: pet.id,
      parsed,
      potentiallyDangerousBreed,
      uploadedPath: null,
      uploadMimeType: null,
      uploadSize: null,
    },
    {
      repo: PetsRepository,
      actor: {
        user: { id: ctx.userId },
        accessPath: access.kind === "owner" ? "owner" : "org",
        // The bearer door stamps what the cookie door stamps. `OWNER_AUTHORSHIP`
        // is exported precisely so a native write cannot re-declare it and end
        // up signed `authorVerified: true` by accident; the org path carries the
        // authorship the resolver computed from the member's own matrícula.
        eventAuthorship: access.kind === "owner" ? OWNER_AUTHORSHIP : access.eventAuthorship,
        existingPet: pet,
        existingCanonicalIds: { hasMicrochip: existingCanonicalIds.microchip !== null },
      },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
    },
  );

  if (!result.ok) {
    // The use-case's message is es-AR prose written for a form. It is NOT
    // echoed: this surface answers with a code from the contract's vocabulary
    // and nothing else, so a client cannot come to depend on a sentence.
    reportError("api-v1-profile/edit_identity", result.error);
    return apiV1Error("profile_failed", 500);
  }

  // REACHABLE, not defensive. `updatePet` queues exactly one notification — the
  // PPP registration reminder — and only when the animal BECAME potentially
  // dangerous, which needs a breed change. This door edits the breed, so the
  // transition is reachable from it and the flush is real work.
  await flushNotifications(result.notifications, new Date().toISOString().slice(0, 10));

  return ack({ command: "edit_identity", changed });
}

/**
 * CONTACTOS DE EMERGENCIA — the pet-level override, through the web's writer.
 *
 * The use-case is called UNCHANGED, its own ownership re-check included. It is
 * the one place the `role = 'owner'` rule is written down, and calling it rather
 * than re-deriving the join is the whole reason this endpoint can claim parity.
 */
async function setEmergencyContacts(
  ctx: CommandContext,
  access: ResolvedProfileAccess,
  input: Extract<PetProfileCommandInput, { command: "set_emergency_contacts" }>,
) {
  const pet = access.pet;

  // `changed` compares the row the ACCESS GUARD already read against what the
  // writer is about to store, normalised the same way its own `toColumn` does
  // (blank ⇒ null). A second read after the write would be a query to learn
  // something already known, and would race a concurrent editor into an answer
  // about somebody else's change.
  const changed =
    cleared(input.preferredVetName) !== pet.preferredVetName ||
    cleared(input.preferredVetPhone) !== pet.preferredVetPhone ||
    cleared(input.emergencyContactName) !== pet.emergencyContactName ||
    cleared(input.emergencyContactPhone) !== pet.emergencyContactPhone;

  const result = await updateEmergencyContactsForPet(ctx.userId, ctx.publicToken, {
    preferredVetName: input.preferredVetName,
    preferredVetPhone: input.preferredVetPhone,
    emergencyContactName: input.emergencyContactName,
    emergencyContactPhone: input.emergencyContactPhone,
  });

  if ("error" in result) {
    // NOT_FOUND here means the ownership row moved between the guard and the
    // write — a transfer that completed mid-request. It answers 404 like every
    // other "you may not see this" on the surface rather than 500: nothing
    // failed, the caller simply stopped being the owner.
    if (result.error === "NOT_FOUND") return apiV1Error("not_found", 404);
    if (result.error.startsWith("VALIDATION_ERROR")) return apiV1Error("invalid_request", 400);
    reportError("api-v1-profile/set_emergency_contacts", result.error);
    return apiV1Error("profile_failed", 500);
  }

  return ack({ command: "set_emergency_contacts", changed });
}

/** "" (or whitespace) is a CLEARED override — the writer's own `toColumn`. */
function cleared(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the domain layer's `estimatedWeightKg: string | null` into the
 * `number | null` the PPP resolver expects. NaN-guards a malformed string down
 * to null — the same helper `src/modules/pets/actions.ts` keeps for the cookie
 * door, and deliberately the same behaviour: a weight nobody can read is "no
 * weight data", never a throw in the middle of a write.
 */
function parseEstimatedWeightKg(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? null : n;
}

/**
 * Flush queued notifications post-tx, through the CANONICAL write path.
 *
 * NOT `db.insert(notifications)`, which is what the cookie door beside this one
 * still does. `src/modules/pets/actions.ts` predates
 * `lib/infra/notification-service.ts` and is carried in that fence's baseline;
 * copying it here would have grown the baseline by one, in NEW code, on the
 * exact migration the fence exists to finish. The service adds what the raw
 * insert has never had: idempotency (`ON CONFLICT (dedupe_key) DO NOTHING`) and
 * a dead letter, so a transient DB fault delays the notice instead of dropping
 * it silently.
 *
 * THE DEDUPE KEY IS DAY-SCOPED, and the granularity is a decision. The one
 * notification this path can queue is the PPP registration reminder, emitted
 * when an animal BECOMES potentially dangerous. Keyed on the pet and the owner
 * alone it would be permanent, so an animal that stopped being PPP and later
 * became so again would never re-notify — a legal obligation silently dropped.
 * Keyed with the day, a double-tap or a retry collapses (which is the whole
 * risk here) and a genuine re-transition tomorrow still speaks. Same shape and
 * same UTC `dayBucket` as the `vaccine_due` reminder in
 * `lib/infra/notifications.ts`, whose own comment spells out the property: a
 * later day is a new bucket, and two concurrent runs on one day collapse into
 * one row.
 *
 * `severity` is narrowed rather than cast: the pets module's own union carries
 * an `"error"` the service does not, and the one notification reachable from
 * this door is `"warning"`. Anything unexpected lands on `"warning"` too, which
 * is the honest floor for a notice about a legal obligation.
 */
async function flushNotifications(pending: NewNotification[], dayBucket: string): Promise<void> {
  if (pending.length === 0) return;
  try {
    await createNotificationsBulk(
      pending.map((n) => ({
        userId: n.userId,
        notificationType: n.notificationType,
        title: n.title,
        body: n.body,
        severity: n.severity === "error" ? "warning" : n.severity,
        category: n.category ?? null,
        ctaLabel: n.ctaLabel ?? null,
        ctaUrl: n.ctaUrl ?? null,
        relatedPetId: n.relatedPetId ?? null,
        relatedEventId: n.relatedEventId ?? null,
        dedupeKey: `${n.notificationType}:${n.relatedPetId ?? "none"}:${n.userId}:${dayBucket}`,
      })),
    );
  } catch (err) {
    // `createNotificationsBulk` dead-letters rather than throwing, so reaching
    // here means the service itself broke. The primary write already committed
    // and must not be undone by a notice that did not send.
    reportError("api-v1-profile/notifications", err);
  }
}

function ack(body: PetProfileEditAckV1) {
  return apiV1Json(body, { status: 200 });
}
