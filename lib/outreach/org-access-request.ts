// Access request from an organization (refugio, veterinaria, red de rescate)
// — validation, abuse checks and the mail it becomes (critique 2026-09-29, M8).
//
// WHY IT EXISTS
// ---------------------------------------------------------------------------
// The landing's "Solicitar acceso" for organizations used to lead to
// /registro, the OWNER's sign-up ("Creá la libreta digital de tu mascota"):
// an organization landed in the wrong flow. Onboarding an organization stays
// admin-driven (an admin creates and verifies it); what an organization needs
// from the public site is a way to ASK. This is that way.
//
// WHAT HAPPENS TO A REQUEST
// ---------------------------------------------------------------------------
// The same shape as the /municipios pilot request (lib/outreach/pilot-request.ts),
// which is the existing path this reuses instead of a new table: ONE email to
// our general mailbox (CONTACT_EMAILS.general, whose documented purpose
// includes access requests), Reply-To set to the requester. NOTHING IS STORED.
// The general mailbox is on the Resend inbound allowlist, so the webhook
// forwards it to the person who reads it. Log lines carry the outcome and the
// organization type only — never a name, an address, a phone or the message.
//
// ABUSE CONTROLS, in the order they run (same as the pilot request)
// ---------------------------------------------------------------------------
//   1. Honeypot `_hp`: a bot that fills it gets the SAME success state and
//      nothing is sent.
//   2. Validation (zod) before any bucket is spent.
//   3. Two buckets: per caller IP, plus one IP-less ceiling on the whole form.
//   4. The locality must exist in the catalogue for that province (checked
//      through lib/place, injected here).
//
// NO DNI. No field can carry one by name.

import { z } from "zod";

import { sanitizeHeaderText } from "@/lib/infra/inbound-mail";
import { escapeHtml } from "@/lib/outreach/pilot-request";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { CONTACT_EMAILS } from "@/lib/ui/contact";
import { pluralizeEs } from "@/lib/utils/format";

function charCount(n: number): string {
  return `${n} ${pluralizeEs(n, "carácter", "caracteres")}`;
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const ORG_TYPES = ["refugio", "veterinaria", "rescate", "otra"] as const;
export type OrgType = (typeof ORG_TYPES)[number];

export const ORG_TYPE_LABELS: Record<OrgType, string> = {
  refugio: "Refugio o protectora",
  veterinaria: "Veterinaria",
  rescate: "Red de rescate o tránsito",
  otra: "Otra organización",
};

/** Form field names — the wire contract between the form and the action. */
export const ORG_ACCESS_FIELDS = {
  orgType: "orgType",
  orgName: "orgName",
  province: "jurisdictionProvince",
  locality: "localityName",
  fullName: "fullName",
  email: "email",
  phone: "phone",
  message: "message",
  consent: "consent",
  honeypot: "_hp",
} as const;

export type OrgAccessFieldKey = Exclude<keyof typeof ORG_ACCESS_FIELDS, "honeypot">;

export const ORG_ACCESS_LIMITS = {
  perIp: { maxPerMinute: 2, maxPerDay: 5 },
  global: { maxPerDay: 60 },
  orgName: 160,
  locality: 120,
  fullName: 120,
  email: 254,
  phone: 40,
  message: 1500,
} as const;

export type OrgAccessState =
  | { status: "idle" }
  | { status: "sent" }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Partial<Record<OrgAccessFieldKey, string>>;
    }
  | { status: "rate_limited"; message: string }
  | { status: "unavailable"; message: string };

export const ORG_ACCESS_INITIAL_STATE: OrgAccessState = { status: "idle" };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const trimmed = (max: number, tooShort: string, tooLong: string) =>
  z.string().trim().min(2, tooShort).max(max, tooLong);

const optionalTrimmed = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((v) => (v.length > 0 ? v : null));

const PHONE_PATTERN = /^[0-9+()\s.-]{6,}$/;

const orgAccessSchema = z.object({
  orgType: z.enum(ORG_TYPES, { error: "Elegí el tipo de organización." }),
  orgName: trimmed(
    ORG_ACCESS_LIMITS.orgName,
    "Indicá el nombre de la organización.",
    `Usá hasta ${charCount(ORG_ACCESS_LIMITS.orgName)}.`,
  ),
  provinceCode: z
    .string()
    .trim()
    .refine((code) => provinceByCode(code) !== null, "Elegí una provincia de la lista."),
  localityName: trimmed(
    ORG_ACCESS_LIMITS.locality,
    "Elegí la localidad de la lista de sugerencias.",
    `Usá hasta ${charCount(ORG_ACCESS_LIMITS.locality)}.`,
  ),
  fullName: trimmed(
    ORG_ACCESS_LIMITS.fullName,
    "Indicá tu nombre y apellido.",
    `Usá hasta ${charCount(ORG_ACCESS_LIMITS.fullName)}.`,
  ),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(ORG_ACCESS_LIMITS.email, "El correo es demasiado largo.")
    .pipe(z.email("Revisá el correo: no parece una dirección válida.")),
  phone: optionalTrimmed(
    ORG_ACCESS_LIMITS.phone,
    `Usá hasta ${charCount(ORG_ACCESS_LIMITS.phone)}.`,
  ).refine(
    (v) => v === null || PHONE_PATTERN.test(v),
    "Revisá el teléfono: usá solo números, espacios, + y guiones.",
  ),
  message: optionalTrimmed(
    ORG_ACCESS_LIMITS.message,
    `El mensaje supera los ${charCount(ORG_ACCESS_LIMITS.message)}.`,
  ),
  consent: z.literal(true, { error: "Necesitamos tu conformidad para responderte." }),
});

export type OrgAccessRequest = z.infer<typeof orgAccessSchema>;

const PATH_TO_FIELD: Record<string, OrgAccessFieldKey> = {
  orgType: "orgType",
  orgName: "orgName",
  provinceCode: "province",
  localityName: "locality",
  fullName: "fullName",
  email: "email",
  phone: "phone",
  message: "message",
  consent: "consent",
};

const INVALID_SUMMARY = "Revisá los campos marcados y volvé a enviar.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export type ParsedOrgAccessRequest =
  | { ok: true; value: OrgAccessRequest }
  | { ok: false; state: Extract<OrgAccessState, { status: "invalid" }> };

export function parseOrgAccessRequest(formData: FormData): ParsedOrgAccessRequest {
  const parsed = orgAccessSchema.safeParse({
    orgType: field(formData, ORG_ACCESS_FIELDS.orgType),
    orgName: field(formData, ORG_ACCESS_FIELDS.orgName),
    provinceCode: field(formData, ORG_ACCESS_FIELDS.province),
    localityName: field(formData, ORG_ACCESS_FIELDS.locality),
    fullName: field(formData, ORG_ACCESS_FIELDS.fullName),
    email: field(formData, ORG_ACCESS_FIELDS.email),
    phone: field(formData, ORG_ACCESS_FIELDS.phone),
    message: field(formData, ORG_ACCESS_FIELDS.message),
    consent: field(formData, ORG_ACCESS_FIELDS.consent) === "on",
  });
  if (parsed.success) return { ok: true, value: parsed.data };

  const fieldErrors: Partial<Record<OrgAccessFieldKey, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = PATH_TO_FIELD[String(issue.path[0] ?? "")];
    if (key && fieldErrors[key] === undefined) fieldErrors[key] = issue.message;
  }
  return { ok: false, state: { status: "invalid", message: INVALID_SUMMARY, fieldErrors } };
}

// ---------------------------------------------------------------------------
// The mail
// ---------------------------------------------------------------------------

export type OrgAccessMail = {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

export function buildOrgAccessMail(request: OrgAccessRequest): OrgAccessMail {
  const province = provinceByCode(request.provinceCode)?.name ?? request.provinceCode;
  const place = `${request.localityName}, ${province}`;
  const rows: Array<[string, string]> = [
    ["Tipo de organización", ORG_TYPE_LABELS[request.orgType]],
    ["Organización", request.orgName],
    ["Localidad", place],
    ["Nombre y apellido", request.fullName],
    ["Correo", request.email],
    ["Teléfono", request.phone ?? "(no lo dejó)"],
  ];
  const message = request.message ?? "(sin mensaje)";

  const text = [
    "Pedido de acceso de una organización, enviado desde miMAR.",
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "Mensaje:",
    message,
    "",
    "Respondé este correo para escribirle directamente: la respuesta va a su dirección.",
  ].join("\n");

  const html = `
    <p>Pedido de acceso de una organización, enviado desde miMAR.</p>
    <table cellpadding="4" cellspacing="0">
      ${rows
        .map(
          ([label, value]) =>
            `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
        )
        .join("\n      ")}
    </table>
    <p><strong>Mensaje:</strong></p>
    <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
    <p>Respondé este correo para escribirle directamente: la respuesta va a su dirección.</p>
  `;

  return {
    to: CONTACT_EMAILS.general,
    replyTo: request.email,
    subject: sanitizeHeaderText(`Pedido de acceso: ${request.orgName} (${place})`),
    text,
    html,
  };
}

// ---------------------------------------------------------------------------
// The use case
// ---------------------------------------------------------------------------

export type OrgAccessDeps = {
  /** Throws when a bucket is exhausted. */
  enforceRateLimit: (
    endpoint: string,
    identifier: string,
    config: { maxPerMinute?: number; maxPerDay?: number },
  ) => Promise<void>;
  isRateLimitError: (err: unknown) => boolean;
  /** True when the locality exists in the catalogue for that province. */
  isKnownLocality: (provinceCode: string, localityName: string) => Promise<boolean>;
  /** Resolves true only when the provider accepted the message. */
  sendMail: (mail: OrgAccessMail) => Promise<boolean>;
  /** Outcome log. Receives the outcome and the organization type — never PII. */
  log?: (outcome: string, orgType: OrgType | null) => void;
};

export const ORG_ACCESS_RATE_LIMITED_MESSAGE =
  "Ya recibimos varios mensajes desde tu conexión. Esperá un rato y volvé a intentar.";

export const ORG_ACCESS_UNAVAILABLE_MESSAGE = `No pudimos enviar tu pedido. Probá de nuevo en unos minutos, o escribinos a ${CONTACT_EMAILS.general}.`;

export async function submitOrgAccessRequest(
  formData: FormData,
  ip: string,
  deps: OrgAccessDeps,
): Promise<OrgAccessState> {
  const log = deps.log ?? (() => {});

  if (field(formData, ORG_ACCESS_FIELDS.honeypot).trim().length > 0) {
    log("honeypot", null);
    return { status: "sent" };
  }

  const parsed = parseOrgAccessRequest(formData);
  if (!parsed.ok) {
    log("invalid", null);
    return parsed.state;
  }
  const request = parsed.value;

  try {
    await deps.enforceRateLimit("org_access_request_ip", ip, ORG_ACCESS_LIMITS.perIp);
    await deps.enforceRateLimit("org_access_request_all", "any", ORG_ACCESS_LIMITS.global);
  } catch (err) {
    if (!deps.isRateLimitError(err)) throw err;
    log("rate_limited", request.orgType);
    return { status: "rate_limited", message: ORG_ACCESS_RATE_LIMITED_MESSAGE };
  }

  if (!(await deps.isKnownLocality(request.provinceCode, request.localityName))) {
    log("invalid", request.orgType);
    return {
      status: "invalid",
      message: INVALID_SUMMARY,
      fieldErrors: { locality: "Elegí la localidad de la lista de sugerencias." },
    };
  }

  const sent = await deps.sendMail(buildOrgAccessMail(request));
  log(sent ? "sent" : "send_failed", request.orgType);
  return sent
    ? { status: "sent" }
    : { status: "unavailable", message: ORG_ACCESS_UNAVAILABLE_MESSAGE };
}
