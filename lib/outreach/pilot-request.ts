// Pilot request from /municipios — validation, abuse checks and the mail it
// becomes (WU6, landing redesign 2026-09-24).
//
// WHAT HAPPENS TO A REQUEST
// ---------------------------------------------------------------------------
// It becomes ONE email to our own pilots mailbox (CONTACT_EMAILS.pilots), with
// Reply-To set to the requester so answering is one click. Nothing is stored:
// there is no table behind this form (PO decision D3), and the log lines this
// module asks for carry the outcome and the organism type only — never a name,
// an address, a phone or the message. The pilots mailbox is on the inbound
// allowlist, so the Resend inbound webhook forwards it to the person who reads
// it (app/api/webhooks/resend-inbound).
//
// WHY THE ORCHESTRATION LIVES HERE AND NOT IN THE ACTION
// ---------------------------------------------------------------------------
// Every side effect is injected (rate limit, locality catalog, mail send), so
// this file never reaches the database or the network and its test runs in the
// unit project. The "use server" action (app/municipios/actions.ts) is the thin
// shim that wires the real ones.
//
// ABUSE CONTROLS, in the order they run
// ---------------------------------------------------------------------------
//   1. Honeypot `_hp`: a bot that fills it gets the SAME success state a
//      person gets and nothing is sent, so the form cannot be used to learn
//      which submissions were dropped.
//   2. Validation (zod) before any bucket is spent — a typo must not cost a
//      person one of their few attempts.
//   3. Two buckets, the submit-org-contact.ts shape: per caller IP, plus one
//      IP-less ceiling on the whole form so N addresses cannot turn our own
//      inbox into a spam sink.
//   4. The locality must exist in the ar_localities catalog (the picker only
//      offers catalog rows; this refuses a hand-crafted post).
//
// NO DNI. The form never asks for one and this schema has no field that could
// carry one by name. A free-text message can contain anything a person types;
// it goes to our inbox and nowhere else.

import { z } from "zod";

import { sanitizeHeaderText } from "@/lib/infra/inbound-mail";
import { provinceByCode } from "@/lib/reference/ar-provincias";
import { CONTACT_EMAILS } from "@/lib/ui/contact";

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export const ORGANISM_TYPES = ["municipio", "provincia", "otro"] as const;
export type OrganismType = (typeof ORGANISM_TYPES)[number];

export const ORGANISM_TYPE_LABELS: Record<OrganismType, string> = {
  municipio: "Municipio",
  provincia: "Provincia",
  otro: "Otro organismo público",
};

/** Form field names — the wire contract between the form and the action. */
export const PILOT_FIELDS = {
  organismType: "organismType",
  organismName: "organismName",
  province: "jurisdictionProvince",
  locality: "localityName",
  fullName: "fullName",
  role: "role",
  email: "email",
  phone: "phone",
  message: "message",
  consent: "consent",
  honeypot: "_hp",
} as const;

export type PilotFieldKey = Exclude<keyof typeof PILOT_FIELDS, "honeypot">;

export const PILOT_LIMITS = {
  /** Per caller IP. Two a minute covers a person fixing a typo and resending. */
  perIp: { maxPerMinute: 2, maxPerDay: 5 },
  /** IP-less ceiling on the whole form: far above real demand, far below spam. */
  global: { maxPerDay: 60 },
  organismName: 160,
  locality: 120,
  fullName: 120,
  role: 120,
  email: 254,
  phone: 40,
  message: 1500,
} as const;

export type PilotRequestState =
  | { status: "idle" }
  | { status: "sent" }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Partial<Record<PilotFieldKey, string>>;
    }
  | { status: "rate_limited"; message: string }
  | { status: "unavailable"; message: string };

export const PILOT_INITIAL_STATE: PilotRequestState = { status: "idle" };

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const trimmed = (max: number, min: number, tooShort: string, tooLong: string) =>
  z.string().trim().min(min, tooShort).max(max, tooLong);

const optionalTrimmed = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((v) => (v.length > 0 ? v : null));

const PHONE_PATTERN = /^[0-9+()\s.-]{6,}$/;

const pilotRequestSchema = z
  .object({
    organismType: z.enum(ORGANISM_TYPES, { error: "Elegí el tipo de organismo." }),
    organismName: trimmed(
      PILOT_LIMITS.organismName,
      2,
      "Indicá el nombre del organismo o del área.",
      `Usá hasta ${PILOT_LIMITS.organismName} caracteres.`,
    ),
    provinceCode: z
      .string()
      .trim()
      .refine((code) => provinceByCode(code) !== null, "Elegí una provincia de la lista."),
    localityName: optionalTrimmed(
      PILOT_LIMITS.locality,
      `Usá hasta ${PILOT_LIMITS.locality} caracteres.`,
    ),
    fullName: trimmed(
      PILOT_LIMITS.fullName,
      2,
      "Indicá tu nombre y apellido.",
      `Usá hasta ${PILOT_LIMITS.fullName} caracteres.`,
    ),
    role: trimmed(
      PILOT_LIMITS.role,
      2,
      "Indicá tu cargo.",
      `Usá hasta ${PILOT_LIMITS.role} caracteres.`,
    ),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(PILOT_LIMITS.email, "El correo es demasiado largo.")
      .pipe(z.email("Revisá el correo: no parece una dirección válida.")),
    phone: optionalTrimmed(
      PILOT_LIMITS.phone,
      `Usá hasta ${PILOT_LIMITS.phone} caracteres.`,
    ).refine(
      (v) => v === null || PHONE_PATTERN.test(v),
      "Revisá el teléfono: usá solo números, espacios, + y guiones.",
    ),
    message: optionalTrimmed(
      PILOT_LIMITS.message,
      `El mensaje supera los ${PILOT_LIMITS.message} caracteres.`,
    ),
    consent: z.literal(true, { error: "Necesitamos tu conformidad para responderte." }),
  })
  .superRefine((value, ctx) => {
    // A municipio IS a locality; a province-level office may leave it blank.
    if (value.organismType === "municipio" && value.localityName === null) {
      ctx.addIssue({
        code: "custom",
        path: ["localityName"],
        message: "Elegí la localidad de tu municipio.",
      });
    }
  });

export type PilotRequest = z.infer<typeof pilotRequestSchema>;

/** Schema path → the field key the form renders the error under. */
const PATH_TO_FIELD: Record<string, PilotFieldKey> = {
  organismType: "organismType",
  organismName: "organismName",
  provinceCode: "province",
  localityName: "locality",
  fullName: "fullName",
  role: "role",
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

export type ParsedPilotRequest =
  | { ok: true; value: PilotRequest }
  | { ok: false; state: Extract<PilotRequestState, { status: "invalid" }> };

export function parsePilotRequest(formData: FormData): ParsedPilotRequest {
  const parsed = pilotRequestSchema.safeParse({
    organismType: field(formData, PILOT_FIELDS.organismType),
    organismName: field(formData, PILOT_FIELDS.organismName),
    provinceCode: field(formData, PILOT_FIELDS.province),
    localityName: field(formData, PILOT_FIELDS.locality),
    fullName: field(formData, PILOT_FIELDS.fullName),
    role: field(formData, PILOT_FIELDS.role),
    email: field(formData, PILOT_FIELDS.email),
    phone: field(formData, PILOT_FIELDS.phone),
    message: field(formData, PILOT_FIELDS.message),
    consent: field(formData, PILOT_FIELDS.consent) === "on",
  });
  if (parsed.success) return { ok: true, value: parsed.data };

  const fieldErrors: Partial<Record<PilotFieldKey, string>> = {};
  for (const issue of parsed.error.issues) {
    const key = PATH_TO_FIELD[String(issue.path[0] ?? "")];
    if (key && fieldErrors[key] === undefined) fieldErrors[key] = issue.message;
  }
  return { ok: false, state: { status: "invalid", message: INVALID_SUMMARY, fieldErrors } };
}

// ---------------------------------------------------------------------------
// The mail
// ---------------------------------------------------------------------------

export type PilotMail = {
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  html: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function jurisdictionLabel(request: PilotRequest): string {
  const province = provinceByCode(request.provinceCode)?.name ?? request.provinceCode;
  return request.localityName ? `${request.localityName}, ${province}` : province;
}

export function buildPilotMail(request: PilotRequest): PilotMail {
  const jurisdiction = jurisdictionLabel(request);
  const rows: Array<[string, string]> = [
    ["Tipo de organismo", ORGANISM_TYPE_LABELS[request.organismType]],
    ["Organismo", request.organismName],
    ["Jurisdicción", jurisdiction],
    ["Nombre y apellido", request.fullName],
    ["Cargo", request.role],
    ["Correo", request.email],
    ["Teléfono", request.phone ?? "(no lo dejó)"],
  ];
  const message = request.message ?? "(sin mensaje)";

  const text = [
    "Pedido de piloto enviado desde miMAR para municipios.",
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "¿Qué le gustaría resolver?",
    message,
    "",
    "Respondé este correo para escribirle directamente: la respuesta va a su dirección.",
  ].join("\n");

  const html = `
    <p>Pedido de piloto enviado desde miMAR para municipios.</p>
    <table cellpadding="4" cellspacing="0">
      ${rows
        .map(
          ([label, value]) =>
            `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
        )
        .join("\n      ")}
    </table>
    <p><strong>¿Qué le gustaría resolver?</strong></p>
    <p style="white-space:pre-wrap">${escapeHtml(message)}</p>
    <p>Respondé este correo para escribirle directamente: la respuesta va a su dirección.</p>
  `;

  return {
    to: CONTACT_EMAILS.pilots,
    replyTo: request.email,
    subject: sanitizeHeaderText(`Pedido de piloto: ${request.organismName} (${jurisdiction})`),
    text,
    html,
  };
}

// ---------------------------------------------------------------------------
// The use case
// ---------------------------------------------------------------------------

export type PilotRequestDeps = {
  /** Throws when a bucket is exhausted. */
  enforceRateLimit: (
    endpoint: string,
    identifier: string,
    config: { maxPerMinute?: number; maxPerDay?: number },
  ) => Promise<void>;
  isRateLimitError: (err: unknown) => boolean;
  /** True when the locality exists in the ar_localities catalog for that province. */
  isCanonicalLocality: (provinceCode: string, localityName: string) => Promise<boolean>;
  /** Resolves true only when the provider accepted the message. */
  sendMail: (mail: PilotMail) => Promise<boolean>;
  /** Outcome log. Receives the outcome and the organism type — never PII. */
  log?: (outcome: string, organismType: OrganismType | null) => void;
};

export const PILOT_RATE_LIMITED_MESSAGE =
  "Ya recibimos varios pedidos desde tu conexión. Esperá un rato y volvé a intentar.";

export const PILOT_UNAVAILABLE_MESSAGE = `No pudimos enviar tu pedido. Probá de nuevo en unos minutos, o escribinos a ${CONTACT_EMAILS.pilots}.`;

export async function submitPilotRequest(
  formData: FormData,
  ip: string,
  deps: PilotRequestDeps,
): Promise<PilotRequestState> {
  const log = deps.log ?? (() => {});

  if (field(formData, PILOT_FIELDS.honeypot).trim().length > 0) {
    log("honeypot", null);
    return { status: "sent" };
  }

  const parsed = parsePilotRequest(formData);
  if (!parsed.ok) {
    log("invalid", null);
    return parsed.state;
  }
  const request = parsed.value;

  try {
    await deps.enforceRateLimit("pilot_request_ip", ip, PILOT_LIMITS.perIp);
    await deps.enforceRateLimit("pilot_request_all", "any", PILOT_LIMITS.global);
  } catch (err) {
    if (!deps.isRateLimitError(err)) throw err;
    log("rate_limited", request.organismType);
    return { status: "rate_limited", message: PILOT_RATE_LIMITED_MESSAGE };
  }

  if (
    request.localityName !== null &&
    !(await deps.isCanonicalLocality(request.provinceCode, request.localityName))
  ) {
    log("invalid", request.organismType);
    return {
      status: "invalid",
      message: INVALID_SUMMARY,
      fieldErrors: { locality: "Elegí la localidad de la lista de sugerencias." },
    };
  }

  const sent = await deps.sendMail(buildPilotMail(request));
  log(sent ? "sent" : "send_failed", request.organismType);
  return sent ? { status: "sent" } : { status: "unavailable", message: PILOT_UNAVAILABLE_MESSAGE };
}
