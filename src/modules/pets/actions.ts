"use server";

// Thin action controllers for the pets domain.
//
// Each action does ONLY:
//   1. Auth guard (security boundary stays here — NOT in use-cases):
//      - createPetAction: requireLiveUser() (no pet exists yet, so there is no
//        pet-scoped guard to use — the liveness guard is the boundary)
//      - updatePetAction / recordMoveAction / correctPetSpeciesAction:
//        requireTitularAccess (pet must exist + ownership check + the holder is
//        NOT a caretaker — all three write titular-only fields: identity,
//        jurisdiction, species)
//   2. Parse formData → ParsedPet (via parsePetForm from domain layer)
//   3. Pre-tx I/O (request-edge concerns):
//      - Jurisdiction canonicalization
//      - Chip format validation + cross-check (redirect/warning stay here)
//      - Storage upload
//      - PPP evaluation
//   4. Build input DTO + call use-case
//   5. Handle Result<T> — on error, cleanup storage + return error state
//   6. Flush pendingNotifications post-tx, best-effort (catch+log)
//   7. redirect
//
// NO business logic beyond edge orchestration. NO direct pet row writes.

import { db, notifications } from "@/db";
import { resolveBreedForWrite } from "@/lib/domain/breed-validation";
import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import { validateMicrochipId } from "@/lib/domain/microchip-validation";
import { lookupByChip } from "@/lib/infra/chip-lookup";
import { requireLiveUser } from "@/lib/infra/live-user";
import { generateForceToken, validateForceToken } from "@/lib/infra/microchip-force-token";
import { findSameOwnerDuplicatePet } from "@/lib/infra/owner-pet-dedupe";
import {
  type SupabaseServerClient,
  requirePetAccess,
  requireTitularAccess,
} from "@/lib/infra/pet-access";
import { fetchActiveIdentifications } from "@/lib/infra/pet-identifiers";
import { resolvePppClassificationForJurisdiction } from "@/lib/infra/ppp-classification";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";

/**
 * Parses the domain layer's `estimatedWeightKg: string | null` into the
 * `number | null` resolvePppClassificationForJurisdiction expects.
 * NaN-guards a malformed string down to null (treated as "no weight data",
 * same as omitted — never throws).
 */
function parseEstimatedWeightKg(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? null : n;
}

import { recordPostAdoptionCheckin } from "./application/checkin/record-post-adoption-checkin";
import type { CheckinFormState } from "./application/checkin/types";
import { recordChipDisputeAgainstActivePet } from "./application/chip-match/record-chip-dispute";
import { recordMovementWriter } from "./application/movement/record-movement";
import { correctPetSpecies } from "./application/profile/correct-species";
import { registerPet } from "./application/register-pet";
import { updatePet } from "./application/update-pet";
import { parsePetForm } from "./domain/pet-form";
import type { NewNotification, NewPetFormState } from "./domain/types";
import { PetsRepository } from "./infrastructure/pets-repository";

// Duplicate-chip gate (data-quality gate P3). A microchip is a globally-unique
// identity: if it already exists in miMAR, the pet exists — the owner must
// claim it or request a transfer, not register a second credential for it.
// Points at the claim wizard (/mis-mascotas/reclamar), which also opens a
// custody dispute when the chip is registered to someone else.
const CHIP_ALREADY_REGISTERED_MSG =
  "Este microchip ya figura registrado en miMAR para otra mascota. Si es tuya, vinculala a tu cuenta o pedí la transferencia desde “Mis mascotas › Reclamar una mascota”.";

// Re-export for consumers that import the type from this module.
export type { NewPetFormState } from "./domain/types";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Flush notifications post-tx, best-effort. Never throws. */
async function flushNotifications(pending: NewNotification[]): Promise<void> {
  if (pending.length === 0) return;
  try {
    await db
      .insert(notifications)
      .values(pending as unknown as (typeof notifications.$inferInsert)[]);
    // Web Push leg (ADR 2026-07-18 §4): urgent-only, best-effort, never throws.
    const { sendPushForNotifications } = await import("@/lib/infra/web-push");
    await sendPushForNotifications(pending as unknown as (typeof notifications.$inferInsert)[]);
  } catch (e) {
    console.error("[pets/actions] notifications insert failed (action did succeed):", e);
  }
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

export async function createPetAction(
  _previous: NewPetFormState,
  formData: FormData,
): Promise<NewPetFormState> {
  const live = await requireLiveUser();
  // live.error, not a bespoke string: telling someone to log in again during a
  // maintenance window sends them round a loop that cannot succeed.
  if (!live.ok) return { error: live.error };
  // The guard hands back the SAME client it authenticated with — the photo
  // upload and its cleanup below need it, and building a second one would open
  // a second session for the same request.
  const { user, supabase } = live;

  const parseResult = parsePetForm(formData);
  if (parseResult.error !== null) {
    const msg =
      parseResult.error === "LOCALITY_REQUIRED"
        ? "Seleccioná la localidad antes de continuar."
        : parseResult.error === "LOCALITY_UNRESOLVED"
          ? "Elegí la localidad/barrio de la lista de sugerencias."
          : parseResult.error;
    return { error: msg };
  }
  // Safe: parseResult.error === null implies parsed is non-null (discriminated union).
  const parsed = parseResult.parsed as NonNullable<typeof parseResult.parsed>;

  // Breed catalog gate (QA A4): the form's control only SUGGESTS; the server
  // decides. Resolve to the canonical catalog label (folding + aliases) or
  // reject — a misspelled PPP breed must not escape the legal regime.
  const breedResolution = resolveBreedForWrite(parsed.species, parsed.breed);
  if (!breedResolution.ok) return { error: breedResolution.error };
  parsed.breed = breedResolution.breed;

  // Jurisdiction canonicalization (pre-tx, request-edge I/O).
  // locality:"strict" — resolveCanonicalJurisdiction (createPet behavior unchanged).
  if (parsed.jurisdictionProvince && parsed.jurisdictionLocality) {
    try {
      const normalizedLoc = await normalizeLocationForWrite(
        {
          province: parsed.jurisdictionProvince,
          provinceCode: null,
          locality: parsed.jurisdictionLocality,
          // The row the picker wrote into the form. Passing null here — which
          // this call did until L2-8 — made the web alta settle a (province,
          // locality) homonym alphabetically, while the bearer registration and
          // the mudanza, which both send the id, settled it correctly: two doors
          // onto `pets.locality_id` disagreeing about the same animal.
          localityIndecId: parsed.localityIndecId ?? null,
          lat: null,
          lng: null,
          address: null,
        },
        { locality: "strict" },
      );
      parsed.jurisdictionProvince = normalizedLoc.province;
      parsed.jurisdictionLocality = normalizedLoc.locality;
      // Structural locality-attribution FK (migration 0147) — threaded into the
      // pets insert via the RegisterPet use-case.
      parsed.localityId = normalizedLoc.localityId;
    } catch (err) {
      if (err instanceof JurisdictionValidationError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  // Data-quality gate P2 — soft same-owner dedupe. BEFORE any insert (and before
  // the photo upload, so a bounced submit leaves no orphan storage object): if
  // the caller already has an ACTIVE owned pet matching on normalized name +
  // species + sex, surface a non-blocking "¿es la misma?" prompt. The owner can
  // open the existing pet or resubmit with duplicateOverride=1 to create anyway.
  const duplicateOverride = String(formData.get("duplicateOverride") ?? "").trim() === "1";
  if (!duplicateOverride) {
    const dup = await findSameOwnerDuplicatePet({
      ownerUserId: user.id,
      name: parsed.name,
      species: parsed.species,
      sex: parsed.sex,
      // A2-alta-asentar-04, the web half. Same defect, one form earlier: a
      // resubmit carrying the SAME hidden key (a reload after a slow POST that
      // did commit) met this scan before the use-case's replay guard and was
      // shown "¿es la misma?" about the pet the form had just created.
      excludeClientIdempotencyKey:
        String(formData.get("clientIdempotencyKey") ?? "").trim() || null,
    });
    if (dup) {
      return {
        error: null,
        duplicatePrompt: {
          name: dup.name,
          species: dup.species,
          sex: dup.sex,
          publicToken: dup.publicToken,
        },
      };
    }
  }

  // Chip format validation (ISO 11784/11785, 15 digits).
  if (parsed.microchipId) {
    const chipValidation = validateMicrochipId(parsed.microchipId);
    if (!chipValidation.ok) {
      return { error: "INVALID_MICROCHIP_FORMAT" };
    }
    parsed.microchipId = chipValidation.normalized;
  }

  // Chip-conflict adjudication receipt (RA-2 F6) — checked BEFORE either chip
  // gate below, because both of them would otherwise dead-end an actor who has
  // already answered the question they ask.
  //
  // A valid forceToken means: this actor was shown the conflicting record and
  // said "no es la misma". It does NOT mean "insert the chip anyway" —
  // pet_identifications_chip_unique (migration 0056) is a partial UNIQUE on
  // code WHERE kind='microchip_iso' AND status='active', so a second active
  // claim on the same code cannot exist. The old `active`-branch comment
  // "Force token valid — fall through to insert" fell through WITH
  // parsed.microchipId still set, so the insert died on that index with an
  // opaque Postgres error.
  //
  // What the escape hatch actually promises is what the match card's own copy
  // says — "Si no es la misma, podés continuar con el registro de tu mascota":
  // register THIS animal. The disputed code stays with the record that already
  // holds it; the new pet is registered without a chip and its owner can add
  // the correct one afterwards.
  //
  // Hoisted above BOTH gates on purpose: scoping it to the found_stray branch
  // left the returning finder blocked by the P3 gate below the moment they
  // picked any other acquisition method.
  //
  // Redeeming one is itself a fact about the OTHER record, so the code is kept
  // here and written to that record's spine once the alta commits — see
  // recordChipDisputeAgainstActivePet below.
  let adjudicatedChipCode: string | null = null;
  if (parsed.microchipId) {
    const forceToken = String(formData.get("forceToken") ?? "").trim();
    if (forceToken && validateForceToken(parsed.microchipId, forceToken)) {
      adjudicatedChipCode = parsed.microchipId;
      parsed.microchipId = null;
      parsed.microchipCountryCode = null;
      parsed.microchipImplantedAt = null;
      parsed.microchipImplantedBy = null;
      parsed.microchipLocation = null;
    }
  }

  // Chip cross-check (found_stray + chip set) — request-edge: redirect stays here.
  if (parsed.acquisitionMethod === "found_stray" && parsed.microchipId) {
    const match = await lookupByChip(parsed.microchipId);
    if (match) {
      if (match.pet.status === "lost") {
        // N3: the form navigates. This is a MID-action branch, so the comment
        // that once sat here ("request-edge: redirect stays here") was the only
        // thing defending it — and it never said why this call would be immune
        // to a defect that hits every other one (X1-F3).
        //
        // The match page's "No es la misma" mints the adjudication receipt this
        // branch checks above, so the neighbour who finds a stray is no longer
        // bounced back to a form that can only send them here again.
        //
        // The code travels in the query string because it is the match page's
        // authorization: that page renders owner PII and its confirm action
        // adjudicates the chip, and both now demand proof the caller knows the
        // colliding code. It is this actor's own input going back to this
        // actor's own browser — no disclosure, and the same shape the return
        // leg already used.
        return {
          error: null,
          redirectTo: `/mis-mascotas/nueva/match/${match.pet.publicToken}?chip=${encodeURIComponent(parsed.microchipId)}`,
        };
      }

      if (match.pet.status === "active") {
        // Signed over caller input — which is safe here, and only here,
        // because lookupByChip just matched this exact string against the
        // canonical active identification: parsed.microchipId IS the matched
        // pet's chip. (The vecino writer reaches the same guarantee by
        // comparing before it signs.) A token is never minted for a code the
        // server has not first tied to a real record.
        return {
          error: null,
          warning: "CHIP_MATCH_ACTIVE",
          matchedPetToken: match.pet.publicToken,
          forceToken: generateForceToken(parsed.microchipId),
        };
      }

      if (match.pet.status === "deceased") {
        // Still a hard block, and deliberately NOT escapable. Two things
        // enforce that, neither of them the absence of a UI: the `active`
        // branch above is the only mint site reachable with a deceased pet's
        // code and it never fires for one, and the vecino writer refuses to
        // mint unless the matched pet is 'lost'. Before that status check the
        // claim here was false — naming a deceased pet's token to the confirm
        // action produced a perfectly valid receipt for its code.
        return {
          error:
            "Este chip está asociado a una mascota registrada como fallecida en miMAR. Pedile a un admin que revise el caso antes de continuar.",
        };
      }
    }
  }

  // Data-quality gate P3 — duplicate-chip block for NON-found_stray alta. The
  // found_stray path above owns its own reunification handling (lost → match
  // page, active → force-token warning). For every other acquisition method a
  // chip that already exists means the pet is already registered: block and
  // point the owner at the claim/transfer path instead of minting a second
  // credential for the same animal (the pet_identifications chip_unique index
  // would otherwise reject the insert with an opaque error).
  if (parsed.microchipId && parsed.acquisitionMethod !== "found_stray") {
    const match = await lookupByChip(parsed.microchipId);
    if (match) {
      return { error: CHIP_ALREADY_REGISTERED_MSG };
    }
  }

  const photoFile = formData.get("photo") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, photoFile, "pet-photos");
  if (upload.error) return { error: upload.error };

  const potentiallyDangerousBreed = await resolvePppClassificationForJurisdiction(
    parsed.species,
    parsed.breed,
    parseEstimatedWeightKg(parsed.estimatedWeightKg),
    {
      country: "AR",
      province: parsed.jurisdictionProvince,
      locality: parsed.jurisdictionLocality,
    },
  );

  // Double-submit idempotency guard (audit §6): stable UUID per form session,
  // posted by the alta wizard as a hidden field.
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  const result = await registerPet(
    {
      parsed,
      potentiallyDangerousBreed,
      uploadedPath: upload.uploadedPath,
      uploadMimeType: upload.mimeType,
      uploadSize: upload.size,
      clientIdempotencyKey,
    },
    {
      repo: PetsRepository,
      actor: { user },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
    },
  );

  if (!result.ok) {
    // Clean up uploaded photo on failure.
    if (upload.uploadedPath) {
      try {
        await supabase.storage.from("pet-photos").remove([upload.uploadedPath]);
      } catch {
        // Swallow.
      }
    }
    return { error: result.error };
  }

  const registered = result.value as NonNullable<typeof result.value>;

  // Double-submit detected: the first submit already created the pet. Remove the
  // photo this retry just uploaded (it would otherwise orphan in storage) and
  // resolve to the already-created pet's success surface — no second pet, no
  // duplicate notifications (registerPet queued none on the duplicate path).
  if (registered.wasDuplicate) {
    if (upload.uploadedPath) {
      try {
        await supabase.storage.from("pet-photos").remove([upload.uploadedPath]);
      } catch {
        // Swallow.
      }
    }
    return {
      error: null,
      redirectTo: `/mis-mascotas/nueva/${registered.publicToken}/credencial`,
    };
  }

  await flushNotifications(result.notifications);

  // The ACTIVE-match escape hatch used to leave no trace anywhere. Written
  // after the alta commits so the note describes something that happened.
  if (adjudicatedChipCode) {
    await recordChipDisputeAgainstActivePet({
      disputedChipCode: adjudicatedChipCode,
      actorUserId: user.id,
    });
  }

  const newPublicToken = registered.publicToken;
  // Onboarding aha: show the QR credential success screen (Item 13).
  // N3 contract: return redirectTo — MinimalNewPetForm navigates client-side
  // (production redirect() from server actions is dropped by Next 15.5 router).
  return {
    error: null,
    redirectTo: `/mis-mascotas/nueva/${newPublicToken}/credencial`,
  };
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

export async function updatePetAction(
  publicToken: string,
  _previous: NewPetFormState,
  formData: FormData,
): Promise<NewPetFormState> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { supabase, user, pet: existingPet, eventAuthorship, accessPath } = access;

  // ARCH-S: fetch canonical chip presence before the update so chipNewlyAdded
  // guard doesn't need the dropped pets.microchipId column.
  const existingCanonicalIds = await fetchActiveIdentifications(existingPet.id);

  const parseResult = parsePetForm(formData);
  if (parseResult.error !== null) {
    const msg =
      parseResult.error === "LOCALITY_REQUIRED"
        ? "Seleccioná la localidad antes de continuar."
        : parseResult.error === "LOCALITY_UNRESOLVED"
          ? "Elegí la localidad/barrio de la lista de sugerencias."
          : parseResult.error;
    return { error: msg };
  }
  // Safe: parseResult.error === null implies parsed is non-null (discriminated union).
  const parsed = parseResult.parsed as NonNullable<typeof parseResult.parsed>;

  // Breed catalog gate (QA A4) — same as createPetAction, with one exception:
  // re-submitting the pet's CURRENT stored breed unchanged is accepted even
  // when off-catalog (QA A5 — a legacy value must survive an unrelated edit;
  // the edit form appends it as its own <option> for exactly this reason).
  //
  // Validated against existingPet.species — the PERSISTED species, never the
  // submitted one. updatePetProfile never writes species (FULL-LOCK, PO
  // decision #40), so `parsed.species` here is attacker-controllable free
  // input with no corresponding write: a crafted species=cat&breed=Persa POST
  // used to pass the gate against the CAT catalog and persist a cross-species
  // breed onto a dog (adversarial review 2026-08-14).
  const breedResolution = resolveBreedForWrite(existingPet.species, parsed.breed, {
    storedBreed: existingPet.breed,
  });
  if (!breedResolution.ok) return { error: breedResolution.error };
  parsed.breed = breedResolution.breed;

  // Jurisdiction canonicalization (same posture as createPetAction).
  // locality:"strict" — resolveCanonicalJurisdiction (updatePet behavior unchanged).
  if (parsed.jurisdictionProvince && parsed.jurisdictionLocality) {
    try {
      const normalizedLoc = await normalizeLocationForWrite(
        {
          province: parsed.jurisdictionProvince,
          provinceCode: null,
          locality: parsed.jurisdictionLocality,
          localityIndecId: null,
          lat: null,
          lng: null,
          address: null,
        },
        { locality: "strict" },
      );
      parsed.jurisdictionProvince = normalizedLoc.province;
      parsed.jurisdictionLocality = normalizedLoc.locality;
    } catch (err) {
      if (err instanceof JurisdictionValidationError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  // Data-quality gate P3 — duplicate-chip block on the profile-edit path. When
  // the owner adds a chip that this pet did not have (existingCanonicalIds.microchip
  // === null) we normalize it and cross-check pet_identifications: a match on a
  // DIFFERENT pet means the chip is already registered elsewhere. Block with the
  // claim/transfer copy instead of letting the chip_unique index reject the
  // insert with an opaque error. Only normalizes on a valid ISO code — malformed
  // input keeps the pre-existing behavior (no new rejection path introduced here).
  if (parsed.microchipId && existingCanonicalIds.microchip === null) {
    const chipValidation = validateMicrochipId(parsed.microchipId);
    if (chipValidation.ok) {
      parsed.microchipId = chipValidation.normalized;
      const match = await lookupByChip(parsed.microchipId);
      if (match && match.pet.id !== existingPet.id) {
        return { error: CHIP_ALREADY_REGISTERED_MSG };
      }
    }
  }

  const photoFile = formData.get("photo") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, photoFile, "pet-photos");
  if (upload.error) return { error: upload.error };

  // PPP classified with the persisted species too (same reasoning as the
  // breed gate above): a species=cat POST with the unchanged PPP breed would
  // otherwise clear potentially_dangerous_breed on a real dog — legally
  // load-bearing state — while the species column itself stays locked.
  const potentiallyDangerousBreed = await resolvePppClassificationForJurisdiction(
    existingPet.species,
    parsed.breed,
    parseEstimatedWeightKg(parsed.estimatedWeightKg),
    {
      country: "AR",
      province: parsed.jurisdictionProvince,
      locality: parsed.jurisdictionLocality,
    },
  );

  const result = await updatePet(
    {
      petId: existingPet.id,
      parsed,
      potentiallyDangerousBreed,
      uploadedPath: upload.uploadedPath,
      uploadMimeType: upload.mimeType,
      uploadSize: upload.size,
    },
    {
      repo: PetsRepository,
      actor: {
        user,
        accessPath,
        eventAuthorship,
        existingPet,
        existingCanonicalIds: { hasMicrochip: existingCanonicalIds.microchip !== null },
      },
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
    },
  );

  if (!result.ok) {
    if (upload.uploadedPath) {
      try {
        await supabase.storage.from("pet-photos").remove([upload.uploadedPath]);
      } catch {
        // Swallow.
      }
    }
    return { error: result.error };
  }

  await flushNotifications(result.notifications);

  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// MOVE (FULL-LOCK jurisdiction path — PO decision #40)
// ---------------------------------------------------------------------------
//
// The profile-edit path no longer mutates jurisdiction. A locality change for an
// established pet flows through here, which is the ONLY owner-facing writer of
// movement_recorded / jurisdiction_changed. The destination is canonicalized
// strictly at the edge (friendly rejection on an off-catalog pair) and again,
// defensively, inside recordMovementWriter before the pets denormalization.

export async function recordMoveAction(
  publicToken: string,
  _previous: NewPetFormState,
  formData: FormData,
): Promise<NewPetFormState> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;

  const loc = parseLocationFromFormData(formData);
  const rawProvince = loc.provinceCode ?? "";
  const rawLocality = loc.locality ?? "";
  if (!rawLocality) return { error: "Seleccioná la localidad de destino." };

  // Strict canonicalization at the edge — reject an off-catalog destination
  // with a user-facing message before it ever reaches the writer.
  let toProvince: string | null;
  let toLocality: string | null;
  // The catalogue ROW the strict resolve landed on. Threaded to the writer so
  // the id the form sent decides `pets.locality_id` instead of being discarded
  // and re-guessed from the name — see RecordMovementParams.resolvedLocalityId
  // (L2-2). Same fix as the bearer door's, because both doors had the same gap.
  let toLocalityId: string | null;
  try {
    const normalized = await normalizeLocationForWrite(
      {
        province: rawProvince,
        provinceCode: rawProvince,
        locality: rawLocality,
        localityIndecId: loc.localityIndecId,
        lat: null,
        lng: null,
        address: null,
      },
      { locality: "strict" },
    );
    toProvince = normalized.province;
    toLocality = normalized.locality;
    toLocalityId = normalized.localityId;
  } catch (err) {
    if (err instanceof JurisdictionValidationError) return { error: err.message };
    throw err;
  }

  const result = await recordMovementWriter({
    pet: { id: pet.id, publicToken: pet.publicToken },
    recordedByUserId: user.id,
    eventAuthorship,
    occurredAt: new Date(),
    movement: {
      sub_kind: "jurisdiction_changed",
      from_country: pet.jurisdictionCountry ?? "AR",
      from_province: pet.jurisdictionProvince,
      from_locality: pet.jurisdictionLocality,
      // The row the animal is leaving (L2-3) — with `to_locality_id`, stamped
      // by the writer, it is what lets a correction between two same-named
      // localities of one province be told from a no-op.
      from_locality_id: pet.localityId,
      to_country: "AR",
      to_province: toProvince,
      to_locality: toLocality,
      effective_date: new Date().toISOString().slice(0, 10),
      reason: String(formData.get("reason") ?? "").trim() || null,
    },
    notes: null,
    resolvedLocalityId: toLocalityId,
  });

  if (!result.ok) {
    // The schema rejects a no-op move (destination === origin) — surface it.
    return {
      error:
        result.error.includes("no-op") || result.error.includes("differ")
          ? "El destino es igual a la localidad actual."
          : `No se pudo registrar el movimiento: ${result.error}`,
    };
  }

  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// CORRECT SPECIES (FULL-LOCK species path — PO decision #40)
// ---------------------------------------------------------------------------
//
// Species is locked on the profile-edit path (it drives PPP/compliance). A
// genuine correction flows here, through `correctPetSpecies` — the SAME
// use-case `POST /api/v1/pets/{token}/profile` reaches with `correct_species`
// (the join scripts/check-owner-surface-parity.ts makes). The event, the breed
// clearing and the PPP recomputation all live there; this door parses the form,
// guards, and puts the use-case's answer into this form's own sentences.

export async function correctPetSpeciesAction(
  publicToken: string,
  _previous: NewPetFormState,
  formData: FormData,
): Promise<NewPetFormState> {
  const access = await requireTitularAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;

  const result = await correctPetSpecies(
    {
      pet,
      newSpecies: String(formData.get("species") ?? ""),
      actor: { userId: user.id, eventAuthorship },
    },
    {
      repo: PetsRepository,
      transaction: async <T>(cb: (tx: unknown) => Promise<T>) =>
        db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>,
      resolvePpp: resolvePppClassificationForJurisdiction,
    },
  );

  if (!result.ok) {
    return {
      error:
        result.code === "species_invalid"
          ? "Elegí una especie válida."
          : `No se pudo corregir la especie: ${result.error}`,
    };
  }
  // The use-case reports a same-species correction as a success that wrote
  // nothing (the replay rule — see its header); THIS form still tells the
  // person there was nothing to correct, exactly as it always has.
  if (!result.changed) {
    return { error: "La especie es la misma; no hay nada que corregir." };
  }

  // N3: return the destination; the form navigates (useActionRedirect).
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// POST-ADOPTION CHECK-IN (strangler migration 33/61)
// ---------------------------------------------------------------------------
//
// The web door of the check-in. Moved here from app/actions/checkin.ts on
// 2026-09-09, the same day the use-case stopped taking the FormData: the rules
// went to ./application/checkin/ but the adapter plumbing stayed inline in the
// app/actions file and blew its line budget. What lives here is exactly what a
// browser form needs and JSON does not — the access guard at the cookie door,
// the field parsing, the location canonicalisation, the attachment upload and
// its rollback — which is this file's stated job (header, steps 1-5). Every
// RULE runs inside `recordPostAdoptionCheckin`, once, for this door and for
// `POST /api/v1/pets/{token}/events` alike.

async function removeEventAttachment(supabase: SupabaseServerClient, path: string | null) {
  if (!path) return;
  try {
    await supabase.storage.from("event-attachments").remove([path]);
  } catch {
    // Swallow — orphaned file at worst.
  }
}

export async function recordPostAdoptionCheckinAction(
  publicToken: string,
  _previous: CheckinFormState,
  formData: FormData,
): Promise<CheckinFormState> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };

  // Check-in is owner-self only. Org-mediated access (refugios cohabiting
  // post-adoption) can READ the resulting event but not WRITE it. The
  // use-case refuses an org member anyway — an organization is never the
  // adopter — but this door says so in its own sentence, before any upload.
  if (access.accessPath !== "owner") {
    return { error: "Solo el adoptante puede registrar un check-in." };
  }
  const { supabase, user, pet } = access;

  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  // Per-event L1 (sprint 4 PR-034). Optional.
  // Canonicalize the ISO provinceCode (e.g. "AR-C") to the display name ("CABA")
  // that every other jurisdiction_province write stores. Without this, the raw
  // ISO code landed in the JSONB payload and govt-dashboard aggregation that
  // filters on display names silently missed check-in events.
  // locality:"none" — canonicalize province only, no catalog lookup.
  const loc = parseLocationFromFormData(formData);
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "none" });
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  try {
    const result = await recordPostAdoptionCheckin({
      pet: { id: pet.id, name: pet.name },
      user: { id: user.id },
      notes,
      eventJurisdictionProvince: normalizedLoc.province,
      eventJurisdictionLocality: normalizedLoc.locality,
      clientIdempotencyKey,
      uploadedPath: upload.uploadedPath,
      uploadedMimeType: upload.mimeType,
      uploadedSize: upload.size,
    });
    if (!result.ok) {
      // A refused or failed write leaves no row for the file to hang off.
      await removeEventAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
  } catch (err) {
    await removeEventAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar el check-in: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // Nav contract N3: RETURN the destination; the form navigates (useActionRedirect).
  // Land on the LIBRETA tab, not the credential face: the freshly created
  // "Seguimiento post-adopción" asiento at the top — now rendering the
  // adopter's own text — IS the confirmation. The bare profile redirect gave
  // no visible sign anything happened (9-role external run, 2026-08-18).
  return { error: null, redirectTo: `/mis-mascotas/${publicToken}?tab=libreta` };
}
