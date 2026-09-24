"use server";

import { type EventFormState, cleanupAttachment, makeTransaction } from "./action-support";

// Re-exported because a dozen form components import the type from here. A
// `export type` is erased at compile time, so it adds no runtime export to a
// "use server" module — which may only expose async functions.
export type { EventFormState } from "./action-support";

// The clinical family lives in ./actions-medical.ts (size ratchet, 2026-08-21).
// NOT re-exported from here: Next refuses any `export … from` in a "use server"
// module — "Only async functions are allowed to be exported in a 'use server'
// file" — even when the re-exported bindings ARE async functions. typecheck,
// lint and the whole vitest suite passed on the re-export; only `next build`
// caught it. Callers import from ./actions-medical directly.

import { db, profiles } from "@/db";
import { pets } from "@/db";
import { CoordError, normalizeLocationForWrite } from "@/lib/domain/location-normalize";
import { parseLocationFromFormData } from "@/lib/domain/location-value";
import { checkOccurredAtPlausible } from "@/lib/events/plausibility";
import { requireUserOrRedirect } from "@/lib/infra/auth-guards";
import { announceCaretakerDeathRecord } from "@/lib/infra/caretaker-activity-alert";
import {
  isTitularHolder,
  requireAlivePetAccess,
  requirePetAccess,
  requireTitularAccess,
} from "@/lib/infra/pet-access";
import { uploadAttachmentIfPresent } from "@/lib/infra/uploads";
import { findDisease } from "@/lib/reference/diseases";
import { checkboxOn } from "@/lib/ui/form-checkbox";
import { parseDateInput } from "@/lib/utils/format";
import type { ContentReportCategory } from "@dim/contract/events";
import { and, eq, isNull } from "drizzle-orm";

// The org capability vocabulary, for the note gate below (PO decision
// 2026-08-26). `organizations` is a shared kernel — it imports from no module,
// so `events:organizations` keeps the graph acyclic; the edge is declared in
// scripts/check-dependency-direction.ts.
import { getGrantedCapabilities } from "@/src/modules/organizations/infrastructure/authz-resolver";
import { enqueueEnoTrigger } from "@/src/modules/surveillance/application/enqueue-eno-trigger";
import { SurveillanceRepository } from "@/src/modules/surveillance/infrastructure/surveillance-repository";
import { createClinicalInfo } from "./application/clinical/clinical-info-use-case";
import { recordDiseaseDiagnosisWriter } from "./application/clinical/record-disease-diagnosis-use-case";
import { createVetVisit } from "./application/clinical/vet-visit-use-case";
import { createDangerousBreedAttestation } from "./application/identity/dangerous-breed-attestation-use-case";
import { createMicrochip } from "./application/identity/microchip-use-case";
import { createNote } from "./application/identity/note-use-case";
import { validateAttestationRegistry } from "./application/identity/validate-attestation-registry";
import { createDeathRecord } from "./application/lifecycle/death-record-use-case";
import {
  findBroadcastRecipientUserIds,
  resolveFoundConfirmationRecipient,
} from "./application/lifecycle/found-notification-audience";
import { reportLostFeedItem } from "./application/lifecycle/report-lost-feed-item-use-case";
import { setPetFound } from "./application/lifecycle/set-pet-found-use-case";
import { setPetLostWriter } from "./application/lifecycle/set-pet-lost-use-case";
import { updateLostLastSeen } from "./application/lifecycle/update-lost-last-seen-use-case";
import {
  createDiseaseReported,
  isDiseaseReportedCode,
} from "./application/surveillance/disease-reported-use-case";
import { createSymptomObservedWriter } from "./application/surveillance/symptom-observed-use-case";
import { CLINICAL_SUB_KINDS } from "./domain/enums";

import { NOTE_CATEGORIES } from "./domain/enums";
import { EventsRepository } from "./infrastructure/events-repository";

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P4 item 1 (2026-07-08): shared IMPOSSIBLE-date guard for the medical/
// clinical/identity writers below that parse an occurred-at/date input.
// Bite actions (src/modules/surveillance/actions.ts) run the same guard at
// their own edge.
// ---------------------------------------------------------------------------

// Every caller in this module parses `occurredAt` from a date-only
// `<input type="date">` via `parseDateInput` (noon-UTC anchor), so the shared
// checkOccurredAtPlausible (lib/events/plausibility.ts) runs in date-only
// mode: the future check compares Argentine calendar days, never the noon-UTC
// instant against the wall clock (which rejected same-day submissions made
// before 09:05 AR).

const surveillanceRepoForEno = new SurveillanceRepository();

/**
 * In-transaction ENO enqueue dep for recordDiseaseDiagnosisWriter (P1-3
 * durability). The eno_processing_queue row is enqueued inside the diagnosis
 * tx so it is atomic with the event insert and can never be lost on a crash.
 * Idempotent on pet_event_id; DB errors propagate to roll the tx back.
 */
async function enqueueEnoTriggerInTx(
  petEvent: {
    id: string;
    petId: string;
    authorRole: string;
    recordedByUserId: string | null;
    authorOrganizationId: string | null;
    payload: Record<string, unknown>;
  },
  tx: unknown,
): Promise<void> {
  await enqueueEnoTrigger(petEvent, { repo: surveillanceRepoForEno, executor: tx });
}

// ---------------------------------------------------------------------------
// Microchip (WU-3 identity)
// ---------------------------------------------------------------------------

export async function createMicrochipAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { supabase, user, pet, eventAuthorship } = access;

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

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();

  // ARCH-S: read canonical chip status (legacy pets.microchipId column dropped).
  const { fetchActiveIdentifications } = await import("@/lib/infra/pet-identifiers");
  const existingIds = await fetchActiveIdentifications(pet.id);

  try {
    const result = await createMicrochip(
      {
        pet: { id: pet.id, canonicalChipNumber: existingIds.microchip?.code ?? null },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as {
          authorRole: string;
          authorOrganizationId: string | null;
          authorVerified: boolean;
        },
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
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar el microchip: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Dangerous-breed attestation (WU-3 identity)
//
// AUTH: requireAlivePetAccess (alive animal + `event.write` on the org path)
// AND the titular gate — deny-list row `ppp-attestation`, T4-I1 / #753. The
// PPP registries inscribe the PROPIETARIO (Ley CABA 4078 via APrA; Ley PBA
// 14.107 via the Registro Provincial), so a caretaker asserting the
// inscription is asserting a legal fact about someone else, permanently.
//
// WHY THE TWO GUARDS AND NOT ONE. `requireTitularAccess` answers the titular
// question and nothing else: it checks neither the animal's life status nor
// the org path's `event.write` capability, both of which this writer needs and
// had before. Composing them the other way round — a single alive-and-titular
// helper — would leave this function calling no guard `check-titular-gate.ts`
// recognises, so the fence would skip it silently rather than bless it. The
// second round trip happens ONLY on the refusal path, and it is there so the
// sentence a denied caretaker reads has exactly one author.
// ---------------------------------------------------------------------------

export async function createDangerousBreedAttestationAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  if (!isTitularHolder(access.accessPath, access.holderRole)) {
    const titular = await requireTitularAccess(publicToken);
    return {
      error: titular.ok ? "Esta acción es solo del titular." : titular.error,
    };
  }
  const { supabase, user, pet, eventAuthorship } = access;

  const registry = String(formData.get("registry") ?? "").trim();
  const registryId = String(formData.get("registryId") ?? "").trim() || null;
  const attestedAtRaw = String(formData.get("attestedAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  // Lote A4 — the accepted registries mirror what the form OFFERED (the
  // per-jurisdiction rule; see validate-attestation-registry.ts).
  const registryError = await validateAttestationRegistry(registry, {
    province: pet.jurisdictionProvince,
    locality: pet.jurisdictionLocality,
  });
  if (registryError) return { error: registryError };
  if (!attestedAtRaw) return { error: "Falta la fecha de atestación." };
  const attestedAt = parseDateInput(attestedAtRaw);
  if (!attestedAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(attestedAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();

  try {
    const result = await createDangerousBreedAttestation(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as {
          authorRole: string;
          authorOrganizationId: string | null;
          authorVerified: boolean;
        },
        registry,
        registryId,
        attestedAt,
        notes,
        uploadedPath: upload.uploadedPath,
        uploadedMimeType: upload.mimeType ?? null,
        uploadedSize: upload.size ?? null,
      },
      { repo, transaction: makeTransaction() },
    );
    if (!result.ok) {
      await cleanupAttachment(supabase, upload.uploadedPath);
      return { error: result.error };
    }
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar la atestación: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Note (WU-3 identity) — requirePetAccess (allows deceased/lost) PLUS the org
// capability gate, which is NOT what requirePetAccess does on its own.
// ---------------------------------------------------------------------------

export async function createNoteAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // PARITY: requirePetAccess (NOT requireAlivePetAccess) — allows deceased/lost pets.
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };

  // THE GATE IS THE RULE (PO decision 2026-08-26) — A BEHAVIOUR CHANGE.
  // -------------------------------------------------------------------------
  // The org ficha has always GATED the note form on `event.write`, and this
  // action never checked it. A server action is itself an addressable endpoint:
  // a member of a holding organization without the capability could invoke this
  // one directly and write a note the UI had already refused them. The wrapper
  // beside it (`orgRecordNoteAction`) does check — but it is a redirect adapter
  // anybody can bypass by calling this export, so its check was never the
  // boundary. The PO ratified the gate as the rule, so the boundary moves here.
  //
  // TWO THINGS DELIBERATELY DO NOT CHANGE:
  //   · The PERSON path. Any current holder — owner, co_owner, foster,
  //     caretaker — still writes notes with no capability to hold, because
  //     capabilities are an ORGANIZATION's vocabulary and a person's ownership
  //     row is not a membership.
  //   · The DECEASED animal, on BOTH paths. `requireAlivePetAccess` is still
  //     not the guard here. A closed life record is a fact about the ANIMAL and
  //     the PO ratified a rule about the CALLER; widening the animal-side rule
  //     would be a second, unratified behaviour change, and it would take the
  //     memorial note away from a shelter that held the animal when it died.
  if (access.accessPath === "org" && access.membership) {
    const granted = await getGrantedCapabilities(access.membership);
    if (!granted.has("event.write")) {
      // The same sentence `requireAlivePetAccess` returns for the clinical
      // writers, verbatim: one refusal, one wording, and it names the
      // capability so the person can ask an administrator for the right thing.
      return {
        error:
          "Necesitás el permiso 'Registrar eventos clínicos' (event.write). Pediselo a un administrador.",
      };
    }
  }

  const { supabase, user, pet, eventAuthorship } = access;

  const text = String(formData.get("text") ?? "").trim();
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const categoryRaw = String(formData.get("category") ?? "").trim();
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  if (!text) return { error: "Falta el contenido de la nota." };
  if (!occurredAtRaw) return { error: "Falta la fecha." };

  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const category = (NOTE_CATEGORIES as readonly string[]).includes(categoryRaw)
    ? categoryRaw
    : null;

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();

  try {
    const result = await createNote(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as {
          authorRole: string;
          authorOrganizationId: string | null;
          authorVerified: boolean;
        },
        text,
        occurredAt,
        category,
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
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo guardar la nota: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Vet visit (WU-4 clinical)
// ---------------------------------------------------------------------------

export async function createVetVisitAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { supabase, user, pet, eventAuthorship } = access;

  const reason = String(formData.get("reason") ?? "").trim();
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const diagnosis = String(formData.get("diagnosis") ?? "").trim() || null;
  const vetName = String(formData.get("vetName") ?? "").trim() || null;
  const clinic = String(formData.get("clinic") ?? "").trim() || null;
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;
  const loc = parseLocationFromFormData(formData);
  // locality:"none" — canonicalize province only (vet_visit behavior unchanged).
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "none" });
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  const eventJurisdictionProvince = normalizedLoc.province;
  const eventJurisdictionLocality = normalizedLoc.locality;

  if (!reason) return { error: "Falta el motivo de la visita." };
  if (!occurredAtRaw) return { error: "Falta la fecha." };

  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  const repo = new EventsRepository();

  try {
    const result = await createVetVisit(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as {
          authorRole: string;
          authorOrganizationId: string | null;
          authorVerified: boolean;
        },
        reason,
        occurredAt,
        diagnosis,
        vetName,
        clinic,
        notes,
        eventJurisdictionProvince,
        eventJurisdictionLocality,
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
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar la visita: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Clinical info (WU-4 clinical)
// ---------------------------------------------------------------------------

export async function createClinicalInfoAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { supabase, user, pet, eventAuthorship } = access;

  const subKindRaw = String(formData.get("subKind") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const details = String(formData.get("details") ?? "").trim() || null;
  const performedBy = String(formData.get("performedBy") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;
  const loc = parseLocationFromFormData(formData);
  // locality:"none" — canonicalize province only (clinical_info behavior unchanged).
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "none" });
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }
  const eventJurisdictionProvince = normalizedLoc.province;
  const eventJurisdictionLocality = normalizedLoc.locality;

  if (!(CLINICAL_SUB_KINDS as readonly string[]).includes(subKindRaw)) {
    return { error: "Tipo de información clínica inválido." };
  }
  const subKind = subKindRaw;
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

  try {
    const result = await createClinicalInfo(
      {
        pet: { id: pet.id },
        user: { id: user.id },
        eventAuthorship: eventAuthorship as {
          authorRole: string;
          authorOrganizationId: string | null;
          authorVerified: boolean;
        },
        subKind,
        title,
        details,
        performedBy,
        occurredAt,
        notes,
        eventJurisdictionProvince,
        eventJurisdictionLocality,
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
  } catch (err) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo guardar la información clínica: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Record disease diagnosis (WU-4 clinical) — VET-ONLY, NO ownership check
// ---------------------------------------------------------------------------

// Re-export types only (no value re-exports in "use server" files).
export type {
  RecordDiseaseDiagnosisWriterInput,
  RecordDiseaseDiagnosisWriterResult,
} from "./application/clinical/record-disease-diagnosis-use-case";

/**
 * A DUPLICATE OF `flushNotifications` IN `./application/writers.ts`, AND THE
 * REASON IT STAYS IS A FENCE RATHER THAN A PREFERENCE.
 *
 * There is no `./application/flush-notifications` module — an earlier version
 * of this docblock claimed one, and it never existed. The shared copy is the
 * EXPORT `flushNotifications` at `./application/writers.ts:77`, which two route
 * writers import: `app/api/v1/pets/[publicToken]/events/writers.ts:172` and
 * `app/api/v1/pets/[publicToken]/lost/commands.ts:99`. Collapsing this function
 * into that export was the obvious third step. It was tried, and
 * `pnpm lint:audit-log` went red one entry — a STALE one, which is the
 * direction that looks like progress:
 *
 *   app/org/[orgToken]/mascotas/[publicToken]/eventos/actions.ts#orgRecordNoteAction
 *
 * `check-audit-log-coverage` resolves reachability ONE HOP, and it says so in
 * its own header. `orgRecordNoteAction` calls `createNoteAction` — in THIS file
 * — so the fence reads this module's source looking for a mutation. The real
 * write is another hop away inside the note use-case, out of its reach. The
 * `db.insert(notifications)` below is the ONLY direct mutation left in this
 * file, which means it is the entire reason the fence can still see that an
 * unaudited operator action mutates the database.
 *
 * Deleting these lines does not fix that debt. It hides it, and then the fence
 * asks to have the baseline entry removed — a fence going blind while reporting
 * a clean ratchet. The duplicate stays until reachability is deepened or that
 * action gets its audit write, whichever comes first.
 */
async function flushNotifications(
  pending: import("./application/types").NewNotification[],
): Promise<void> {
  if (pending.length === 0) return;
  const { notifications } = await import("@/db");
  try {
    // biome-ignore lint/suspicious/noExplicitAny: NewNotification is structurally compatible with notifications.$inferInsert
    await db.insert(notifications).values(pending as any[]);
    // Web Push leg (ADR 2026-07-18 §4): urgent-only, best-effort, never throws.
    const { sendPushForNotifications } = await import("@/lib/infra/web-push");
    await sendPushForNotifications(pending);
  } catch (e) {
    console.error("notifications insert failed (action did succeed)", e);
  }
}

export async function recordDiseaseDiagnosisAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // VET-ONLY auth: role=vet + matriculaVerified=true. NO ownership check.
  const { user } = await requireUserOrRedirect();
  const [vetProfile] = await db
    .select({
      role: profiles.role,
      matriculaVerified: profiles.matriculaVerified,
      displayName: profiles.displayName,
    })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  if (!vetProfile || vetProfile.role !== "vet" || !vetProfile.matriculaVerified) {
    return { error: "Solo veterinarios con matrícula verificada pueden registrar diagnósticos." };
  }

  const diseaseCode = String(formData.get("diseaseCode") ?? "").trim();
  const confirmedByLab = checkboxOn(formData, "confirmedByLab");
  const labName = String(formData.get("labName") ?? "").trim() || null;
  const labReportRef = String(formData.get("labReportReference") ?? "").trim() || null;
  const diagnosisDateRaw = String(formData.get("diagnosisDate") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  if (!diseaseCode) return { error: "Falta el código de enfermedad." };
  const disease = findDisease(diseaseCode);
  if (!disease) return { error: "Código de enfermedad desconocido." };
  if (!diagnosisDateRaw) return { error: "Falta la fecha del diagnóstico." };
  const diagnosisDate = parseDateInput(diagnosisDateRaw);
  if (!diagnosisDate) return { error: "Fecha de diagnóstico inválida." };

  if (confirmedByLab && !labName) {
    return {
      error: "Para marcar como confirmado por laboratorio indicá el nombre del laboratorio.",
    };
  }

  // Resolve pet by publicToken — NO ownership check (vet can diagnose any pet;
  // that absence is deliberate and stays). Art. 16 (Ley 25.326): the deleted_at
  // filter is the ONLY addition — an erased pet answers the same "Mascota no
  // encontrada." as a token that never existed, so the verified-vet surface
  // does not become an erasure oracle, and no new event lands on the spine of
  // a credential the erasure switched off.
  const [pet] = await db
    .select()
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!pet) return { error: "Mascota no encontrada." };

  const plausibility = checkOccurredAtPlausible(diagnosisDate, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const repo = new EventsRepository();

  const result = await recordDiseaseDiagnosisWriter(
    {
      petId: pet.id,
      petName: pet.name,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      vetUserId: user.id,
      vetDisplayName: vetProfile.displayName,
      diseaseCode,
      confirmedByLab,
      labName,
      labReportReference: labReportRef,
      diagnosisDate,
      notes,
    },
    {
      repo,
      transaction: makeTransaction(),
      flushNotifications,
      enqueueEnoTrigger: enqueueEnoTriggerInTx,
    },
  );

  if (!result.ok) {
    return { error: `No se pudo registrar el diagnóstico: ${result.error}` };
  }
  return { error: null };
}

// ---------------------------------------------------------------------------
// Enfermedad reportada (vigilancia) — T4-I1 / issue #759
// ---------------------------------------------------------------------------
//
// `disease_reported` fed `/gob/vigilancia`, the novedades feed, the choropleth
// and the panorama's "activas hoy" formula, and had NO writer at all — the only
// way to produce one was a hand-written INSERT. This is that writer's edge.
//
// WHAT IS COPIED FROM `recordDiseaseDiagnosisAction`, EXACTLY — the header said
// "VERBATIM" and that was too strong, because the two doors differ in the one
// place that matters most (a security review, 2026-09-23):
//
//   COPIED: the AUTH GATE — role=vet AND matriculaVerified, no ownership check.
//     The two are the same act under two names (a professional notifying a
//     reportable disease), and two ENO paths answering "who may notify?"
//     differently is precisely the drift the confidence model had to be
//     rescued from once (#45).
//   COPIED: the pet lookup — same `deletedAt` filter, same refusal string, so
//     this surface does not become an erasure oracle (Art. 16, Ley 25.326).
//   NOT COPIED, AND CANNOT BE: the lab guard. The diagnosis action refuses
//     `confirmedByLab` without a `labName` (the `if` a few hundred lines above
//     this one). It CAN ask that because `clinical_info_logged` carries
//     `lab_name` / `lab_report_reference`; `disease_reported`'s strict schema
//     carries neither, so there is no field to demand.
//
// SO THIS DOOR DOES NOT OFFER THE FLAG AT ALL. `confirmed_by_lab: true` is the
// A4 bumper in lib/events/event-confidence.ts: it returns
// `institutional_verified` — the HIGHEST tier, above a vet's own signature —
// for ANY author, on an event feeding a government surveillance surface. A
// checkbox with no lab reference behind it would mint that claim with nothing
// to check it against, and `disease_reported` is deliberately absent from
// `AMENDABLE_EVENT_TYPES`, so a wrong one could never be corrected by an
// overlay. Lab confirmation belongs to the path that can record WHICH lab:
// `recordDiseaseDiagnosisAction`. This writer always files `false`.
//
// Re-offering it here is a SCHEMA decision, not a form change: give
// `diseaseReported` a lab reference first, then a guard like the diagnosis
// action's, then the field. In that order.

export async function createDiseaseReportedAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  const { user } = await requireUserOrRedirect();
  const [vetProfile] = await db
    .select({ role: profiles.role, matriculaVerified: profiles.matriculaVerified })
    .from(profiles)
    .where(eq(profiles.id, user.id))
    .limit(1);

  if (!vetProfile || vetProfile.role !== "vet" || !vetProfile.matriculaVerified) {
    return {
      error: "Solo veterinarios con matrícula verificada pueden reportar una enfermedad.",
    };
  }

  const disease = String(formData.get("disease") ?? "").trim();
  const dateOfOnsetRaw = String(formData.get("dateOfOnset") ?? "").trim();
  const clinicalNotes = String(formData.get("clinicalNotes") ?? "").trim() || null;
  // NOT READ FROM THE FORM, and the absence is the point — see the header. A
  // `confirmedByLab` field posted to this action is IGNORED rather than
  // refused, because a refusal would tell a caller the flag is nearly
  // available; it is not available at all until the schema can say which lab.

  // The enum is re-checked HERE and not left to the zod schema inside the
  // use-case, because a strict-schema throw surfaces as a 500-shaped "no se
  // pudo registrar" instead of the sentence a person can act on.
  if (!isDiseaseReportedCode(disease)) {
    return { error: "Elegí una enfermedad de la lista." };
  }
  if (!dateOfOnsetRaw) return { error: "Falta la fecha de inicio de los signos." };
  const occurredAt = parseDateInput(dateOfOnsetRaw);
  if (!occurredAt) return { error: "Fecha de inicio inválida." };

  const [pet] = await db
    .select()
    .from(pets)
    .where(and(eq(pets.publicToken, publicToken), isNull(pets.deletedAt)))
    .limit(1);
  if (!pet) return { error: "Mascota no encontrada." };

  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const result = await createDiseaseReported(
    {
      pet: {
        id: pet.id,
        jurisdictionProvince: pet.jurisdictionProvince ?? null,
        jurisdictionLocality: pet.jurisdictionLocality ?? null,
      },
      vet: { userId: user.id },
      // The vet is signing as a matriculated professional, which is what
      // `professional_verified` means — and it is resolved from the MATRÍCULA
      // checked above, never from a role label. No organization id: this door
      // is the individual's, not an org channel's.
      eventAuthorship: { authorRole: "vet", authorOrganizationId: null, authorVerified: true },
      disease,
      // ALWAYS FALSE, never the form's. A literal rather than a variable so
      // the one line a reader has to check is the one that carries the claim:
      // this writer cannot reach the A4 bumper, so the highest tier it can
      // produce is the vet's own `professional_verified`.
      confirmedByLab: false,
      dateOfOnset: dateOfOnsetRaw,
      occurredAt,
      clinicalNotes,
    },
    { repo: new EventsRepository(), transaction: makeTransaction() },
  );

  if (!result.ok) {
    return { error: `No se pudo registrar la enfermedad: ${result.error}` };
  }
  return { error: null };
}

// ---------------------------------------------------------------------------
// Disclosure prefs + enriched description form helpers (lifecycle)
// ---------------------------------------------------------------------------

function parseDisclosurePrefsFromForm(
  formData: FormData,
): import("./application/lifecycle/set-pet-lost-use-case").DisclosurePrefsInput {
  const checked = (name: string) => checkboxOn(formData, name);
  const hasSection = [
    "disclose_first_name_when_lost",
    "disclose_phone_when_lost",
    "disclose_email_when_lost",
    "disclose_last_location_when_lost",
    "allow_finder_form_when_lost",
  ].some((key) => formData.has(key));

  // cursor privacy P4: fail CLOSED. A caller that omits the disclosure section
  // entirely used to inherit the pet's current (possibly permissive) prefs via
  // a `petDefaults` fallback — but the only real caller (MarkLostWizard) always
  // submits all five fields explicitly via hidden inputs, so "section absent"
  // means no consent was expressed, not "keep whatever was there before".
  // Every toggle defaults to false rather than silently republishing PII.
  if (!hasSection) {
    return {
      discloseFirstNameWhenLost: false,
      disclosePhoneWhenLost: false,
      discloseEmailWhenLost: false,
      discloseLastLocationWhenLost: false,
      allowFinderFormWhenLost: false,
    };
  }

  return {
    discloseFirstNameWhenLost: checked("disclose_first_name_when_lost"),
    disclosePhoneWhenLost: checked("disclose_phone_when_lost"),
    discloseEmailWhenLost: checked("disclose_email_when_lost"),
    discloseLastLocationWhenLost: checked("disclose_last_location_when_lost"),
    allowFinderFormWhenLost: checked("allow_finder_form_when_lost"),
  };
}

function parseEnrichedDescriptionFromForm(
  formData: FormData,
): import("./application/lifecycle/set-pet-lost-use-case").EnrichedLostDescriptionInput | null {
  const enrichedKeys = [
    "enriched_color",
    "enriched_distinguishing_features",
    "enriched_accessories_when_lost",
    "enriched_behavior_notes",
    "enriched_last_seen_context",
    "enriched_microchip_id",
    "enriched_tattoo_code",
    "enriched_tattoo_location",
    "enriched_tattoo_description",
  ];

  const hasSection = enrichedKeys.some((k) => formData.has(k));
  if (!hasSection) return null;

  const str = (key: string) => String(formData.get(key) ?? "").trim() || null;

  return {
    color: str("enriched_color"),
    distinguishingFeatures: str("enriched_distinguishing_features"),
    accessoriesWhenLost: str("enriched_accessories_when_lost"),
    behaviorNotes: str("enriched_behavior_notes"),
    lastSeenContext: str("enriched_last_seen_context"),
    microchipId: str("enriched_microchip_id"),
    tattooCode: str("enriched_tattoo_code"),
    tattooLocation: str("enriched_tattoo_location"),
    tattooDescription: str("enriched_tattoo_description"),
  };
}

// ---------------------------------------------------------------------------
// Symptom observed (WU-5 surveillance-bridge)
// ---------------------------------------------------------------------------

// Re-export types only (no value re-exports in "use server" files).
export type {
  CreateSymptomObservedWriterParams as SymptomObservedWriterParams,
  CreateSymptomObservedWriterResult,
} from "./application/surveillance/symptom-observed-use-case";

export type SymptomFormState = {
  error: string | null;
  ok?: boolean;
  /** Same `redirectTo` contract as EventFormState (see its docblock). */
  redirectTo?: string;
};

export async function createSymptomObservedAction(
  publicToken: string,
  _previous: SymptomFormState,
  formData: FormData,
): Promise<SymptomFormState> {
  // AUTH: requireAlivePetAccess (alive pets only).
  const access = await requireAlivePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { pet, user, eventAuthorship } = access;

  const freeText = String(formData.get("freeText") ?? "").trim();
  if (!freeText) return { error: "Tenés que describir los síntomas." };

  const severityRaw = String(formData.get("severity") ?? "").trim();
  const severity: "mild" | "moderate" | "severe" | null =
    severityRaw === "mild" || severityRaw === "moderate" || severityRaw === "severe"
      ? severityRaw
      : null;

  const onsetRaw = String(formData.get("onsetAt") ?? "").trim();
  const onsetAt = onsetRaw.length > 0 ? onsetRaw : null;

  // Guard the optional date-only onset (the writer stamps occurredAt from it;
  // an unparseable value falls back to "now" inside the use-case, so only a
  // successfully parsed onset needs the plausibility check).
  if (onsetAt) {
    const onsetDate = parseDateInput(onsetAt);
    if (onsetDate) {
      const plausibility = checkOccurredAtPlausible(onsetDate, pet.dateOfBirth);
      if (plausibility) return plausibility;
    }
  }

  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  const repo = new EventsRepository();

  const result = await createSymptomObservedWriter(
    {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petSpecies: pet.species,
      petJurisdictionCountry: pet.jurisdictionCountry,
      petJurisdictionProvince: pet.jurisdictionProvince ?? null,
      petJurisdictionLocality: pet.jurisdictionLocality ?? null,
      rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
      recordedByUserId: user.id,
      eventAuthorship: eventAuthorship as {
        authorRole: string;
        authorOrganizationId: string | null;
        authorVerified: boolean;
      },
      freeText,
      severity,
      onsetAt,
      clientIdempotencyKey,
    },
    {
      repo,
      transaction: makeTransaction(),
      flushNotifications,
    },
  );

  if (!result.ok) {
    return { error: `No se pudo registrar el síntoma: ${result.error}` };
  }

  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/mis-mascotas/${publicToken}`);
  return {
    error: null,
    ok: true,
    redirectTo: `/mis-mascotas/${publicToken}?evento=sintoma_registrado`,
  };
}

// ---------------------------------------------------------------------------
// Set pet lost (WU-6 lifecycle) — writer re-export
// ---------------------------------------------------------------------------

// Re-export types only (no value re-exports in "use server" files).
export type {
  SetPetLostWriterParams,
  SetPetLostWriterResult,
  DisclosurePrefsInput,
  EnrichedLostDescriptionInput,
} from "./application/lifecycle/set-pet-lost-use-case";

/**
 * The pages whose content a lost/found flip changes, marked stale.
 *
 * Neither lost nor found revalidated anything until 2026-09-18 (T1-C1), unlike
 * every sibling pet mutation under src/modules/pets/application/{lost-mode,
 * tier2-public,service-dog,physical-tag-interest}. The owner could land back on
 * a profile still showing the lost-case block for an animal the database
 * already had as active — the stale page `ensurePetFound` in
 * e2e/demo/_helpers.ts documents. The public credential carries the lost
 * banner, and the pet list carries the status, so both go stale with it.
 *
 * Not exported: a "use server" module may only export async actions.
 */
async function revalidateLostStatePages(publicToken: string): Promise<void> {
  const { revalidatePath } = await import("next/cache");
  revalidatePath(`/mis-mascotas/${publicToken}`);
  revalidatePath(`/p/${publicToken}`);
  revalidatePath("/mis-mascotas");
}

export async function setPetLostAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // AUTH: requirePetAccess (accepts non-alive — lost pets can still update disclosure prefs).
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;

  const locationDescription = String(formData.get("locationAddress") ?? "").trim() || null;
  const reason = String(formData.get("reason") ?? "").trim() || null;

  const locationLatRaw = String(formData.get("locationLat") ?? "").trim() || null;
  const locationLngRaw = String(formData.get("locationLng") ?? "").trim() || null;

  // Validate coords through the gate.
  // - isFinite check preserved from before P2 (user error message unchanged).
  // - STEP 3 hardening: also reject out-of-range coords (previously not checked).
  if (locationLatRaw && locationLngRaw) {
    const latNum = Number.parseFloat(locationLatRaw);
    const lngNum = Number.parseFloat(locationLngRaw);
    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return { error: "Coordenadas inválidas. Tocá el mapa de nuevo para marcar el punto." };
    }
    if (latNum < -90 || latNum > 90 || lngNum < -180 || lngNum > 180) {
      return { error: "La ubicación está fuera de rango." };
    }
  }

  // Parse disclosure prefs from FormData (checkbox pattern). cursor privacy P4:
  // fails closed when the section is absent — see parseDisclosurePrefsFromForm.
  const disclosurePrefs = parseDisclosurePrefsFromForm(formData);
  const enrichedDescription = parseEnrichedDescriptionFromForm(formData);

  const repo = new EventsRepository();

  const { broadcastLostPet } = await import("@/lib/infra/lost-pet-broadcast");

  const result = await setPetLostWriter(
    {
      petId: pet.id,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petStatus: pet.status,
      petSpecies: pet.species,
      petBreed: pet.breed,
      petColor: pet.color,
      petJurisdictionProvince: pet.jurisdictionProvince,
      petJurisdictionLocality: pet.jurisdictionLocality,
      ownerUserId: user.id,
      ownerDisplayName: "",
      fromStatus: pet.status,
      recordedByUserId: user.id,
      eventAuthorship: eventAuthorship as Record<string, unknown>,
      locationDescription,
      locationLat: locationLatRaw,
      locationLng: locationLngRaw,
      reason,
      disclosurePrefs,
      enrichedDescription,
    },
    {
      repo,
      transaction: makeTransaction(),
      broadcastLostPet: broadcastLostPet as Parameters<
        typeof setPetLostWriter
      >[1]["broadcastLostPet"],
    },
  );

  if (result.error) return result;

  await revalidateLostStatePages(pet.publicToken);

  if (String(formData.get("noRedirect") ?? "") === "1") {
    return { error: null, ok: true };
  }

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Update lost last-seen (WU-6 lifecycle) — "ACTUALIZAR" on LostCaseBlock
// ---------------------------------------------------------------------------

// Re-export types only (no value re-exports in "use server" files).
export type {
  UpdateLostLastSeenParams,
  UpdateLostLastSeenResult,
} from "./application/lifecycle/update-lost-last-seen-use-case";

export async function updateLostLastSeenAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // AUTH: requirePetAccess (accepts non-alive), same as setPetLostAction/
  // setPetFoundAction — the use-case itself rejects non-'lost' status.
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;

  const locationDescription = String(formData.get("locationAddress") ?? "").trim() || null;
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  const loc = parseLocationFromFormData(formData);
  // locality:"none" — this flow doesn't validate against the INDEC catalog
  // (parity with setPetLostAction's own last-seen point capture); coords are
  // optional (an owner may want to log a text-only update with no map pin).
  let normalizedLoc: Awaited<ReturnType<typeof normalizeLocationForWrite>>;
  try {
    normalizedLoc = await normalizeLocationForWrite(loc, { locality: "none" });
  } catch (err) {
    if (err instanceof CoordError) {
      return { error: err.message };
    }
    throw err;
  }

  // Compose the note text from the address/reference + free-text note — the
  // note_added payload has a single required `text` field (no separate
  // location_description like status_changed has).
  const text = [locationDescription, reason].filter(Boolean).join(" — ") || null;

  const repo = new EventsRepository();

  const result = await updateLostLastSeen(
    {
      petId: pet.id,
      petStatus: pet.status,
      recordedByUserId: user.id,
      eventAuthorship: eventAuthorship as {
        authorRole: string;
        authorOrganizationId: string | null;
        authorVerified: boolean;
      },
      text,
      locationDescription,
      locationLat: normalizedLoc.lat != null ? String(normalizedLoc.lat) : null,
      locationLng: normalizedLoc.lng != null ? String(normalizedLoc.lng) : null,
      clientIdempotencyKey,
    },
    { repo, transaction: makeTransaction() },
  );

  if (result.error) return { error: result.error };

  // The new last-seen point is on the owner's profile and on the public lost
  // poster (/p/{token}); without this the owner lands on the redirect below and
  // sees the OLD point, which reads as "didn't save". Same set as lost/found.
  await revalidateLostStatePages(pet.publicToken);

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Set pet found (WU-6 lifecycle)
// ---------------------------------------------------------------------------

export async function setPetFoundAction(
  publicToken: string,
  _previous: EventFormState,
  _formData: FormData,
): Promise<EventFormState> {
  // AUTH: requirePetAccess (accepts non-alive).
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship } = access;

  const repo = new EventsRepository();

  // BOTH READS MOVED OUT, to `./application/lifecycle/found-notification-audience`,
  // when `POST /api/v1/pets/{token}/lost` needed the same pair. The first of
  // them carries a `role = 'owner'` filter that was missing until 2026-08-23 and
  // a comment explaining why the filter is right there and wrong in the sighting
  // flow; a second door that re-typed the query would have re-typed the bug.
  const ownerUserId = await resolveFoundConfirmationRecipient(pet.id, user.id);

  await setPetFound(
    {
      petId: pet.id,
      petStatus: pet.status,
      petPublicToken: pet.publicToken,
      petName: pet.name,
      petSex: pet.sex,
      recordedByUserId: user.id,
      ownerUserId,
      eventAuthorship: eventAuthorship as {
        authorRole: string;
        authorOrganizationId: string | null;
        authorVerified: boolean;
      },
    },
    {
      repo,
      transaction: makeTransaction(),
      findBroadcastRecipientUserIds,
      flushNotifications,
    },
  );

  await revalidateLostStatePages(pet.publicToken);

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}

// ---------------------------------------------------------------------------
// Reportar un mensaje del feed de modo perdida (moderación de contenido)
// ---------------------------------------------------------------------------

/**
 * REPORT ONE ITEM OF THE LOST-MODE FEED.
 *
 * IT LIVES HERE AND NOT IN `app/actions/lost-mode.ts`, and that distinction is
 * the codebase's, not mine. That file is a strangler shim under a line budget
 * and holds only the disclosure preference, which writes COLUMNS on `pets`. The
 * lost-mode commands that APPEND AN EVENT — mark lost, update the sighting,
 * mark found — live in this module, build their dependencies with
 * `new EventsRepository()` and `makeTransaction()`, and this does exactly what
 * they do a couple of functions above.
 *
 * PARITY WITH THE APP, NOT A SECOND POLICY. The native app sends
 * `report_content` to `POST /api/v1/pets/{token}/lost`; this action calls the
 * SAME use-case behind the SAME guard. Only the door differs.
 *
 * `requirePetAccess`, then ONE NARROWING. Whoever may READ this feed may report
 * an item on it — including the temporary caretaker, likely the person reading
 * the abusive message while the titular deals with other things. The ORG PATH
 * IS REFUSED, mirroring the API's `checkCommandGuard`: the hide is pet-global,
 * so an organization holding `shelter_custody` could otherwise make a finder's
 * "tengo a tu perro, llamame" vanish from the OWNER's cockpit. `LostCaseBlock`
 * withholds the control on its org variant so this refusal is never a button
 * that answers 403.
 *
 * NO STATE GATE. Reporting objects to a sentence; it asks nothing of the
 * animal's status. Requiring `lost` would mean somebody who already marked
 * their pet found could no longer take down a message received during the
 * search.
 *
 * RETURNS `EventFormState` RATHER THAN THROWING, like its siblings above, and
 * for a reason that is not symmetry: in production Next REDACTS the message of
 * an error crossing a Server Action boundary. A `throw` carrying "ese mensaje ya
 * no está en la búsqueda" would reach the client as "An error occurred in the
 * Server Components render" — the one branch a person actually reaches would be
 * the one branch they cannot read.
 */
export async function reportLostFeedItemAction(
  publicToken: string,
  targetEventId: string,
  category: ContentReportCategory,
  reason: string | null,
): Promise<EventFormState> {
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { user, pet, eventAuthorship, accessPath } = access;

  // THE ORG REFUSAL, ON THIS DOOR TOO. It lived only in the API's
  // `checkCommandGuard`, so the mobile door was closed and this one was wide
  // open — while three documents asserted the control existed. Withholding the
  // control in `LostCaseBlock` did NOT close it: the action is imported and
  // bound at module level in a component that renders on both variants, so its
  // action id ships to the org client and can simply be POSTed. A HIDDEN BUTTON
  // IS NOT AN AUTHORIZATION CONTROL.
  //
  // `requirePetAccess` returns ok for the org path and does not even check
  // `event.write` — that gate lives in `requireAlivePetAccess`, which this
  // action deliberately does not call. So the refusal has to be here, spelled
  // out, exactly as `reactivateLostSearchAction` spells its own.
  //
  // WHY: the hide is pet-global. An org holding `shelter_custody` could make a
  // finder's "tengo a tu perro, llamame" disappear from the OWNER's feed,
  // counter, credential, /perdidas and /casos — silently, irreversibly, at the
  // moment a search is about to end, in a product with custody disputes as a
  // first-class concept. A caretaker keeps the affordance: they come through
  // the PERSON path, which the titular opened for them.
  if (accessPath === "org") {
    return { error: "Solo quien tiene a la mascota a su cargo puede reportar un mensaje." };
  }

  const result = await reportLostFeedItem(
    {
      petId: pet.id,
      targetEventId,
      category,
      reason,
      recordedByUserId: user.id,
      eventAuthorship: eventAuthorship as {
        authorRole: string;
        authorOrganizationId: string | null;
        authorVerified: boolean;
      },
    },
    { repo: new EventsRepository(), transaction: makeTransaction() },
  );

  // The named row is not a reportable item of THIS pet. A non-existent id, one
  // belonging to another animal, and a scan all answer identically on purpose:
  // telling them apart would make this an oracle for which event ids are real.
  if (result.error === "TARGET_INVALID") {
    return { error: "Ese mensaje ya no está en la búsqueda. Actualizá la página." };
  }

  // NO `redirectTo`. The other actions in this family send the caller to the
  // pet's page because they changed the animal's state; here the person stays
  // where they are and the row disappears when the page is re-derived. Who
  // navigates is the client's call, and the list is recomputed on read.
  return { error: null, ok: true };
}

// ---------------------------------------------------------------------------
// Death record (WU-6 lifecycle — multi-cascade)
// ---------------------------------------------------------------------------

export async function createDeathRecordAction(
  publicToken: string,
  _previous: EventFormState,
  formData: FormData,
): Promise<EventFormState> {
  // AUTH: requirePetAccess (accepts non-alive — deceased guard is inside the writer).
  const access = await requirePetAccess(publicToken);
  if (!access.ok) return { error: access.error };
  const { supabase, user, pet, eventAuthorship } = access;

  if (pet.status === "deceased")
    return { error: "Esta mascota ya está registrada como fallecida." };

  const {
    DEATH_CAUSES: DC,
    DISPOSITION_METHODS: DM,
    VET_CONTACT_VALUES: VCV,
  } = await import("./domain/death-rules");

  const cause = String(formData.get("cause") ?? "").trim();
  const causeDetail = String(formData.get("causeDetail") ?? "").trim() || null;
  const confirmedByVet = formData.get("confirmedByVet") === "true";
  const vetName = String(formData.get("vetName") ?? "").trim() || null;
  const dispositionMethodRaw = String(formData.get("dispositionMethod") ?? "").trim();
  const facility = String(formData.get("facility") ?? "").trim() || null;
  const occurredAtRaw = String(formData.get("occurredAt") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim() || null;

  const deathAtClinic = formData.get("deathAtClinic") === "true";
  const clinicName = String(formData.get("clinicName") ?? "").trim() || null;
  const vetContactedOwnerRaw = String(formData.get("vetContactedOwner") ?? "").trim();
  const vetDecidedAlone = formData.get("vetDecidedAlone") === "true";
  const ownerToPrivateCrematorium = formData.get("ownerToPrivateCrematorium") === "true";

  if (!(DC as readonly string[]).includes(cause))
    return { error: "Causa de fallecimiento inválida." };
  if (!occurredAtRaw) return { error: "Falta la fecha." };

  const occurredAt = parseDateInput(occurredAtRaw);
  if (!occurredAt) return { error: "Fecha inválida." };
  // A future death date is an impossible record (PO decision 2026-07-16 —
  // same family as the P4 guard on the medical writers above).
  const plausibility = checkOccurredAtPlausible(occurredAt, pet.dateOfBirth);
  if (plausibility) return plausibility;

  const dispositionMethod = dispositionMethodRaw === "" ? null : dispositionMethodRaw;
  if (dispositionMethod !== null && !(DM as readonly string[]).includes(dispositionMethod)) {
    return { error: "Método de disposición inválido." };
  }

  const vetContactedOwner = vetContactedOwnerRaw === "" ? null : vetContactedOwnerRaw;
  if (vetContactedOwner !== null && !(VCV as readonly string[]).includes(vetContactedOwner)) {
    return { error: "Valor de contacto del veterinario inválido." };
  }

  if (clinicName && !deathAtClinic) {
    return {
      error: "Indicaste un nombre de clínica pero no marcaste que falleció en una veterinaria.",
    };
  }
  if (vetContactedOwner && !deathAtClinic) {
    return { error: "El contacto del veterinario solo aplica si falleció en una veterinaria." };
  }
  if (vetDecidedAlone && vetContactedOwner !== "no") {
    return {
      error:
        "Solo se puede marcar 'vet decidió sin contacto' cuando el veterinario no logró contactar al propietario.",
    };
  }

  const diseaseCodeRaw = String(formData.get("diseaseCode") ?? "").trim() || null;
  const confirmedByLab = formData.get("confirmedByLab") === "true";
  const clientIdempotencyKey = String(formData.get("clientIdempotencyKey") ?? "").trim() || null;

  const diseaseCode = cause === "disease" && diseaseCodeRaw ? diseaseCodeRaw : null;
  if (diseaseCode && !findDisease(diseaseCode)) {
    return { error: "Enfermedad no reconocida." };
  }
  const { isReportable } = await import("@/lib/reference/diseases");
  const reportable = isReportable(diseaseCode);

  const attachmentFile = formData.get("attachment") as File | null;
  const upload = await uploadAttachmentIfPresent(supabase, attachmentFile, "event-attachments");
  if (upload.error) return { error: upload.error };

  // Look up custody_episode BEFORE the tx — stamp caseId on the death event.
  const { findOpenCaseForPetAndKind } = await import("@/lib/infra/case-helpers");
  const custodyEpisodeCaseForDeath = await findOpenCaseForPetAndKind(pet.id, "custody_episode");

  const repo = new EventsRepository();

  const result = await createDeathRecord(
    {
      pet: {
        id: pet.id,
        name: pet.name,
        status: pet.status,
        rabiesObservationStatus: pet.rabiesObservationStatus ?? null,
        jurisdictionProvince: pet.jurisdictionProvince ?? null,
        jurisdictionLocality: pet.jurisdictionLocality ?? null,
      },
      recordedByUserId: user.id,
      eventAuthorship: eventAuthorship as {
        authorRole: string;
        authorOrganizationId: string | null;
        authorVerified: boolean;
      },
      cause,
      causeDetail,
      confirmedByVet,
      vetName,
      dispositionMethod,
      facility,
      occurredAt,
      notes,
      deathAtClinic,
      clinicName,
      vetContactedOwner,
      vetDecidedAlone,
      ownerToPrivateCrematorium,
      diseaseCode,
      confirmedByLab,
      isReportable: reportable,
      uploadedPath: upload.uploadedPath,
      uploadedMimeType: upload.mimeType ?? null,
      uploadedSize: upload.size ?? null,
      clientIdempotencyKey,
      custodyEpisodeCaseId: custodyEpisodeCaseForDeath?.id ?? null,
    },
    {
      repo,
      transaction: makeTransaction(),
      flushNotifications,
    },
  );

  if (!result.ok) {
    await cleanupAttachment(supabase, upload.uploadedPath);
    return {
      error: `No se pudo registrar el fallecimiento: ${result.error}`,
    };
  }

  // T9.13/T9.14 — gate, copy and failure policy in lib/infra/caretaker-activity-alert.ts.
  await announceCaretakerDeathRecord(access, result.insertedEventId);

  return { error: null, ok: true, redirectTo: `/mis-mascotas/${publicToken}` };
}
