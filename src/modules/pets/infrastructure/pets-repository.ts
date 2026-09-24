// PetsRepository — thin Drizzle wrapper for pet domain writes.
// Accepts optional `tx` for use inside db.transaction() calls,
// mirroring the existing AdoptionRepository and openCase(input, tx) pattern.
// Returns domain shapes (not raw Drizzle row types).
// No auth logic — auth lives at the action edge.

import { and, eq, sql } from "drizzle-orm";

import { attachments, type db, ownerships, petEvents, petIdentifications, pets } from "@/db";
import { chipImplantSiteFromLocation } from "@/lib/domain/microchip-implant-site";
import { validateEventPayload } from "@/lib/events/event-schemas";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { generateUniqueToken } from "@/lib/infra/unique-token";
import { parseDateInput } from "@/lib/utils/format";
import type { DiffEntry } from "@/src/modules/pets/domain/pet-diff";
import {
  custodyKindToOwnershipRole,
  custodyKindToRegisteredPayloadKind,
} from "@/src/modules/pets/domain/pet-rules";
import type { ParsedPet } from "@/src/modules/pets/domain/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AuthorRole = "owner" | "scanner" | "finder" | "vet" | "shelter" | "govt" | "system";

type EventAuthorship = {
  authorRole: AuthorRole;
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

type InsertPetRegisteredArgs = {
  publicToken: string;
  parsed: ParsedPet;
  potentiallyDangerousBreed: boolean;
  uploadedPath: string | null;
  uploadMimeType: string | null;
  uploadSize: number | null;
  userId: string;
  now: Date;
  /**
   * Idempotency guard — anchored on the pet_registered event (audit §6).
   * Optional at the repo boundary (defaults to NULL) so pre-existing callers /
   * tests need not thread it; the use-case (registerPet) always supplies it.
   */
  clientIdempotencyKey?: string | null;
};

type UpdatePetProfileArgs = {
  petId: string;
  parsed: ParsedPet;
  potentiallyDangerousBreed: boolean;
  changes: DiffEntry[];
  hasContentChanges: boolean;
  flagChanged: boolean;
  chipNewlyAdded: boolean;
  uploadedPath: string | null;
  uploadMimeType: string | null;
  uploadSize: number | null;
  userId: string;
  eventAuthorship: EventAuthorship;
  now: Date;
};

type CorrectSpeciesArgs = {
  petId: string;
  oldSpecies: string;
  newSpecies: string;
  /** Stored breed before the correction (for the event's change entry). */
  oldBreed: string | null;
  /**
   * Breed after the correction — null when the stored breed does not resolve
   * within the NEW species' catalog (actions.ts clears it in the same write;
   * otherwise the grandfather rule preserves a cross-species label forever).
   * Pass the stored breed unchanged when it survives the correction.
   */
  newBreed: string | null;
  /** Recomputed PPP flag for the corrected species (a non-dog clears PPP). */
  potentiallyDangerousBreed: boolean;
  userId: string;
  eventAuthorship: EventAuthorship;
  now: Date;
};

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const PetsRepository = {
  /**
   * Generates a unique public token for a new pet (DIM-XXXX-XXXX format).
   * Uses the same advisory-check + retry pattern as the original createPetAction.
   */
  async generatePublicToken(): Promise<string> {
    return generateUniqueToken(pets, pets.publicToken, generatePublicToken);
  },

  /**
   * Double-submit idempotency lookup for the owner alta (audit §6). Must be
   * called inside the same db.transaction() as insertPetRegistered.
   *
   * Mirrors the intake writer (create-intake.ts): takes a session-stable
   * advisory lock on the key so concurrent same-key submits serialize, then
   * looks for a pet_registered event already anchored on that key. A hit means
   * a prior submit already created the pet — the caller must NOT insert again.
   *
   * NOTE: the partial unique index pet_events_idempotency_idx is keyed on
   * (pet_id, event_type, client_idempotency_key); for a brand-new pet the
   * pet_id differs on every attempt, so the index cannot serialize alta
   * double-submits on its own. The advisory lock + this SELECT is the actual
   * guard (the index remains a same-pet backstop, as in the replace flow).
   *
   * SCOPED TO THE OWNER, and it was not (fixed 2026-08-25, WU-B review FB-3).
   * The predicate used to be (event_type, client_idempotency_key) and nothing
   * else — a key is GLOBAL in that lookup, so two users presenting the same key
   * means the second one silently receives the FIRST one's publicToken with a
   * 201 and no pet of their own. Under random UUIDv4 the collision probability
   * is negligible; it is not negligible under any DETERMINISTIC key derivation,
   * and this repo already does that elsewhere (`deriveBulkIdempotencyKey`). A
   * client that derives its key from the form contents — an obvious thing for a
   * native app to do so a retry after a crash reuses the key — hands two
   * neighbours registering a cat named Michi the same string.
   *
   * The advisory lock is narrowed the same way, so two users are no longer
   * serialized against each other for holding the same key. Narrowing it is
   * safe precisely because the lookup narrowed too: what has to be atomic is
   * the (owner, key) pair, which is now exactly what is locked.
   */
  async findDuplicateRegistration(
    clientIdempotencyKey: string,
    ownerUserId: string,
    tx: Tx,
  ): Promise<{ publicToken: string; name: string } | null> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${ownerUserId} || ':' || ${clientIdempotencyKey}))`,
    );
    const [existing] = await tx
      .select({ publicToken: pets.publicToken, name: pets.name })
      .from(petEvents)
      .innerJoin(pets, eq(pets.id, petEvents.petId))
      .where(
        and(
          eq(petEvents.eventType, "pet_registered"),
          eq(petEvents.clientIdempotencyKey, clientIdempotencyKey),
          // `recorded_by_user_id` is set to the registering user by
          // insertPetRegistered below, so it is the same identity the caller
          // presents — not a projection that could lag.
          eq(petEvents.recordedByUserId, ownerUserId),
        ),
      )
      .limit(1);
    return existing ?? null;
  },

  /**
   * Composite atomic write for registering a new pet.
   * Must be called inside a db.transaction().
   *
   * Handles:
   *   - pets row insert
   *   - ownerships row (role depends on custodyKind)
   *   - optional attachment + primaryPhotoId update
   *   - pet_registered event (explicit snake_case payload)
   *   - if chip: microchip_implanted event + petIdentifications double-write
   */
  async insertPetRegistered(
    args: InsertPetRegisteredArgs,
    tx: Tx,
  ): Promise<{ petId: string; eventId: string }> {
    const {
      publicToken,
      parsed,
      potentiallyDangerousBreed,
      uploadedPath,
      uploadMimeType,
      uploadSize,
      userId,
      now,
      clientIdempotencyKey,
    } = args;

    // Insert pet row. Legacy chip/tattoo columns (microchipId, microchipCountryCode,
    // microchipImplantedAt, microchipImplantedBy, microchipLocation) omitted —
    // ARCH-R removes these writes; canonical rows go to pet_identifications below.
    const [newPet] = await tx
      .insert(pets)
      .values({
        publicToken,
        name: parsed.name,
        species: parsed.species,
        sex: parsed.sex,
        breed: parsed.breed,
        dateOfBirth: parsed.dateOfBirth,
        birthDateIsEstimated: parsed.birthDateIsEstimated,
        color: parsed.color,
        estimatedWeightKg: parsed.estimatedWeightKg,
        favouriteFoods: parsed.favouriteFoods.length > 0 ? parsed.favouriteFoods : null,
        knownAllergies: parsed.knownAllergies.length > 0 ? parsed.knownAllergies : null,
        trainingLevel: parsed.trainingLevel,
        potentiallyDangerousBreed,
        insuranceCompany: parsed.insuranceCompany,
        insurancePolicyNumber: parsed.insurancePolicyNumber,
        jurisdictionProvince: parsed.jurisdictionProvince,
        jurisdictionLocality: parsed.jurisdictionLocality,
        localityId: parsed.localityId ?? null,
        acquisitionMethod: parsed.acquisitionMethod,
        emergencyInfoVisible: parsed.emergencyInfoVisible,
        permanentConditions: parsed.permanentConditions,
        permanentConditionsOther: parsed.permanentConditionsOther,
        discloseConditionsPublicly: parsed.discloseConditionsPublicly,
      })
      .returning();

    // Ownership row — custodyKind drives the role.
    const ownershipRole = custodyKindToOwnershipRole(parsed.custodyKind);
    await tx.insert(ownerships).values({
      petId: newPet.id,
      ownerUserId: userId,
      role: ownershipRole,
      startedAt: now,
    });

    // Optional photo attachment + primaryPhotoId update.
    if (uploadedPath) {
      const [attachment] = await tx
        .insert(attachments)
        .values({
          petId: newPet.id,
          uploadedByUserId: userId,
          storagePath: uploadedPath,
          mimeType: uploadMimeType ?? "image/jpeg",
          fileSize: uploadSize ?? 0,
        })
        .returning();
      await tx.update(pets).set({ primaryPhotoId: attachment.id }).where(eq(pets.id, newPet.id));
    }

    // pet_registered event — explicit snake_case payload (no spread of ParsedPet).
    const petRegisteredPayload = validateEventPayload("pet_registered", {
      name: parsed.name,
      species: parsed.species,
      sex: parsed.sex,
      breed: parsed.breed,
      date_of_birth: parsed.dateOfBirth,
      birth_date_is_estimated: parsed.birthDateIsEstimated,
      color: parsed.color,
      microchip_id: parsed.microchipId,
      microchip_country_code: parsed.microchipCountryCode,
      microchip_implanted_at: parsed.microchipImplantedAt,
      microchip_implanted_by: parsed.microchipImplantedBy,
      microchip_location: parsed.microchipLocation,
      estimated_weight_kg: parsed.estimatedWeightKg,
      favourite_foods: parsed.favouriteFoods,
      known_allergies: parsed.knownAllergies,
      training_level: parsed.trainingLevel,
      insurance_company: parsed.insuranceCompany,
      insurance_policy_number: parsed.insurancePolicyNumber,
      jurisdiction_province: parsed.jurisdictionProvince,
      jurisdiction_locality: parsed.jurisdictionLocality,
      // The catalogue ROW behind those two names, so the spine can reproduce
      // `pets.locality_id` instead of re-resolving a homonym by name (L2-3).
      jurisdiction_locality_id: parsed.localityId ?? null,
      potentially_dangerous_breed: potentiallyDangerousBreed,
      acquisition_method: parsed.acquisitionMethod,
      has_photo: uploadedPath !== null,
      has_microchip: parsed.microchipId !== null,
      custody_kind: custodyKindToRegisteredPayloadKind(parsed.custodyKind),
    });

    const [registeredEvent] = await tx
      .insert(petEvents)
      .values({
        petId: newPet.id,
        eventType: "pet_registered",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        payload: petRegisteredPayload,
        // Anchors the double-submit idempotency guard (audit §6). NULL for any
        // caller that does not supply a key (unaffected by the partial index).
        clientIdempotencyKey: clientIdempotencyKey ?? null,
      })
      .returning();

    // Microchip: emit event + petIdentifications double-write.
    if (parsed.microchipId) {
      const microchipEventPayload = validateEventPayload("microchip_implanted", {
        chip_number: parsed.microchipId,
        country_code: parsed.microchipCountryCode,
        implanted_by: parsed.microchipImplantedBy,
        location_on_body: parsed.microchipLocation,
        implant_date_known: !!parsed.microchipImplantedAt,
      });

      await tx.insert(petEvents).values({
        petId: newPet.id,
        eventType: "microchip_implanted",
        occurredAt: parseDateInput(parsed.microchipImplantedAt) ?? now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: "owner",
        payload: microchipEventPayload,
      });

      // Double-write to pet_identifications (compliance PR 0, parity with original).
      const chipImplantSite = chipImplantSiteFromLocation(parsed.microchipLocation);
      await tx.insert(petIdentifications).values({
        petId: newPet.id,
        kind: "microchip_iso",
        code: parsed.microchipId,
        recordedAt: (parsed.microchipImplantedAt ?? now.toISOString().slice(0, 10)) as string,
        recordedByUserId: userId,
        isoCountryCode: parsed.microchipId.slice(0, 3),
        isoManufacturerCode: parsed.microchipId.slice(3, 7),
        isoNationalId: parsed.microchipId.slice(7, 15),
        isoCompliant: true,
        implantationSite: chipImplantSite as string | undefined,
      });
    }

    return { petId: newPet.id, eventId: registeredEvent.id };
  },

  /**
   * Composite atomic write for updating a pet profile.
   * Must be called inside a db.transaction().
   *
   * Handles:
   *   - pets row update (always — even for flag-only changes)
   *   - optional attachment + primaryPhotoId second update
   *   - pet_profile_updated event ONLY when hasContentChanges=true
   *   - microchip_implanted event when chipNewlyAdded=true
   *
   * NOTE: Does NOT insert petIdentifications on update chipNewlyAdded path.
   * This matches the current behavior of app/actions/pets.ts exactly (parity).
   */
  async updatePetProfile(args: UpdatePetProfileArgs, tx: Tx): Promise<{ eventId: string | null }> {
    const {
      petId,
      parsed,
      potentiallyDangerousBreed,
      changes,
      hasContentChanges,
      chipNewlyAdded,
      uploadedPath,
      uploadMimeType,
      uploadSize,
      userId,
      eventAuthorship,
      now,
    } = args;

    // Always update the pet row (covers flag-only and content changes).
    // Legacy chip columns (microchipId, microchipCountryCode, microchipImplantedAt,
    // microchipImplantedBy, microchipLocation) omitted — ARCH-R; canonical rows
    // are managed via pet_identifications (see chipNewlyAdded block below).
    //
    // FULL-LOCK (PO decision #40, review 14 items 5/6): `species`,
    // `jurisdictionProvince`, and `jurisdictionLocality` are intentionally NOT in
    // this SET. The profile-edit path can never mutate them — even for a crafted
    // request. Jurisdiction moves route exclusively through recordMovementWriter
    // (movement_recorded / jurisdiction_changed); species corrections route
    // through PetsRepository.correctSpecies below. Both emit an event first.
    await tx
      .update(pets)
      .set({
        name: parsed.name,
        sex: parsed.sex,
        breed: parsed.breed,
        dateOfBirth: parsed.dateOfBirth,
        birthDateIsEstimated: parsed.birthDateIsEstimated,
        color: parsed.color,
        estimatedWeightKg: parsed.estimatedWeightKg,
        favouriteFoods: parsed.favouriteFoods.length > 0 ? parsed.favouriteFoods : null,
        knownAllergies: parsed.knownAllergies.length > 0 ? parsed.knownAllergies : null,
        trainingLevel: parsed.trainingLevel,
        potentiallyDangerousBreed,
        insuranceCompany: parsed.insuranceCompany,
        insurancePolicyNumber: parsed.insurancePolicyNumber,
        acquisitionMethod: parsed.acquisitionMethod,
        emergencyInfoVisible: parsed.emergencyInfoVisible,
        permanentConditions: parsed.permanentConditions,
        permanentConditionsOther: parsed.permanentConditionsOther,
        discloseConditionsPublicly: parsed.discloseConditionsPublicly,
        updatedAt: now,
      })
      .where(eq(pets.id, petId));

    // Optional photo attachment + second primaryPhotoId update.
    if (uploadedPath) {
      const [attachment] = await tx
        .insert(attachments)
        .values({
          petId,
          uploadedByUserId: userId,
          storagePath: uploadedPath,
          mimeType: uploadMimeType ?? "image/jpeg",
          fileSize: uploadSize ?? 0,
        })
        .returning();
      await tx.update(pets).set({ primaryPhotoId: attachment.id }).where(eq(pets.id, petId));
    }

    let eventId: string | null = null;

    // Emit pet_profile_updated ONLY for content changes (not flag-only).
    if (hasContentChanges) {
      const petProfileUpdatedPayload = validateEventPayload("pet_profile_updated", {
        changes,
        photo_replaced: uploadedPath !== null,
      });

      const [updateEvent] = await tx
        .insert(petEvents)
        .values({
          petId,
          eventType: "pet_profile_updated",
          occurredAt: now,
          recordedAt: now,
          recordedByUserId: userId,
          authorRole: eventAuthorship.authorRole,
          authorOrganizationId: eventAuthorship.authorOrganizationId,
          authorVerified: eventAuthorship.authorVerified,
          payload: petProfileUpdatedPayload,
        })
        .returning();

      eventId = updateEvent.id;
    }

    // Emit microchip_implanted when chip was newly added.
    if (chipNewlyAdded && parsed.microchipId) {
      const microchipEventPayload = validateEventPayload("microchip_implanted", {
        chip_number: parsed.microchipId,
        country_code: parsed.microchipCountryCode,
        implanted_by: parsed.microchipImplantedBy,
        location_on_body: parsed.microchipLocation,
        implant_date_known: !!parsed.microchipImplantedAt,
      });

      await tx.insert(petEvents).values({
        petId,
        eventType: "microchip_implanted",
        occurredAt: parseDateInput(parsed.microchipImplantedAt) ?? now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: eventAuthorship.authorRole,
        authorOrganizationId: eventAuthorship.authorOrganizationId,
        authorVerified: eventAuthorship.authorVerified,
        payload: microchipEventPayload,
      });

      // Canonical dual-write — insert active microchip row in pet_identifications.
      // Only when the chip was newly added (chipNewlyAdded guard already asserts
      // no prior chip existed on this pet).
      const chipCode = parsed.microchipId;
      const chipImplantSite = chipImplantSiteFromLocation(parsed.microchipLocation);
      await tx.insert(petIdentifications).values({
        petId,
        kind: "microchip_iso",
        code: chipCode,
        recordedAt: (parsed.microchipImplantedAt ?? now.toISOString().slice(0, 10)) as string,
        recordedByUserId: userId,
        recordedByLabel: parsed.microchipImplantedBy,
        isoCountryCode: chipCode.slice(0, 3),
        isoManufacturerCode: chipCode.slice(3, 7),
        isoNationalId: chipCode.slice(7, 15),
        isoCompliant: true,
        implantationSite: chipImplantSite as string | undefined,
      });
    }

    return { eventId };
  },

  /**
   * Event-governed species correction (FULL-LOCK path, PO decision #40).
   * Species is locked on the profile-edit path; a genuine correction (e.g. a
   * cat registered as a dog) flows here. Must be called inside a
   * db.transaction().
   *
   * Write order mirrors recordMovementWriter: the immutable fact (a
   * pet_profile_updated event carrying the single species change) is inserted
   * FIRST, then the pets.species denormalization + recomputed PPP flag. This
   * keeps an audit trail and prevents a species change with no corresponding
   * event (the same divergence class the movement writer guards against).
   */
  async correctSpecies(args: CorrectSpeciesArgs, tx: Tx): Promise<{ eventId: string }> {
    const {
      petId,
      oldSpecies,
      newSpecies,
      oldBreed,
      newBreed,
      potentiallyDangerousBreed,
      userId,
      eventAuthorship,
      now,
    } = args;

    // A species correction can also flip the derived PPP classification (a dog
    // corrected to a cat clears it; a cat corrected to a PPP-breed dog sets it).
    // The pets.potentiallyDangerousBreed column is dual-written below, so the
    // event MUST carry that change too — otherwise the correction is not fully
    // event-derivable and the flag flip has no corresponding fact (Invariant #3
    // / event-pairing). Read the prior flag inside the tx (before the update)
    // and include the change ONLY when it actually differs.
    const [currentRow] = await tx
      .select({ potentiallyDangerousBreed: pets.potentiallyDangerousBreed })
      .from(pets)
      .where(eq(pets.id, petId))
      .limit(1);
    const oldPpp = currentRow?.potentiallyDangerousBreed ?? false;

    const changes: Array<{ field: string; old: unknown; new: unknown }> = [
      { field: "species", old: oldSpecies, new: newSpecies },
    ];
    // A breed that does not survive the species correction (cleared by
    // actions.ts against the NEW species' catalog) is dual-written below, so
    // the event must carry that change too — same event-pairing reasoning as
    // the PPP flag.
    if (oldBreed !== newBreed) {
      changes.push({ field: "breed", old: oldBreed, new: newBreed });
    }
    if (oldPpp !== potentiallyDangerousBreed) {
      changes.push({
        field: "potentially_dangerous_breed",
        old: oldPpp,
        new: potentiallyDangerousBreed,
      });
    }

    const payload = validateEventPayload("pet_profile_updated", {
      changes,
      photo_replaced: false,
    });

    const [event] = await tx
      .insert(petEvents)
      .values({
        petId,
        eventType: "pet_profile_updated",
        occurredAt: now,
        recordedAt: now,
        recordedByUserId: userId,
        authorRole: eventAuthorship.authorRole,
        authorOrganizationId: eventAuthorship.authorOrganizationId,
        authorVerified: eventAuthorship.authorVerified,
        payload,
      })
      .returning();

    await tx
      .update(pets)
      .set({ species: newSpecies, breed: newBreed, potentiallyDangerousBreed, updatedAt: now })
      .where(eq(pets.id, petId));

    return { eventId: event.id };
  },
};
