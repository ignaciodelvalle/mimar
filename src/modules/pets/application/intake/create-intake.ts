// Use-case: createIntake — org-side intake (strangler migration 11/61).
//
// Org-side intake — a refugio or rescue org takes custody of an animal.
// Atomic write: new pet + ownership(role='shelter_custody', owner_org=…) +
// pet_registered event + shelter_intake_recorded event, all in one tx.
//
// Capability-gated on `intake.create`. The capability is enforced by the
// thin shim (app/actions/intake.ts); the use-case receives the authenticated
// context (user + organization) and runs the rest verbatim.
//
// Lost & Found Fase 2: if microchipId is provided, a cross-check is performed
// BEFORE inserting the new pet. Depending on the matched pet's status:
//   - lost    → redirect to match confirmation page (BLOCK)
//   - active  → return warning with forceToken; if forceToken is valid, proceed
//   - deceased → return error (BLOCK, admin review required)
//
// Lost & Found Fase 7: microchipId is validated against ISO 11784/11785 (15
// digits) before the cross-check so malformed chip strings never reach the DB.
//
// Tattoo match (D2): if tattooCode is provided, a cross-check is performed
// after the chip check. On a match, returns TATTOO_MATCH_POSSIBLE advisory
// with a tattooAckToken. Re-submitting with a valid tattooAckToken proceeds.
// Never auto-merges; always "posible coincidencia, verificá con foto".
//
// §2.2: notifications accumulate in pendingNotifications[] inside the tx
// and are inserted AFTER the transaction commits (best-effort, logged on failure).

import { db, notifications, ownerships, petEvents, petIdentifications, pets } from "@/db";
import { resolveBreedForWrite } from "@/lib/domain/breed-validation";
import {
  CoordError,
  JurisdictionValidationError,
  normalizeLocationForWrite,
} from "@/lib/domain/location-normalize";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import { chipImplantSiteFromLocation } from "@/lib/domain/microchip-implant-site";
import { validateMicrochipId } from "@/lib/domain/microchip-validation";
import { EventPayloadValidationError, validateEventPayload } from "@/lib/events/event-schemas";
import { checkOccurredAtPlausible } from "@/lib/events/plausibility";
import { openCase } from "@/lib/infra/case-helpers";
import { lookupByChip } from "@/lib/infra/chip-lookup";
import { matchesDbError } from "@/lib/infra/db-errors";
import { generateIntakeMatchClaim } from "@/lib/infra/intake-match-claim";
import { resolvePppClassificationForJurisdiction } from "@/lib/infra/ppp-classification";
import { generatePublicToken } from "@/lib/infra/publicToken";
import { generateTattooAckToken, validateTattooAckToken } from "@/lib/infra/tattoo-ack-token";
import { lookupByTattoo, normalizeTattooCode } from "@/lib/infra/tattoo-lookup";
import { generateUniqueToken } from "@/lib/infra/unique-token";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { parseDateInput } from "@/lib/utils/format";
import {
  type CreateIntakeInputCode,
  createIntakeInputSchema,
  firstIntakeInputCode,
} from "@dim/contract/input";
import { and, eq, sql } from "drizzle-orm";

import type { IntakeFormState } from "./types";

// es-AR copy for the client-input contract's failure codes. The codes live in
// @dim/contract (framework-free, copy-free); the words live here, where the
// wizard's voice is. A native client maps the same codes to its own screens.
//
// GENERIC is the fallback for a malformed request that carries no code this
// contract defines — an operator must never see a raw zod string.
const INTAKE_INPUT_MESSAGES: Record<CreateIntakeInputCode | "GENERIC", string> = {
  NAME_REQUIRED: "Falta el nombre (o un alias temporal).",
  SPECIES_REQUIRED: "Falta la especie.",
  INTAKE_REASON_REQUIRED: "Indicá el motivo de ingreso.",
  GENERIC: "Datos inválidos.",
};

/**
 * FormData → the plain record the client-input schema validates.
 *
 * Only string entries: the intake form posts no files, and a File landing in a
 * text field is a malformed request the schema should reject as a type error
 * rather than something this function should coerce into a filename.
 */
function intakeFormRecord(formData: FormData): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") record[key] = value;
  }
  return record;
}

// A microchip is a globally-unique identity (pet_identifications_chip_unique:
// one active microchip_iso row per code). When the chip already belongs to an
// ACTIVE registered pet, creating a second intake for it is structurally doomed —
// the insert always violates the unique index. The old "continue anyway"
// forceToken path therefore never worked: it fell through to that guaranteed
// constraint violation and surfaced a raw driver error. So this is an HONEST hard
// block, not a warning — it explains WHY and points at the flows that actually
// apply (mirrors the owner-side CHIP_ALREADY_REGISTERED_MSG for the org context).
// Note: a chip on a LOST pet is handled earlier (redirect to the match/
// reunification flow); this message covers the active-owner case only.
const CHIP_MATCH_ACTIVE_BLOCK_MSG =
  "Este microchip ya está registrado en miMAR para una mascota activa con familia. No se puede crear un segundo ingreso con el mismo chip. Si la familia entregó al animal, tiene que iniciar la transferencia de titularidad desde su cuenta. Si el animal está perdido, pedile a la familia que lo marque como perdido en miMAR: recién ahí el sistema te propone confirmar la coincidencia y registrar la custodia.";

// QA B1 — same hard block, different guidance: when the active pet has NO
// individual owner (lookupByChip's ownerUserId is null) it is under another
// organization's custody, so "la familia inicia la transferencia" is wrong
// advice. Point the operator at the org-to-org path instead.
const CHIP_MATCH_ACTIVE_ORG_CUSTODY_BLOCK_MSG =
  "Este microchip ya está registrado en miMAR para una mascota activa bajo custodia de otra organización. No se puede crear un segundo ingreso con el mismo chip. Coordiná el traspaso directamente con esa organización para que registre la salida o la transferencia de custodia. Si el animal está perdido, pedile a esa organización que lo marque como perdido en miMAR: recién ahí el sistema te propone confirmar la coincidencia y registrar la custodia.";

/**
 * Picks the active-chip hard-block copy by custody shape: an individual owner
 * (ownerUserId set) gets the with-family guidance; null means org custody and
 * gets the org-to-org guidance. Exported for unit tests.
 */
export function chipMatchActiveBlockMessage(ownerUserId: string | null): string {
  return ownerUserId === null
    ? CHIP_MATCH_ACTIVE_ORG_CUSTODY_BLOCK_MSG
    : CHIP_MATCH_ACTIVE_BLOCK_MSG;
}

// Exported for the bulk CSV import (org-pilot-pack D1): the preview validates
// each row through THESE exact write-time rules on synthetic FormData, so the
// preview can never diverge from what createIntake would accept. Export-only
// change — behavior untouched.
export function parseIntakeForm(formData: FormData) {
  const loc = parseLocationFromFormData(formData);

  // STRUCTURE first, from the client-input contract (native-readiness T1.3):
  // which fields exist, which are required, which are enums, what an empty
  // string means. This used to be twenty `String(formData.get(…)).trim()`
  // statements whose net effect nobody could read — least of all a native
  // client, which is why the shape now lives in @dim/contract/input.
  //
  // DOMAIN resolution stays below, where it belongs: breed catalogue,
  // jurisdiction canonicalization, date plausibility, tattoo normalization.
  // Every one of those needs a catalogue, a clock or the database.
  const input = createIntakeInputSchema.safeParse(intakeFormRecord(formData));
  if (!input.success) {
    return {
      parsed: null,
      error: INTAKE_INPUT_MESSAGES[firstIntakeInputCode(input.error) ?? "GENERIC"],
    };
  }
  const client = input.data;
  const { name, species, sex, custodyRole, intakeReason, ageYears, ageMonths } = client;

  let dateOfBirth: string | null = null;
  let birthDateIsEstimated = false;
  if (ageYears !== null || ageMonths !== null) {
    const totalMonths = (ageYears ?? 0) * 12 + (ageMonths ?? 0);
    const dob = new Date();
    dob.setMonth(dob.getMonth() - totalMonths);
    dateOfBirth = dob.toISOString().slice(0, 10);
    birthDateIsEstimated = true;
  }

  const occurredAtRaw = client.occurredAt;
  const occurredAt = occurredAtRaw ? parseDateInput(occurredAtRaw) : new Date();
  if (occurredAtRaw && !occurredAt) {
    return { parsed: null, error: "Fecha de ingreso inválida." };
  }
  // Future-date guard (PO decision 2026-07-16, same family as P4 item 1):
  // date-only input → AR calendar-day compare. No BEFORE_BIRTH leg here — the
  // pet's DOB is ESTIMATED from the age fields at this very moment, so
  // comparing the (past) intake date against it would produce false rejections.
  if (occurredAtRaw && occurredAt) {
    const plausibility = checkOccurredAtPlausible(occurredAt, null);
    if (plausibility) return { parsed: null, error: plausibility.error };
  }

  // Breed catalog gate (QA A4): resolve to the canonical catalog label
  // (folding + colloquial aliases) or reject. Lives HERE — not in
  // createIntake — so the bulk CSV import preview, which validates rows
  // through this exact parser, rejects an invented breed at preview time
  // instead of at insert time. Intake creates a NEW pet, so there is no
  // stored value to grandfather.
  const breedResolution = resolveBreedForWrite(species, client.breed ?? "");
  if (!breedResolution.ok) return { parsed: null, error: breedResolution.error };
  const breed = breedResolution.breed;
  // Config-theater fix (handoff 2026-07-03 #3): the intake form previously had
  // no weight field at all, so ppp_weight_threshold could never fire for
  // shelter-intaken dogs (PPP classification degraded to breed-only). Kept as
  // a string here — same shape as pets.estimatedWeightKg (numeric column) and
  // the pet_registered event payload; parsed to a number only where the PPP
  // classifier needs it (see resolvePppClassificationForJurisdiction call below).
  const estimatedWeightKg = client.estimatedWeightKg;
  const microchipId = client.microchipId;

  // Tattoo code — stored normalized (trim + uppercase + collapse whitespace).
  // Pass raw input to lookupByTattoo (it normalizes internally). For the
  // pets row write we normalize here to keep the DB consistent with
  // every other writer (createTattooForUser pattern).
  const tattooCode = client.tattooCode ? normalizeTattooCode(client.tattooCode) : null;

  // Idempotency guard (projection-writes audit §6): the wizard posts a stable
  // UUID per form session so a double-submit doesn't create a second pet.
  const clientIdempotencyKey = client.clientIdempotencyKey;

  return {
    parsed: {
      name,
      species,
      sex,
      breed,
      dateOfBirth,
      birthDateIsEstimated,
      color: client.color,
      distinguishingFeatures: client.distinguishingFeatures,
      estimatedWeightKg,
      microchipId,
      // A country code without a chip is meaningless — a leftover from a
      // cleared field, never a fact about the animal.
      microchipCountryCode: microchipId ? client.microchipCountryCode : null,
      tattooCode,
      clientIdempotencyKey,
      jurisdictionProvince: provinceByCode(loc.provinceCode ?? "")?.name ?? null,
      jurisdictionLocality: loc.locality,
      // The row the picker wrote into the form (L2-8) — carried so the strict
      // canonicalization in `createIntake` resolves the catalogue BY ID and does
      // not settle a (province, locality) homonym alphabetically.
      localityIndecId: loc.localityIndecId,
      intakeReason,
      intakeCondition: client.intakeCondition,
      rescueJurisdiction: client.rescueJurisdiction,
      occurredAt: occurredAt as Date,
      custodyRole,
      // Flag is jurisdiction-resolved at action time — parse stays sync.
    },
    error: null,
  };
}

export async function createIntake(
  orgToken: string,
  user: { id: string },
  organization: { id: string; displayName: string; verified: boolean },
  formData: FormData,
): Promise<IntakeFormState> {
  const { parsed, error: parseError } = parseIntakeForm(formData);
  if (parseError || !parsed) return { error: parseError ?? "Datos inválidos." };

  // Structural locality-attribution FK (migration 0147). Resolved from the
  // strict canonicalization below; stays null when there's no locality to resolve.
  let jurisdictionLocalityId: string | null = null;

  // Canonicalize the pet's jurisdiction strictly against the INDEC catalog.
  // The intake form uses LocationFields (forces a catalog selection); this
  // validates crafted/bypassed requests and ensures org-side intakes converge
  // on the same canonical spelling as owner-side registrations.
  // locality:"strict" — resolveCanonicalJurisdiction (intake behavior unchanged).
  if (parsed.jurisdictionProvince && parsed.jurisdictionLocality) {
    try {
      const normalizedLoc = await normalizeLocationForWrite(
        {
          province: parsed.jurisdictionProvince,
          provinceCode: null,
          locality: parsed.jurisdictionLocality,
          // See the field's note in `parseIntakeForm` (L2-8).
          localityIndecId: parsed.localityIndecId ?? null,
          lat: null,
          lng: null,
          address: null,
        },
        { locality: "strict" },
      );
      parsed.jurisdictionProvince = normalizedLoc.province;
      parsed.jurisdictionLocality = normalizedLoc.locality;
      jurisdictionLocalityId = normalizedLoc.localityId;
    } catch (err) {
      if (err instanceof JurisdictionValidationError) {
        return { error: err.message };
      }
      if (err instanceof CoordError) {
        return { error: err.message };
      }
      throw err;
    }
  }

  // Lost & Found Fase 7 — validate chip format (ISO 11784/11785, 15 digits)
  // before the cross-check so malformed values never reach the DB.
  if (parsed.microchipId) {
    const chipValidation = validateMicrochipId(parsed.microchipId);
    if (!chipValidation.ok) {
      return { error: "INVALID_MICROCHIP_FORMAT" };
    }
    // Overwrite with the normalized (separators stripped) form.
    parsed.microchipId = chipValidation.normalized;
  }

  // Lost & Found Fase 2 — microchip cross-check before inserting.
  if (parsed.microchipId) {
    const match = await lookupByChip(parsed.microchipId);
    if (match) {
      if (match.pet.status === "lost") {
        // BLOCK: send the operator to the match-confirmation page so the org
        // can confirm. Attach an HMAC claim binding THIS org + THIS matched pet
        // so the match page / confirm writer can gate on it (review 24 HIGH
        // #6/#7): loading the lost pet by token alone leaked owner PII
        // cross-org.
        //
        // Reported, not performed (nav contract N3). This is the branch where a
        // dropped redirect hurt most: the operator gets no error and no
        // navigation, so the animal in front of them — already registered as
        // lost by a family looking for it — silently goes nowhere. `ok` stays
        // unset because nothing was created.
        const claim = generateIntakeMatchClaim(orgToken, match.pet.publicToken);
        return {
          error: null,
          redirectTo: `/org/${orgToken}/intake/match/${match.pet.publicToken}?claim=${encodeURIComponent(claim)}`,
        };
      }

      if (match.pet.status === "active") {
        // HARD BLOCK: the chip belongs to a live active pet. A second intake for
        // the same chip would always violate pet_identifications_chip_unique, so
        // there is no honest "continue anyway" — return helpful guidance instead,
        // worded for the actual custody shape (family vs another org — QA B1).
        return { error: chipMatchActiveBlockMessage(match.pet.ownerUserId) };
      }

      if (match.pet.status === "deceased") {
        // BLOCK unconditionally — admin review required.
        return {
          error:
            "Este chip está asociado a una mascota registrada como fallecida en miMAR. Pedile a un admin que revise el caso antes de continuar.",
        };
      }
    }
  }

  // Tattoo cross-check (D2) — advisory only, never auto-merge.
  // Tattoo codes collide across registries; we surface a warning and require
  // visual verification ("posible coincidencia, verificá con foto").
  // On re-submit with a valid tattooAckToken the check is skipped — the
  // operator has asserted the animals are different after photo review.
  if (parsed.tattooCode) {
    const tattooAckToken = String(formData.get("tattooAckToken") ?? "").trim();
    const ackValid = tattooAckToken
      ? validateTattooAckToken(parsed.tattooCode, tattooAckToken)
      : false;

    if (!ackValid) {
      const tattooMatch = await lookupByTattoo(parsed.tattooCode);
      if (tattooMatch && tattooMatch.pet.status !== "deceased") {
        // Advisory: surface the possible match so the operator can photo-verify.
        // Tattoo codes collide across registries, so this stays a warn-with-continue
        // case (via tattooAckToken) — unlike an active chip, a duplicate tattoo does
        // NOT violate a unique constraint, so proceeding is legitimate. If a chip is
        // also present it already cleared the cross-check above (no active match, or
        // a lost/deceased match already returned), so no chip token is threaded here.
        return {
          error: null,
          warning: "TATTOO_MATCH_POSSIBLE",
          matchedPetToken: tattooMatch.pet.publicToken,
          tattooAckToken: generateTattooAckToken(parsed.tattooCode),
        };
      }
    }
    // Ack token valid, or no match (or only deceased match) → proceed.
  }

  const publicToken = await generateUniqueToken(pets, pets.publicToken, generatePublicToken);
  const now = new Date();
  const authorVerified = organization.verified;

  // Jurisdiction-aware PPP evaluation (spec govt-business-rules-poc §4;
  // weight-threshold enforcement admin-rules-console ADR-3). Config-theater
  // fix (handoff 2026-07-03 #3): the intake form now carries an optional
  // weight field, so shelter-intaken dogs can be weight-flagged the same way
  // owner register/update pets are. NaN-guards a malformed string down to
  // null (treated as "no weight data"), mirroring parseEstimatedWeightKg in
  // src/modules/pets/actions.ts.
  const parsedEstimatedWeightKg =
    parsed.estimatedWeightKg === null ? null : Number.parseFloat(parsed.estimatedWeightKg);
  const potentiallyDangerousBreed = await resolvePppClassificationForJurisdiction(
    parsed.species,
    parsed.breed,
    Number.isNaN(parsedEstimatedWeightKg) ? null : parsedEstimatedWeightKg,
    {
      country: "AR",
      province: parsed.jurisdictionProvince,
      locality: parsed.jurisdictionLocality,
    },
  );

  type PendingNotification = typeof notifications.$inferInsert;
  const pendingNotifications: PendingNotification[] = [];

  // Set when a duplicate submit is detected inside the tx — the intake already
  // succeeded once, so we short-circuit to the same success surface.
  let duplicateOf: { publicToken: string; name: string } | null = null;

  try {
    await db.transaction(async (tx) => {
      // Idempotency guard (projection-writes audit §6): a double-submit of the
      // intake wizard must not create a second pet + idents. The wizard sends a
      // stable clientIdempotencyKey per form session; the pet_registered event
      // anchors it. The advisory lock serializes concurrent same-key submits so
      // the second one always sees the first one's committed row.
      if (parsed.clientIdempotencyKey) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${parsed.clientIdempotencyKey}))`,
        );
        const [existing] = await tx
          .select({ publicToken: pets.publicToken, name: pets.name })
          .from(petEvents)
          .innerJoin(pets, eq(pets.id, petEvents.petId))
          .where(
            and(
              eq(petEvents.eventType, "pet_registered"),
              eq(petEvents.clientIdempotencyKey, parsed.clientIdempotencyKey),
            ),
          )
          .limit(1);
        if (existing) {
          duplicateOf = existing;
          return;
        }
      }

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
          distinguishingFeatures: parsed.distinguishingFeatures,
          estimatedWeightKg: parsed.estimatedWeightKg,
          // ARCH-S: microchipId, microchipCountryCode, tattooCode columns dropped
          // from pets — canonical rows written to pet_identifications below.
          jurisdictionProvince: parsed.jurisdictionProvince,
          jurisdictionLocality: parsed.jurisdictionLocality,
          localityId: jurisdictionLocalityId,
          potentiallyDangerousBreed: potentiallyDangerousBreed,
        })
        .returning();

      await tx.insert(ownerships).values({
        petId: newPet.id,
        ownerOrganizationId: organization.id,
        role: parsed.custodyRole,
        startedAt: parsed.occurredAt,
      });

      const registeredPayload = validateEventPayload("pet_registered", {
        name: parsed.name,
        species: parsed.species,
        sex: parsed.sex,
        breed: parsed.breed,
        date_of_birth: parsed.dateOfBirth,
        birth_date_is_estimated: parsed.birthDateIsEstimated,
        color: parsed.color,
        microchip_id: parsed.microchipId,
        microchip_country_code: parsed.microchipCountryCode,
        microchip_implanted_at: null,
        microchip_implanted_by: null,
        microchip_location: null,
        estimated_weight_kg: parsed.estimatedWeightKg,
        favourite_foods: [],
        known_allergies: [],
        training_level: null,
        insurance_company: null,
        insurance_policy_number: null,
        jurisdiction_province: parsed.jurisdictionProvince,
        jurisdiction_locality: parsed.jurisdictionLocality,
        // The catalogue ROW the two names resolved to — the same value written
        // into `pets.locality_id` below, so the spine can reproduce it (L2-3).
        jurisdiction_locality_id: jurisdictionLocalityId,
        potentially_dangerous_breed: potentiallyDangerousBreed,
        acquisition_method: null,
        has_photo: false,
        has_microchip: parsed.microchipId !== null,
        custody_kind: parsed.custodyRole === "owner" ? "owner_by_org" : "shelter_custody_by_org",
      });
      await tx.insert(petEvents).values({
        petId: newPet.id,
        eventType: "pet_registered",
        occurredAt: parsed.occurredAt,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "shelter",
        authorOrganizationId: organization.id,
        authorVerified,
        payload: registeredPayload,
        clientIdempotencyKey: parsed.clientIdempotencyKey,
      });

      // Cases system: open a custody_episode for every org intake so the
      // custody period has a first-class entry in /casos. The lifecycle's
      // opensEvents = shelter_intake_recorded with no sub-condition, so all
      // intake reasons (rescue / surrender / stray_found / other) open a case.
      // "seizure" is excluded from org-side intake (DC1); the govt decomiso
      // flow will open its own case. Close transitions (custody_transferred,
      // adoption_finalized, death_recorded) are wired separately and are out
      // of scope here — cases stay open until then.
      const custodyCase = await openCase(
        {
          kind: "custody_episode",
          primarySubjectKind: "registered_pet",
          primaryPetId: newPet.id,
          jurisdictionProvince: parsed.jurisdictionProvince,
          jurisdictionLocality: parsed.jurisdictionLocality,
          localityId: jurisdictionLocalityId,
          openedByUserId: user.id,
          openedByOrganizationId: organization.id,
          openedReason: { code: "org_intake", intakeReason: parsed.intakeReason },
        },
        tx,
      );

      const intakePayload = validateEventPayload("shelter_intake_recorded", {
        intake_reason: parsed.intakeReason,
        intake_condition: parsed.intakeCondition,
        rescue_jurisdiction: parsed.rescueJurisdiction,
      });
      await tx.insert(petEvents).values({
        petId: newPet.id,
        eventType: "shelter_intake_recorded",
        occurredAt: parsed.occurredAt,
        recordedAt: now,
        recordedByUserId: user.id,
        authorRole: "shelter",
        authorOrganizationId: organization.id,
        authorVerified,
        payload: intakePayload,
        caseId: custodyCase.id,
      });

      // Canonical dual-write — EVENT FIRST, then pet_identifications row
      // (projection-writes audit 2026-07-04 P1: intake wrote idents with no
      // microchip_implanted/tattoo_recorded event, so the log was incomplete
      // for SENASA export and rederivePetCache flagged drift — the exact
      // S002 class the owner path already avoids in pets-repository.ts).
      if (parsed.microchipId) {
        const chipCode = parsed.microchipId;
        const implantSite = chipImplantSiteFromLocation(null); // no location at intake
        // The microchip_implanted schema requires country_code / implanted_by /
        // location_on_body as explicit (nullable) keys — omitting them makes the
        // strict schema reject the payload with an invalid_type error. At intake
        // the chip pre-exists: the org did not implant it, so implanted_by and
        // location_on_body are genuinely unknown (null), and country_code carries
        // the form value (same as the pet_registered snapshot above). This mirrors
        // the owner-side writer in pets-repository.ts::insertPetRegistered.
        const microchipEventPayload = validateEventPayload("microchip_implanted", {
          chip_number: chipCode,
          country_code: parsed.microchipCountryCode,
          implanted_by: null,
          location_on_body: null,
          implant_date_known: false,
        });
        await tx.insert(petEvents).values({
          petId: newPet.id,
          eventType: "microchip_implanted",
          occurredAt: parsed.occurredAt,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified,
          payload: microchipEventPayload,
          caseId: custodyCase.id,
        });
        await tx.insert(petIdentifications).values({
          petId: newPet.id,
          kind: "microchip_iso",
          code: chipCode,
          // El evento de arriba declara implant_date_known:false — en un intake
          // de refugio el animal llega con el chip puesto y nadie sabe cuándo se
          // lo implantaron. Escribir acá la fecha del intake inventaba un dato
          // que el spine marca como desconocido, y dejaba stored y derived
          // hablando modelos distintos (la proyección devuelve null). null es la
          // verdad: no sabemos la fecha.
          recordedAt: null,
          recordedByUserId: user.id,
          isoCountryCode: chipCode.slice(0, 3),
          isoManufacturerCode: chipCode.slice(3, 7),
          isoNationalId: chipCode.slice(7, 15),
          isoCompliant: true,
          implantationSite: implantSite ?? undefined,
        });
      }

      if (parsed.tattooCode) {
        const tattooEventPayload = validateEventPayload("tattoo_recorded", {
          tattoo_code: parsed.tattooCode,
          recorded_at: parsed.occurredAt.toISOString(),
          tattoo_date_known: false,
        });
        await tx.insert(petEvents).values({
          petId: newPet.id,
          eventType: "tattoo_recorded",
          occurredAt: parsed.occurredAt,
          recordedAt: now,
          recordedByUserId: user.id,
          authorRole: "shelter",
          authorOrganizationId: organization.id,
          authorVerified,
          payload: tattooEventPayload,
          caseId: custodyCase.id,
        });
        await tx.insert(petIdentifications).values({
          petId: newPet.id,
          kind: "tattoo",
          code: parsed.tattooCode,
          // Mismo caso que el chip: el evento declara tattoo_date_known:false.
          recordedAt: null,
          recordedByUserId: user.id,
        });
      }

      // Heads-up notification to the user who recorded the intake. This is a
      // confirmation, not an alert — severity=success. The refugio's other
      // members aren't pinged in v1; bulk-fanout on every intake would noise
      // them out at high-capacity shelters (per AGENTS.md "El Campito scale").
      pendingNotifications.push({
        userId: user.id,
        notificationType: "shelter_intake_confirmed",
        title: `Ingreso registrado: ${parsed.name}`,
        body: `${parsed.name} ahora figura en custodia de ${organization.displayName}.`,
        severity: "success",
        ctaLabel: "Ver listado",
        ctaUrl: `/org/${orgToken}/mascotas`,
        relatedPetId: newPet.id,
      });
    });
  } catch (err) {
    // Never surface a raw Zod validation message to the user. A payload-schema
    // failure is an internal contract bug — log the detail for us, show a
    // friendly es-AR message to the operator.
    if (err instanceof EventPayloadValidationError) {
      console.error(
        "[intake] event payload validation failed",
        err.eventType,
        err.zodError?.issues ?? err.message,
      );
      return {
        error:
          "No pudimos registrar el ingreso por un problema con los datos de la mascota. Revisá los campos e intentá de nuevo; si persiste, avisanos.",
      };
    }
    // A concurrent insert (or any path that reached the insert with a chip already
    // active — e.g. a race between the cross-check and the tx) trips the unique
    // index. Translate it into the same friendly guidance instead of leaking the
    // raw driver string ("duplicate key value violates unique constraint …").
    if (matchesDbError(err, { code: "23505", constraint: "pet_identifications_chip_unique" })) {
      return { error: CHIP_MATCH_ACTIVE_BLOCK_MSG };
    }
    return {
      error: `No se pudo registrar el ingreso: ${
        err instanceof Error ? err.message : "error desconocido"
      }`,
    };
  }

  // Duplicate submit — the first submit already created the pet. Surface the
  // original result (no second pet, no second notifications).
  if (duplicateOf !== null) {
    const original = duplicateOf as { publicToken: string; name: string };
    if (String(formData.get("noRedirect") ?? "") === "1") {
      return {
        error: null,
        ok: true,
        createdPetToken: original.publicToken,
        createdPetName: original.name,
      };
    }
    return {
      error: null,
      redirectTo: `/org/${orgToken}/mascotas?nueva=${original.publicToken}`,
    };
  }

  if (pendingNotifications.length > 0) {
    try {
      await db.insert(notifications).values(pendingNotifications);
    } catch (e) {
      console.error("notifications insert failed (action did succeed)", e);
    }
  }

  if (String(formData.get("noRedirect") ?? "") === "1") {
    return {
      error: null,
      ok: true,
      createdPetToken: publicToken,
      createdPetName: parsed.name,
    };
  }

  return {
    error: null,
    redirectTo: `/org/${orgToken}/mascotas?nueva=${publicToken}`,
  };
}
