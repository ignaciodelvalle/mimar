// Use-case: submit an anonymous contact message to an organization.
//
// No auth required — public form.
// Rate limits enforced by caller-provided enforceRateLimit dep (injectable for testing).

import type {
  InsertContactInput,
  OrgRepository,
} from "@/src/modules/organizations/infrastructure/org-repository";
import type { UseCaseResult } from "./types";

// ---------------------------------------------------------------------------
// Repo interface
// ---------------------------------------------------------------------------

export interface SubmitOrgContactRepo {
  findOrgByToken: OrgRepository["findOrgByToken"];
  insertContact: OrgRepository["insertContact"];
  /**
   * Admins de la org — destinatarios del aviso. Sin esto el mensaje entraba a
   * `org_contact_messages` y NADIE se enteraba: la tabla no tenía lector, el
   * portal no tenía bandeja, y el caso de uso devolvía `notifications: []`
   * mientras la UI prometía "te contactan por email" (auditoría 2026-08-04).
   */
  adminRecipients: OrgRepository["adminRecipients"];
}

// ---------------------------------------------------------------------------
// Input / Deps
// ---------------------------------------------------------------------------

export type SubmitOrgContactInput = {
  orgToken: string;
  kind: "contact" | "volunteer";
  name: string | null | undefined;
  email: string;
  message: string;
  ip: string;
};

type Deps = {
  repo: SubmitOrgContactRepo;
  /**
   * Injectable rate-limit enforcer. Throws when the limit is exceeded.
   * The caller provides the key — this use-case passes org-id-specific keys.
   */
  enforceRateLimit: (
    key: string,
    cohort: string,
    opts: { maxPerMinute?: number; maxPerDay?: number },
  ) => Promise<void>;
  /** Optional: classify a thrown error as a rate-limit error. Defaults to never. */
  isRateLimitError?: (err: unknown) => boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LEN = 500;
const MAX_NAME_LEN = 100;
const MAX_EMAIL_LEN = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function submitOrgContact(
  input: SubmitOrgContactInput,
  deps: Deps,
): Promise<UseCaseResult<Record<never, never>>> {
  const { repo, enforceRateLimit, isRateLimitError } = deps;

  // 1. Resolve org.
  const org = await repo.findOrgByToken(input.orgToken);
  if (!org) {
    return { ok: false, error: "Refugio no encontrado." };
  }

  // 2. Validate inputs.
  const name =
    (typeof input.name === "string" ? input.name.trim().slice(0, MAX_NAME_LEN) : null) || null;
  const email = input.email.trim().toLowerCase();
  const message = input.message.trim();

  if (!email || !EMAIL_PATTERN.test(email) || email.length > MAX_EMAIL_LEN) {
    return { ok: false, error: "Indicá un email válido para que puedan responderte." };
  }
  if (message.length < 10) {
    return { ok: false, error: "El mensaje es muy corto (mínimo 10 caracteres)." };
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return { ok: false, error: `El mensaje supera los ${MAX_MESSAGE_LEN} caracteres.` };
  }

  // 3. Rate limits.
  try {
    await enforceRateLimit("org_contact_ip", input.ip, { maxPerMinute: 3, maxPerDay: 5 });
    await enforceRateLimit(`org_contact_org:${org.id}`, "any", { maxPerDay: 20 });
  } catch (err) {
    if (isRateLimitError ? isRateLimitError(err) : false) {
      return {
        ok: false,
        error: "Ya enviaste varios mensajes hace poco. Esperá un rato y probá de nuevo, por favor.",
      };
    }
    throw err;
  }

  // 4. Persist.
  const contactInput: InsertContactInput = {
    organizationId: org.id,
    kind: input.kind,
    inquirerName: name,
    inquirerEmail: email,
    message,
    submitterIp: input.ip === "unknown" ? null : input.ip,
  };
  await repo.insertContact(contactInput);

  // Avisar a los admins de la org. El mensaje ya está persistido; la
  // notificación es lo que lo vuelve legible por un humano — sin ella, la
  // promesa de la UI ("te contactan") no la puede cumplir nadie.
  const admins = await repo.adminRecipients(org.id);
  const esVoluntario = input.kind === "volunteer";
  const notifications = admins.map((admin) => ({
    userId: admin.userId,
    notificationType: esVoluntario ? "org_volunteer_message" : "org_contact_message",
    title: esVoluntario ? "Alguien quiere ser voluntario" : "Mensaje nuevo de contacto",
    body: esVoluntario
      ? `${name ?? "Una persona"} se ofreció como voluntario/a y dejó ${email} para que la contacten.`
      : `${name ?? "Una persona"} escribió desde el perfil público y dejó ${email} para que le respondan.`,
    severity: "info" as const,
    ctaLabel: "Ver mensajes",
    ctaUrl: `/org/${input.orgToken}/mensajes`,
  }));

  return { ok: true, value: {}, notifications };
}
