"use server";

// Atender (walk-in clinical signing) server actions.
//
// These are thin, org-scoped edge actions for the walk-in case. They REUSE the
// exact clinical WRITERS (the events-module use-cases) and carry the #43
// provenance via `eventAuthorship` resolved by resolveAtenderPet — they do NOT
// reimplement the writer or the provenance logic. The only reason they exist
// separately from src/modules/events/actions.ts is the auth EDGE: the shared
// actions call requireAlivePetAccess (custody-gated), which fail-closes for a
// walk-in. Here the guard is resolveAtenderPet (event.write + DIM code, no
// custody). The writers themselves are custody-free, so nothing shared is
// weakened.
//
// Scope: CLINICAL events only (vacuna, desparasitación, cirugía/estudio,
// medicación, nota clínica). No custody/transfer/adoption; no owner PII.

import {
  FREQUENCY_LABELS,
  generateDoseSchedule,
  intervalHoursForFrequency,
  parseFrequencyFields,
} from "@/lib/reference/medication-schedule";

import { db } from "@/db";
import { checkChipMatchesCanonical } from "@/lib/domain/microchip-validation";
import { checkOccurredAtPlausible } from "@/lib/events/plausibility";
import type { SupabaseServerClient } from "@/lib/infra/pet-access";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { findDrugByLabel } from "@/lib/reference/drugs";
import { findVaccineByName } from "@/lib/reference/lookups";
import { createClient } from "@/lib/supabase/server";
import { parseDateInput } from "@/lib/utils/format";

import type { EventFormState } from "@/src/modules/events/actions";
import { createClinicalInfo } from "@/src/modules/events/application/clinical/clinical-info-use-case";
import { createMicrochip } from "@/src/modules/events/application/identity/microchip-use-case";
import { createNote } from "@/src/modules/events/application/identity/note-use-case";
import { createDeworming } from "@/src/modules/events/application/medical/deworming-use-case";
import { createMedicationStart } from "@/src/modules/events/application/medical/medication-start-use-case";
import { createSterilization } from "@/src/modules/events/application/medical/sterilization-use-case";
import { createVaccination } from "@/src/modules/events/application/medical/vaccination-use-case";
import { DEATH_CAUSES, DISPOSITION_METHODS } from "@/src/modules/events/domain/death-rules";
import { CLINICAL_SUB_KINDS } from "@/src/modules/events/domain/enums";
import { revalidatePath } from "next/cache";

import { EventsRepository } from "@/src/modules/events/infrastructure/events-repository";

import { findAuthoritiesForJurisdiction } from "@/lib/infra/approval-routing";
import { closeCase, findOpenCaseForPetAndKind } from "@/lib/infra/case-helpers";
import { activeHumanInstitutionalAdminIds } from "@/lib/infra/notification-recipients";
import { createNotificationsBulk } from "@/lib/infra/notification-service";
import { clinicMayRecordObservationDeath } from "@/lib/infra/vet-observation-reach";
import { professionalCloseObservation } from "@/src/modules/surveillance/application/professional-close-observation";
import type { RabiesObservationOutcome } from "@/src/modules/surveillance/domain/rabies-observation";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";
import { ATENDER_TOKEN_PATTERN, normalizeAtenderToken, resolveAtenderPet } from "./atender-access";
import { attemptedChipMatchesDeclaration, rejectIfAlreadySigned } from "./atender-declared-events";
import { completeAtenderSignature } from "./atender-signature-completion";
import { hasUncataloguedVaccineFlag } from "./atender-vaccine-gate";

export type { EventFormState } from "@/src/modules/events/actions";

// ---------------------------------------------------------------------------
// Local plumbing (mirrors src/modules/events/actions.ts module-local helpers)
// ---------------------------------------------------------------------------

function makeTransaction(): <T>(cb: (tx: unknown) => Promise<T>) => Promise<T> {
  return <T>(cb: (tx: unknown) => Promise<T>) =>
    db.transaction(cb as Parameters<typeof db.transaction>[0]) as Promise<T>;
}

async function cleanupAttachment(supabase: SupabaseServerClient, path: string | null) {
  if (!path) return;
  try {
    await supabase.storage.from("event-attachments").remove([path]);
  } catch {
    // Swallow — orphaned file at worst.
  }
}

// authorship typing shim used by every writer (matches events/actions.ts)
type Authorship = {
  authorRole: string;
  authorOrganizationId: string | null;
  authorVerified: boolean;
};

// Every writer below closes through completeAtenderSignature — see that module's
// header. It owns BOTH the owner alert and the `?firmado=1` receipt, so success
// is not something a walk-in writer can construct on its own and the alert
// cannot be forgotten by a writer added later.

// ---------------------------------------------------------------------------
// Code entry — resolve a DIM credential to the signing surface
// ---------------------------------------------------------------------------

export async function lookupAtenderPetAction(
  orgToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const rawCode = String(formData.get("code") ?? "");
  const normalized = normalizeAtenderToken(rawCode);
  if (!normalized) return { error: "Ingresá el código de la credencial." };
  if (!ATENDER_TOKEN_PATTERN.test(normalized)) {
    return { error: "El formato del código es DIM-XXXX-XXXX." };
  }

  const access = await resolveAtenderPet(orgToken, normalized);
  if (!access.ok) return { error: access.error };

  return {
    error: null,
    ok: true,
    redirectTo: `/org/${orgToken}/atender/${access.pet.publicToken}`,
  };
}

// ---------------------------------------------------------------------------
// Vaccination
// ---------------------------------------------------------------------------

export async function atenderVaccinationAction(
  orgToken: string,
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const vaccineName = String(formData.get("vaccineName") ?? "").trim();
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const brand = String(formData.get("brand") ?? "").trim() || null;
  const batch = String(formData.get("batch") ?? "").trim() || null;
  // The signer IS the applier on this surface — when the field is left blank
  // (a vet understandably doesn't type their own name), the record fills it
  // from the signing identity instead of committing an anonymous dose. The
  // shared libreta's Profesional column reads this payload field, and a
  // SIGNED dose was rendering "—" beside an owner-declared one showing its
  // cited name (9-role external run, 2026-08-18). Typed input still wins:
  // a vet recording a colleague's application can name them.
  const administeredBy =
    String(formData.get("administeredBy") ?? "").trim() || access.signer.recordName;
  const nextDueAtRaw = String(formData.get("nextDueAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!vaccineName) return { error: "Falta el nombre de la vacuna." };
  if (!occurredAtRaw) return { error: "Falta la fecha de aplicación." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha de aplicación inválida." };
  // Same date-only plausibility guard as the owner edge (P4 item 1) — the
  // walk-in input is an <input type="date">, so AR calendar-day compare.
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;
  const nextDueAt = nextDueAtRaw ? parseDateInput(nextDueAtRaw) : null;
  if (nextDueAtRaw && !nextDueAt) return { error: "Fecha de próxima dosis inválida." };

  // THE HARD GATE, server-side mirror (#5, PO decision, defense in depth): a
  // vaccine name outside the catalog must never commit unless it's explicitly
  // flagged as uncatalogued in notes — the client picker (AtenderVaccinationGate)
  // is the primary gate; this is the backstop for a client that skips it.
  if (!hasUncataloguedVaccineFlag(notes) && !findVaccineByName(vaccineName)) {
    return {
      error:
        "Esa vacuna no está en el catálogo. Elegí una del listado o marcala como no catalogada en las notas.",
    };
  }

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createVaccination(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        vaccineName,
        occurredAt,
        brand,
        batch,
        administeredBy,
        nextDueAt,
        notes,
        sourceReminderId: null,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar la vacuna: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // Closed AFTER the try/catch, always: the owner alert inside is POST-COMMIT, so
  // a hypothetical throw there can never reach cleanupAttachment and delete the
  // attachment of an event that already persisted.
  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "vaccination_administered",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Deworming
// ---------------------------------------------------------------------------

export async function atenderDewormingAction(
  orgToken: string,
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const product = String(formData.get("product") ?? "").trim();
  const type = String(formData.get("type") ?? "").trim();
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const nextDueAtRaw = String(formData.get("nextDueAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!product) return { error: "Falta el nombre del producto." };
  if (!["internal", "external", "both"].includes(type))
    return { error: "Tipo de antiparasitario inválido." };
  if (!occurredAtRaw) return { error: "Falta la fecha de aplicación." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha de aplicación inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;
  const nextDueAt = nextDueAtRaw ? parseDateInput(nextDueAtRaw) : null;
  if (nextDueAtRaw && !nextDueAt) return { error: "Fecha de próxima dosis inválida." };

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createDeworming(
      {
        pet: { id: pet.id, name: pet.name },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        product,
        type,
        occurredAt,
        nextDueAt,
        notes,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar el antiparasitario: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "deworming_administered",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Clinical info (cirugía / estudio clínico)
// ---------------------------------------------------------------------------

export async function atenderClinicalInfoAction(
  orgToken: string,
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const subKindRaw = String(formData.get("subKind") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const details = String(formData.get("details") ?? "").trim() || null;
  const performedBy = String(formData.get("performedBy") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!(CLINICAL_SUB_KINDS as readonly string[]).includes(subKindRaw)) {
    return { error: "Tipo de información clínica inválido." };
  }
  if (!title) return { error: "Falta el título / nombre del estudio o procedimiento." };
  if (!occurredAtRaw) return { error: "Falta la fecha." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createClinicalInfo(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        subKind: subKindRaw,
        title,
        details,
        performedBy,
        occurredAt,
        notes,
        // Walk-in surface does not capture per-event jurisdiction; the pet's
        // own jurisdiction is the projection default (parity with owner flow
        // when location is left blank).
        eventJurisdictionProvince: null,
        eventJurisdictionLocality: null,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo guardar la información clínica: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "clinical_info_logged",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Medication start
// ---------------------------------------------------------------------------

export async function atenderMedicationStartAction(
  orgToken: string,
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const drugName = String(formData.get("drugName") ?? "").trim();
  const dose = String(formData.get("dose") ?? "").trim();
  const prescribedBy = String(formData.get("prescribedBy") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!drugName) return { error: "Falta el nombre del medicamento." };
  if (!dose) return { error: "Falta la dosis." };
  if (!occurredAtRaw) return { error: "Falta la fecha de inicio." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha de inicio inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const frequencyRaw = String(formData.get("frequency") ?? "").trim();
  const customHoursRaw = String(formData.get("customHours") ?? "").trim() || null;
  const durationDaysRaw = String(formData.get("durationDays") ?? "").trim() || null;
  const firstDoseAtRaw = String(formData.get("firstDoseAt") ?? "").trim() || null;
  if (!frequencyRaw) return { error: "Falta la frecuencia." };

  const parsedFreq = parseFrequencyFields(
    frequencyRaw,
    customHoursRaw,
    durationDaysRaw,
    firstDoseAtRaw,
  );
  if (parsedFreq.error !== null) return { error: parsedFreq.error };
  const { frequency, customHours, durationDays, firstDoseAt } = parsedFreq as {
    error: null;
    frequency: import("@/lib/reference/drugs").FrequencyKind;
    customHours: number | null;
    durationDays: number | null;
    firstDoseAt: Date;
  };

  const intervalHours = intervalHoursForFrequency(frequency, customHours);
  const schedule = generateDoseSchedule({ firstDoseAt, intervalHours, durationDays });
  const matchedDrug = findDrugByLabel(drugName);
  const frequencyLabel = (FREQUENCY_LABELS as Record<string, string>)[frequency] ?? frequency;

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createMedicationStart(
      {
        pet: { id: pet.id, name: pet.name },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        drugName,
        dose,
        prescribedBy,
        occurredAt,
        notes,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
        frequency,
        customHours,
        durationDays,
        firstDoseAt,
        schedule,
        matchedDrugCode: matchedDrug?.code ?? null,
        frequencyLabel,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar la medicación: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "medication_started",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Clinical note
// ---------------------------------------------------------------------------

export async function atenderNoteAction(
  orgToken: string,
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const text = String(formData.get("text") ?? "").trim();
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!text) return { error: "Falta el contenido de la nota." };
  if (!occurredAtRaw) return { error: "Falta la fecha." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createNote(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        text,
        occurredAt,
        // Clinical note — category is owner-facing taxonomy; leave null here.
        category: null,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo guardar la nota: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "note_added",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Microchip — fresh placement OR declared-by-owner sign-off (#3, #43)
// ---------------------------------------------------------------------------
//
// Two entry points share this action: the ¿Qué querés registrar? grid sends
// confirmEventId = null (a FRESH placement the vet just implanted — PO
// decision 2026-08-06, Cowork QA v3 M3), and PendingSignaturesCard binds the
// owner-declared pet_event id (a confirmation, with the scan-match guard
// below).
//
// Same #43 provenance mechanism the vaccine keystone already uses (this file,
// atenderVaccinationAction): the writer is CUSTODY-FREE and takes the SIGNER's
// eventAuthorship from resolveAtenderPet, so a matriculated vet's chip
// confirmation lands as verified_professional exactly like every other
// atender-signed event. `confirmEventId`, when present, is the pet_event id
// of the owner-declared row this submission confirms — bound as a SERVER
// ACTION ARGUMENT (see AtenderCaptureMounter's .bind), not a form field, so a
// client cannot forge which declared event a signature targets. Append-only:
// rejectIfAlreadySigned only reads that row; this action always INSERTS a new
// event, never edits the original.

export async function atenderMicrochipAction(
  orgToken: string,
  publicToken: string,
  confirmEventId: string | null,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const chipNumber = String(formData.get("chipNumber") ?? "").trim();
  const countryCode = String(formData.get("countryCode") ?? "").trim() || null;
  const implantedBy = String(formData.get("implantedBy") ?? "").trim() || null;
  const locationOnBody = String(formData.get("locationOnBody") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!chipNumber) return { error: "Falta el número de microchip." };
  if (!occurredAtRaw) return { error: "Falta la fecha de implantación." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  if (confirmEventId) {
    const rejected = await rejectIfAlreadySigned(
      pet.id,
      "microchip_implanted",
      confirmEventId,
      eventAuthorship,
    );
    if (rejected) return rejected;

    // Proof of scan. The pending-signatures card no longer shows or prefills
    // the declared number (see toPendingDeclaredEvent), so the signer types
    // what they read off the scanner. Without this the typed value and the
    // declaration could diverge and we would still mark THAT declaration
    // professionally verified — stamping a number it never contained onto an
    // append-only record. The comparison lives in the SQL predicate; the
    // declared value is never selected.
    const matches = await attemptedChipMatchesDeclaration(pet.id, confirmEventId, chipNumber);
    if (!matches) {
      return {
        error:
          "El número no coincide con el microchip declarado por la persona responsable. Verificá la lectura del escáner.",
      };
    }
  }

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  // ARCH-S parity with the owner action: read canonical chip status (legacy
  // pets.microchipId column dropped).
  const { fetchActiveIdentifications } = await import("@/lib/infra/pet-identifiers");
  const existingIds = await fetchActiveIdentifications(pet.id);

  // Fresh placement (grid path, no confirmEventId): a pet that already carries
  // THIS chip needs nothing appended. Without this refusal a re-submit after a
  // page reload (fresh idempotency key) passes checkChipMatchesCanonical —
  // codes agree — and appends a duplicate microchip_implanted row to the
  // append-only spine. The confirm path covers the same hole with
  // rejectIfAlreadySigned; this is its fresh-path counterpart.
  if (
    !confirmEventId &&
    existingIds.microchip &&
    !checkChipMatchesCanonical(existingIds.microchip.code, chipNumber)
  ) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error:
        "Esta mascota ya tiene ese microchip registrado. Si querés firmarlo como profesional, usá «Confirmar y firmar» en los eventos declarados pendientes.",
    };
  }

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createMicrochip(
      {
        pet: { id: pet.id, canonicalChipNumber: existingIds.microchip?.code ?? null },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        chipNumber,
        countryCode,
        implantedBy,
        locationOnBody,
        occurredAt,
        notes,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar el microchip: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "microchip_implanted",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// Sterilization — declared-by-owner sign-off (#3, #43 keystone extension)
// ---------------------------------------------------------------------------
//
// See atenderMicrochipAction above for the shared rationale (same #43
// provenance mechanism, same confirmEventId/append-only contract).

export async function atenderSterilizationAction(
  orgToken: string,
  publicToken: string,
  confirmEventId: string | null,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;
  const supabase = await createClient();

  const procedure = String(formData.get("procedure") ?? "").trim();
  const performedBy = String(formData.get("performedBy") ?? "").trim() || null;
  const clinic = String(formData.get("clinic") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!["castration", "spay"].includes(procedure)) return { error: "Procedimiento inválido." };
  if (!occurredAtRaw) return { error: "Falta la fecha de la cirugía." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  if (confirmEventId) {
    const rejected = await rejectIfAlreadySigned(
      pet.id,
      "sterilization_performed",
      confirmEventId,
      eventAuthorship,
    );
    if (rejected) return rejected;
  }

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();
  let signedEventId: string | null = null;
  try {
    const result = await createSterilization(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as Authorship,
        procedure,
        performedBy,
        clinic,
        occurredAt,
        notes,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
        clientIdempotencyKey,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
    signedEventId = result.value?.eventId ?? null;
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar la esterilización: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return completeAtenderSignature({
    orgToken,
    publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName: access.organizationName,
    signerUserId: user.id,
    eventId: signedEventId,
    eventType: "sterilization_performed",
    occurredAt,
  });
}

// ---------------------------------------------------------------------------
// atenderCloseRabiesObservationAction — el veterinario cierra la observación
// ---------------------------------------------------------------------------
//
// POR QUÉ EXISTE, y es una mentira corregida más que una capacidad agregada:
// hasta el 2026-09-17 sólo admin y autoridad sanitaria podían cerrar una
// observación antirrábica, mientras DOS notificaciones le decían al dueño "pedí
// el cierre a tu veterinario". El matriculado que observó al animal diez días no
// podía registrar el resultado clínico. Decisión del PO.
//
// LA REGLA: matrícula VALIDADA más relación con la mascota. Las dos salen de
// `resolveAtenderPet`, que es el mismo boundary por el que este profesional ya
// firma vacunas sobre animales que no tiene en custodia:
//
//   · relación — `event.write` sobre ESTA organización más conocer el código DIM
//     (31^8, ≈ posesión física de la credencial: el dueño trajo al animal).
//   · matrícula — `eventAuthorship.authorVerified`, atada al FIRMANTE y no a la
//     organización (keystone de provenance #43). Una organización verificada
//     cuyo miembro no es matriculado NO pasa el chequeo de abajo.
//
// LO QUE EL PO ACEPTA CON ESTO, dicho para que no haya que deducirlo: cualquier
// matriculado que tenga el animal delante puede cerrar, no sólo el que condujo
// la observación — porque el sistema NO REGISTRA quién la condujo. Las
// observaciones son `in_situ` (domicilio del dueño) y el campo de la clínica
// oficial está declarado y sin implementar. La barrera real es física, y es la
// misma que ya protege cada evento clínico de walk-in (PO-3).
//
// NO DUPLICA LA LÓGICA DEL CIERRE. Delega en el mismo caso de uso que usa el
// Estado, así que la carrera de cierres concurrentes, la guarda adentro del
// UPDATE, el plazo legal del negativo (PO 2026-09-18), el fan-out a la
// autoridad ante un positivo y la fila de auditoría son LOS MISMOS. Lo único
// distinto es la puerta — y cómo se entregan los avisos, que abajo se explica.
export async function atenderCloseRabiesObservationAction(
  orgToken: string,
  publicToken: string,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, organizationId, organizationName, eventAuthorship } = access;

  // LA MATRÍCULA, y el mensaje nombra qué falta en vez de decir "no podés".
  // Un miembro de una organización verificada que no es matriculado firma como
  // `shelter`, no como `vet`: puede asentar eventos y NO puede cerrar una
  // observación antirrábica, que es un resultado clínico.
  if (eventAuthorship.authorRole !== "vet" || !eventAuthorship.authorVerified) {
    return {
      error:
        "El resultado de una observación antirrábica lo registra un profesional con matrícula validada. Si sos veterinario, pedí que se valide tu matrícula desde el perfil de la organización.",
    };
  }

  const outcomeRaw = String(formData.get("outcome") ?? "").trim();
  const OUTCOMES: RabiesObservationOutcome[] = [
    "negative",
    "positive_rabies",
    "dead",
    "lost_to_followup",
  ];
  if (!OUTCOMES.includes(outcomeRaw as RabiesObservationOutcome)) {
    return { error: "Elegí un resultado para la observación." };
  }
  const closureNotes = String(formData.get("closureNotes") ?? "").trim() || null;

  const result = await professionalCloseObservation(
    {
      // THE PET THE GUARD RESOLVED, not the raw URL segment. resolveAtenderPet
      // normalizes the code and refuses an erased pet; the use case's lookup
      // matches the token exactly and does not filter `deleted_at`. Handing it
      // the raw string meant the guard and the write could disagree about which
      // animal — or whether any — was being closed.
      petPublicToken: pet.publicToken,
      outcome: outcomeRaw as RabiesObservationOutcome,
      closureNotes,
      // `jurisdictions` vacío a propósito: el alcance del veterinario no es
      // territorial, es la mascota que tiene delante. El caso de uso sólo mira
      // jurisdicciones cuando el rol es `govt`.
      actor: {
        profile: { id: user.id, role: "vet" },
        jurisdictions: [],
        organizationId,
        organizationName,
      },
    },
    {
      repo: new SurveillanceRepository(),
      closeCase: async (args, tx) => {
        await closeCase(args, tx as Parameters<typeof closeCase>[1]);
      },
      transaction: db.transaction.bind(db),
      findAuthoritiesForJurisdiction: (jurisdiction) =>
        findAuthoritiesForJurisdiction(jurisdiction, {
          route: "rabies_observation_positive_authority",
        }),
      // A lookup that THROWS still reaches a human with a positive.
      findNationalAdminIds: () => activeHumanInstitutionalAdminIds(),
    },
  );

  if (!result.ok) return { error: result.error };
  const { endedEventId, closedAt, ownerNotice } = result.value;

  // THE URGENT FAN-OUT TO THE HEALTH AUTHORITY (a positive), through the
  // DURABLE service: dedupe key, dead-letter on failure, drained by the cron.
  // It went through a raw insert whose catch only logged, so one transient
  // error dropped a confirmed-rabies alert and the vet still saw success.
  //
  // The key is derived here, anchored on the ended event — the act being
  // announced — in the service's `event:${eventId}:${userId}:${type}` shape.
  // Not on the bite case, as the State's door does: an observation can lack an
  // open case, and a missing anchor must not cost the authority its alert.
  await createNotificationsBulk(
    result.notifications.map((n) => ({
      ...n,
      dedupeKey: `event:${endedEventId}:${n.userId}:${n.notificationType}`,
    })),
  );

  revalidatePath(`/org/${orgToken}/atender/${pet.publicToken}`);

  // THE OWNER, through the same exit as every walk-in writer. A clinic without
  // custody just wrote a legal result on this animal, so the owner-alert
  // contract applies to it exactly as to a vaccine: every active owner and
  // co-owner, the clinic named, a durable write keyed on the event. Only the
  // WORDS differ — `ownerNotice` carries the result and, for a positive, the
  // urgency, instead of "nuevo registro en la libreta" — so the owner gets ONE
  // notice about the close, not a generic one beside the real one.
  return completeAtenderSignature({
    orgToken,
    publicToken: pet.publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName,
    signerUserId: user.id,
    eventId: endedEventId,
    eventType: "rabies_observation_ended",
    occurredAt: closedAt,
    ownerNotice: ownerNotice ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// atenderRecordDeathInObservationAction — the vet records a death during a
// rabies observation, from the clinic
// ---------------------------------------------------------------------------
//
// PO DECISION D8 (2026-09-18). Until now the veterinarian was told to ask the
// authority or the owner: the web death form sits behind requirePetAccess and
// the API's appendDeath behind PetHolderAccess, both of which admit only
// whoever HOLDS the animal, so a walk-in clinic had no door — while it is very
// often the clinic that has the body in front of it.
//
// WHO: exactly who may close the observation here (atenderCloseRabiesObservation
// Action above) — `resolveAtenderPet` (event.write on THIS organization + the
// DIM code) and a validated matrícula bound to the SIGNER. The same two checks,
// in the same order, with the same refusal copy.
//
// WHAT: the canonical death, through the SAME writer the owner and the API use
// (createDeathRecord) — one `death_recorded` on the append-only spine, no new
// event type — with its veterinary-closer extension: the observation's
// `rabies_observation_ended` {outcome: dead} signed by this vet, the guarded
// close (a concurrent close aborts the death with it), the professional close's
// audit row, the bite case closed, all in ONE transaction. The writer's own
// post-commit path sends the URGENT death-in-observation alert to the
// jurisdiction's authorities through the durable service (dedupe key +
// dead-letter), falling back to the national administrators if the lookup
// throws — the route every death-in-observation already takes.
//
// IRREVERSIBLE, so it is confirmed twice: the form's own confirmation step, and
// `confirmIrreversible` checked HERE, because a form is a courtesy. A double
// submit carries the same `clientIdempotencyKey` and resolves to the first
// death, with no second cascade and no second alert.
//
// THE OWNERS are told through the walk-in exit, like every writer here: every
// active owner and co-owner, the clinic named, URGENT — their animal died while
// under a legal observation and a clinic without custody recorded it.
export async function atenderRecordDeathInObservationAction(
  orgToken: string,
  publicToken: string,
  formData: FormData,
): Promise<EventFormState> {
  const access = await resolveAtenderPet(orgToken, publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, organizationId, organizationName, eventAuthorship } = access;

  // The licence — the same gate, and the same words, as the close above.
  if (eventAuthorship.authorRole !== "vet" || !eventAuthorship.authorVerified) {
    return {
      error:
        "El resultado de una observación antirrábica lo registra un profesional con matrícula validada. Si sos veterinario, pedí que se valide tu matrícula desde el perfil de la organización.",
    };
  }

  // Only a RUNNING observation. The writer refuses anything else inside its
  // transaction too; this answers before anything is parsed, with the reason.
  if (pet.rabiesObservationStatus !== "in_progress") {
    return {
      error: `${pet.name} no tiene una observación antirrábica en curso. Si ya terminó sin cierre, cerrala desde “Cerrar observación antirrábica”.`,
    };
  }

  if (formData.get("confirmIrreversible") !== "true") {
    return {
      error: "Confirmá que el fallecimiento es definitivo: queda asentado y no se puede deshacer.",
    };
  }

  const cause = String(formData.get("cause") ?? "").trim();
  if (!(DEATH_CAUSES as readonly string[]).includes(cause)) {
    return { error: "Elegí la causa del fallecimiento." };
  }
  const causeDetail = String(formData.get("causeDetail") ?? "").trim() || null;

  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  if (!occurredAtRaw) return { error: "Falta la fecha del fallecimiento." };
  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const dispositionRaw = String(formData.get("dispositionMethod") ?? "").trim();
  const dispositionMethod = dispositionRaw === "" ? null : dispositionRaw;
  if (
    dispositionMethod !== null &&
    !(DISPOSITION_METHODS as readonly string[]).includes(dispositionMethod)
  ) {
    return { error: "Método de disposición inválido." };
  }
  const facility = String(formData.get("facility") ?? "").trim() || null;
  const deathAtClinic = formData.get("deathAtClinic") === "true";
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  // The animal's jurisdiction routes the authority alert. Read here, by the
  // token the guard resolved, rather than widened into resolveAtenderPet's
  // deliberately narrow projection — the same lookup the close above uses.
  const surveillance = new SurveillanceRepository();
  const [located, biteCase, custodyEpisodeCase] = await Promise.all([
    surveillance.findPetByToken(pet.publicToken),
    surveillance.findOpenBiteCase(pet.id),
    findOpenCaseForPetAndKind(pet.id, "custody_episode"),
  ]);
  if (!located || located.id !== pet.id) return { error: "Mascota no encontrada." };

  // A death is terminal: walk-in trust needs a second anchor (see
  // lib/infra/vet-observation-reach.ts — security review 2026-09-18, D8).
  const observationStarted = await surveillance.findLatestObservationStarted(pet.id);
  const reach = await clinicMayRecordObservationDeath({
    organizationId,
    petId: pet.id,
    petProvince: located.jurisdictionProvince ?? null,
    observationStartedAt: observationStarted?.occurredAt ?? null,
  });
  if (!reach) {
    return {
      error: `Solo puede registrar el fallecimiento una veterinaria de la misma provincia que ${pet.name} o la que ya viene atendiendo su observación. Avisá a la autoridad sanitaria de su jurisdicción.`,
    };
  }

  // Loaded here, not at module top: the death writer pulls the rehome cascade
  // (and its schema enums) into every walk-in writer's import graph otherwise.
  const { createDeathRecord } = await import(
    "@/src/modules/events/application/lifecycle/death-record-use-case"
  );
  const result = await createDeathRecord(
    {
      pet: {
        id: pet.id,
        name: pet.name,
        status: pet.status,
        rabiesObservationStatus: pet.rabiesObservationStatus,
        jurisdictionProvince: located.jurisdictionProvince ?? null,
        jurisdictionLocality: located.jurisdictionLocality ?? null,
      },
      recordedByUserId: user.id,
      eventAuthorship: eventAuthorship as Authorship,
      cause,
      causeDetail,
      // The death is recorded BY a matriculated vet; the payload says so.
      confirmedByVet: true,
      vetName: null,
      dispositionMethod,
      facility,
      occurredAt,
      notes,
      deathAtClinic,
      clinicName: deathAtClinic ? organizationName : null,
      vetContactedOwner: null,
      vetDecidedAlone: false,
      ownerToPrivateCrematorium: false,
      diseaseCode: null,
      confirmedByLab: false,
      isReportable: false,
      uploadedPath: null,
      uploadedMimeType: null,
      uploadedSize: null,
      clientIdempotencyKey,
      custodyEpisodeCaseId: custodyEpisodeCase?.id ?? null,
      biteCaseId: biteCase?.id ?? null,
      observationCloser: {
        role: "vet",
        userId: user.id,
        organizationId,
        petPublicToken: pet.publicToken,
      },
    },
    {
      repo: new EventsRepository(),
      transaction: makeTransaction(),
      // Foster / rehome notices the cascades may queue, through the durable
      // service like every other notice this action sends. Each carries the
      // death as its related event, which keys it for the retry cron.
      flushNotifications: async (rows) => {
        await createNotificationsBulk(
          rows.map((n) => ({
            ...n,
            dedupeKey: `event:${n.relatedEventId ?? pet.id}:${n.userId}:${n.notificationType}`,
          })),
        );
      },
      closeObservationIfOpen: (petId, status, now, tx) =>
        surveillance.closeObservationIfOpen(
          petId,
          status,
          now,
          tx as Parameters<typeof surveillance.closeObservationIfOpen>[3],
        ),
      // The action spelled out as a literal, so lint:audit-actions can check it.
      insertObservationCloseAuditLog: (entry, tx) =>
        surveillance.insertObservationCloseAuditLog(
          { ...entry, action: "rabies_observation_closed_professional" },
          tx as Parameters<typeof surveillance.insertObservationCloseAuditLog>[1],
        ),
    },
  );

  if (!result.ok) {
    return { error: `No se pudo registrar el fallecimiento: ${result.error}` };
  }

  revalidatePath(`/org/${orgToken}/atender/${pet.publicToken}`);

  return completeAtenderSignature({
    orgToken,
    publicToken: pet.publicToken,
    petId: pet.id,
    petName: pet.name,
    organizationName,
    signerUserId: user.id,
    // A replayed key inserted nothing: the receipt is still owed, the owners
    // were already told the first time.
    eventId: result.insertedEventId,
    eventType: "death_recorded",
    occurredAt,
    ownerNotice: {
      notificationType: "rabies_observation_completed_professional_owner",
      severity: "urgent",
      title: `Fallecimiento durante la observación — ${pet.name}`,
      body: `Un veterinario matriculado de ${organizationName} registró el fallecimiento de ${pet.name} durante su observación antirrábica. La observación quedó cerrada y se avisó a la autoridad sanitaria, que puede necesitar tomar una muestra. Si no reconocés esta atención, avisá a la autoridad sanitaria de tu localidad.`,
      ctaLabel: `Ver a ${pet.name}`,
      ctaUrl: `/mis-mascotas/${pet.publicToken}`,
      relatedCaseId: biteCase?.id ?? null,
    },
  });
}
