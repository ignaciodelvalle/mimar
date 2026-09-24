// Ley 25.326 art. 14 (derecho de acceso) — turning `export_subject_data`'s raw
// JSON keys into what a person actually reads on the "Ver mis datos" screen.
//
// THE PROBLEM THIS FIXES (PO decision 13A, 2026-09-23)
// ---------------------------------------------------------------------------
// The export's top-level keys are the RPC's own snake_case column/table names —
// `operator_feed_watermarks`, `push_targets`, `audit_log`, `subject_user_id`.
// Both clients used to show a lightly-"unshouted" version of the raw key
// ("Operator feed watermarks", "Subject user id") rather than a real label.
// That technically complies with art. 14 — nothing is hidden — but it fails the
// promise the screen itself makes ("te mostramos todo lo que guardamos") for a
// citizen who has never heard the word "watermark".
//
// THIS MODULE DOES NOT TOUCH THE RAW EXPORT. It is presentation ONLY: the
// downloadable/shareable JSON (`exportShareText` in each platform's screen) is
// untouched and stays byte-for-byte the RPC's own output — legal completeness
// lives there, not here. What this module decides is what the READABLE SUMMARY
// shows: a human label per section, and which sections are worth a person's
// attention at all.
//
// WHY A KNOWN-KEY TABLE, WHEN THE OLD MODULE REFUSED ONE ON PRINCIPLE
// ---------------------------------------------------------------------------
// `apps/mobile/src/account/subject-data-summary.ts` used to have NO allow-list
// on purpose: "a section the RPC adds tomorrow shows up here tomorrow,
// unprompted — and a section it drops disappears, instead of being rendered as
// an empty row." That property is preserved, not abandoned: a key this module
// has never heard of still shows up, with `SUBJECT_RIGHTS_FALLBACK_LABEL`
// ("Otros datos") rather than vanishing. What changes is that a key this module
// DOES know gets a real Spanish label instead of its unshouted snake_case name,
// and a short, fixed list of purely-internal bookkeeping keys never shows up at
// all — because a citizen was never going to recognise "operator feed
// watermark" as something they hold an opinion about.
//
// HIDE RULES (each one is a PO decision, not a default)
// ---------------------------------------------------------------------------
//   1. `hidden: true` in SUBJECT_RIGHTS_SECTION_LABELS — envelope metadata
//      about the EXPORT ITSELF (`schema_version`, `exported_at`,
//      `exported_under`, `subject_user_id`) and pure internal bookkeeping with
//      no accountability content a person needs told about
//      (`operator_feed_watermarks`, `user_surface_visits` — both are "have you
//      seen this screen" read-position markers, not data about the person's
//      life). These never show, content or not.
//   2. Runtime-empty — ANY section (known or unknown key) whose value has no
//      content (`summarizeSubjectRightsValue` returns "sin datos") is hidden
//      from the readable list. This is the "hide only what's empty" half of
//      the rule; the raw export still carries the empty array/null for anyone
//      reading the JSON.
//
// WHAT IS DELIBERATELY **NOT** HIDDEN: `audit_log` and `push_targets` /
// `push_subscriptions` are just as "technical" in origin as the watermarks
// above, but they carry content a person should know exists — their own
// action history, and which of their devices get push notifications — so they
// get a plain Spanish label instead of being hidden. Only emptiness or PURE
// bookkeeping hides a section; "sounds technical" alone does not.
//
// KEY-LIST PARITY WITH THE SQL IS ENFORCED BY A TEST, NOT BY HAND
// ---------------------------------------------------------------------------
// `__tests__/subject-rights-sections.migration-parity.test.ts` reads
// `db/migrations/0245_user_surface_visits_subject_rights.sql` at test time and
// diffs its `jsonb_build_object` keys against `SUBJECT_RIGHTS_SECTION_LABELS`.
// A table added to the RPC without a matching entry here fails that test
// instead of silently falling back to "Otros datos" forever.

import { pluralizeEs } from "./pluralize-es.ts";

/** One entry of the known-key label table. */
export type SubjectRightsSectionMeta = {
  /** Human Spanish label for this export key. */
  label: string;
  /**
   * Never shown in the readable summary, even with content — envelope
   * metadata about the export itself, or pure internal bookkeeping with no
   * accountability content. See the module header for the full rule.
   */
  hidden?: boolean;
};

/**
 * Every top-level key `export_subject_data` (migration 0245) is known to
 * produce, mapped to how the readable summary should treat it.
 */
export const SUBJECT_RIGHTS_SECTION_LABELS: Readonly<Record<string, SubjectRightsSectionMeta>> = {
  profile: { label: "Tu perfil" },
  pets: { label: "Tus mascotas" },
  identifications: { label: "Identificaciones de tus mascotas" },
  pet_events: { label: "Lo que anotaste en la libreta" },
  welfare_reports_filed: { label: "Denuncias de bienestar que hiciste" },
  custody_disputes: { label: "Disputas de tenencia" },
  pet_transfers: { label: "Transferencias de mascotas" },
  pet_tags: { label: "Chapas de identificación" },
  pet_caretaker_grants: { label: "Cuidadores temporales" },
  foster_volunteers: { label: "Tu inscripción como hogar de tránsito" },
  org_contact_messages: { label: "Mensajes que enviaste a organizaciones" },
  push_subscriptions: { label: "Avisos activados (navegador)" },
  push_targets: { label: "Avisos activados (celular)" },
  // Watermarks: passive "have you visited/seen this" read-position markers,
  // not data about the person's life — pure internal bookkeeping.
  operator_feed_watermarks: { label: "Marcador interno de novedades", hidden: true },
  user_surface_visits: { label: "Marcador interno de pantallas visitadas", hidden: true },
  physical_tag_interest: { label: "Tu interés en chapas físicas" },
  organization_invitations: { label: "Invitaciones a organizaciones" },
  notifications: { label: "Tus avisos" },
  organization_memberships: { label: "Tu participación en organizaciones" },
  // Technical in origin, but content a person should know about — kept
  // visible with a plain label rather than hidden (PO decision 13A).
  audit_log: { label: "Historial de tus acciones" },
  // Envelope metadata about the EXPORT ITSELF, not a category of data about
  // the person — same reasoning the old module already applied to
  // schema_version alone; extended here to its three siblings.
  schema_version: { label: "Versión del formato de exportación", hidden: true },
  exported_at: { label: "Fecha de exportación", hidden: true },
  exported_under: { label: "Norma aplicada", hidden: true },
  subject_user_id: { label: "Identificador interno de la cuenta", hidden: true },
};

/**
 * Shown for a key this table has never heard of. NEVER hides the section —
 * only known internal-bookkeeping keys and runtime-empty sections are hidden
 * (see the module header). A future table the RPC starts returning is still
 * visible, unprompted, just without a bespoke Spanish name yet.
 */
export const SUBJECT_RIGHTS_FALLBACK_LABEL = "Otros datos";

/** What `summarizeSubjectRightsValue` returns for an empty/absent section. */
const EMPTY_SUMMARY = "sin datos";

/**
 * What one section's value amounts to, in es-AR words rather than a bare
 * number — "0" next to a section name reads like a failed load, "sin datos"
 * is a statement about the file. FOUR CASES, matching the four shapes
 * `jsonb_build_object` can produce: an array of rows, an object (the
 * profile), a scalar, or null/absent.
 */
export function summarizeSubjectRightsValue(value: unknown): string {
  if (value === null || value === undefined) return EMPTY_SUMMARY;
  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY_SUMMARY;
    return `${value.length} ${pluralizeEs(value.length, "registro")}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return EMPTY_SUMMARY;
    return `${keys.length} ${pluralizeEs(keys.length, "campo")}`;
  }
  // A scalar. Reported as present but NEVER printed — this is a table of
  // contents, not a second rendering of the subject's own PII.
  return "presente";
}

/** One row of the readable "Ver mis datos" summary. */
export type SubjectRightsSection = {
  /** The RPC's own key. Stable, and a React key. */
  key: string;
  /** Human Spanish label — from the table above, or the generic fallback. */
  label: string;
  /** How much of it there is, in words. */
  summary: string;
};

/**
 * Every VISIBLE top-level section of the export, in the RPC's own key order
 * (never re-sorted — a reader comparing this against the raw JSON should find
 * the rows where the file put them).
 *
 * Drops: keys marked `hidden` above, and any section (known or unknown) whose
 * value is empty. Never drops a key this table has never heard of merely for
 * being unknown — see the module header.
 */
export function subjectRightsSections(
  subject: Readonly<Record<string, unknown>>,
): SubjectRightsSection[] {
  const sections: SubjectRightsSection[] = [];
  for (const key of Object.keys(subject)) {
    const meta = SUBJECT_RIGHTS_SECTION_LABELS[key];
    if (meta?.hidden) continue;
    const summary = summarizeSubjectRightsValue(subject[key]);
    if (summary === EMPTY_SUMMARY) continue;
    sections.push({ key, label: meta?.label ?? SUBJECT_RIGHTS_FALLBACK_LABEL, summary });
  }
  return sections;
}

// ---------------------------------------------------------------------------
// Field-level labels for the `profile` section (PO decision 13A: "render
// human labels for the common fields and format dates in es-AR; never render
// a DNI other than the stored last-4 display form").
//
// Not currently wired into either platform's summary card — both draw counts
// only, on purpose (see each screen's own tests: "the export's VALUES painted
// onto the screen" is a defect those screens exist to prevent). This is the
// safe, WHITELIST-based building block for whenever a field-level view is
// built: `profile.dni_hash` and any column this table does not name is simply
// never rendered by `describeProfileFields`, so a future column added to
// `profiles` cannot leak into a readable view the way the raw key used to.
// ---------------------------------------------------------------------------

export type SubjectRightsFieldKind = "text" | "date" | "boolean";

export type SubjectRightsFieldMeta = {
  label: string;
  kind: SubjectRightsFieldKind;
};

/**
 * WHITELIST, not a blacklist. `dni_hash`, `miarg_sub`, `identity_source`,
 * `avatar_url`, `id`, `deleted_at` and any column not named here are excluded
 * BY OMISSION — `describeProfileFields` never looks at a key this table does
 * not list. `dni_last4` is the only DNI-shaped field ever rendered.
 */
export const PROFILE_FIELD_LABELS: Readonly<Record<string, SubjectRightsFieldMeta>> = {
  display_name: { label: "Nombre", kind: "text" },
  phone: { label: "Teléfono", kind: "text" },
  dni_last4: { label: "DNI (últimos 4 dígitos)", kind: "text" },
  dni_verified: { label: "DNI verificado", kind: "boolean" },
  jurisdiction_province: { label: "Provincia declarada", kind: "text" },
  jurisdiction_locality: { label: "Localidad declarada", kind: "text" },
  emergency_contact_name: { label: "Contacto de emergencia", kind: "text" },
  emergency_contact_phone: { label: "Teléfono de emergencia", kind: "text" },
  preferred_vet_name: { label: "Veterinario/a de confianza", kind: "text" },
  preferred_vet_phone: { label: "Teléfono del veterinario/a", kind: "text" },
  matricula_number: { label: "Matrícula profesional", kind: "text" },
  matricula_jurisdiccion: { label: "Jurisdicción de la matrícula", kind: "text" },
  created_at: { label: "Cuenta creada", kind: "date" },
  updated_at: { label: "Última actualización", kind: "date" },
};

export type SubjectRightsFieldRow = {
  key: string;
  label: string;
  value: string;
};

/**
 * The one timezone every export date renders in — Argentina's, so the date a
 * person reads matches the calendar day they lived it, not the server's UTC
 * day. Self-contained (no `@/lib/utils/format` import): this package is
 * installed by the React Native app, which cannot reach a Next.js `@/` path.
 */
const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

const SUBJECT_RIGHTS_DATE_FORMAT = new Intl.DateTimeFormat("es-AR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: AR_TIME_ZONE,
});

/** es-AR "DD/MM/AAAA" for a profile timestamp. "—" for missing/invalid input. */
export function formatSubjectRightsDate(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return SUBJECT_RIGHTS_DATE_FORMAT.format(date);
}

/**
 * The `profile` section's fields, readable: human label, es-AR date
 * formatting, DNI never beyond its stored last-4 form. Skips a field that is
 * null/undefined/empty rather than showing an empty row.
 */
export function describeProfileFields(
  profile: Readonly<Record<string, unknown>> | null | undefined,
): SubjectRightsFieldRow[] {
  if (!profile) return [];
  const rows: SubjectRightsFieldRow[] = [];
  for (const [key, meta] of Object.entries(PROFILE_FIELD_LABELS)) {
    const raw = profile[key];
    if (raw === null || raw === undefined || raw === "") continue;
    const value =
      meta.kind === "date"
        ? formatSubjectRightsDate(raw)
        : meta.kind === "boolean"
          ? raw
            ? "Sí"
            : "No"
          : String(raw);
    rows.push({ key, label: meta.label, value });
  }
  return rows;
}
