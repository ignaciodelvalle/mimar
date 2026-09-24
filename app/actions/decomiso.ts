"use server";

// Decomiso (Ley 14.346) — thin server action controllers.
//
// Business logic lives in src/modules/decomiso/application/.
// This file: auth guard → delegate to use-case → deliver notifications → return.
//
// Spec: docs/superpowers/specs/2026-05-19-decomiso-welfare-authority-design.md §5.1–5.3.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db, organizations } from "@/db";
import { decomisoEvidenceRowPath } from "@/lib/infra/attachment-location";
import { requireDecomisoPrincipal } from "@/lib/infra/auth-guards";
import {
  type EndedCaretakerGrant,
  notifyCaretakersOfHandoff,
} from "@/lib/infra/end-pet-ownerships";
import { MAX_DECOMISO_EVIDENCE_TOTAL_BYTES } from "@/lib/media/limits";
import {
  type DecomisoEvidenceMime,
  MAX_DECOMISO_EVIDENCE_BYTES,
  decomisoEvidenceExtension,
  detectDecomisoEvidenceMime,
} from "@/lib/media/validate";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCapability } from "@/src/modules/organizations/infrastructure/authz-resolver";

import { resolveGovtOrgForUser } from "@/src/modules/decomiso/application/resolve-govt-org";

import { deliverDecomisoNotifications } from "@/src/modules/decomiso/application/deliver-decomiso-notifications";

import {
  acceptDecomisoHandoffInTx,
  validateAcceptDecomisoHandoff,
} from "@/src/modules/decomiso/application/accept-decomiso-handoff";
import {
  executeDecomiso,
  validateExecuteDecomiso,
} from "@/src/modules/decomiso/application/execute-decomiso";
import {
  reassignDecomisoInTx,
  validateReassignDecomiso,
} from "@/src/modules/decomiso/application/reassign-decomiso";
import {
  rejectDecomisoHandoffInTx,
  validateRejectDecomisoHandoff,
} from "@/src/modules/decomiso/application/reject-decomiso-handoff";
import {
  returnCustodyToOwnerInTx,
  validateReturnCustodyToOwner,
} from "@/src/modules/decomiso/application/return-custody-to-owner";
import { ATTACHMENT_BUCKET, type NewNotification } from "@/src/modules/decomiso/domain/types";

// ---------------------------------------------------------------------------
// Re-export public types (callers must not change)
// ---------------------------------------------------------------------------

// `warning` is set when the act SUCCEEDED but one or more notifications could
// not be delivered. It is not an error: the decomiso stands, and undoing a
// recorded seizure over a notification blip would be worse. But the funcionario
// has to be told, because an in-app row is the only channel this product has —
// there is no email leg anywhere in lib/infra/ — so a lost notification means
// the person is simply never informed. The failed payloads are parked in
// notification_dead_letter by the delivery path, so the trail survives too.
export type ExecuteDecomisoResult =
  | { ok: true; publicCode: string; warning?: string | null }
  | { error: string };
export type DecomisoHandshakeResult =
  | { ok: true; publicCode: string; warning?: string | null }
  | { error: string };

export type SeizureMotive =
  | "maltrato_fisico"
  | "abandono_extremo"
  | "acumulacion"
  | "trafico"
  | "sin_refugio_critico"
  | "pelea_de_perros"
  | "otro";

export interface UnownedAnimalInput {
  species: string;
  sex: "male" | "female" | "unknown";
  breed?: string | null;
  color?: string | null;
  distinguishingFeatures?: string | null;
  approxAgeMonths?: number | null;
}

export interface ExecuteDecomisoInput {
  subjectKind: "registered_pet" | "unowned_animal";
  petPublicToken?: string | null;
  unownedAnimal?: UnownedAnimalInput | null;
  seizureMotive: SeizureMotive;
  seizureMotiveOtherDetail?: string | null;
  judicialProceedingReference?: string | null;
  originatingWelfareReportId?: string | null;
  intendedReceiverOrganizationId: string;
  intakeCondition?: string | null;
  attachmentFiles: File[];
}

// ---------------------------------------------------------------------------
// executeDecomisoAction
// ---------------------------------------------------------------------------

export async function executeDecomisoAction(
  input: ExecuteDecomisoInput,
): Promise<ExecuteDecomisoResult> {
  // ---- 1. Auth -----------------------------------------------------------
  const session = await requireDecomisoPrincipal();
  const { user } = session;

  if (session.profile.role === "govt" && session.jurisdictions.length === 0) {
    return {
      error:
        "No tenés jurisdicciones activas asignadas. Contactá al administrador para ejecutar un decomiso.",
    };
  }

  // ---- 2. Resolve govt org -----------------------------------------------
  const govtOrg = await resolveGovtOrgForUser(user.id);
  if (!govtOrg) {
    return {
      error:
        "Tu usuario no está asociado a ninguna autoridad sanitaria. Contactá al administrador para configurar tu organización.",
    };
  }

  if (!govtOrg.jurisdictionProvince) {
    return {
      error: "La organización sanitaria no tiene provincia asignada. Contactá al administrador.",
    };
  }

  // ---- 3. Pre-tx validation (module use-case) ----------------------------
  // Seizure motive, receiver org, attachments, subject-kind branch
  // (jurisdiction scope + double-seizure guard) live in the decomiso module.
  const validated = await validateExecuteDecomiso(input, { session, govtOrg }, db);
  if (!validated.ok) return { error: validated.error };
  const { receiverOrg: validatedReceiverOrg, existingPet } = validated;

  // ---- 7. Upload attachments to Storage (before the DB transaction) ------
  const supabaseAdmin = createAdminClient();
  const attachmentDir = randomUUID();

  type UploadedAttachment = {
    filename: string;
    /** The `attachments.storage_path` — bucket-prefixed (attachment-location.ts). */
    storagePath: string;
    /** The key inside ATTACHMENT_BUCKET, for the compensating remove. */
    objectPath: string;
    mimeType: string;
    size: number;
  };
  const uploadedAttachments: UploadedAttachment[] = [];

  // Type by BYTES, for every file, before ANY upload (A07-4). The client's
  // `file.type` and filename extension decide nothing: the stored content type
  // is the detected one and the object key's extension is derived from it. A
  // refusal here leaves nothing in the bucket to clean up.
  //
  // JPG/PNG/WEBP photos and the PDF acta, up to 10 MiB each: exactly what the
  // private `decomiso-evidence` bucket (db/migrations/0234) admits — PO
  // decision D10 (2026-09-18). A PDF is recognised by its `%PDF-` signature,
  // never by its name or declared type. Only the service role writes there.
  // The bytes are stored as they arrived — no re-encode, no metadata strip —
  // by PO decision D7 (2026-09-18): the EXIF/GPS of seizure evidence is itself
  // evidence. Readers sign it only for viewers who read the decomiso itself
  // (lib/infra/decomiso-evidence-access.ts), never for everyone with pet access.
  const typedFiles: Array<{
    file: File;
    buffer: Buffer;
    mimeType: DecomisoEvidenceMime;
  }> = [];
  // The TOTAL ceiling, mirrored from the form: the browser pre-check is a
  // courtesy, this is the rule (security review 2026-09-18, LOW).
  const totalBytes = input.attachmentFiles.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_DECOMISO_EVIDENCE_TOTAL_BYTES) {
    return {
      error: `Los archivos juntos superan los ${MAX_DECOMISO_EVIDENCE_TOTAL_BYTES / (1024 * 1024)} MB.`,
    };
  }
  for (const file of input.attachmentFiles) {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.byteLength > MAX_DECOMISO_EVIDENCE_BYTES) {
      return {
        error: `"${file.name}" supera el límite de ${MAX_DECOMISO_EVIDENCE_BYTES / (1024 * 1024)} MB.`,
      };
    }
    const mimeType = detectDecomisoEvidenceMime(buffer);
    if (!mimeType) {
      return {
        error: `El archivo "${file.name}" no es una imagen JPG, PNG o WEBP ni un PDF.`,
      };
    }
    typedFiles.push({ file, buffer, mimeType });
  }

  for (const { file, buffer, mimeType } of typedFiles) {
    const objectPath = `${attachmentDir}/${randomUUID()}.${decomisoEvidenceExtension(mimeType)}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from(ATTACHMENT_BUCKET)
      .upload(objectPath, buffer, { contentType: mimeType });

    if (uploadError) {
      if (uploadedAttachments.length > 0) {
        await supabaseAdmin.storage
          .from(ATTACHMENT_BUCKET)
          .remove(uploadedAttachments.map((u) => u.objectPath));
      }
      return {
        error: `No se pudo subir el adjunto "${file.name}": ${uploadError.message}`,
      };
    }
    uploadedAttachments.push({
      filename: file.name,
      storagePath: decomisoEvidenceRowPath(objectPath),
      objectPath,
      mimeType,
      size: buffer.byteLength,
    });
  }

  // ---- 8. Run the transaction via use-case -------------------------------
  let createdPublicCode = "";
  let pendingNotifications: NewNotification[] = [];
  let endedGrants: EndedCaretakerGrant[] = [];
  let seizedPet: { name: string; publicToken: string } | null = null;

  try {
    await db.transaction(async (tx) => {
      const result = await executeDecomiso(
        input,
        {
          user,
          govtOrg: govtOrg as typeof govtOrg & { jurisdictionProvince: string },
          receiverOrg: validatedReceiverOrg,
          existingPet,
          unownedData:
            input.subjectKind === "unowned_animal" ? (input.unownedAnimal ?? null) : null,
          uploadedAttachments,
        },
        tx,
      );

      if (!result.ok) throw new Error(result.error);
      createdPublicCode = result.publicCode;
      pendingNotifications = result.pendingNotifications as NewNotification[];
      endedGrants = result.endedCaretakerGrants;
      seizedPet = result.seizedPet;
    });
  } catch (err) {
    // Compensating cleanup: best-effort delete uploaded blobs on tx failure.
    if (uploadedAttachments.length > 0) {
      await supabaseAdmin.storage
        .from(ATTACHMENT_BUCKET)
        .remove(uploadedAttachments.map((u) => u.objectPath))
        .catch((cleanupErr) => {
          console.error("storage cleanup after failed decomiso tx (best-effort)", cleanupErr);
        });
    }
    return {
      error: `No se pudo ejecutar el decomiso: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  // Deliver notifications outside the main tx. Durable (dead-lettered on
  // failure) and VISIBLE (the warning rides back to the operator) — see
  // deliver-decomiso-notifications.ts for why a swallowed failure here was the
  // worst of the five identical sites.
  const delivery = await deliverDecomisoNotifications(pendingNotifications, {
    casePublicCode: createdPublicCode,
    stage: "executed",
  });

  // A temporary caretaker whose arrangement this seizure ended. They just lost
  // access and the animal is gone from their hands; the ownership notices above
  // go to the titular and the orgs, never to them.
  if (endedGrants.length > 0 && seizedPet) {
    await notifyCaretakersOfHandoff(endedGrants, seizedPet);
  }

  revalidatePath("/gob/decomisos");
  return { ok: true, publicCode: createdPublicCode, warning: delivery.warning };
}

// ---------------------------------------------------------------------------
// acceptDecomisoHandoffAction
// ---------------------------------------------------------------------------

export async function acceptDecomisoHandoffAction(input: {
  receiverOrgToken: string;
  casePublicCode: string;
}): Promise<DecomisoHandshakeResult> {
  // Resolve the receiver org by publicToken first to pin requireCapability.
  const [receiverOrgByToken] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, input.receiverOrgToken))
    .limit(1);
  if (!receiverOrgByToken) {
    return { error: "Organización destinataria no encontrada." };
  }

  const auth = await requireCapability("org.transfer.accept", receiverOrgByToken.id);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  // Defense-in-depth: verify token matches the capability-resolved org.
  if (organization.publicToken !== input.receiverOrgToken) {
    return { error: "Estás operando desde una organización distinta a la destinataria." };
  }

  // Pre-tx validation.
  const validated = await validateAcceptDecomisoHandoff(
    { casePublicCode: input.casePublicCode },
    { user, organization },
    db,
  );
  if (!validated.ok) return { error: validated.error };
  const { caseRow, govtOrgId, govtOrgName } = validated;

  let pendingNotifications: NewNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      const result = await acceptDecomisoHandoffInTx(
        caseRow,
        govtOrgId,
        govtOrgName,
        { user, organization },
        tx,
      );
      pendingNotifications = result.pendingNotifications as NewNotification[];
    });
  } catch (err) {
    return {
      error: `No se pudo aceptar el handoff de decomiso: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  const delivery = await deliverDecomisoNotifications(pendingNotifications, {
    casePublicCode: input.casePublicCode,
    stage: "handoff_accepted",
  });

  revalidatePath(`/org/${input.receiverOrgToken}/transferencias/recibidas`);
  revalidatePath("/gob/decomisos");
  return { ok: true, publicCode: input.casePublicCode, warning: delivery.warning };
}

// ---------------------------------------------------------------------------
// rejectDecomisoHandoffAction
// ---------------------------------------------------------------------------

export async function rejectDecomisoHandoffAction(input: {
  receiverOrgToken: string;
  casePublicCode: string;
  reason?: string | null;
  message?: string | null;
}): Promise<DecomisoHandshakeResult> {
  const [receiverOrgByToken] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.publicToken, input.receiverOrgToken))
    .limit(1);
  if (!receiverOrgByToken) {
    return { error: "Organización destinataria no encontrada." };
  }

  const auth = await requireCapability("org.transfer.accept", receiverOrgByToken.id);
  if (auth.error !== null) return { error: auth.error };
  const { user, organization } = auth;

  if (organization.publicToken !== input.receiverOrgToken) {
    return { error: "Estás operando desde una organización distinta a la destinataria." };
  }

  // Pre-tx validation.
  const validated = await validateRejectDecomisoHandoff(
    { casePublicCode: input.casePublicCode, reason: input.reason, message: input.message },
    { user, organization },
    db,
  );
  if (!validated.ok) return { error: validated.error };
  const { caseRow, govtOrgId, reasonNote } = validated;

  let pendingNotifications: NewNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      const result = await rejectDecomisoHandoffInTx(
        caseRow,
        govtOrgId,
        reasonNote,
        { user, organization },
        tx,
      );
      pendingNotifications = result.pendingNotifications as NewNotification[];
    });
  } catch (err) {
    return {
      error: `No se pudo rechazar el handoff de decomiso: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  const delivery = await deliverDecomisoNotifications(pendingNotifications, {
    casePublicCode: input.casePublicCode,
    stage: "handoff_rejected",
  });

  revalidatePath(`/org/${input.receiverOrgToken}/transferencias/recibidas`);
  revalidatePath("/gob/decomisos");
  return { ok: true, publicCode: input.casePublicCode, warning: delivery.warning };
}

// ---------------------------------------------------------------------------
// reassignDecomisoToAnotherReceiverAction
// ---------------------------------------------------------------------------

export async function reassignDecomisoToAnotherReceiverAction(input: {
  casePublicCode: string;
  newReceiverOrgId: string;
  reason?: string | null;
}): Promise<DecomisoHandshakeResult> {
  // 1. Auth.
  const session = await requireDecomisoPrincipal();
  const { user } = session;

  if (session.profile.role === "govt" && session.jurisdictions.length === 0) {
    return {
      error: "No tenés jurisdicciones activas asignadas para reasignar un decomiso.",
    };
  }

  // 2. Resolve govt org.
  const govtOrg = await resolveGovtOrgForUser(user.id);
  if (!govtOrg) {
    return {
      error: "Tu usuario no está asociado a ninguna autoridad sanitaria.",
    };
  }

  // 3+4. Pre-tx validation (module use-case): case load + open-episode
  // checks, opener authorization, new-receiver rules, pet-name resolution.
  const validated = await validateReassignDecomiso(
    input,
    { govtOrg, actor: { role: session.profile.role, jurisdictions: session.jurisdictions } },
    db,
  );
  if (!validated.ok) return { error: validated.error };
  const { caseRow, newReceiverOrg: validatedNewReceiverOrg, petName, reassignReason } = validated;

  let pendingNotifications: NewNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      const result = await reassignDecomisoInTx(
        caseRow,
        validatedNewReceiverOrg,
        petName,
        reassignReason,
        { user, govtOrg },
        tx,
      );
      pendingNotifications = result.pendingNotifications as NewNotification[];
    });
  } catch (err) {
    return {
      error: `No se pudo reasignar el decomiso: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  const delivery = await deliverDecomisoNotifications(pendingNotifications, {
    casePublicCode: input.casePublicCode,
    // Distinct per reassignment: a case can be reassigned more than once, and a
    // dedupe key shared with the first would swallow the second announcement.
    stage: `reassigned:${input.newReceiverOrgId}`,
  });

  revalidatePath("/gob/decomisos");
  return { ok: true, publicCode: input.casePublicCode, warning: delivery.warning };
}

// ---------------------------------------------------------------------------
// returnCustodyToOwnerAction
// ---------------------------------------------------------------------------

export async function returnCustodyToOwnerAction(input: {
  casePublicCode: string;
}): Promise<DecomisoHandshakeResult> {
  // 1. Auth.
  const session = await requireDecomisoPrincipal();
  const { user } = session;

  if (session.profile.role === "govt" && session.jurisdictions.length === 0) {
    return {
      error: "No tenés jurisdicciones activas asignadas para devolver un decomiso.",
    };
  }

  // 2. Resolve govt org.
  const govtOrg = await resolveGovtOrgForUser(user.id);
  if (!govtOrg) {
    return {
      error: "Tu usuario no está asociado a ninguna autoridad sanitaria.",
    };
  }

  // 3. Pre-tx validation (module use-case): case load + open-episode checks,
  // opener authorization, immediate former-owner derivation.
  const validated = await validateReturnCustodyToOwner(
    input,
    { govtOrg, actor: { role: session.profile.role, jurisdictions: session.jurisdictions } },
    db,
  );
  if (!validated.ok) return { error: validated.error };
  const { caseRow, formerOwner, petName, petPublicToken } = validated;

  let pendingNotifications: NewNotification[] = [];

  try {
    await db.transaction(async (tx) => {
      const result = await returnCustodyToOwnerInTx(
        caseRow,
        formerOwner,
        petName,
        { user, govtOrg },
        tx,
      );
      pendingNotifications = result.pendingNotifications as NewNotification[];
    });
  } catch (err) {
    return {
      error: `No se pudo devolver la mascota al dueño: ${err instanceof Error ? err.message : "error desconocido"}`,
    };
  }

  const delivery = await deliverDecomisoNotifications(pendingNotifications, {
    casePublicCode: input.casePublicCode,
    stage: "returned_to_owner",
  });

  revalidatePath("/gob/decomisos");
  revalidatePath(`/gob/casos/${input.casePublicCode}`);
  if (petPublicToken) {
    revalidatePath(`/mis-mascotas/${petPublicToken}`);
  }
  revalidatePath("/mis-mascotas");
  return { ok: true, publicCode: input.casePublicCode, warning: delivery.warning };
}
