// DIM data model — see AGENTS.md for the design rationale behind every table here.
//
// Naming convention: tables are plural snake_case (`pet_events`), columns are
// snake_case in the DB but exposed as camelCase in TypeScript via the second
// argument to each column definition.
//
// Append-only discipline: `pet_events` rows are NEVER updated or deleted.
// Corrections are new events. This is enforced by convention here; the database
// will eventually enforce it via Row Level Security policies and triggers.

import { inArray, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ============================================================================
// Shared SQL fragments
// ============================================================================

// Canonical jurisdiction_province enum literal used by the CHECK constraints
// on the 11 tables that store this column. See migration
// 0055_jurisdiction_province_canonical.sql and lib/jurisdiction-canonical.ts.
// Keep this list in sync with PROVINCES in lib/ar-provincias.ts.
const CANONICAL_PROVINCE_SQL_LIST = sql`(
  'Buenos Aires','CABA','Catamarca','Chaco','Chubut','Córdoba','Corrientes',
  'Entre Ríos','Formosa','Jujuy','La Pampa','La Rioja','Mendoza','Misiones',
  'Neuquén','Río Negro','Salta','San Juan','San Luis','Santa Cruz','Santa Fe',
  'Santiago del Estero','Tierra del Fuego','Tucumán'
)`;

// ============================================================================
// Enums
// ============================================================================

// User's primary role at the application level. See AGENTS.md → "User roles".
// `owner` is the default for self-serve signup. `vet` and `govt` are
// granted via the admin-page approval flow (Fase 0 spec). `admin` is the
// universal-scope DIM staff role; bootstrap is a manual SQL seed of the
// founder, subsequent admins are approved by another admin. `national`
// (migration 0214) is the READ-ONLY institutional role with country-wide read
// scope on /gob — no govt_assignments, refused by every mutating action, never
// admitted to /admin (lib/infra/auth-guards.ts, requireGobReadAccessOrRedirect).
export const userRoleEnum = pgEnum("user_role", ["owner", "vet", "govt", "admin", "national"]);

/** The `profiles.role` value set — derived from the enum so a new role is a one-line change here. */
export type UserRole = (typeof userRoleEnum.enumValues)[number];

export const petSexEnum = pgEnum("pet_sex", ["male", "female", "unknown"]);

export const trainingLevelEnum = pgEnum("training_level", [
  "none",
  "basic",
  "intermediate",
  "advanced",
  "professional",
]);

// Notification severity drives the visual badge / color on the notifications
// list and any future bell-icon indicator. See AGENTS.md → "Notifications".
export const notificationSeverityEnum = pgEnum("notification_severity", [
  "info",
  "success",
  "warning",
  "urgent",
]);

export const petStatusEnum = pgEnum("pet_status", ["active", "lost", "deceased"]);

// Custody role. See AGENTS.md → Ownership for semantics.
// `owner`: permanent legal owner (person or org).
// `co_owner`: schema-ready, UI deferred.
// `shelter_custody`: temporary custody pending placement — used by refugios AND by
//   individual citizens who pick up strays (the vecino-helps-stray case).
// `foster`: temporary physical caregiver under an org's umbrella. Business rule
//   (not enforced at DB level): requires owner_user_id + active
//   organization_membership on the same org that holds the parallel shelter_custody row.
// `caretaker`: cuidador temporal — a trusted person looking after an owned pet
//   for a bounded period (petsitter, vecina, family). IMPLEMENTED END TO END
//   since custodia-temporal (migrations 0189-0193); the "UI deferred" note this
//   replaces was true until then. Lifecycle in `pet_caretaker_grants`, one
//   active row per pet, and NOT titularidad: see the ownerships table comment
//   below and lib/domain/titular-only.ts for what the role may not do.
export const ownershipRoleEnum = pgEnum("ownership_role", [
  "owner",
  "co_owner",
  "shelter_custody",
  "foster",
  "caretaker",
]);

export type OwnershipRole = (typeof ownershipRoleEnum.enumValues)[number];

// Who authored an event.
// `owner` in v1 self-serve flows.
// `scanner` is for credential_scanned events when an anonymous or non-owner user
// loads the public credential page.
// `finder` is for events authored by someone who found an animal they do not
// own: finder_in_possession via /p/[token]/encontre, and the note_added rows
// the chip-collision adjudication writes onto a third party's record. The test
// is who the author IS, not which event type they reached for — signing those
// notes "owner" showed the real owner a note apparently written by themselves.
// `shelter` activates when refugios author events on pets they hold in custody.
// `vet`, `govt`, `system` activate in later phases.
export const authorRoleEnum = pgEnum("author_role", [
  "owner",
  "scanner",
  "finder",
  "vet",
  "shelter",
  "govt",
  "system",
]);

export const reminderTypeEnum = pgEnum("reminder_type", [
  "vaccine",
  "deworming",
  "medication",
  "appointment",
  "custom",
  "post_adoption_checkin",
]);

// Welfare report enums — animal-cruelty / welfare denuncia system.
// Legal frame: Ley Nacional 14.346 (1954).

export const petAcquisitionMethodEnum = pgEnum("pet_acquisition_method", [
  "adopted",
  "purchased",
  "found_stray",
  "gift",
  "born_in_litter",
  "other",
]);

// Organization classification. Kept open like `event_type` so adding a new type
// is a one-line edit. See AGENTS.md → Organizations.
export const orgTypeEnum = pgEnum("org_type", [
  "clinic",
  "shelter",
  "rescue_network",
  "sanitary_authority",
  "other",
]);

export const orgStatusEnum = pgEnum("org_status", ["active", "suspended", "dissolved"]);

// PII baseline — Ley 25.326 art. 4° (base legal del tratamiento).
// Declared in migration 0058 (`pii.apply_baseline()`). Used by the `purpose`
// column on PII-bearing tables (profiles, pets, pet_identifications,
// custody_disputes) so each row can be traced to a legal basis.
export const dataPurposeEnum = pgEnum("data_purpose", [
  "identidad_mascota",
  "salud_animal",
  "notificacion_zoonosis",
  "reunificacion_perdida",
  "control_poblacional",
  "razas_peligrosas",
  "auditoria_legal",
  "consentimiento_marketing",
]);

export type DataPurpose = (typeof dataPurposeEnum.enumValues)[number];

// Role within an organization. See AGENTS.md → OrganizationMembership.
// `can_write_pet_events` on the membership row gates author privileges
// independently from role — transportistas may have role=member with false,
// coordinators and vets typically true.
export const organizationMembershipRoleEnum = pgEnum("organization_membership_role", [
  "admin",
  "coordinator",
  "member",
  "volunteer",
  "foster",
  "vet_individual",
]);

// Capability grants on a membership. `pending` is the initial state when an
// employee requests access; an admin transitions it to `approved` or `denied`.
// `revoked` is a previously-approved grant that an admin took back — kept as a
// distinct terminal state so the audit trail preserves the prior approval.
export const organizationCapabilityStatusEnum = pgEnum("organization_capability_status", [
  "pending",
  "approved",
  "denied",
  "revoked",
]);

// Capability catalog kept as TEXT (not an enum) so adding a new capability is
// a one-line edit. Validation happens in src/modules/organizations/domain/capabilities.ts.
// Membership role=admin implicitly holds every capability and is NOT required to be
// granted them explicitly (see infrastructure/authz-resolver.ts → getGrantedCapabilities).
export const ORGANIZATION_CAPABILITIES = [
  "pet.read_held",
  "intake.create",
  "foster.assign",
  "foster.end",
  "adoption.review",
  "adoption.finalize",
  "custody.transfer",
  "event.write",
  "member.invite",
  "capability.grant",
  // Scheduling system (Fase 0). Service providers earn these via the approval
  // flow; NOT included in VET_INDIVIDUAL_IMPLICIT_CAPS (intentional per spec).
  "service_offering.create",
  "appointment.manage",
  // Bite reporting (org-side). Vets and shelter coordinators with this
  // capability can register a bite they witnessed or learned of clinically
  // on a pet that is NOT in their custody (owner-held). The bite atomically
  // starts the 10-day rabies observation per Decreto 4669/1973 (PBA).
  "bite.report",
  // Adoption listing management (spec adoption-listing-public v1.3 D2/D3).
  // Toggles publicar/pausar and edits the shelter-curated copy that renders
  // on /adoptar (story, requirements, buckets, tri-state checkboxes).
  "adoption.listing.manage",
  // Cross-org transfer handshake (spec 2026-05-19-cross-org-transfer-ux).
  // `propose` lets the sender open a custody_transfer_proposed; `accept`
  // lets the receiver finalize the custody_transferred + ownership flip.
  // CT9 says these are auto-implicit for admin/coordinator roles but the
  // grant table still applies for explicit grants to member/volunteer.
  "org.transfer.propose",
  "org.transfer.accept",
] as const;
export type OrganizationCapability = (typeof ORGANIZATION_CAPABILITIES)[number];

export const welfareReportSubjectKindEnum = pgEnum("welfare_report_subject_kind", [
  "registered_pet",
  "unowned_animal",
  "location",
  "general",
]);

export const welfareReportKindEnum = pgEnum("welfare_report_kind", [
  "abandonment",
  "neglect",
  "physical_abuse",
  "chained",
  "no_shelter",
  "hoarding",
  "dog_fighting",
  "trafficking",
  "other",
]);

export const welfareReportSeverityEnum = pgEnum("welfare_report_severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const welfareReportStatusEnum = pgEnum("welfare_report_status", [
  "open",
  "triaged",
  "in_progress",
  "closed",
  "duplicate",
  "invalid",
]);

// Event types — SOURCE OF TRUTH MOVED (native-readiness T1.1, 2026-08-20).
//
// `EVENT_TYPES` / `EventType` are declared in `@dim/contract/events` and
// re-exported here. The direction of the dependency is the point: this ORM
// module now depends on the domain vocabulary, not the other way round. A
// React Native client can name an event type without installing drizzle-orm.
//
// The re-export is COMPATIBILITY, not the contract. ~90 files still import
// `EventType` from `@/db/schema` or `@/db` and keep working unchanged; new
// code — and any module that has no other reason to know the database exists —
// should import from `@dim/contract/events` directly.
//
// Still TEXT, not a pgEnum: adding an event type must never require a
// migration. Validation happens in application code against the const.
export { EVENT_TYPES, type EventType } from "@dim/contract/events";

// ============================================================================
// Profiles — application-level user record
// ============================================================================
// Supabase Auth manages `auth.users` (email, password, sessions). Our
// `profiles` table mirrors it: `profiles.id` equals `auth.users.id`. Anything
// app-specific (display name, phone, DNI for future Mi Argentina integration)
// lives here.

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey(),
    // Primary user role at the application level. Always `owner` for self-serve
    // signups; vet/govt accounts are admin-assigned. See AGENTS.md → User roles.
    role: userRoleEnum("role").notNull().default("owner"),
    displayName: text("display_name").notNull(),
    phone: text("phone"),
    // A BUCKET-RELATIVE PATH INTO THE PRIVATE `avatars` BUCKET — `{userId}/{ts}.{ext}`
    // — NOT a URL, despite the column's name.
    //
    // The column is `avatar_url` and stays `avatar_url`: `erase_subject_data`
    // and `export_subject_data` are SECURITY DEFINER functions that name it,
    // and their live definitions sit inside immutable migrations (latest: 0208,
    // ~470 lines). Renaming the column would mean re-creating both RPCs to
    // change one identifier — a far larger blast radius than the defect fixed
    // here. The DRIZZLE FIELD is renamed instead, so every TypeScript reader
    // breaks at compile time and has to be visited: the old contents were a
    // fabricated `/object/sign/avatars/…` URL with no `?token=` (storage-gc.ts
    // "Fix the writer first"), and a reader that silently kept treating the new
    // contents as a URL would render a broken image rather than fail loudly.
    // Migration 0219 reshapes the existing rows. Sign it with
    // `avatarSignedUrl()` at render time; `organizations.avatar_url` is a
    // DIFFERENT column with different semantics and is untouched.
    avatarStoragePath: text("avatar_url"),
    // Mi Argentina identity (Wave 5 Item 25a — migration 0106).
    // No DNI in plaintext rule (Ley 25.326 / Mi Argentina premise).
    //   miarg_sub       — opaque, stable subject ID from Mi Argentina OIDC.
    //   identity_source — 'miarg' (verified via OIDC) | 'legacy' (form-verified).
    //   dni_hash        — HMAC-SHA256(dni, pepper) hex. Equality matching only.
    //                     Pepper in env/KMS, never in DB. See lib/dni-hash.ts.
    //   dni_last4       — right(dni, 4). Human disambiguation in operator UI only.
    //   dni_verified    — boolean flag (preserved from pre-25a schema).
    //   dni_verified_at — when verification happened.
    // TODO(25b): wire miarg_sub via Mi Argentina OIDC callback.
    miargSub: text("miarg_sub"),
    identitySource: text("identity_source").default("legacy").$type<"miarg" | "legacy">(),
    dniHash: text("dni_hash"),
    dniLast4: text("dni_last4"),
    dniVerified: boolean("dni_verified").notNull().default(false),
    dniVerifiedAt: timestamp("dni_verified_at", { withTimezone: true }),
    // Vet professional license. Nullable; submitted via /cuenta/upgrade.
    // Admin manually flips role='vet' after verification. jurisdiccion is the
    // province/jurisdiction that issued the matricula — the registry to check.
    matriculaNumber: text("matricula_number"),
    matriculaJurisdiccion: text("matricula_jurisdiccion"),
    matriculaVerified: boolean("matricula_verified").notNull().default(false),
    // Emergency contact + preferred vet — the ACCOUNT-LEVEL default, rendered
    // by LibretaFace's EmergenciaBlock only as the fallback when the pet has
    // no per-pet override (pets.preferred_vet_* / emergency_contact_*, P2).
    // NOT shown on the public credential — /p exposes at most the owner phone
    // behind pets.disclosePhoneWhenLost. Added by migration 0042.
    preferredVetName: text("preferred_vet_name"),
    preferredVetPhone: text("preferred_vet_phone"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    // Distinguishes self-serve (owner/vet) accounts from institutional (admin/govt)
    // accounts. Stored as text+CHECK to avoid enum migration cost when adding
    // new values in future Fases (e.g. 'service_provider' in Fase 8).
    accountType: text("account_type")
      .notNull()
      .default("personal")
      .$type<"personal" | "institutional">(),
    // System service account flag (migration 0109 — C21). Distinguishes
    // machine/service accounts (e.g. the panorama seeder, automation actors)
    // from human operators. Replaces the brittle `display_name LIKE 'system:%'`
    // heuristic that broke once auth-user enumeration exceeded one page and
    // emails came back blank. The last-admin guard and the admin roster
    // partition read this flag instead of inspecting the display name.
    isSystem: boolean("is_system").notNull().default(false),
    // Irreversible soft-deactivation timestamp. NULL = active. Set by
    // deactivateAdminAction / deactivateGovtAction in Fase 5.
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    // Legal consent proof (Ley 25.326 art. 5 — informed, express, provable).
    // Written at signup when the TOS/privacy checkbox is accepted. tosVersion
    // stores the LEGAL_VERSION (lib/legal-version.ts) in force at that moment so
    // we can demonstrate WHAT the user agreed to. NULL for accounts created
    // before migration 0087 / institutional accounts provisioned by admins.
    // Added by migration 0087.
    tosAcceptedAt: timestamp("tos_accepted_at", { withTimezone: true }),
    tosVersion: text("tos_version"),
    /**
     * INERT since migration 0205. Do not write to these.
     *
     * ERRATA — this said "collected at registration (step 2) and used for
     * regional health-campaign targeting". The first half was true; the second
     * was never true of the code. The columns had exactly ONE writer
     * (completeIdentityAction) and ZERO readers: every aggregate, panorama
     * layer, k-anonymity cell and routing path keys on `pets.*`,
     * `welfare_reports.*`, `service_offerings.*`, `govt_assignments.*` or
     * `organizations.*`, never on profiles — and lib/infra/admin-search.ts
     * records the profile→jurisdiction link being REJECTED on purpose for govt
     * user scoping.
     *
     * The same false purpose was printed on the public privacy page ("se usan
     * para enrutar denuncias y estimar coberturas") and in the signup field's
     * own hint. Holding a personal datum for a purpose that does not exist is a
     * finalidad problem under Ley 25.326 art. 4 in its own right, so the
     * decision (PO, 2026-08-27: "la jurisdicción implica compliance, pero es a
     * nivel mascota y no cuenta") was to stop asking rather than to reword the
     * promise. 0205 removed the writer, removed the form field, nulled both
     * columns for every existing profile and re-issued the COMMENT ON COLUMN.
     *
     * Kept as columns rather than dropped: `export_subject_data` projects the
     * whole profile row with `row_to_json`, so dropping them would change the
     * shape of an art. 14 export for no benefit. Added by migration 0097.
     */
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // PII baseline (compliance PR 1, migration 0058). Added by
    // pii.apply_baseline(). See lib/audit/log.ts (todo, separate sprint).
    createdBy: uuid("created_by").references((): AnyPgColumn => profiles.id, {
      onDelete: "set null",
    }),
    updatedBy: uuid("updated_by").references((): AnyPgColumn => profiles.id, {
      onDelete: "set null",
    }),
    purpose: dataPurposeEnum("purpose"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    // Daily operator digest (T2-N1, migration 0230). Opt-out is per-account,
    // defaults to false (institutional operators are subscribed by default —
    // the digest only ever fires for a role that actually holds a queue).
    // dailyDigestLastSentOn is the idempotency watermark: the cron claims it
    // with a conditional UPDATE (compare-and-swap, `IS DISTINCT FROM $today`)
    // immediately before the send — after composing the mail, not before — so
    // a retried run (or a second dispatcher pass the same day) cannot
    // double-send; the row-level lock on that UPDATE serializes concurrent
    // attempts for the same user for free, no separate dedupe table needed. A
    // failed send puts the previous value back so a retry can resend (security
    // review 2026-09-18; migration 0230's header describes the first version).
    // AR calendar day (see lib/infra/daily-operator-digest.ts), not UTC.
    dailyDigestOptOut: boolean("daily_digest_opt_out").notNull().default(false),
    dailyDigestLastSentOn: date("daily_digest_last_sent_on"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Unique index on miarg_sub (partial — only when set). Added by migration 0106.
    miargSubUnique: uniqueIndex("profiles_miarg_sub_unique")
      .on(table.miargSub)
      .where(sql`${table.miargSub} IS NOT NULL`),
    // Unique index on dni_hash (partial — only when set). Replaces former
    // profiles_dni_unique_when_present on dni_number. Added by migration 0106.
    dniHashUnique: uniqueIndex("profiles_dni_hash_unique")
      .on(table.dniHash)
      .where(sql`${table.dniHash} IS NOT NULL`),
    matriculaUnique: uniqueIndex("profiles_matricula_unique_when_present")
      .on(table.matriculaNumber)
      .where(sql`${table.matriculaNumber} IS NOT NULL`),
    // Partial index for active institutional operators — used by admin list pages
    // and capability checks in Fase 5. Added by migration 0011.
    institutionalActiveIdx: index("profiles_institutional_active_idx")
      .on(table.role)
      .where(sql`${table.accountType} = 'institutional' AND ${table.deactivatedAt} IS NULL`),
    // PII soft-delete partial (compliance PR 1, migration 0058).
    // Renamed from public_profiles_deleted_idx → profiles_deleted_idx (migration 0095).
    profilesDeletedIdx: index("profiles_deleted_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    // CHECK constraints — added via ALTER in migrations 0011 / 0015.
    // NOTE: profiles_account_type_role_match was added in 0015 and dropped
    // in 0016 ("Drop profiles_account_type_role_match — keep app-layer
    // enforcement only"). DO NOT mirror it here. Tests insert admin/govt
    // profiles with account_type=personal during fixture setup; reinstating
    // this check breaks admin-institutional, role-upgrade, and revocation
    // suites.
    profilesAccountTypeValid: check(
      "profiles_account_type_valid",
      sql`${table.accountType} in ('personal', 'institutional')`,
    ),
    profilesInstitutionalNoPii: check(
      "profiles_institutional_no_pii",
      sql`${table.accountType} = 'personal' or (${table.dniHash} is null and ${table.matriculaNumber} is null and ${table.matriculaJurisdiccion} is null and ${table.miargSub} is null)`,
    ),
    // Added by migration 0097.
    profilesJurisdictionProvinceCanonical: check(
      "profiles_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

// ============================================================================
// Pets — the credential itself
// ============================================================================

export const pets = pgTable(
  "pets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Short, URL-safe token rendered into the QR code and printed tags.
    // Format: e.g. "DIM-3K4F-9P2X". Generated in application code.
    publicToken: text("public_token").notNull().unique(),
    species: text("species").notNull(), // dog, cat, ...
    breed: text("breed"),
    name: text("name").notNull(),
    sex: petSexEnum("sex").notNull().default("unknown"),
    dateOfBirth: date("date_of_birth"),
    birthDateIsEstimated: boolean("birth_date_is_estimated").notNull().default(false),
    color: text("color"),
    distinguishingFeatures: text("distinguishing_features"),
    // ARCH-S: microchipId, microchipCountryCode, microchipImplantedAt,
    // microchipImplantedBy, microchipLocation dropped — canonical data lives
    // in pet_identifications (migration 0084).
    // ARCH-S: tattooCode, tattooLocation, tattooDescription, tattooRecordedAt,
    // tattooRecordedBy, tattooPhotoId dropped — canonical data lives in
    // pet_identifications (migration 0084).
    // FK to attachments.id. NOT a hard FK at the DB level — circular reference
    // with attachments.pet_id. Application code keeps these in sync.
    primaryPhotoId: uuid("primary_photo_id"),
    status: petStatusEnum("status").notNull().default("active"),
    deceasedAt: timestamp("deceased_at", { withTimezone: true }),
    // Most recent reported weight. Updated on each weight_recorded event so we
    // don't need to scan the timeline to render the current weight on the
    // pet card. Source of truth is the events; this is a denormalized cache.
    estimatedWeightKg: numeric("estimated_weight_kg", { precision: 5, scale: 2 }),
    // Free-text arrays for owner-known facts about the pet. Predefined options
    // come from lib/lookups.ts but the columns accept anything the user types
    // into the "otros" field.
    favouriteFoods: text("favourite_foods").array(),
    knownAllergies: text("known_allergies").array(),
    // Training level — owner self-reported.
    trainingLevel: trainingLevelEnum("training_level"),
    // Computed at registration based on breed + species via lib/breeds.ts.
    // Captures "what the law said about this breed at the time of registration."
    // Driver of the dangerous_breed_attested flow (Ley CABA 4078, Ley Prov 14.107).
    potentiallyDangerousBreed: boolean("potentially_dangerous_breed").notNull().default(false),
    // Pet-insurance info — entirely optional, owner-provided.
    insuranceCompany: text("insurance_company"),
    insurancePolicyNumber: text("insurance_policy_number"),
    // Per-pet emergency contact / preferred vet override (owner-ia-redesign P2,
    // PO decision 2 — migration 0145). Mirror of the account-level defaults on
    // profiles (migration 0042). NULL = fall back to the owner's profile-level
    // value; a non-null pet value overrides it for this pet only. UI preference,
    // NOT a fact about the pet — editing does NOT emit a pet event. Fallback
    // resolution lives in lib/domain/emergency-contacts.ts.
    preferredVetName: text("preferred_vet_name"),
    preferredVetPhone: text("preferred_vet_phone"),
    emergencyContactName: text("emergency_contact_name"),
    emergencyContactPhone: text("emergency_contact_phone"),
    // Coarse administrative tagging for aggregation. Never precise coordinates.
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Structural locality-attribution FK (migration 0147). Nullable + additive:
    // the free-text jurisdiction_locality above stays the display/backfill source;
    // this is the NEW join key into the ar_localities catalog (its uuid PK). Set on
    // the write path via normalizeLocationForWrite and backfilled for historical
    // rows; NULL when the locality does not resolve (centroid fallback keeps it
    // visible). References the uuid PK — not indec_id — so CABA barrios (null
    // indec_id) are attributable too.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    // HOW locality_id was decided (lib/domain/place.ts; CHECK in migration 0248).
    // NULL = not recorded. localidades-por-id B1.
    placeMethod: text("place_method"),
    // Internal seed-provenance marker (migration 0160). NULL for every real pet
    // registration; set ONLY by scripts/seed-*.ts to the generating script's tag
    // ('panorama', 'panorama-hist', 'perf'). Mirrors welfare_reports.seed_tag
    // (0155): a plain column carries the provenance so the rendered public_token
    // does not have to double as one. Never rendered — do NOT select this column
    // in citizen/operator-facing queries. The spine-integrity fence reads it to
    // exempt bulk volume fixtures (seed-perf) explicitly rather than silently.
    seedTag: text("seed_tag"),
    // How the owner came to have this pet. Nullable so existing rows survive db:push
    // without a default. Collected at registration and included in pet_registered payload.
    acquisitionMethod: petAcquisitionMethodEnum("acquisition_method"),
    // Owner-toggled "this pet takes daily medication — contact me" banner on the
    // public credential page. UI preference, NOT a fact about the pet — flipping
    // this flag does NOT emit a pet_profile_updated event. Tier 0+ per
    // AGENTS.md → Privacy tiers; the banner reveals no PII beyond itself.
    emergencyInfoVisible: boolean("emergency_info_visible").notNull().default(false),
    // Lost & Found — per-field disclosure preferences (Fase 1).
    // Owner controls what contact info is visible on the public credential when
    // the pet is lost. These are UI preferences — changes do NOT emit
    // pet_profile_updated events, analogous to emergencyInfoVisible above.
    // Source of truth for the credential render; the status_changed event
    // optionally carries a disclosure_prefs_snapshot for historical audit.
    //
    // Privacy hardening (cursor privacy P4, migration 0158): these three
    // PII-disclosing columns used to default to true (the old hardcoded Tier 1
    // reveal), which disagreed with MarkLostWizard's affirmative-consent
    // defaults (all OFF) — defense-in-depth now aligns the column DEFAULT with
    // the wizard so any insert path that skips the wizard's explicit values
    // still lands closed, not open. allow_finder_form_when_lost stays true —
    // it exposes no owner PII (see MarkLostWizard DISCLOSURE_DEFAULTS).
    discloseFirstNameWhenLost: boolean("disclose_first_name_when_lost").notNull().default(false),
    disclosePhoneWhenLost: boolean("disclose_phone_when_lost").notNull().default(false),
    discloseEmailWhenLost: boolean("disclose_email_when_lost").notNull().default(false),
    discloseLastLocationWhenLost: boolean("disclose_last_location_when_lost")
      .notNull()
      .default(false),
    allowFinderFormWhenLost: boolean("allow_finder_form_when_lost").notNull().default(true),
    // KEY 1 of the two-key alternate-public-contact model (custodia-temporal,
    // migration 0193, PO 2026-08-19). NOT a reuse of disclosePhoneWhenLost:
    // that one governs the TITULAR's own phone, and folding the two together
    // would mean turning your own number on silently publishes a third party's.
    // Key 2 is `pet_caretaker_grants.public_contact_consent_at`. Either key
    // missing → the public credential shows no caretaker at all.
    discloseCaretakerContactWhenLost: boolean("disclose_caretaker_contact_when_lost")
      .notNull()
      .default(false),
    // "Primeros pasos" onboarding checklist — per-pet dismissed step keys
    // (owner-onboarding train, migration 0153). A step key here ("photo",
    // "microchip", "vaccines", "emergency_contact", "disclosure_prefs") means
    // the owner explicitly chose "Omitir" for that nudge — NOT that the
    // underlying task was done (done is derived live from the pet's own
    // fields/ledger events) and NOT that the capability is disabled: the
    // owner can still add a photo / set disclosure prefs later through their
    // normal surfaces, this only silences the onboarding nudge. UI
    // preference like the disclose_*_when_lost columns above — a dismissal
    // does NOT emit a pet_profile_updated event (the append-only event log
    // stays for facts about the pet, not for owner UI choices).
    dismissedFirstSteps: text("dismissed_first_steps").array().notNull().default(sql`'{}'::text[]`),
    // Tier 2 público temporal — owner opt-in window for /p/[publicToken].
    // When non-null and > now(), the public credential reveals a curated
    // medical summary (vacunas vigentes, esterilización, medicación
    // activa, condiciones permanentes) on top of the Tier 0 identity
    // rollups it normally shows. Set by enableTier2PublicAction (hardcoded
    // +24h in v1), cleared by revokeTier2PublicAction or naturally by
    // expiration. Owner contact / address / notes are never exposed.
    tier2PublicEnabledUntil: timestamp("tier2_public_enabled_until", { withTimezone: true }),
    // Permanent (no-expiry) Tier 2 flag for the "siempre visible" option.
    // Active when true, regardless of tier2PublicEnabledUntil.
    // Cleared by revokeTier2PublicAction together with tier2PublicEnabledUntil.
    tier2PublicPermanent: boolean("tier2_public_permanent").notNull().default(false),
    // External legal custody proceedings flag. Set true by
    // custody_dispute_raised events (admin or govt initiated), unset by
    // custody_dispute_resolved. Features that should respect the flag
    // (transfers, adoption finalize, scheduling) opt in per-feature.
    inCustodyDispute: boolean("in_custody_dispute").notNull().default(false),
    // Rabies observation lifecycle. Set by reportBiteAction (in_progress), by
    // the daily sweep (window_expired_unclosed when the statutory window elapses
    // with no professional closure — 2026-08-17; it used to write
    // completed_negative with no clinical author), by the death_recorded hook
    // (completed_dead), or by professional close (any completed_*). null when no
    // observation ever existed.
    // See src/modules/surveillance/domain/rabies-observation.ts.
    rabiesObservationStatus: text("rabies_observation_status"),
    // Denormalized pregnancy lifecycle flag — spec pregnancy-tracking PR4.
    // Re-derivable from clinical_info_logged(sub_kind='pregnancy') events.
    // Server actions recordPregnancyStartedAction / recordPregnancyEndedAction
    // dual-write this. CHECK constraint in migration 0036 locks the value set.
    pregnancyStatus: text("pregnancy_status"),
    // Adoption eligibility — spec foster-volunteers-pool v1.4 §17. NULL = not
    // determined yet; the surface "/adoptar" (future) lists only TRUE; the
    // org "no aptas" surface lists FALSE with the structured reason.
    adoptionEligible: boolean("adoption_eligible"),
    adoptionIneligibleReason: text("adoption_ineligible_reason"),
    adoptionIneligibleReasonNotes: text("adoption_ineligible_reason_notes"),
    adoptionIneligibleUntil: timestamp("adoption_ineligible_until", { withTimezone: true }),
    adoptionEligibilitySetAt: timestamp("adoption_eligibility_set_at", { withTimezone: true }),
    adoptionEligibilitySetByUserId: uuid("adoption_eligibility_set_by_user_id").references(
      () => profiles.id,
      { onDelete: "set null" },
    ),

    // Adoption listing — spec 2026-05-18 adoption-listing-public v1.3.
    // Two timestamps + 9 columns of shelter-curated copy + a fee. Together
    // they drive /adoptar listing visibility and ficha rendering. CHECK
    // constraints in migration 0030 enforce enum-style values without
    // forcing a Postgres enum migration on every label tweak.
    adoptionListedAt: timestamp("adoption_listed_at", { withTimezone: true }),
    adoptionListingPausedAt: timestamp("adoption_listing_paused_at", { withTimezone: true }),
    adoptionStory: text("adoption_story"),
    adoptionRequirements: text("adoption_requirements"),
    adoptionEnergyLevel: text("adoption_energy_level").$type<"low" | "medium" | "high">(),
    adoptionSizeEstimate: text("adoption_size_estimate").$type<
      "small" | "medium" | "large" | "xl"
    >(),
    adoptionAgeBucket: text("adoption_age_bucket").$type<
      "puppy" | "junior" | "young" | "adult" | "senior"
    >(),
    adoptionGoodWithKids: boolean("adoption_good_with_kids"),
    adoptionGoodWithDogs: boolean("adoption_good_with_dogs"),
    adoptionGoodWithCats: boolean("adoption_good_with_cats"),
    adoptionNeedsYard: boolean("adoption_needs_yard"),
    adoptionFeeArs: integer("adoption_fee_ars"),

    // Permanent conditions (migration 0031). text[] holds catalog codes
    // from lib/permanent-conditions.ts; `permanent_conditions_other` is
    // free text only meaningful when 'otra' is in the array.
    // ARRAY[]::text[] is the canonical form PG normalizes empty-array defaults
    // to on introspection; using it as the schema default avoids perpetual
    // drift from drizzle-kit comparing '{}' (its own array serialization) to
    // PG's introspected '{}'::text[]/ARRAY[]::text[] form.
    permanentConditions: text("permanent_conditions")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    permanentConditionsOther: text("permanent_conditions_other"),
    discloseConditionsPublicly: boolean("disclose_conditions_publicly").notNull().default(false),

    // PII baseline (compliance PR 1, migration 0058).
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => profiles.id, { onDelete: "set null" }),
    purpose: dataPurposeEnum("purpose"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // ARCH-S: microchipUnique (pets_microchip_unique_when_present) dropped — migration 0084.
    jurisdictionIdx: index("pets_jurisdiction_idx").on(
      table.jurisdictionProvince,
      table.jurisdictionLocality,
    ),
    // Structural locality-attribution FK index (migration 0147). Partial on
    // IS NOT NULL — only resolved rows carry the key.
    localityIdIdx: index("pets_locality_id_idx")
      .on(table.localityId)
      .where(sql`${table.localityId} IS NOT NULL`),
    // Seed-provenance index (migration 0160). Partial on IS NOT NULL — only
    // synthetic rows carry a tag, so the index stays empty in production.
    seedTagIdx: index("pets_seed_tag_idx")
      .on(table.seedTag)
      .where(sql`${table.seedTag} IS NOT NULL`),
    statusIdx: index("pets_status_idx").on(table.status),
    // PII soft-delete partial (compliance PR 1).
    // Renamed from public_pets_deleted_idx → pets_deleted_idx (migration 0095).
    petsDeletedIdx: index("pets_deleted_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    adoptionListingIdx: index("pets_adoption_listing_active_idx")
      .on(table.adoptionListedAt, table.id)
      .where(
        sql`${table.adoptionListedAt} IS NOT NULL AND ${table.adoptionListingPausedAt} IS NULL`,
      ),
    adoptionIneligibleReasonValid: check(
      "pets_adoption_ineligible_reason_valid",
      sql`${table.adoptionIneligibleReason} IS NULL OR ${table.adoptionIneligibleReason} IN ('medical_treatment','behavioral_evaluation','recovery','quarantine','legal_hold','age','pending_intake_eval','other')`,
    ),
    adoptionEligibilityConsistent: check(
      "pets_adoption_eligibility_consistent",
      sql`(${table.adoptionEligible} IS NOT NULL AND ${table.adoptionEligibilitySetAt} IS NOT NULL) OR (${table.adoptionEligible} IS NULL AND ${table.adoptionEligibilitySetAt} IS NULL)`,
    ),
    adoptionIneligibleReasonRequired: check(
      "pets_adoption_ineligible_reason_required",
      sql`${table.adoptionEligible} IS NULL OR ${table.adoptionEligible} = true OR (${table.adoptionEligible} = false AND ${table.adoptionIneligibleReason} IS NOT NULL)`,
    ),
    adoptionIneligibleOtherNeedsNotes: check(
      "pets_adoption_ineligible_other_needs_notes",
      sql`${table.adoptionIneligibleReason} IS NULL OR ${table.adoptionIneligibleReason} != 'other' OR (${table.adoptionIneligibleReasonNotes} IS NOT NULL AND length(trim(${table.adoptionIneligibleReasonNotes})) > 0)`,
    ),
    adoptionEligibilitySetByIdx: index("pets_adoption_eligibility_set_by_idx").on(
      table.adoptionEligibilitySetByUserId,
    ),
    // CHECK constraints also declared via ALTER in migrations 0021, 0030, 0031, 0036.
    petsRabiesObservationStatusValid: check(
      "pets_rabies_observation_status_valid",
      sql`${table.rabiesObservationStatus} is null or ${table.rabiesObservationStatus} in ('in_progress', 'window_expired_unclosed', 'completed_negative', 'completed_positive_rabies', 'completed_dead', 'completed_lost_to_followup')`,
    ),
    petsAdoptionEnergyLevelValid: check(
      "pets_adoption_energy_level_valid",
      sql`${table.adoptionEnergyLevel} is null or ${table.adoptionEnergyLevel} in ('low','medium','high')`,
    ),
    petsAdoptionSizeEstimateValid: check(
      "pets_adoption_size_estimate_valid",
      sql`${table.adoptionSizeEstimate} is null or ${table.adoptionSizeEstimate} in ('small','medium','large','xl')`,
    ),
    petsAdoptionAgeBucketValid: check(
      "pets_adoption_age_bucket_valid",
      sql`${table.adoptionAgeBucket} is null or ${table.adoptionAgeBucket} in ('puppy','junior','young','adult','senior')`,
    ),
    petsAdoptionFeeNonNegative: check(
      "pets_adoption_fee_non_negative",
      sql`${table.adoptionFeeArs} is null or ${table.adoptionFeeArs} >= 0`,
    ),
    petsConditionsOtherConsistent: check(
      "pets_conditions_other_consistent",
      sql`${table.permanentConditionsOther} is null or 'otra' = any(${table.permanentConditions})`,
    ),
    petsPregnancyStatusValid: check(
      "pets_pregnancy_status_valid",
      sql`${table.pregnancyStatus} is null or ${table.pregnancyStatus} in ('in_progress', 'completed_live_birth', 'completed_stillbirth', 'completed_miscarriage', 'completed_termination')`,
    ),
    // ARCH-S: petsTattooLocationValid (pets_tattoo_location_valid) dropped — migration 0084.
    // ARCH-S: tattooCodeIdx (pets_tattoo_code_idx) dropped — migration 0084.
    petsJurisdictionProvinceCanonical: check(
      "pets_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
    // Migration 0178. `species` gates the entire PPP regime
    // (`isPotentiallyDangerousBreed` returns false for anything but 'dog'), so a
    // 'Perro' or a 'DOG' switches a legal regime off in silence. Values from
    // lib/utils/species.ts, the single source of truth for the labels.
    petsSpeciesValid: check(
      "pets_species_valid",
      sql`${table.species} in ('dog', 'cat', 'rabbit', 'guinea_pig', 'ferret', 'other')`,
    ),
  }),
);

// ============================================================================
// Organizations — peer to users (clinics, refugios, rescue networks, authorities)
// ============================================================================
// See AGENTS.md → Organizations. Verification is admin-stamped after document
// review (personería jurídica for refugios, matrícula for clinics, CUIT
// cross-check). Unverified orgs can use the system but their events write with
// author_verified=false, branding does not appear on public credentials, and
// they are excluded from broadcast-target queries.

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicToken: text("public_token").notNull().unique(),
    legalName: text("legal_name").notNull(),
    displayName: text("display_name").notNull(),
    orgType: orgTypeEnum("org_type").notNull(),
    cuit: text("cuit").unique(),
    personeriaJuridicaNumber: text("personeria_juridica_number"),
    email: text("email").notNull(),
    phone: text("phone"),
    website: text("website"),
    avatarUrl: text("avatar_url"),
    verified: boolean("verified").notNull().default(false),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByUserId: uuid("verified_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    tier0ShowBranding: boolean("tier_0_show_branding").notNull().default(false),
    // T-4.3: whether this org is shown as origin shelter on public credentials of pets it holds/adopted out.
    // Distinct from tier0ShowBranding (event authorship on timeline). Gated by org.verified.
    tier0ShowOriginOrg: boolean("tier_0_show_origin_org").notNull().default(false),
    // Set to true when a clinic org was auto-verified at creation because its sole admin
    // held a verified personal matrícula (solo-vet-consultorio bridge, D1).
    // Used by the matrícula-revocation cascade (D4) to un-verify ONLY matrícula-derived
    // verifications, never institutionally-reviewed ones.
    autoVerifiedViaMatricula: boolean("auto_verified_via_matricula").notNull().default(false),
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    status: orgStatusEnum("status").notNull().default("active"),
    // Public-profile fields (handoff P1-1). Surfaced on /refugios/[orgToken]
    // for verified shelter / rescue_network orgs. Free-form description
    // capped at 2000 chars via CHECK constraint declared below. Donation
    // methods is a typed JSONB blob (cbu / cvu / alias / mpLink / btcAddress)
    // — see DonationMethods type in lib/org-public-profile.ts.
    description: text("description"),
    logoStoragePath: text("logo_storage_path"),
    discloseAddress: boolean("disclose_address").notNull().default(true),
    donationMethods: jsonb("donation_methods"),
    // Canonical coordinate columns (P3 location convergence, DEPLOY 2).
    // Legacy latitude/longitude numeric(9,6) dropped in migration 0103.
    locationLat: numeric("location_lat", { precision: 10, scale: 7 }),
    locationLng: numeric("location_lng", { precision: 10, scale: 7 }),
    // Declared shelter capacity (Item 16 D1, migration 0102). All nullable — capacity is optional.
    // Occupancy is always derived from active shelter_custody ownerships (lib/org-census.ts),
    // never stored here. See dim-interno:docs/superpowers-private/specs/archive/2026-06-18-wave3-org-ops-handoff.md §Item 16.
    capacityDogs: integer("capacity_dogs"),
    capacityCats: integer("capacity_cats"),
    capacityOther: integer("capacity_other"),
    capacityTotal: integer("capacity_total"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    orgTypeIdx: index("organizations_org_type_idx").on(table.orgType),
    verifiedIdx: index("organizations_verified_idx").on(table.verified),
    descriptionLengthCheck: check(
      "organizations_description_length_check",
      sql`${table.description} IS NULL OR length(${table.description}) <= 2000`,
    ),
    locationPairCheck: check(
      "organizations_location_pair_check",
      sql`(${table.locationLat} IS NULL) = (${table.locationLng} IS NULL)`,
    ),
    organizationsJurisdictionProvinceCanonical: check(
      "organizations_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

// Inbound contact messages from anonymous visitors to the public
// refugio profile (handoff P2-8). Server actions write here under
// rate-limit guards; reads gated to org members via RLS (added in
// the migration). No email/PII validation beyond format — the
// inquirer is anonymous by design.
export const orgContactMessages = pgTable(
  "org_contact_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** What surface produced the message — 'contact' (Contactar sheet)
     * or 'volunteer' (Ser voluntario sheet). New kinds = one CHECK
     * update, no schema migration. */
    kind: text("kind").notNull().default("contact").$type<"contact" | "volunteer">(),
    inquirerName: text("inquirer_name"),
    inquirerEmail: text("inquirer_email").notNull(),
    message: text("message").notNull(),
    /**
     * The caller IP the daily rate-limit cohort is keyed on.
     *
     * ERRATA — this said "First IP from X-Forwarded-For", and so does the
     * `COMMENT ON COLUMN` in db/migrations/0051_org_contact_messages.sql:30.
     * Neither was ever true of the code. The value is produced by `callerIp()`
     * (lib/infra/rate-limit.ts), reached through `callerIpAddress()` in
     * src/modules/organizations/actions.ts: it reads `x-real-ip` first and, only
     * if that is absent, walks x-forwarded-for from the RIGHT and takes the LAST
     * non-empty hop. The first segment is never read.
     *
     * WHY THE WRONG SENTENCE IS DANGEROUS RATHER THAN MERELY WRONG. The FIRST
     * XFF segment is the one this repo documents everywhere else as
     * CLIENT-CONTROLLED and freely spoofable — it is what a caller puts in the
     * header, not what the edge observed. A future "fix" that aligned the code
     * to this comment would therefore key an abuse limiter on the one segment an
     * abuser chooses, and it would look like tidying a mismatch rather than
     * removing a control.
     *
     * The migration is applied and immutable, so its SQL cannot be edited; the
     * record is corrected forward instead, by migration 0204, which re-issues
     * the `COMMENT ON COLUMN` with the real mechanism. Same move as the ERRATA
     * at the top of src/modules/auth/application/subject-rights/
     * erase-subject-data.ts, one step further: there the false premise lived
     * only in a migration HEADER and could only be answered in prose, here it
     * also lives in a live database object that a forward migration can reach.
     */
    submitterIp: text("submitter_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => ({
    orgIdx: index("org_contact_messages_org_idx").on(table.organizationId),
    createdAtIdx: index("org_contact_messages_created_at_idx").on(table.createdAt),
    kindCheck: check(
      "org_contact_messages_kind_check",
      sql`${table.kind} IN ('contact', 'volunteer')`,
    ),
    messageLengthCheck: check(
      "org_contact_messages_message_length_check",
      sql`length(${table.message}) <= 500`,
    ),
    emailLengthCheck: check(
      "org_contact_messages_email_length_check",
      sql`length(${table.inquirerEmail}) <= 254`,
    ),
  }),
);

// Coverage zones for each org — used to target lost-pet broadcasts and to
// filter adoption listings by region. Multiple rows per org allowed.
export const organizationCoverage = pgTable(
  "organization_coverage",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    // NOT NULL added in migration 0073 (verified zero null rows before applying).
    jurisdictionProvince: text("jurisdiction_province").notNull(),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    isPrimary: boolean("is_primary").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("organization_coverage_org_id_idx").on(table.organizationId),
    jurisdictionIdx: index("organization_coverage_jurisdiction_idx").on(
      table.jurisdictionProvince,
      table.jurisdictionLocality,
    ),
    // Unique per (org, province, locality) with NULLS NOT DISTINCT so that
    // province-level rows (locality IS NULL) also deduplicate correctly.
    // Added in migration 0073.
    // Constraint name is intentionally short to stay under Postgres's 63-char limit.
    orgProvinceLocalityUnique: unique("org_coverage_org_province_locality_unique")
      .on(table.organizationId, table.jurisdictionProvince, table.jurisdictionLocality)
      .nullsNotDistinct(),
    organizationCoverageJurisdictionProvinceCanonical: check(
      "organization_coverage_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

// People ↔ orgs link. One user can hold memberships across many orgs.
// `can_write_pet_events` gates author privileges independently of role.
export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: organizationMembershipRoleEnum("role").notNull(),
    title: text("title"),
    canWritePetEvents: boolean("can_write_pet_events").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    invitedByUserId: uuid("invited_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    // Lost & Found — broadcast opt-in (Fase 6).
    // When a pet is marked lost, broadcastLostPet fans out a notification to
    // members of organizations whose coverage matches the pet's jurisdiction.
    // Members with receivesBroadcasts=false are silently excluded from the fanout.
    // Default true: opt-in by default; members can individually opt out.
    receivesBroadcasts: boolean("receives_broadcasts").notNull().default(true),
  },
  (table) => ({
    orgIdx: index("organization_memberships_org_id_idx").on(table.organizationId),
    userIdx: index("organization_memberships_user_id_idx").on(table.userId),
    // Exactly one active membership per (org, user). Mirrors migration 0072.
    // Prevents duplicate active memberships if two concurrent invite-accepts
    // slip past the FOR UPDATE lock (e.g. via different invite tokens).
    // Note: organization_memberships_active_idx (non-unique on same columns) was
    // dropped in migration 0095 — it was fully covered by this unique index.
    activeUniqueIdx: uniqueIndex("organization_memberships_active_unique")
      .on(table.organizationId, table.userId)
      .where(sql`${table.leftAt} IS NULL`),
  }),
);

// Per-membership capability grants. Each row is a request + decision audit
// record: who asked for what, when, who decided, and why. `organization_id` is
// denormalized from the membership so the admin queue (pending grants per org)
// is a single-index scan. The server action that writes here keeps it in sync.
export const organizationCapabilityGrants = pgTable(
  "organization_capability_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    membershipId: uuid("membership_id").notNull(),
    organizationId: uuid("organization_id").notNull(),
    capability: text("capability").notNull(),
    status: organizationCapabilityStatusEnum("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    requestedReason: text("requested_reason"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id"),
    decisionReason: text("decision_reason"),
  },
  (table) => ({
    // Auto-generated FK names exceed Postgres's 63-char identifier limit (NAMEDATALEN-1)
    // and get silently truncated, producing perpetual schema/migration drift. Declare
    // explicit names matching the truncated form already stored in PG.
    membershipFk: foreignKey({
      name: "organization_capability_grants_membership_id_organization_membe",
      columns: [table.membershipId],
      foreignColumns: [organizationMemberships.id],
    }).onDelete("cascade"),
    organizationFk: foreignKey({
      name: "organization_capability_grants_organization_id_organizations_id",
      columns: [table.organizationId],
      foreignColumns: [organizations.id],
    }).onDelete("cascade"),
    decidedByUserFk: foreignKey({
      name: "organization_capability_grants_decided_by_user_id_profiles_id_f",
      columns: [table.decidedByUserId],
      foreignColumns: [profiles.id],
    }).onDelete("set null"),
    membershipCapabilityIdx: index("org_capability_grants_membership_capability_idx").on(
      table.membershipId,
      table.capability,
    ),
    // Single-index lookup for an admin reviewing pending requests for one org.
    orgPendingIdx: index("org_capability_grants_org_pending_idx")
      .on(table.organizationId)
      .where(sql`${table.status} = 'pending'`),
    // At most one open (pending or approved) grant per (membership, capability).
    // Denials and revocations are terminal and don't block a fresh request.
    oneOpenGrantPerCapability: uniqueIndex("org_capability_grants_one_open_per_capability")
      .on(table.membershipId, table.capability)
      .where(sql`${table.status} IN ('pending', 'approved')`),
  }),
);

// ============================================================================
// Ownership — who holds custody of each pet, with history (polymorphic)
// ============================================================================
// Polymorphic holder: exactly one of (owner_user_id, owner_organization_id) is
// set per row, enforced via CHECK constraint. Ownership is the projection; the
// source of truth for transfers is always a custody_transferred or
// adoption_finalized event.
//
// Active-owner constraint: at most one active row per pet WHERE role='owner'.
// Multiple foster or co_owner rows can coexist with an active owner, or with
// each other when there is no permanent owner yet. ORGANISATION-held
// shelter_custody is capped at ONE live row per pet (0195, below): a live owner
// row and a live shelter_custody row CAN coexist — that pair is the
// rehome-by-titular sponsorship, where the animal keeps living with its titular
// while a verified org sponsors the adoption listing — but two orgs can never
// hold it at once. USER-held shelter_custody (a neighbour holding a found pet,
// confirm-chip-match-vecino.ts) is outside that cap on purpose: it was never
// constrained before 0195 and ADR-1 only needed the organisation rule.
//
// caretaker (custodia-temporal, migration 0189): the temporary caretaker of an
// owned pet — petsitter, vecina, family. NO LONGER "UI deferred": the role is
// implemented end to end, its lifecycle lives in `pet_caretaker_grants`, and it
// is capped at ONE ACTIVE ROW PER PET by its own partial unique index below.
// The cap is duplicated on purpose: the grants table protects the WORKFLOW, but
// `ownerships` is what every RLS policy and every read path joins, so the
// invariant consumers depend on has to hold where consumers read it.

export const ownerships = pgTable(
  "ownerships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").references(() => profiles.id, { onDelete: "cascade" }),
    ownerOrganizationId: uuid("owner_organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    role: ownershipRoleEnum("role").notNull().default("owner"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    // Self-reference; not a hard FK to avoid migration ordering issues.
    transferredFromId: uuid("transferred_from_id"),
    // D17 (foster volunteers pool): only meaningful when role='foster'. When
    // true, the org may assign additional co-fosters to the same pet. The
    // first foster sets this at acceptance time; can be toggled later.
    allowCoFoster: boolean("allow_co_foster").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    polymorphicHolder: check(
      "ownerships_polymorphic_holder",
      sql`((${table.ownerUserId} IS NOT NULL)::int + (${table.ownerOrganizationId} IS NOT NULL)::int) = 1`,
    ),
    oneActiveOwnerPerPet: uniqueIndex("ownerships_one_active_owner_per_pet")
      .on(table.petId)
      .where(sql`${table.role} = 'owner' AND ${table.endedAt} IS NULL`),
    // custodia-temporal (0189). ownerships_one_active_owner_per_pet is
    // `where role='owner'`, so it constrained caretaker rows not at all: a seed
    // or a future feature could have opened two active caretaker rows on one
    // pet and every consumer that joins ownerships would have silently picked
    // one. Now it fails loudly — which is the point.
    oneActiveCaretakerPerPet: uniqueIndex("ownerships_one_active_caretaker_per_pet")
      .on(table.petId)
      .where(sql`${table.role} = 'caretaker' AND ${table.endedAt} IS NULL`),
    // rehome-by-titular (0195), design ADR-1. Replaces 0077's per-(pet, org)
    // index, which let TWO orgs hold live custody of one pet — exactly what two
    // concurrent accepts of the same rehome_request would produce. Over the
    // org-held population this index strictly implies the old one, so the old
    // one was dropped in 0195 rather than kept as a second source of truth.
    // Scoped to `owner_organization_id IS NOT NULL`: user-held custody rows
    // (a neighbour holding a found pet) were never constrained by 0077 either —
    // it treated NULL orgs as distinct — and a per-pet index would have turned
    // the second neighbour's chip-match confirmation into an unhandled 23505.
    oneActiveOrgShelterCustodyPerPet: uniqueIndex(
      "ownerships_one_active_org_shelter_custody_per_pet",
    )
      .on(table.petId)
      .where(
        sql`${table.role} = 'shelter_custody' AND ${table.endedAt} IS NULL AND ${table.ownerOrganizationId} IS NOT NULL`,
      ),
    ownerUserIdx: index("ownerships_owner_user_id_idx").on(table.ownerUserId),
    ownerOrgIdx: index("ownerships_owner_organization_id_idx").on(table.ownerOrganizationId),
    // General (pet_id) index — covers the unfiltered orphan-detection EXISTS in
    // lib/metrics/program-health.ts fetchDataQuality. The partial unique indexes
    // above only cover specific role+active rows, so they can't serve the
    // all-rows lookup; without this the check seq-scanned ownerships per pet
    // (~135 s on the seed). A FK does not create an index in Postgres (0112).
    petIdIdx: index("ownerships_pet_id_idx").on(table.petId),
  }),
);

// ============================================================================
// PetCaretakerGrants — the temporary-caretaker invitation lifecycle
// ============================================================================
// custodia-temporal, migration 0189.
//
// WHY ITS OWN TABLE, and not a reuse of `pet_transfers`. The shape matches
// almost exactly (to_owner_email, a status machine, a public token), but a
// transfers row that transfers nothing poisons every existing query on that
// table — the transfer dashboards, the cross-org expiry sweep, the handshake
// case. The relationship is TEMPLATE, not table.
//
// WHY IT IS NOT A SPINE EVENT. There is no `caretaker_proposed` event: a
// pending invitation is workflow state, not a fact about the animal. Only an
// explicit ACCEPT produces a fact, and that is `caretaker_designated`, emitted
// in the same transaction as the `ownerships(role='caretaker')` row. This table
// plus audit_log IS the record of everything before that — consistent with
// invariant #3 rather than an exception to it.
//
// `ends_at` is NOT NULL by design: an open-ended arrangement is precisely the
// thing this feature refuses to create. The 180-day maximum is deliberately NOT
// a CHECK here — a forward-only, immutable migration is the wrong place to
// commit a product number that is still the PO's to change; the cap lives in
// src/modules/caretakers/domain.

export const petCaretakerGrants = pgTable(
  "pet_caretaker_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The `/cuidado/{token}` key handed to the invitee. Unguessable, unique.
    publicToken: text("public_token").notNull().unique(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    grantedByUserId: uuid("granted_by_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    // NULL until accept: the invitation may be addressed to someone who does
    // not have an account yet (the email below is the only handle we have).
    caretakerUserId: uuid("caretaker_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    caretakerEmail: text("caretaker_email").notNull(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "accepted" | "rejected" | "cancelled" | "expired" | "ended">(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    note: text("note"),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedReason: text("ended_reason"),
    // The projected ownership row, set at accept. The event is authoritative;
    // this pointer is what lets the drift harness compare the two.
    ownershipId: uuid("ownership_id").references(() => ownerships.id, { onDelete: "set null" }),
    // Stored witness for the T-3 reminder. A "fires exactly once" guarantee
    // needs a witness, not a date computation — a 04:05 re-run of the daily
    // dispatcher would otherwise send it twice.
    reminderSentAt: timestamp("reminder_sent_at", { withTimezone: true }),
    // KEY 2 of the two-key consent model for showing an ALTERNATE PUBLIC
    // CONTACT on the credential (PO decision 2026-08-19). NULL = never
    // consented. Key 1 is the titular's own disclosure toggle on `pets`
    // (disclose_*_when_lost, off by default); this is the CARETAKER's consent,
    // captured at invitation-accept time. BOTH are required. Never collapse the
    // two into one owner-side flag: publishing a third party's contact on an
    // unauthenticated page is not the titular's consent to give.
    publicContactConsentAt: timestamp("public_contact_consent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // PII baseline (pii.apply_baseline in migration 0189). caretaker_email is
    // an identifiable third party who may not even have an account.
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => profiles.id, { onDelete: "set null" }),
    purpose: dataPurposeEnum("purpose"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
  },
  (table) => ({
    statusCheck: check(
      "pet_caretaker_grants_status_check",
      sql`${table.status} IN ('pending','accepted','rejected','cancelled','expired','ended')`,
    ),
    periodCheck: check(
      "pet_caretaker_grants_period_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
    // The accept invariant, in the database. AMENDED BY 0192 — 0189 wrote this
    // over `accepted` ALONE, which made the `accepted -> ended` transition
    // impossible: the terminal UPDATE flips the status while both pointers stay
    // set, so the biconditional was violated on every revoke, withdrawal and
    // cron expiry. The whole ending path was unreachable and no schema test
    // caught it, because a row is legal until you try to move it.
    //
    // The set is now "an arrangement that actually happened": accepted OR
    // ended must name the caretaker and the ownership row it produced, and a
    // grant that never became one (pending/rejected/cancelled/expired) must not
    // carry both — which is 0189's real worry (a cancelled invitation keeping a
    // phantom ownership pointer the drift harness would compare against).
    //
    // A `pending` row MAY carry `caretaker_user_id` while `ownership_id` is
    // still NULL. Used: an invitation to somebody who already has an account
    // records who they are, so a cancellation can notify the right person.
    acceptCheck: check(
      "pet_caretaker_grants_accept_check",
      sql`(${table.status} IN ('accepted','ended')) = (${table.caretakerUserId} IS NOT NULL AND ${table.ownershipId} IS NOT NULL)`,
    ),
    // Backstop for the domain rule. The interesting case is not the UI (the
    // form never offers it) but a script or a future feature.
    noSelfDesignationCheck: check(
      "pet_caretaker_grants_no_self_designation_check",
      sql`${table.grantedByUserId} <> ${table.caretakerUserId}`,
    ),
    // Consent is captured at accept and nowhere else. Weak form on purpose so
    // the record SURVIVES the grant ending — see the migration for the full
    // reasoning.
    publicContactConsentCheck: check(
      "pet_caretaker_grants_public_contact_consent_check",
      sql`${table.publicContactConsentAt} IS NULL OR ${table.status} <> 'pending'`,
    ),
    onePendingPerPet: uniqueIndex("pet_caretaker_grants_one_pending_per_pet")
      .on(table.petId)
      .where(sql`${table.status} = 'pending'`),
    oneAcceptedPerPet: uniqueIndex("pet_caretaker_grants_one_accepted_per_pet")
      .on(table.petId)
      .where(sql`${table.status} = 'accepted'`),
    // Cron scan: pending older than 7 days, accepted past ends_at, T-3 window.
    statusEndsAtIdx: index("pet_caretaker_grants_status_ends_at_idx").on(
      table.status,
      table.endsAt,
    ),
    // The caretaker's own /mis-mascotas.
    activeCaretakerIdx: index("pet_caretaker_grants_caretaker_active_idx")
      .on(table.caretakerUserId)
      .where(sql`${table.status} = 'accepted'`),
    petIdIdx: index("pet_caretaker_grants_pet_id_idx").on(table.petId),
  }),
);

// ============================================================================
// PetEvents — the append-only timeline (the spine)
// ============================================================================
// Every fact about a pet's life is a row here. Never edited, never deleted.
// Corrections are new rows that reference the original event in `payload`.

export const petEvents = pgTable(
  "pet_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    // TEXT with no CHECK and no enum: the catalog lives in TypeScript
    // (EVENT_TYPES) and is enforced by `validateEventPayload` on the way in.
    // That is a statement about ONE writer. Name both, because until migration
    // 0212 the second one made the comment false: the Drizzle/BYPASSRLS path
    // (every use case, every server action, /api/v1) validates; the PostgREST
    // path never reaches app code, and 0190's INSERT policy constrained only
    // the titular-only event-type family, never this column against the
    // catalog and never `author_role`/`author_verified` at all. Migration 0212
    // dropped that policy, so `pet_events` now has no caller-facing write
    // surface and the Drizzle path is the only writer left — fenced by
    // __tests__/rls/pet-events-write-lockdown.test.ts.
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedByUserId: uuid("recorded_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    authorRole: authorRoleEnum("author_role").notNull().default("owner"),
    // Institutional actor when the author acted on behalf of an org (clinic vet,
    // refugio coordinator, sanitary-authority employee). Distinct from
    // recorded_by_user_id, which always names the individual person.
    authorOrganizationId: uuid("author_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    authorVerified: boolean("author_verified").notNull().default(false),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    notes: text("notes"),
    // Location as (lat, lng) for v1. Migrate to PostGIS `geography(Point, 4326)`
    // when we add radius search / polygon-based projections. Drizzle has
    // customType support for it; lift-and-shift will be straightforward.
    locationLat: numeric("location_lat", { precision: 10, scale: 7 }),
    locationLng: numeric("location_lng", { precision: 10, scale: 7 }),
    // Cases system (migration 0033 + FK added migration 0079). Nullable — at
    // most one case per event. The case_id is append-only at the DB level
    // (enforced by trigger). ON DELETE RESTRICT: events are immutable records
    // that predate any case deletion; hard-deleting a case while events reference
    // it is an integrity error, not a silent cascade.
    // NOTE: cases is declared after petEvents in this file, so we use the
    // forward-reference pattern via a lambda.
    caseId: uuid("case_id").references((): AnyPgColumn => cases.id, {
      onDelete: "restrict",
    }),
    // ENO Event-Trust Tier 1 Fase B (migration 0047). UUID v4 generated
    // client-side before form submission. NULL for admin writes and any
    // path that does not supply a key. The partial unique index
    // `pet_events_idempotency_idx` on (pet_id, event_type, key) WHERE
    // key IS NOT NULL enforces last-stable-wins idempotency: ON CONFLICT
    // DO NOTHING + fetch-existing returns the original row silently.
    clientIdempotencyKey: uuid("client_idempotency_key"),
    // SENASA alignment (compliance PR 3, migration 0061). All nullable —
    // populated by the new sanitary event form; legacy rows stay NULL.
    // FK to ref.* tables in the migration; declared here as plain text
    // because Drizzle declares FKs per-column and the ref schema lives
    // out of band.
    tipoEventoCode: text("tipo_evento_code"),
    loteBiologico: text("lote_biologico"),
    laboratorio: text("laboratorio"),
    vencimientoBiologico: date("vencimiento_biologico"),
    viaAplicacionCode: text("via_aplicacion_code"),
    vetMatricula: text("vet_matricula"),
    vetJurisdiccionCode: text("vet_jurisdiccion_code"),
    establecimientoRenspa: text("establecimiento_renspa"),
    proximaDosisAt: date("proxima_dosis_at"),
    firmadoAt: timestamp("firmado_at", { withTimezone: true }),
    firmaHash: text("firma_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petTimelineIdx: index("pet_events_pet_id_occurred_at_idx").on(table.petId, table.occurredAt),
    eventTypeIdx: index("pet_events_event_type_idx").on(table.eventType),
    // Composite for province-scale analytics scans that filter by event_type +
    // a time window WITHOUT pet_id (govt-home-kpis.ts rabies coverage KPI) —
    // perf/scale review 2026-07-04, migration 0122.
    eventTypeOccurredAtIdx: index("pet_events_event_type_occurred_at_idx").on(
      table.eventType,
      table.occurredAt,
    ),
    // Transaction-time twin of the above (viz-suite wave 0, migration 0142):
    // the reporting-lag aggregate (median(recorded_at - occurred_at) per unit,
    // filtered by type) and every basis=transaction window scan sort/filter on
    // recorded_at, which had no index. Same composite shape as its valid-time
    // sibling so the planner treats both bases symmetrically.
    eventTypeRecordedAtIdx: index("pet_events_event_type_recorded_at_idx").on(
      table.eventType,
      table.recordedAt,
    ),
    authorRoleIdx: index("pet_events_author_role_idx").on(table.authorRole),
    locationIdx: index("pet_events_location_idx").on(table.locationLat, table.locationLng),
    // Partial unique index for client-side idempotency keys (migration 0047).
    // Only rows with a non-null key participate — see comment on column above.
    idempotencyIdx: uniqueIndex("pet_events_idempotency_idx")
      .on(table.petId, table.eventType, table.clientIdempotencyKey)
      .where(sql`client_idempotency_key is not null`),
    // Cross-pet idempotency lookup (migration 0119): the org-intake guard looks
    // up pet_registered events by (event_type, client_idempotency_key) BEFORE a
    // pet exists, so the pet_id-leading idempotencyIdx above cannot serve it.
    // Partial (key IS NOT NULL) keeps it tiny. Declared here so drizzle-kit push
    // does not drop the migration-created index (schema↔migration agreement).
    typeClientKeyIdx: index("pet_events_type_client_key_idx")
      .on(table.eventType, table.clientIdempotencyKey)
      .where(sql`client_idempotency_key is not null`),
    // SENASA alignment partial index (compliance PR 3, migration 0061).
    tipoEventoCodeIdx: index("pet_events_tipo_evento_code_idx")
      .on(table.tipoEventoCode)
      .where(sql`${table.tipoEventoCode} IS NOT NULL`),
    // ARCH-K (migration 0081): JSONB payload expression indexes for hot-path
    // queries that filter on payload field values in WHERE / NOT EXISTS clauses.
    // Expression syntax mirrors org_invitations_active_unique (lower(email)).
    // Partial (IS NOT NULL) keeps indexes small — only rows that carry the field.
    payloadMedStartedIdx: index("pet_events_payload_med_started_idx")
      .on(sql`(payload->>'medication_started_event_id')`)
      .where(sql`payload->>'medication_started_event_id' IS NOT NULL`),
    payloadAppEventIdIdx: index("pet_events_payload_app_event_id_idx")
      .on(sql`(payload->>'application_event_id')`)
      .where(sql`payload->>'application_event_id' IS NOT NULL`),
    payloadApplicantUserIdIdx: index("pet_events_payload_applicant_user_id_idx")
      .on(sql`(payload->>'applicant_user_id')`)
      .where(sql`payload->>'applicant_user_id' IS NOT NULL`),
    // Amendment overlay probe (migration 0118, projection-cron audit 2026-07-03
    // A2): SQL KPI aggregates resolve the latest correction per target event
    // via payload->>'target_event_id' (lib/infra/amendment-sql.ts). Partial:
    // only event_amended rows participate, so the index stays tiny.
    payloadAmendedTargetIdx: index("pet_events_amended_target_idx")
      .on(sql`(payload->>'target_event_id')`)
      .where(sql`event_type = 'event_amended'`),
    // Org-scoped overdue-checkins driver (migration 0141, staging-readiness
    // triage #42): countOverdueCheckins (lib/analytics/org-dashboard.ts)
    // filters adoption_finalized events by payload->>'previous_owner_organization_id'
    // to bound the DRIVE side of the checkins join. Partial: only
    // adoption_finalized rows participate, same shape as payloadAmendedTargetIdx.
    payloadPreviousOwnerOrgIdx: index("pet_events_payload_previous_owner_org_idx")
      .on(sql`(payload->>'previous_owner_organization_id')`)
      .where(sql`event_type = 'adoption_finalized'`),
    // Cases system FK index (shipped in migration 0033, mirrored here for
    // schema↔migration agreement). Partial: most events carry no case_id.
    caseIdIdx: index("pet_events_case_id_idx")
      .on(table.caseId)
      .where(sql`${table.caseId} IS NOT NULL`),
    // V1-8 perf (migration 0090): unindexed FKs caused sequential scans on
    // author/recorder lookups. pet_events is the largest table. Partial
    // (IS NOT NULL) keeps both small — many rows have a null author org and
    // some legacy rows have a null recorder.
    recordedByUserIdx: index("pet_events_recorded_by_user_id_idx")
      .on(table.recordedByUserId)
      .where(sql`${table.recordedByUserId} IS NOT NULL`),
    authorOrganizationIdx: index("pet_events_author_organization_id_idx")
      .on(table.authorOrganizationId)
      .where(sql`${table.authorOrganizationId} IS NOT NULL`),
    // Data-integrity: lat and lng must be stored together or not at all
    // (migration 0100). NOT VALID on first apply — validate once data confirmed
    // clean. Mirrors organizations_coordinates_pair_check.
    locationPairCheck: check(
      "pet_events_location_pair_check",
      sql`(${table.locationLat} IS NULL) = (${table.locationLng} IS NULL)`,
    ),
  }),
);

// ============================================================================
// Reminders
// ============================================================================
// Most reminders are auto-generated from events (e.g. a vaccination event with
// `next_due_at` creates a reminder pointing back via `source_event_id`).
// Users can also create custom ones.

export const reminders = pgTable(
  "reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    reminderType: reminderTypeEnum("reminder_type").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    title: text("title").notNull(),
    description: text("description"),
    sourceEventId: uuid("source_event_id").references(() => petEvents.id, {
      onDelete: "set null",
    }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Scheduling system (Fase 0): link to a real appointment when backed by a
    // booking. Null = personal reminder only (existing flow unchanged, D7).
    // Intentionally NOT using .references() here — the FK to appointments is
    // enforced at the DB level (see migration 0013). Drizzle cannot express
    // circular FKs (reminders → appointments → reminders) via references() without
    // an implicit-any error; the plain uuid column is the standard workaround.
    appointmentId: uuid("appointment_id"),
    // Snooze support (C2, migration 0040). Cap: 3×7d, then 30d cooldown.
    // When snoozed_until > now the cron skips this reminder.
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    snoozeCount: integer("snooze_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userDueIdx: index("reminders_user_due_at_idx").on(table.userId, table.dueAt),
    petDueIdx: index("reminders_pet_due_at_idx").on(table.petId, table.dueAt),
    appointmentIdx: index("reminders_appointment_idx")
      .on(table.appointmentId)
      .where(sql`${table.appointmentId} IS NOT NULL`),
    // Medication / checkin type lookups per pet (migration 0096).
    petTypeDueIdx: index("reminders_pet_type_due_idx").on(
      table.petId,
      table.reminderType,
      table.dueAt,
    ),
  }),
);

// ============================================================================
// Attachments — uploaded files (photos of the pet, scans of paper booklets...)
// ============================================================================

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id").references(() => pets.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => petEvents.id, { onDelete: "cascade" }),
    // Approval-flow attachments: one or the other (or neither, for pet/event
    // attachments). approval_evidence files hang off the approval_request;
    // revocation_evidence files hang off the audit_log entry that recorded
    // the revocation. See admin-page-design spec §4.6.
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "cascade",
    }),
    auditLogId: uuid("audit_log_id").references(() => auditLog.id, {
      onDelete: "cascade",
    }),
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    storagePath: text("storage_path").notNull(), // path inside the Supabase Storage bucket
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size"),
    caption: text("caption"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petIdx: index("attachments_pet_id_idx").on(table.petId),
    eventIdx: index("attachments_event_id_idx").on(table.eventId),
    // Parent FK XOR constraint (ARCH-D).
    //
    // Attachments have two distinct parent groups:
    //   content group      — pet_id / event_id (event attachments carry both)
    //   approval-flow group — approval_request_id / audit_log_id (revocation
    //                         evidence, approval evidence — never mixed)
    //
    // Invariant: approval-flow parents are mutually exclusive with content
    // parents and with each other. "Zero parents" is a valid transient state
    // (uploadRevocationEvidence stages the row before claimAttachmentsForAudit
    // claims it inside the revocation transaction). Two members of the same
    // group simultaneously — or one from each group — is always a data error.
    atMostOneParent: check(
      "attachments_at_most_one_parent",
      sql`num_nonnulls(${table.approvalRequestId}, ${table.auditLogId}) <= 1 AND ((${table.approvalRequestId} IS NULL AND ${table.auditLogId} IS NULL) OR (${table.petId} IS NULL AND ${table.eventId} IS NULL))`,
    ),
  }),
);

// ============================================================================
// Inferred TypeScript types — use these in app code
// ============================================================================

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;

export type Pet = typeof pets.$inferSelect;
export type NewPet = typeof pets.$inferInsert;

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;

export type OrganizationCoverage = typeof organizationCoverage.$inferSelect;
export type NewOrganizationCoverage = typeof organizationCoverage.$inferInsert;

export type OrganizationMembership = typeof organizationMemberships.$inferSelect;
export type NewOrganizationMembership = typeof organizationMemberships.$inferInsert;

export type OrganizationCapabilityGrant = typeof organizationCapabilityGrants.$inferSelect;
export type NewOrganizationCapabilityGrant = typeof organizationCapabilityGrants.$inferInsert;

export type Ownership = typeof ownerships.$inferSelect;
export type NewOwnership = typeof ownerships.$inferInsert;

export type PetEvent = typeof petEvents.$inferSelect;
export type NewPetEvent = typeof petEvents.$inferInsert;

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;

export type Attachment = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

// ============================================================================
// Notifications — per-user message history with read/archived state
// ============================================================================
// Distinct from PetEvents:
//   - Events are immutable facts about the world (the pet's life).
//   - Notifications are messages TO a user, with mutable state (read, archived).
// Notifications often *project from* events — e.g. registering a pet with a
// dangerous breed produces a `ppp_registration_reminder`. Some are pure
// system messages (welcome, app updates) with no source event.
//
// `first_stranger_scan` (owner-onboarding train): fired once per pet, the
// first time a non-owner scans its public credential — see
// lib/infra/notify-owner-of-first-stranger-scan.ts. Every notificationType
// literal's es-AR label lives in lib/utils/format.ts's
// NOTIFICATION_TYPE_LABELS, kept in sync by convention (no schema enum here).

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    // Free text (not enum) so adding a new notification type doesn't need a
    // migration. Validated in app code.
    notificationType: text("notification_type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    severity: notificationSeverityEnum("severity").notNull().default("info"),
    // Optional call-to-action button.
    ctaLabel: text("cta_label"),
    ctaUrl: text("cta_url"),
    // Optional links back to the domain entities that triggered this.
    relatedPetId: uuid("related_pet_id").references(() => pets.id, { onDelete: "set null" }),
    relatedEventId: uuid("related_event_id").references(() => petEvents.id, {
      onDelete: "set null",
    }),
    // Cron-emitted notifications keyed off a specific reminder (e.g. the
    // post_adoption_checkin family) carry the reminder id here so the cron
    // can dedupe per-reminder. relatedEventId is reserved for pet_events
    // FK semantics and is shared across all reminders that source from the
    // same event, so it can't carry the per-reminder identity by itself.
    relatedReminderId: uuid("related_reminder_id").references(() => reminders.id, {
      onDelete: "set null",
    }),
    // Cases system (migration 0033). Lets the dashboard collapse N
    // case-derived notifications into one "Caso X" entry. Nullable —
    // free-standing notifications never set this. FK to cases(id) added in
    // migration 0128 (C6 defense-in-depth): ON DELETE SET NULL so a deleted
    // case nulls the grouping rather than leaving a dangling ref. Forward
    // reference (cases is declared later in this file), same as petEvents.caseId.
    relatedCaseId: uuid("related_case_id").references((): AnyPgColumn => cases.id, {
      onDelete: "set null",
    }),
    // Category for /notificaciones tab filtering (C2, migration 0040).
    // Values: 'health', 'custody', 'adoption', 'welfare', 'admin'. Nullable
    // for pre-C2 rows that were inserted without a category.
    category: text("category"),
    // Caller-supplied idempotency key, set by createNotification()
    // (lib/infra/notification-service.ts). Generalizes migration 0088's
    // event-natural-key guard to cover cron + broadcast notifications, which
    // have no related_event_id. The partial unique index below enforces one
    // row per key. NULL for legacy / not-yet-migrated direct inserts (exempt).
    // Migration 0124.
    dedupeKey: text("dedupe_key"),
    // State.
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userUnreadIdx: index("notifications_user_unread_idx")
      .on(table.userId)
      .where(sql`${table.readAt} IS NULL AND ${table.archivedAt} IS NULL`),
    userCreatedIdx: index("notifications_user_created_idx").on(table.userId, table.createdAt),
    // Tab filter index: WHERE archived_at IS NULL (only active notifications)
    userCategoryIdx: index("notifications_user_category_idx")
      .on(table.userId, table.category)
      .where(sql`${table.archivedAt} IS NULL`),
    // Per-reminder throttle check index for runVaccineDueScan()
    reminderRecentIdx: index("notifications_reminder_recent_idx")
      .on(table.relatedReminderId, table.createdAt)
      .where(sql`${table.relatedReminderId} IS NOT NULL`),
    // Idempotency guard for event-derived notifications (ENO fanout et al.).
    // Lets consumers insert with onConflictDoNothing so re-processing a queue
    // row never duplicates a legal notification. Partial: free-standing /
    // cron-emitted notifications (related_event_id IS NULL) are exempt because
    // they legitimately repeat (user, type) across occurrences. Migration 0088.
    eventNaturalKeyUnique: uniqueIndex("notifications_event_natural_key_unique")
      .on(table.userId, table.relatedEventId, table.notificationType)
      .where(sql`${table.relatedEventId} IS NOT NULL`),
    // Cases system FK index (shipped in migration 0033, mirrored here for
    // schema↔migration agreement). Lets the dashboard collapse case-derived
    // notifications without scanning. Partial: free-standing notifications
    // never set related_case_id.
    relatedCaseIdIdx: index("notifications_related_case_id_idx")
      .on(table.relatedCaseId)
      .where(sql`${table.relatedCaseId} IS NOT NULL`),
    // Pet FK index for lost-pet / disease dedup scans (migration 0096).
    // Partial: only rows that reference a specific pet are relevant.
    relatedPetIdx: index("notifications_related_pet_idx")
      .on(table.relatedPetId)
      .where(sql`${table.relatedPetId} IS NOT NULL`),
    // Generalized idempotency guard for the createNotification() service.
    // Applies to ALL notification types (cron + broadcast included), unlike
    // 0088's event-only guard. The service inserts with ON CONFLICT
    // (dedupe_key) DO NOTHING so a retry / concurrent double-run is a no-op.
    // Partial: rows with dedupe_key IS NULL (legacy direct inserts) are exempt.
    // Migration 0124.
    dedupeKeyUnique: uniqueIndex("notifications_dedupe_key_unique")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} IS NOT NULL`),
  }),
);

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;

// ---------------------------------------------------------------------------
// Push subscriptions (migration 0152) — Web Push (VAPID) delivery targets.
//
// PWA push v1 (ADR 2026-07-18-native-readiness §4): the notifications table
// stays the source of truth; Web Push is a best-effort second delivery leg for
// severity='urgent' rows only. Each row is one browser PushSubscription
// (endpoint + client keys) owned by one user. Revocation is soft (revoked_at)
// — set when the user toggles push off or the push service answers 410/404 —
// so the row keeps an auditable trail; hard deletion only via profiles cascade.
// ---------------------------------------------------------------------------

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    // Push service URL for this browser registration. Globally unique: the
    // same endpoint re-submitted (same browser, new session) upserts in place.
    endpoint: text("endpoint").notNull().unique(),
    // Client public key + auth secret from PushSubscription.getKey(), base64url.
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    // Best-effort browser identification for the user's device list. Optional.
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set on every successful delivery; lets a cleanup cron drop stale rows.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Soft revocation: user toggled off, or the push service returned 410/404.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    // Send-path index: all active subscriptions for one user.
    userActiveIdx: index("push_subscriptions_user_active_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    // Purge-path index (migration 0197): the revoked rows older than the TTL
    // that lib/infra/data-lifecycle.ts prunes nightly. Partial on the REVOKED
    // population — the send path's index above covers the live one — so a live
    // row costs nothing to maintain here and the purge's `revoked_at < cutoff`
    // is an index-range scan instead of a table scan.
    revokedAtIdx: index("push_subscriptions_revoked_at_idx")
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} IS NOT NULL`),
  }),
);

export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;

// ============================================================================
// PushTargets — native (Expo) push destinations, sibling of push_subscriptions
// ============================================================================
// A SECOND TABLE RATHER THAN THREE NULLABLE COLUMNS. `push_subscriptions` above
// declares `endpoint`, `p256dh` and `auth` NOT NULL because a browser
// registration cannot exist without them, and the web send path leans on that.
// A device token fills none of the three. Relaxing them to fit a channel that
// did not exist yet would weaken three live invariants to accommodate a
// hypothetical one — so the native channel gets its own table and the two stay
// siblings permanently. This is NOT a migration path: web push keeps
// `push_subscriptions` for good.
//
// THE UNIQUE KEY IS `device_id`, AND IT IS DELIBERATELY NOT THE TOKEN. Expo push
// tokens rotate. A token used as the conflict target orphans a row on every
// rotation, and once orphaned there is no install identity left to reconcile
// against — the table grows a tail of dead rows nobody can attribute.
// `device_id` is a UUID the app mints ONCE on first launch and keeps in
// `expo-secure-store`. One install is one row, for the life of the install.
//
// THE CONSEQUENCE IS INTENDED, not an accident of the key choice: registration
// upserts `user_id` on conflict with `device_id`, so if a second person signs in
// on the same phone the row's owner flips and the first person stops receiving
// pushes there. That is correct. A lock screen belongs to whoever is signed in
// on that device, not to whoever signed in first.
export const pushTargets = pgTable(
  "push_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    // Install identity, minted once by the app and held in expo-secure-store.
    // Globally unique: one install is one row. See the note above for why this
    // is the conflict target and the token is not.
    deviceId: text("device_id").notNull().unique(),
    // The Expo push token (ExponentPushToken[...]). Rotates; updated in place on
    // re-registration, which is why it is not the key.
    expoPushToken: text("expo_push_token").notNull(),
    platform: text("platform").notNull(),
    // Triage only: which build a dead token came from. Nothing routes on it.
    appVersion: text("app_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Bumped on every successful delivery, same contract as push_subscriptions.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // Soft revocation: sign-out, or Expo answered DeviceNotRegistered. Hard
    // deletion happens only server-side (the purge) or via the profiles cascade.
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // The Expo receipt id from the last message this device ACCEPTED, awaiting
    // reconciliation (migration 0223). `DeviceNotRegistered` — the one signal
    // that says a delivery address is dead — mostly arrives in the RECEIPT and
    // not in the ticket, because Expo has not talked to FCM or APNs yet when it
    // writes the ticket. This is how the nightly job finds the row an answer
    // belongs to. Cleared once read, or once it has aged past Expo's ~24h.
    pendingReceiptId: text("pending_receipt_id"),
    // When that id was written. Only the AGE is ever read: Expo answers nothing
    // for a receipt id older than roughly a day, so an aged-out id is cleared
    // unasked rather than re-queried nightly forever.
    pendingReceiptAt: timestamp("pending_receipt_at", { withTimezone: true }),
  },
  (table) => ({
    // Send-path index: all active targets for one user. Mirrors
    // push_subscriptions_user_active_idx.
    userActiveIdx: index("push_targets_user_active_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    // Purge-path index, partial on the REVOKED population for the same reason
    // push_subscriptions_revoked_at_idx is: the live rows are already covered
    // above, so a live row costs nothing to maintain here and the purge's
    // `revoked_at < cutoff` is an index-range scan instead of a table scan.
    revokedAtIdx: index("push_targets_revoked_at_idx")
      .on(table.revokedAt)
      .where(sql`${table.revokedAt} IS NOT NULL`),
    // The reconciliation job's read: every device with a receipt still owed,
    // oldest first. Partial on the PENDING population for the same reason the
    // one above is partial on the revoked one — at any moment almost every row
    // has nothing outstanding, and a full index would be maintained on every
    // send to answer a question about a handful.
    pendingReceiptIdx: index("push_targets_pending_receipt_idx")
      .on(table.pendingReceiptAt)
      .where(sql`${table.pendingReceiptId} IS NOT NULL`),
    // Expo brokers to exactly two stores. The constraint is here rather than in
    // a comment because a third value would be a typo, not a feature.
    platformValid: check(
      "push_targets_platform_valid",
      sql`${table.platform} in ('ios', 'android')`,
    ),
  }),
);

export type PushTarget = typeof pushTargets.$inferSelect;
export type NewPushTarget = typeof pushTargets.$inferInsert;

// ============================================================================
// NotificationDeadLetter — recoverable failure surface (migration 0124)
// ============================================================================
// When the createNotification() service's insert throws (pool exhaustion,
// deploy-time connection drop, brief outage) it writes the payload here instead
// of only console.error'ing — closing the ARCH-P silent-dropout gap
// (consistency review 2026-07-04 C.1). A follow-on retry cron drains
// unresolved rows.
export const notificationDeadLetter = pgTable(
  "notification_dead_letter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The dedupe_key the failed insert would have used (nullable). NOT unique:
    // a dead-letter row is a failure record, not a live notification, and the
    // same key may fail more than once before it is resolved.
    dedupeKey: text("dedupe_key"),
    // The full notification insert payload, so a retry cron can replay it
    // verbatim through createNotification() once the transient fault clears.
    payload: jsonb("payload").notNull(),
    // Best-effort capture of the error that caused the flush to fail.
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by the retry cron when it re-attempts this payload.
    retriedAt: timestamp("retried_at", { withTimezone: true }),
    // Set when the payload was successfully re-delivered (or manually resolved).
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => ({
    // The "unresolved" working set the retry cron scans.
    unresolvedIdx: index("notification_dead_letter_unresolved_idx")
      .on(table.createdAt)
      .where(sql`${table.resolvedAt} IS NULL`),
  }),
);

export type NotificationDeadLetter = typeof notificationDeadLetter.$inferSelect;
export type NewNotificationDeadLetter = typeof notificationDeadLetter.$inferInsert;

// ============================================================================
// WelfareReports — animal-cruelty / welfare denuncia (Ley 14.346)
// ============================================================================
// Separate domain from the pet-event catalog. Reporters can be logged-in or
// anonymous (reporter_user_id is null for anonymous submissions). The subject
// can be a registered DIM pet, an unowned animal (free text), or a
// location/situation. Workflow transitions (triage, close) are done via
// service role by welfare officers — admin UI deferred to a later slice.

export const welfareReports = pgTable(
  "welfare_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Short reference code for tracking — lets anonymous reporters retrieve
    // their own denuncia later without logging in. Format: DEN-XXXX-XXXX.
    // Generated at insert time with retry-on-collision (see lib/welfare-codes.ts).
    // Uniqueness is enforced by the `referenceCodeIdx` unique index below; declaring
    // `.unique()` here too would create a duplicate constraint with a conflicting name.
    referenceCode: text("reference_code").notNull(),

    // Reporter (null when anonymous)
    reporterUserId: uuid("reporter_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    // Org-side denuncia (spec 2026-05-19-org-abuse-investigation): set
    // when a member of a verified org emits the report on behalf of
    // the org. Drives priority sort in /gob/maltrato, audit attribution,
    // and multi-source escalation when ≥2 orgs report the same subject.
    reporterOrganizationId: uuid("reporter_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    reporterContactEmail: text("reporter_contact_email"),
    reporterContactPhone: text("reporter_contact_phone"),

    // What
    kind: welfareReportKindEnum("kind").notNull(),
    severity: welfareReportSeverityEnum("severity").notNull(),
    description: text("description").notNull(),
    // What the reporter observed on the animal, verbatim (migration 0209, PO
    // decision 2026-09-01: campo propio). Free text and NOT coded symptoms:
    // the coded pipeline (symptom_observed events) needs a registered pet,
    // and this column exists precisely for the reports that have none.
    observedSymptoms: text("observed_symptoms"),

    // Subject
    subjectKind: welfareReportSubjectKindEnum("subject_kind").notNull(),
    subjectPetId: uuid("subject_pet_id").references(() => pets.id, {
      onDelete: "set null",
    }),
    subjectDescription: text("subject_description"),

    // Where
    locationAddress: text("location_address"),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Structural locality-attribution FK (migration 0147). Nullable + additive —
    // mirrors pets.localityId. References the ar_localities uuid PK.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    // HOW locality_id was decided (lib/domain/place.ts; CHECK in migration 0248).
    // NULL = not recorded. localidades-por-id B1.
    placeMethod: text("place_method"),
    // The place AS ENTERED and AS RESOLVED (lib/events/place-payload.ts). A
    // denuncia about an unregistered animal writes no event, so this is the
    // only record of a typed locality that did not resolve (P2). Migration 0248.
    placeEntered: jsonb("place_entered"),
    // Low-confidence routing mark (migration 0162, PO decision D.11).
    // TRUE = the geocoder was unreachable and the (province, locality) above was
    // read out of the FORM TEXT instead. The report is routed on a GUESS, so the
    // triage queue MUST show it (WelfareDenunciaRow) — a flag no screen renders
    // would ship D.11's accepted risk without D.11's mitigation.
    jurisdictionUnverified: boolean("jurisdiction_unverified").notNull().default(false),
    // Coordinate pair. Numeric(10,7) matches pet_events.location_lat/lng so
    // both tables can flow through the same accessor (`lib/location.ts`).
    locationLat: numeric("location_lat", { precision: 10, scale: 7 }),
    locationLng: numeric("location_lng", { precision: 10, scale: 7 }),

    // When
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // Workflow (admin/welfare-officer side comes later; default open)
    status: welfareReportStatusEnum("status").notNull().default("open"),
    triagedAt: timestamp("triaged_at", { withTimezone: true }),
    triagedByUserId: uuid("triaged_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    resolutionNotes: text("resolution_notes"),
    // Moderation layer — auto-flagged anonymous denuncias await admin
    // review at /admin/moderacion. /gob/maltrato excludes flagged-not-
    // resolved rows so govt only sees triage-ready cases.
    flaggedAt: timestamp("flagged_at", { withTimezone: true }),
    flagReasons: jsonb("flag_reasons").notNull().default([]),
    moderationResolvedAt: timestamp("moderation_resolved_at", { withTimezone: true }),
    moderationResolvedByUserId: uuid("moderation_resolved_by_user_id").references(
      () => profiles.id,
      { onDelete: "set null" },
    ),
    // Govt→admin escalation (migration 0132). A jurisdiction govt can hand a
    // flagged denuncia back to the national admin queue instead of approving or
    // rejecting it. The row stays moderation-pending (admin still owns it) but
    // leaves the govt actionable queue. Motivo lives in the
    // welfare_report_escalated_to_admin audit_log row.
    moderationEscalatedAt: timestamp("moderation_escalated_at", { withTimezone: true }),
    moderationEscalatedByUserId: uuid("moderation_escalated_by_user_id").references(
      () => profiles.id,
      { onDelete: "set null" },
    ),
    // Cases system (migration 0033). Linked to the welfare_denuncia case
    // opened atomically on submit. Nullable for historical rows.
    caseId: uuid("case_id"),

    // Assignment (migration 0041). Welfare officer who has taken ownership of
    // this report. Null = unassigned. Set via assignWelfareToMeAction.
    assignedToUserId: uuid("assigned_to_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

    // Derivation to org (migration 0076). Set by a govt/admin actor who forwards
    // this report to a verified shelter or rescue network for follow-up.
    // derivedToOrganizationId drives the org-side "Recibidos" inbox.
    derivedToOrganizationId: uuid("derived_to_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    derivedAt: timestamp("derived_at", { withTimezone: true }),
    derivedByUserId: uuid("derived_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

    // Org intervention state (migration 0092, UI-7). Set by an org member that
    // received the derived report. NULL = no org action yet; 'tomado' = taken
    // (under intervention); 'devuelto' = org returned it (cannot intervene).
    // NON-PII workflow metadata — safe for the org-facing projection. Gov stays
    // the only closer; these columns never transition the welfare status enum.
    orgInterventionStatus: text("org_intervention_status"),
    orgInterventionAt: timestamp("org_intervention_at", { withTimezone: true }),

    // Internal, NON-RENDERED seed-cleanup marker (migration 0155). NULL for
    // every real citizen report — only scripts/seed-panorama.ts writes it, to
    // find its own rows on --clean/re-seed without smuggling a marker into
    // `description` (which IS rendered). Never select this column in a
    // citizen/operator-facing query.
    seedTag: text("seed_tag"),
  },
  (table) => ({
    referenceCodeIdx: uniqueIndex("welfare_reports_reference_code_unique").on(table.referenceCode),
    reporterIdx: index("welfare_reports_reporter_idx").on(table.reporterUserId),
    statusIdx: index("welfare_reports_status_idx").on(table.status),
    subjectPetIdx: index("welfare_reports_subject_pet_idx").on(table.subjectPetId),
    jurisdictionIdx: index("welfare_reports_jurisdiction_idx").on(
      table.jurisdictionProvince,
      table.jurisdictionLocality,
    ),
    // Structural locality-attribution FK index (migration 0147).
    localityIdIdx: index("welfare_reports_locality_id_idx")
      .on(table.localityId)
      .where(sql`${table.localityId} IS NOT NULL`),
    locationIdx: index("welfare_reports_location_idx").on(table.locationLat, table.locationLng),
    assignedToIdx: index("welfare_reports_assigned_to_idx").on(table.assignedToUserId),
    derivedToOrgIdx: index("welfare_reports_derived_to_org_idx").on(table.derivedToOrganizationId),
    // FK indexes shipped in earlier migrations, mirrored here for schema↔migration
    // agreement. case_id (migration 0033) and reporter_organization_id (migration
    // 0035). Both partial — most reports have neither set.
    caseIdIdx: index("welfare_reports_case_id_idx")
      .on(table.caseId)
      .where(sql`${table.caseId} IS NOT NULL`),
    reporterOrganizationIdx: index("welfare_reports_org_reporter_idx")
      .on(table.reporterOrganizationId)
      .where(sql`${table.reporterOrganizationId} IS NOT NULL`),
    // Government welfare inbox: (province, locality, status) for active
    // reports (migration 0096). Partial: excludes terminal statuses.
    jurisdictionStatusIdx: index("welfare_reports_jurisdiction_status_idx")
      .on(table.jurisdictionProvince, table.jurisdictionLocality, table.status)
      .where(sql`${table.status} NOT IN ('closed', 'invalid', 'duplicate')`),
    // Overdue queue sort: (province, locality, created_at) for open reports
    // (migration 0096).
    openCreatedAtIdx: index("welfare_reports_open_created_at_idx")
      .on(table.jurisdictionProvince, table.jurisdictionLocality, table.createdAt)
      .where(sql`${table.status} = 'open'`),
    welfareReportsJurisdictionProvinceCanonical: check(
      "welfare_reports_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
    welfareReportsOrgInterventionStatusCheck: check(
      "welfare_reports_org_intervention_status_check",
      sql`${table.orgInterventionStatus} is null or ${table.orgInterventionStatus} in ('tomado', 'devuelto')`,
    ),
    // Data-integrity: lat and lng must be stored together or not at all
    // (migration 0100). NOT VALID on first apply — validate once data confirmed
    // clean. Mirrors organizations_coordinates_pair_check.
    locationPairCheck: check(
      "welfare_reports_location_pair_check",
      sql`(${table.locationLat} IS NULL) = (${table.locationLng} IS NULL)`,
    ),
  }),
);

export type WelfareReport = typeof welfareReports.$inferSelect;
export type NewWelfareReport = typeof welfareReports.$inferInsert;

// ============================================================================
// WelfareReportAttachments — evidence files for welfare denuncia submissions
// ============================================================================
// Separate from the generic `attachments` table: different RLS, different
// bucket (welfare-evidence), and a different lifecycle (anonymous-capable,
// report-scoped, no delete in v1).

export const welfareReportAttachments = pgTable(
  "welfare_report_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    welfareReportId: uuid("welfare_report_id").notNull(),
    // Uploaded-by is nullable for anonymous denuncia uploads.
    uploadedByUserId: uuid("uploaded_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    storagePath: text("storage_path").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSize: integer("file_size").notNull(),
    originalFilename: text("original_filename"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // FK name exceeds 63 chars when drizzle auto-generates; declare it explicitly.
    welfareReportFk: foreignKey({
      name: "welfare_report_attachments_welfare_report_id_welfare_reports_id",
      columns: [table.welfareReportId],
      foreignColumns: [welfareReports.id],
    }).onDelete("cascade"),
    reportIdx: index("welfare_report_attachments_report_idx").on(table.welfareReportId),
  }),
);

export type WelfareReportAttachment = typeof welfareReportAttachments.$inferSelect;
export type NewWelfareReportAttachment = typeof welfareReportAttachments.$inferInsert;

// ============================================================================
// LibretaShareTokens — Tier-2 owner-issued share links for the libreta
// ============================================================================
// Each row is one shareable surface created by an owner. Revocation is a flag
// flip (revoked_at), not a delete. Views are tracked via pet_events of type
// libreta_shared_viewed; view_count_cached and last_viewed_at_cached are
// denormalized counters updated on each view for fast display without scanning
// the events log.
//
// D7 from the plan: server-side reads via Drizzle bypass RLS. RLS policies in
// db/rls.sql govern PostgREST only (defense-in-depth for owner self-service).

export const libretaShareTokens = pgTable(
  "libreta_share_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shareToken: text("share_token").notNull().unique(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    createdByUserId: uuid("created_by_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    label: text("label"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    viewCountCached: integer("view_count_cached").notNull().default(0),
    lastViewedAtCached: timestamp("last_viewed_at_cached", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petActiveIdx: index("libreta_share_tokens_pet_idx")
      .on(table.petId)
      .where(sql`${table.revokedAt} IS NULL`),
    // Note: libreta_share_tokens_token_idx (non-unique on share_token) was dropped
    // in migration 0095 — it is fully covered by the UNIQUE constraint on share_token.
  }),
);

export type LibretaShareToken = typeof libretaShareTokens.$inferSelect;
export type NewLibretaShareToken = typeof libretaShareTokens.$inferInsert;

// REMOVED — `share_telemetry` (migrations 0032 → 0167).
//
// It held one row per view of a Tier-2 libreta share link (pet_id,
// share_token_id, viewed_at, viewer_ip_hash, user_agent). The 2026-08-04 sweep
// found exactly one writer and ZERO readers: no query, no projection, no
// screen. The owner-visible view count has always come from
// libretaShareTokens.viewCountCached / lastViewedAtCached, which stay.
// PO decision TEL-1 (2026-08-04): stop collecting and delete what accumulated.
// Migration 0167 drops the table. Do not reintroduce it without a specified
// reader and its own retention rule.

// ============================================================================
// Admin governance — govt_assignments, approval_requests, audit_log
// ============================================================================
// Implements the four-role authority model from docs/superpowers/specs/
// 2026-05-17-admin-page-design.md. Govt is scope-limited by (province,
// locality) via govt_assignments; admin is universal. approval_requests is
// the canonical contract for every state mutation that needs authority;
// audit_log records every authority action append-only (enforced by a
// Postgres trigger — bypass via app.allow_audit_mutation GUC for tests, which
// since 0182 ALSO requires app.allow_audit_mutation_actor and self-logs).
//
// service_provider_scheduling and target_service_provider_id are DEFERRED
// to Fase 8 (service_providers table does not exist yet).

export const govtAssignments = pgTable(
  "govt_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province").notNull(),
    jurisdictionLocality: text("jurisdiction_locality").notNull(),
    // WHICH catalogue row was granted (migration 0246, C2b). The name pair above
    // stays the display source and the scope key; this records the exact row the
    // admin picked, so a within-province homonym is not re-resolved to the
    // alphabetically first department. NULL for a whole-province grant and for
    // legacy rows whose name is ambiguous inside their province.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    grantedByUserId: uuid("granted_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    revocationReason: text("revocation_reason"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeUnique: uniqueIndex("govt_assignments_active_unique")
      .on(table.userId, table.jurisdictionProvince, table.jurisdictionLocality)
      .where(sql`${table.revokedAt} IS NULL`),
    userActiveIdx: index("govt_assignments_user_active_idx")
      .on(table.userId)
      .where(sql`${table.revokedAt} IS NULL`),
    localityIdx: index("govt_assignments_locality_idx")
      .on(table.jurisdictionProvince, table.jurisdictionLocality)
      .where(sql`${table.revokedAt} IS NULL`),
    localityIdIdx: index("govt_assignments_locality_id_idx")
      .on(table.localityId)
      .where(sql`${table.localityId} IS NOT NULL`),
    govtAssignmentsJurisdictionProvinceCanonical: check(
      "govt_assignments_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type GovtAssignment = typeof govtAssignments.$inferSelect;
export type NewGovtAssignment = typeof govtAssignments.$inferInsert;

// Approval request types — kept as TEXT (with a DB CHECK) so adding a new
// type is one migration of the CHECK constraint, not an enum migration.
// Validation happens in lib/approval-payloads.ts.
// Institutional accounts (govt, admin) are created directly by an existing
// admin via createInstitutionalAccountForAuthority — there is no
// "user requests to become govt/admin" flow. Removed in migration 0015:
//   role_upgrade_govt, role_upgrade_admin, govt_assignment_grant.
// "service_provider_scheduling" is deferred to Fase 8.
export const APPROVAL_REQUEST_TYPES = [
  "role_upgrade_vet",
  "organization_verification",
  // Ley 26.858 service-dog credential verification. The applicant is the
  // pet owner; targetUserId is the owner (one approval per pet, identified
  // by `payload.pet_id`). Approving sets pet_service_dog.credential_status
  // to 'vigente' + verified_at + verified_by_user_id.
  "service_dog_credential_verification",
] as const;
export type ApprovalRequestType = (typeof APPROVAL_REQUEST_TYPES)[number];

export const APPROVAL_REQUEST_STATUSES = ["pending", "approved", "rejected", "withdrawn"] as const;
export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicToken: text("public_token").notNull().unique(),
    type: text("type").notNull().$type<ApprovalRequestType>(),
    status: text("status").notNull().default("pending").$type<ApprovalRequestStatus>(),
    applicantUserId: uuid("applicant_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    initiatedBy: text("initiated_by").notNull().default("self").$type<"self" | "authority">(),
    initiatedByUserId: uuid("initiated_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    // Polymorphic target — exactly one set per type (enforced by DB CHECK).
    targetUserId: uuid("target_user_id").references(() => profiles.id, { onDelete: "cascade" }),
    targetOrganizationId: uuid("target_organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    // Drives admin/govt scope matching. Always required.
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province").notNull(),
    jurisdictionLocality: text("jurisdiction_locality").notNull(),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    payload: jsonb("payload").notNull().default({}),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedByUserId: uuid("decided_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    decisionNotes: text("decision_notes"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    statusIdx: index("approval_requests_status_idx")
      .on(table.status, table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    applicantIdx: index("approval_requests_applicant_idx").on(
      table.applicantUserId,
      table.createdAt,
    ),
    jurisIdx: index("approval_requests_juris_idx")
      .on(table.jurisdictionProvince, table.jurisdictionLocality)
      .where(sql`${table.status} = 'pending'`),
    typeIdx: index("approval_requests_type_idx").on(table.type, table.status),
    initiatedByIdx: index("approval_requests_initiated_by_idx").on(table.initiatedByUserId),
    decidedByIdx: index("approval_requests_decided_by_idx").on(table.decidedByUserId),
    // Admin proposal lookup by target org (migration 0096). Partial: only
    // organization_verification requests set this column.
    targetOrgIdx: index("approval_requests_target_org_idx")
      .on(table.targetOrganizationId)
      .where(sql`${table.targetOrganizationId} IS NOT NULL`),
    // CHECK constraints — also declared via ALTER in migrations 0015, 0017.
    approvalTypeValid: check(
      "approval_type_valid",
      sql`${table.type} in ('role_upgrade_vet', 'organization_verification', 'service_dog_credential_verification')`,
    ),
    approvalStatusValid: check(
      "approval_status_valid",
      sql`${table.status} in ('pending', 'approved', 'rejected', 'withdrawn')`,
    ),
    approvalInitiatedValid: check(
      "approval_initiated_valid",
      sql`${table.initiatedBy} in ('self', 'authority')`,
    ),
    approvalTargetConsistent: check(
      "approval_target_consistent",
      sql`case ${table.type} when 'role_upgrade_vet' then ${table.targetUserId} is not null and ${table.targetOrganizationId} is null when 'organization_verification' then ${table.targetUserId} is null and ${table.targetOrganizationId} is not null end`,
    ),
    approvalDecisionConsistent: check(
      "approval_decision_consistent",
      // decidedByUserId is nullable for system-automated decisions (e.g. auto-verify via matrícula).
      // decidedAt IS NOT NULL is still required to prove a decision was made.
      sql`(${table.status} in ('approved', 'rejected') and ${table.decidedAt} is not null) or (${table.status} in ('pending', 'withdrawn') and ${table.decidedAt} is null and ${table.decidedByUserId} is null)`,
    ),
    approvalRequestsJurisdictionProvinceCanonical: check(
      "approval_requests_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type ApprovalRequest = typeof approvalRequests.$inferSelect;
export type NewApprovalRequest = typeof approvalRequests.$inferInsert;

// audit_log action catalog. TEXT (no enum) per spec §4.5 — escalable.
//
// SINGLE SOURCE OF TRUTH since migration 0184: this list is also the DB CHECK
// constraint `audit_log_action_valid`, and
// __tests__/audit-log-action-check.test.ts fails if the two ever drift. Adding
// an action here therefore REQUIRES a migration that widens the CHECK — which
// is the point: `action` used to be a bare `text` column typed only in
// TypeScript, so any writer outside drizzle (a trigger, an RPC, a `as
// typeof auditLog.$inferInsert` cast) could mint an action nobody had declared.
// One did: `scan_event_purged`, written by the scan-retention trigger since
// migration 0104, was absent from this list for ~4 months with 160 rows in the
// local database to show for it.
//
// ORDER IS FREE, DUPLICATES ARE NOT — the parity test asserts set equality and
// also that this array has no repeated entries (it carried a duplicate
// `self_resignation_vet` until 2026-08-16).
export const AUDIT_LOG_ACTIONS = [
  "request_viewed",
  "evidence_viewed",
  // Audience-precision plan (2026-06-19): an authority opened a welfare report's
  // EXACT coordinate. Ley 14.346 justifies the access; Ley 25.326 accountability
  // requires the trail. Payload: { welfare_report_id, reference_code }.
  "welfare_location_viewed",
  "request_approved",
  "request_rejected",
  // Non-terminal "pedir más información" on a pending approval request (UI/UX
  // audit 2026-07). The approval_requests status CHECK constraint has no
  // compatible intermediate state (pending must keep decided_at/decided_by
  // NULL), so the info request is a notes-only audit event + applicant
  // notification that leaves the request pending. Payload: { message }.
  "request_info_requested",
  "revocation_org_verified",
  "revocation_vet_role",
  "revocation_govt_assignment",
  "revocation_govt_role",
  "revocation_admin_role",
  "revocation_scheduling",
  "self_resignation_vet",
  "self_resignation_govt",
  "self_resignation_admin",
  "pii_queried",
  "admin_seeded",
  // Fase 5: institutional account lifecycle actions
  "institutional_govt_created",
  "institutional_admin_created",
  // Pilot T1-P9 (migration 0225): an admin created a read-only `national`
  // observer. Payload shape identical to the two above.
  "institutional_national_created",
  "admin_deactivated_by_admin",
  "govt_deactivated_by_admin",
  "operator_credentials_reset",
  // T2-S6 (migration 0229): TOTP second factor for institutional accounts.
  // enrolled — the account holder verified a new factor at /mfa/configurar.
  // reset_by_admin — an admin removed every factor of another institutional
  // account (lost phone); the next sign-in enrols again. Payload carries the
  // removed factor ids, never a secret.
  "mfa_factor_enrolled",
  "mfa_factors_reset_by_admin",
  "govt_locality_assigned",
  "institutional_create_orphan_auth_user", // compensating-delete failure leak log
  // Slice 3a: user self-service profile edits
  "profile_self_updated",
  "profile_avatar_updated",
  "profile_avatar_upload_failed",
  // Slice 3b: applicant self-service withdrawal
  "approval_request_withdrawn_by_applicant",
  // Slice 3d: user self-service role transitions.
  // self_resignation_vet — vet demotes themselves to owner (§7.8) — is already
  // declared above; its notification type is self_resignation_confirmed (sent
  // to the vet after resignation). It used to be listed a SECOND time right
  // here; the duplicate was removed 2026-08-16 when this array became the
  // source of the DB CHECK.
  // govt_self_deactivated — govt deactivates their own institutional account (§7.5).
  //   Notification types:
  //     govt_self_deactivated_admin_notice — to every active admin
  //     govt_self_deactivated_cascade_notice — to other govts who now sole-cover affected localities
  "govt_self_deactivated",
  // Placeholder DNI verification (pre Mi Argentina OAuth). User confirms their
  // DNI number; the bit is set server-side. TODO(mi-argentina): replace with
  // real OAuth callback action when the Mi Argentina integration lands.
  "dni_verified_self",
  // B11: the user cut every one of their own sessions ("cerrar sesión en todos
  // los dispositivos"). Ordinary logout writes no row — ending your own session
  // on your own device is navigation, not accountability. This one is a security
  // RESPONSE, pressed because a phone was lost or a machine was shared, and
  // "when did the legitimate owner last do this?" is exactly what an incident
  // review asks afterwards. Actor, target and subject are the same person, so
  // the row carries no PII the actor FK does not already carry.
  // Payload: { surface: "web" | "api_v1" }.
  "sessions_revoked_self",
  // Fase 14: auto-expiry cron writes one of these per request swept (status
  // pending older than 60 days → withdrawn). The `system_actor` for these
  // rows is the oldest active admin (first row in profiles WHERE
  // role='admin' AND account_type='institutional').
  "approval_request_withdrawn_by_system",
  // Fase 10: custody dispute lifecycle. Raised, party added, resolved (with
  // resolution outcome in payload), withdrawn (admin or raiser), and escalated
  // to judicial channels (light path — dispute stays open, note appended).
  "dispute_raised",
  "dispute_party_added",
  "dispute_resolved",
  "dispute_withdrawn",
  "dispute_escalated",
  // Ley 26.858: service-dog credential lifecycle. Created by owner, verified
  // by admin/govt via the approval flow, revoked by admin/govt with motivo.
  "service_dog_credential_revoked",
  // Welfare-officer queue triage actions (Ley 14.346 denuncia pipeline).
  // Govt/admin moves welfare_reports rows through the state machine; each
  // transition writes one of these audit rows with from/to status + notes.
  "welfare_report_triaged",
  "welfare_report_started",
  "welfare_report_closed",
  // Moderation layer — admin resolves an auto-flagged anonymous report
  // either by passing it to triage (unflag) or confirming it as spam.
  "welfare_report_unflagged",
  "welfare_report_confirmed_spam",
  // Jurisdiction moderation (migration 0132): a govt escalates a flagged
  // denuncia to the national admin queue with a motivo. Payload:
  // { welfare_report_id, reference_code, flag_reasons_snapshot, notes }.
  "welfare_report_escalated_to_admin",
  // Org-side welfare denuncia (spec 2026-05-19-org-abuse-investigation).
  // Emitted by `createOrgWelfareReportAction` to distinguish institutional
  // reports from the anon/civil flow tracked by `welfare_report_submitted`.
  "welfare_report_submitted_by_org",
  // Cross-org transfer handshake (spec 2026-05-19-cross-org-transfer-ux).
  // The handshake lifecycle is two-phase: propose → accept/reject/cancel.
  "cross_org_transfer_proposed",
  "cross_org_transfer_accepted",
  "cross_org_transfer_rejected",
  "cross_org_transfer_cancelled_by_sender",
  "cross_org_transfer_auto_expired",
  // Adoption application lifecycle (adoption-listing-public §11). Submitted
  // by the applicant via /adoptar/{token}/postular, approved/rejected by
  // admin/coordinator of the shelter from the org portal. The auto-rejected
  // cascade triggered by adoption_finalized also emits _rejected rows.
  "adoption_application_submitted",
  "adoption_application_resolved",
  // Govt business rules CRUD (spec 2026-05-19-govt-business-rules-poc-design).
  // Admin-only operations on the govt_business_rules table.
  "govt_business_rule_created",
  "govt_business_rule_updated",
  "govt_business_rule_deleted",
  // Append-only escape hatch — emitted by the pet_events trigger whenever
  // app.allow_event_mutation is set during an UPDATE/DELETE on pet_events.
  // The session must also set app.allow_event_mutation_actor (uuid) so the
  // trigger has an accountable actor; otherwise the mutation is refused.
  "pet_events_mutation_override",
  // Same append-only escape hatch for case_events (migration 0121), sharing the
  // app.allow_event_mutation + app.allow_event_mutation_actor GUC pair.
  "case_events_mutation_override",
  // Scan-retention purge (migration 0104 / db/triggers.sql
  // enforce_pet_events_append_only): under app.allow_scan_purge='true' the
  // trigger permits DELETE of a scanner-authored credential_scanned event past
  // its 90-day TTL and writes ONE of these rows per deleted event.
  // Payload: { pet_event_id, pet_id, occurred_at, retention_days }.
  // MISSING FROM THIS CATALOG UNTIL 2026-08-16 — see the header note. It was
  // reported as a LOW finding in dim-interno:docs/reviews/results/01-event-sourcing.md
  // (item 11) alongside the two mutation_override actions; only those two were
  // ever added. Nothing could notice, because nothing compared the catalog to
  // what the database actually stored. Migration 0184's CHECK now does.
  "scan_event_purged",
  // Same hatch for audit_log itself (Lote B2, migration 0182): the
  // app.allow_audit_mutation bypass now REQUIRES app.allow_audit_mutation_actor
  // (uuid) and self-logs the override — a privileged session can no longer
  // rewrite the audit trail with zero trace.
  "audit_log_mutation_override",
  // Microchip replacement / revocation (Sprint 1B Phase B).
  "microchip.replace",
  // Analytics bulk export — generated by a govt/admin user from /gob/analytics/export.
  // Payload: { schema_version, includes, format, period, file_path, row_counts, rejected_counts }.
  "analytics_export_generated",
  // Wave C (gob-audit-inventory): CSV export button on a single /gob dashboard
  // (poblacion, censo, adopciones, campanas) — aggregate/scoped rows only, no
  // raw PII pet lists (contrast with analytics_export_generated's storage+email
  // multi-slice bulk export). Payload: { dashboard, row_counts }.
  "gob_dashboard_export_generated",
  // SENASA / LSUCyF batch export — GET /gob/senasa/export (migration 0220).
  // Payload: { format, scope: { kind, jurisdiction_count, province, locality },
  //            period: { since, until } }.
  //
  // NOT a variant of gob_dashboard_export_generated, and the entry right above
  // is why: that one declares itself "aggregate/scoped rows only, no raw PII pet
  // lists", and this is one row per animal per sanitary event with the exact
  // clinical date. The repo's own rule for when to split an action (migration
  // 0202 split three because the ACTOR differed; 0203 kept one for two surfaces
  // because only the TRANSPORT differed) points the same way here: the ACT and
  // the data class differ, not the transport.
  //
  // No row count in the payload — the response is streamed, so the count is not
  // known when the row is written, and a row written afterwards is missing
  // precisely when a transfer was interrupted mid-download. See logSenasaExport
  // (lib/analytics/senasa-export-query.ts).
  "senasa_export_generated",
  // Welfare MPF CABA export — formal denuncia PDF for fiscalía (Ley 14.346).
  // Payload: { welfareReportId, referenceCode, storagePath, schemaVersion }.
  "welfare_mpf_export_generated",
  // PPP export — RUPPPA CABA registration PDF for potentially dangerous breed owners.
  // Payload: { petId, petPublicToken, targetJurisdiction, breed, schemaVersion }.
  "ppp_export_generated",
  // Travel doc bundle export (movilidad-jurisdiccional Fase 1, R5.3).
  // Payload: { petId, petPublicToken, corridorIds, semaforo, schemaVersion }.
  "travel_export_generated",
  // ENO (Enfermedades de Notificación Obligatoria) — govt notification fanout.
  // Spec: 2026-05-21-eno-pipeline-design.md (ENO-D2, ENO-D3, ENO-D4, ENO-D5).
  // Payload: { disease_code, disease_severity, pet_id, targets_count,
  //            owner_was_notified, legal_anchor }.
  "eno_notification_emitted",
  // Owner-initiated custody dispute (chip/tatuaje claim wizard, P3-1).
  // Payload: { dispute_public_token, pet_id, attachments_count }.
  "claim_dispute_submitted",
  // Direct claim of a free (no active custody) chip-registered pet.
  // Payload: { pet_id, identifier_kind }.
  "free_pet_claimed",
  // Pet transfer (owner → owner) — P3-2 handshake actions.
  // Payload varies per action; transfer_public_token + pet_id are always present.
  "pet_transfer_initiated",
  "pet_transfer_accepted",
  "pet_transfer_rejected",
  "pet_transfer_cancelled",
  "pet_transfer_expired",
  // Temporary caretaker (custodia-temporal, migration 0189). The grant lifecycle
  // the titular drives: designate → the invitee accepts → the titular revokes.
  //
  // DECLARED LATE, AND THAT IS THE POINT. src/modules/caretakers/actions.ts has
  // written these three since the feature shipped, through a local
  // `flushAuditLog` that casts with `as typeof auditLog.$inferInsert` — the same
  // escape hatch the header of this list warns about. Because they were never
  // named here they were never in the CHECK either, so every insert violated
  // audit_log_action_valid and was swallowed by that helper's catch. Result:
  // ZERO audit rows for the entire feature, silently. The parity test could not
  // see it — it compares this list against the constraint, and the two agreed
  // perfectly about a set that omitted all three.
  //
  // AND THE GAP WAS THREE ACTIONS WIDER THAN THAT FIX (2026-08-23). Only
  // `withdraw` was flagged when the first three landed; `reject` and `cancel`
  // wrote no audit row either. All three missing ones are grant ENDINGS, which
  // is the half that matters for a custody arrangement: who ended it, when, and
  // on whose initiative is exactly what someone asks afterwards. A grant could
  // be created, accepted and terminated leaving a trail of the first two only.
  //
  // The three endings are kept DISTINCT rather than folded into one
  // `caretaker_grant_ended` with a reason in the payload, because the actor
  // differs by outcome and the actor is the point: the invitee rejects, the
  // titular cancels a pending invitation, the caretaker withdraws from an
  // active one. Matches `caretaker_grant_revoked`, already its own action for
  // the titular ending an active arrangement.
  //
  // Payloads: designated { grant_public_token, pet_id, to_email, to_user_known };
  // accepted { grant_public_token, public_contact_consent }; revoked /
  // rejected / cancelled / withdrawn { grant_public_token, pet_id }.
  "caretaker_designated",
  "caretaker_grant_accepted",
  "caretaker_grant_cancelled",
  "caretaker_grant_rejected",
  "caretaker_grant_revoked",
  "caretaker_grant_withdrawn",
  // Subject rights — Ley 25.326 (compliance PR 1). Emitted by the RPCs
  // export_subject_data + erase_subject_data declared in migration 0059.
  "subject_data_exported",
  "subject_erasure",
  // Decomiso (Ley 14.346) seizure lifecycle — spec §4.5
  // (2026-05-19-decomiso-welfare-authority-design.md).
  // Emitted by executeDecomisoAction and the handoff accept/reject/cancel actions.
  "decomiso_executed",
  "decomiso_handoff_accepted",
  "decomiso_handoff_rejected",
  "decomiso_handoff_cancelled",
  // Return-to-owner terminal (closed_to_owner_return in
  // src/modules/cases/domain/lifecycles/custody-episode.ts). Emitted by
  // returnCustodyToOwnerAction.
  "decomiso_returned_to_owner",
  // Outbreak investigation lifecycle (Ley 15.465/60 + Decreto 3640/64 ENO).
  // Emitted by outbreak investigation server actions (app/actions/outbreak-investigation.ts).
  "outbreak_investigation_opened",
  "outbreak_investigation_escalated",
  "outbreak_investigation_closed_resolved",
  "outbreak_investigation_closed_dismissed",
  "outbreak_investigation_note_added",
  // Professional closure of a 10-day rabies observation (Ley 22.953, Decreto
  // 4669/1973 PBA). Added 2026-08-17 with the PO decision that ONLY a
  // professional may assert a clinical outcome: the cron and the owner used to
  // write outcome='negative' with no clinical author, and this action is now the
  // sole path by which an outcome enters the record. Emitted inside the close
  // transaction by professionalCloseObservation.
  // Payload: { pet_id, pet_public_token, case_id, observation_started_event_id,
  //            outcome, closed_by_role, closure_notes, before_values, after_values }.
  "rabies_observation_closed_professional",
  // The OPENING half of the same window, added 2026-08-22 (top-10 review H1).
  // An organization declaring that a third party's animal bit somebody is the
  // most consequential org write in the system — public red banner, authority
  // fan-out, rehome blocked, and only a professional or the State may close it.
  // It left NO audit row at all: `SELECT DISTINCT action FROM audit_log`
  // returned 43 actions and not one was a bite. Written inside the report
  // transaction by reportBiteFromOrg (a deduplicated retry writes none).
  // Payload: { pet_id, pet_public_token, case_id, case_public_code,
  //            bite_event_id, reporter_role, victim_kind, severity,
  //            jurisdiction_province, jurisdiction_locality, authority_basis,
  //            before_values, after_values }.
  // `authority_basis` records WHICH arm of the new gate admitted the report —
  // "pet_relation" (this org attended or held the animal) or "org_coverage"
  // (the incident happened where this org works).
  "bite_reported_by_org",
  // One-time backfill script for missed ENO notifications (bug fix PR #137).
  // Written once per script invocation (not per event).
  // Payload: { since, until, limit, processed, notified, skipped, errors, dry_run }.
  "eno_backfill_run_completed",
  // Welfare derivation to org (migration 0076). Govt/admin forwards a report
  // to a verified shelter or rescue_network for field follow-up.
  // Payload: { welfareReportId, referenceCode, targetOrgId, targetOrgDisplayName }.
  "welfare_report_derived_to_org",
  // Org membership lifecycle (ARCH-T). Covers the transitions that were
  // previously unaudited: member added (via invitation accept or org creation),
  // member removed (admin-initiated or self-leave), role change, and
  // canWritePetEvents toggle.
  //
  // Payload keys by action:
  //   org_member_added:              org_id, member_user_id, role,
  //                                  how ("invitation_accept" | "org_creation"),
  //                                  invitation_id (when how=invitation_accept)
  //   org_member_removed:            org_id, member_user_id, role,
  //                                  how ("admin_remove" | "self_leave")
  //   org_member_role_changed:       org_id, member_user_id, role_before, role_after
  //   org_member_event_write_changed: org_id, member_user_id,
  //                                  can_write_pet_events_before,
  //                                  can_write_pet_events_after
  "org_member_added",
  "org_member_removed",
  "org_member_role_changed",
  "org_member_event_write_changed",
  // V0-5: direct admin verify/unverify (no evidence upload required).
  // For evidence-backed formal revocations use revocation_org_verified instead.
  //   org_verified payload:   { org_id, org_display_name }
  //   org_unverified payload: { org_id, org_display_name, reason? }
  "org_verified",
  "org_unverified",
  // V1-9: org-side PII access trail. Emitted when an org reviewer opens an
  // adoption application and reads the applicant's full identity (name, phone,
  // housing). One row per page view (server-component fetch — fires once per
  // load, not per re-render). target_user_id = applicant (the PII subject),
  // target_organization_id = the reviewing org.
  //   adopter_pii_viewed payload:
  //     { org_id, application_event_id, applicant_user_id, pet_id }
  "adopter_pii_viewed",
  // Item 14.1: personal account self-deactivation (owner/vet). No coverage
  // check needed (govt-only concern). Payload: { reason, role }.
  "personal_self_deactivated",
  // The way back from the line above (migration 0221). requireLiveUser refuses
  // every write from a deactivated account, personal ones included, so the
  // deactivation is now a real state and needs a real exit that is not a
  // support ticket. Personal accounts ONLY: an institutional deactivation is an
  // operator's act on somebody else's account and is undone by an operator.
  // Payload: { role } — no reason, deliberately; see the migration's header for
  // why undoing your own decision is not charged prose.
  "personal_self_reactivated",
  // Wave 2 Item 15 — correction by amendment (principle #2, 2026-06-19).
  // D5: admin/govt amendments are sensitive — emits this audit row with
  // full amendment details (pet_id, target_event_id, amendment_event_id,
  // reason, changes, actor_role). Payload: { pet_id, target_event_id,
  // amendment_event_id, reason, changes, actor_role }.
  "event_amended_sensitive",
  // Outreach "Enviar recordatorio(s)" (sweep-fixes-2 2026-07-23) — a govt/admin
  // operator triggers a system-mediated vaccine_due reminder from the overdue-
  // antirrábica list (/gob/operativos?vista=alcance). One row per invocation
  // (single "Recordar" or the bulk "Enviar recordatorios (N)"), never per
  // notification — the write-path companion to pii_queried. Payload:
  // { surface, pipeline, requested_count, sent_count, already_notified_count,
  //   no_owner_count, out_of_scope_count }.
  "outreach_reminder_sent",
  // Physical tag (chapa) lifecycle — owner activation, owner revocation, and
  // admin batch issuance (design D9). tag.lote_issue payload: {lote_id, count}
  // — never the serials' activation codes.
  "tag.activate",
  "tag.revoke",
  "tag.lote_issue",
  // Capability grant lifecycle (Lote B1) — decide-capability.ts writes one of
  // these per decision; grant-capability.ts writes capability_granted for a
  // direct grant. Payload: { org_id, grant_id, membership_id, capability,
  // reason }. Revoked additionally carries { revoked_by_user_id, revoked_at,
  // original_decided_by_user_id, original_decided_at } — the grants-table row
  // itself is NOT overwritten on revoke (provenance stays in decided*).
  "capability_granted",
  "capability_denied",
  "capability_revoked",
  // An authority fan-out resolved to ZERO recipients (2026-08-17, migration 0187).
  //
  // An empty fan-out was the only failure in the system that left NO trace at
  // all: the loop runs zero times, the action returns ok, and nothing is written
  // anywhere — so it would have been the last failure anyone ever found. This
  // action IS that trace. Written best-effort (never rolls back the business
  // write it accompanies) and always with the route that went nowhere.
  //
  // NOT written when the admin fallback fires — that path DID reach humans.
  // Only a genuinely empty recipient set produces a row.
  //
  // Payload: { route, province, locality, reason } — `reason` is
  // "no_govt_no_admin" for the resolver, or a route-specific string
  // ("no_receiver_coordinators", "no_govt_targets", …) for the sites that build
  // their own recipient set.
  "notification_fanout_empty",

  // Actos de operador sobre un expediente (#41), agregados el 2026-09-17.
  //
  // POR QUÉ EXISTEN, porque el baseline los tenía como una decisión pendiente:
  // el hecho ya vive en la espina append-only `case_events`, que carga su propio
  // autor, así que el argumento de "otro libro ya lo cubre" era real y por eso
  // estaban en `audit-log-coverage-baseline.json` esperando una definición.
  //
  // Se resuelve hacia la trazabilidad porque el costo es asimétrico. Una fila de
  // más no le hace daño a nadie. Una consulta de rendición de cuentas bajo la
  // Ley 25.326 que NO encuentra en `audit_log` que una autoridad identificada
  // cerró un expediente legal sí — y la ausencia de esa fila es permanentemente
  // indistinguible de la ausencia del acto que habría descrito.
  //
  // La distinción que hace el par: el evento registra la AFIRMACIÓN, esta fila
  // registra el ACTO ADMINISTRATIVO con su estado anterior y posterior. Es el
  // mismo argumento que escribió el cierre profesional de observación
  // antirrábica el 2026-08-17, aplicado al vecino.
  "case_note_recorded",
  "case_closed_manually",
  "case_escalated_manually",
] as const;
export type AuditLogAction = (typeof AUDIT_LOG_ACTIONS)[number];

export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Nullable after ARCH-H (migration 0080): ON DELETE SET NULL so a hard-
    // deleted profile does not block audit trail retention. NULL actor is
    // displayed as "Usuario eliminado" in admin audit UI.
    actorUserId: uuid("actor_user_id").references(() => profiles.id, { onDelete: "set null" }),
    action: text("action").notNull().$type<AuditLogAction>(),
    approvalRequestId: uuid("approval_request_id").references(() => approvalRequests.id, {
      onDelete: "set null",
    }),
    targetUserId: uuid("target_user_id").references(() => profiles.id, { onDelete: "set null" }),
    targetOrganizationId: uuid("target_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    targetGovtAssignmentId: uuid("target_govt_assignment_id").references(() => govtAssignments.id, {
      onDelete: "set null",
    }),
    payload: jsonb("payload").notNull().default({}),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    actorIdx: index("audit_log_actor_idx").on(table.actorUserId, table.performedAt),
    requestIdx: index("audit_log_request_idx").on(table.approvalRequestId),
    targetUserIdx: index("audit_log_target_user_idx").on(table.targetUserId),
    targetOrganizationIdx: index("audit_log_target_organization_idx").on(
      table.targetOrganizationId,
    ),
    actionIdx: index("audit_log_action_idx").on(table.action, table.performedAt),
    // WS-PERF P1: default ORDER BY (performed_at DESC, id DESC) now hits this
    // index directly instead of doing a full sort on every unfiltered page load.
    performedAtIdx: index("audit_log_performed_at_idx").on(table.performedAt, table.id),
  }),
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

// ============================================================================
// Govt business rules (POC) — spec 2026-05-19-govt-business-rules-poc-design.
//
// Per-jurisdiction overrides of system-wide business rules. POC scope:
//   - ppp_breed_list                         (which dog breeds are PPP)
//   - ppp_weight_threshold                   (size-based PPP cutoff)
//   - ppp_attestation_required_registries    (where the owner must atestar)
//
// Cascade resolved at READ time by lib/business-rules-resolver.ts:
//   locality > province > country > hardcoded defaults (lib/business-rules-defaults.ts).
// ============================================================================

export const GOVT_BUSINESS_RULE_TYPES = [
  "ppp_breed_list",
  "ppp_weight_threshold",
  "ppp_attestation_required_registries",
  "physical_credential_channels",
  // Whether this jurisdiction requires a microchip (migration 0150). Default
  // TRUE (lib/domain/business-rules-defaults.ts) so the microchip obligation
  // keeps showing everywhere until a jurisdiction opts out. Pet-scope rule.
  "microchip_required",
  // Promoted rule types (admin-rules-console, migration 0116) — see
  // lib/domain/rule-types-registry.ts for label/schema/resolutionScope.
  "rabies_observation_window",
  "due_soon_window",
  "reminder_windows",
  "long_stay_days",
  // Which format the MPF (fiscalía) welfare export PDF uses for this
  // jurisdiction (migration 0156). Default "estandar_nacional" (the only
  // format the codebase renders today — lib/analytics/welfare-exports.ts) so
  // the cascade is real ahead of any second format's rollout. Unlocks the MPF
  // export for every jurisdiction (see jurisdiction-compliance 2026-07-22):
  // the old CABA-only gate (MPF_CONFIGURED_PROVINCES) is replaced by "every
  // jurisdiction gets the national default format unless configured
  // otherwise" — no fake per-province integrations.
  "mpf_export_format",
  // Jurisdiction-aware compliance obligations (migration 0183, rules-engine
  // v2). Per-pet obligation tiers resolved through the same cascade; thin
  // payloads — the tier + legal provenance live in dedicated columns below.
  "rabies_vaccination",
  "sterilization",
  // Per-jurisdiction metric targets (ADR-8) — PARTIAL record over the four
  // legally-varying TARGETS keys; national programmatic benchmarks stay flat.
  "compliance_targets",
] as const;
export type GovtBusinessRuleType = (typeof GOVT_BUSINESS_RULE_TYPES)[number];

/**
 * Requirement tier for obligation-carrying rule types (migration 0183).
 * NULL on a row (or an unresolved cascade) means "tier not established" —
 * consumers fall back to their pre-tier behavior (e.g. microchip_required's
 * payload.required boolean) so the rollout is non-breaking.
 */
export const REQUIREMENT_LEVELS = [
  "mandatory",
  "recommended",
  "not_regulated",
  "optional",
] as const;
export type RequirementLevel = (typeof REQUIREMENT_LEVELS)[number];

export const govtBusinessRules = pgTable(
  "govt_business_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    ruleType: text("rule_type").notNull().$type<GovtBusinessRuleType>(),
    rulePayload: jsonb("rule_payload").notNull(),
    notes: text("notes"),
    legalAnchorIds: text("legal_anchor_ids").array(),
    // Jurisdiction-aware compliance provenance (migration 0183) — all
    // nullable/additive. requirement_level carries the obligation tier;
    // legal_basis/authority/source_url/effective_* document WHICH law backs
    // the rule; baseline_version tags rows applied by the legal-baseline seed
    // (NULL = admin-authored; the seed never clobbers admin rows).
    requirementLevel: text("requirement_level").$type<RequirementLevel>(),
    legalBasis: text("legal_basis"),
    authority: text("authority"),
    sourceUrl: text("source_url"),
    effectiveFrom: date("effective_from"),
    effectiveUntil: date("effective_until"),
    baselineVersion: text("baseline_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    createdByUserId: uuid("created_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByUserId: uuid("updated_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    ruleTypeIdx: index("govt_business_rules_rule_type_idx").on(table.ruleType),
    // NOTE: this list is wider than GOVT_BUSINESS_RULE_TYPES — it also allows
    // travel_corridor_requirements (migration 0120), which has no TS enum
    // entry. When widening, copy the live DB list verbatim, never regenerate
    // it from the enum (migration-errata.md).
    govtBusinessRulesRuleTypeValid: check(
      "govt_business_rules_rule_type_valid",
      sql`${table.ruleType} in ('ppp_breed_list', 'ppp_weight_threshold', 'ppp_attestation_required_registries', 'physical_credential_channels', 'microchip_required', 'rabies_observation_window', 'due_soon_window', 'reminder_windows', 'long_stay_days', 'travel_corridor_requirements', 'mpf_export_format', 'rabies_vaccination', 'sterilization', 'compliance_targets')`,
    ),
    govtBusinessRulesRequirementLevelValid: check(
      "govt_business_rules_requirement_level_valid",
      sql`${table.requirementLevel} is null or ${table.requirementLevel} in ('mandatory', 'recommended', 'not_regulated', 'optional')`,
    ),
    // One row per (rule_type, jurisdiction tuple) — NULLS NOT DISTINCT so
    // country-level rows (province/locality NULL) deduplicate too. The
    // baseline seed (scripts/seed-legal-baseline.ts) upserts on this
    // constraint; the app writer's duplicate check predates it.
    govtBusinessRulesTypeJurisdictionUnique: unique("govt_business_rules_type_jurisdiction_unique")
      .on(
        table.ruleType,
        table.jurisdictionCountry,
        table.jurisdictionProvince,
        table.jurisdictionLocality,
      )
      .nullsNotDistinct(),
    govtBusinessRulesJurisdictionProvinceCanonical: check(
      "govt_business_rules_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type GovtBusinessRule = typeof govtBusinessRules.$inferSelect;
export type NewGovtBusinessRule = typeof govtBusinessRules.$inferInsert;

// ============================================================================
// Scheduling system — Fase 0
// ============================================================================
// service_offerings → service_schedule_rules → time_slots ← appointments
//
// Provider is polymorphic: exactly one of (organization_id, provider_user_id)
// is set per service_offerings row, mirroring the Ownership pattern.
// Enforcement: DB CHECK constraint + Drizzle-level XOR (one nullable, one nullable).

// ============================================================================
// ServiceOfferings
// ============================================================================

export const serviceOfferings = pgTable(
  "service_offerings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Short URL-safe token. Format: OFR-XXXX-XXXX. Generated in application code
    // by `generateOfferingToken()` (lib/infra/publicToken.ts), which is the only
    // producer and the authority on the prefix. This comment said `SVO-` until
    // 2026-09-02; the migration that created the column carries the same stale
    // example and cannot be edited (migrations are immutable), so the producer
    // is the thing to check, never a comment.
    // SEED SCRIPTS DO NOT USE THIS FORMAT. Each one mints its own recognisable,
    // usually deterministic prefix so a re-run converges instead of minting a
    // second offering — `scripts/seed-*.ts` are the authority on which, and the
    // set grows whenever a seed is added. `PANO-SVO-…` (seed-panorama.ts) and
    // `DEMO-SVO-…` (seed-demo-scenario.ts) are examples, NOT the list: at the
    // time of writing `DIM-PILOT-…` (seed-turnos-testers.ts) and
    // `PERF-COV-SVO-…` (seed-coverage.ts) were also live, and an earlier version
    // of this comment named only the first two.
    publicToken: text("public_token").notNull().unique(),

    // Polymorphic provider: exactly one of these two must be set (XOR enforced
    // by DB CHECK constraint `provider_xor`).
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    providerUserId: uuid("provider_user_id").references(() => profiles.id, {
      onDelete: "cascade",
    }),

    // Jurisdiction for approval routing — denormalized from provider.
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),

    serviceKind: text("service_kind").notNull(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    durationMinutes: integer("duration_minutes").notNull().default(15),
    slotCapacity: integer("slot_capacity").notNull().default(1),
    priceArs: numeric("price_ars", { precision: 10, scale: 2 }),
    eligibilitySpecies: text("eligibility_species").array(),
    eligibilityAgeMinMonths: integer("eligibility_age_min_months"),
    eligibilityAgeMaxMonths: integer("eligibility_age_max_months"),

    // Approval workflow (D8: own status column, not approval_requests table).
    status: text("status").notNull().default("pending_approval"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewedByUserId: uuid("reviewed_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    rejectionReason: text("rejection_reason"),

    // Whether the offering surfaces on the public refugio profile
    // (`/refugios/[orgToken]`). Default false per privacy-first (handoff
    // P1-3); the offering owner explicitly opts in via the org-side form.
    isPublic: boolean("is_public").notNull().default(false),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("service_offerings_org_idx")
      .on(table.organizationId)
      .where(sql`${table.organizationId} IS NOT NULL`),
    providerIdx: index("service_offerings_provider_idx")
      .on(table.providerUserId)
      .where(sql`${table.providerUserId} IS NOT NULL`),
    pendingIdx: index("service_offerings_pending_idx")
      .on(table.status, table.submittedAt)
      .where(sql`${table.status} = 'pending_approval'`),
    activeSearchIdx: index("service_offerings_active_search_idx")
      .on(table.serviceKind, table.status)
      .where(sql`${table.status} = 'approved'`),
    jurisdictionIdx: index("service_offerings_jurisdiction_idx").on(
      table.jurisdictionCountry,
      table.jurisdictionProvince,
      table.jurisdictionLocality,
    ),
    providerXor: check(
      "provider_xor",
      sql`(${table.organizationId} is not null and ${table.providerUserId} is null) or (${table.organizationId} is null and ${table.providerUserId} is not null)`,
    ),
    serviceStatusValid: check(
      "service_status_valid",
      sql`${table.status} in ('pending_approval', 'approved', 'rejected', 'paused', 'archived')`,
    ),
    serviceCapacityPositive: check("service_capacity_positive", sql`${table.slotCapacity} > 0`),
    serviceDurationPositive: check("service_duration_positive", sql`${table.durationMinutes} > 0`),
    serviceOfferingsJurisdictionProvinceCanonical: check(
      "service_offerings_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type ServiceOffering = typeof serviceOfferings.$inferSelect;
export type NewServiceOffering = typeof serviceOfferings.$inferInsert;

// ============================================================================
// ServiceScheduleRules
// ============================================================================
// Weekly recurring availability for a service offering. Discrete fields (days +
// time window + effective date range) — no RRULE (D4).

export const serviceScheduleRules = pgTable(
  "service_schedule_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceOfferingId: uuid("service_offering_id").notNull(),
    daysOfWeek: smallint("days_of_week").array().notNull(), // ISO 8601: 1=Mon..7=Sun
    startTimeLocal: time("start_time_local").notNull(),
    endTimeLocal: time("end_time_local").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveUntil: date("effective_until"), // null = open-ended
    timezone: text("timezone").notNull().default("America/Argentina/Buenos_Aires"),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // FK name exceeds 63 chars when drizzle auto-generates; declare it explicitly.
    serviceOfferingFk: foreignKey({
      name: "service_schedule_rules_service_offering_id_service_offerings_id",
      columns: [table.serviceOfferingId],
      foreignColumns: [serviceOfferings.id],
    }).onDelete("cascade"),
    offeringActiveIdx: index("schedule_rules_offering_active_idx")
      .on(table.serviceOfferingId)
      .where(sql`${table.status} = 'active'`),
    ruleTimeWindowSane: check(
      "rule_time_window_sane",
      sql`${table.endTimeLocal} > ${table.startTimeLocal}`,
    ),
    ruleDatesSane: check(
      "rule_dates_sane",
      sql`${table.effectiveUntil} is null or ${table.effectiveUntil} >= ${table.effectiveFrom}`,
    ),
    ruleDaysNonempty: check("rule_days_nonempty", sql`array_length(${table.daysOfWeek}, 1) > 0`),
    ruleStatusValid: check(
      "rule_status_valid",
      sql`${table.status} in ('active', 'paused', 'archived')`,
    ),
  }),
);

export type ServiceScheduleRule = typeof serviceScheduleRules.$inferSelect;
export type NewServiceScheduleRule = typeof serviceScheduleRules.$inferInsert;

// ============================================================================
// TimeSlots
// ============================================================================
// Discrete bookable slots materialized from schedule rules (D5: cron-based,
// 60-day rolling window). The bookings_count <= capacity DB CHECK is the final
// guardrail against race conditions; the advisory lock is the primary mitigation.

export const timeSlots = pgTable(
  "time_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serviceOfferingId: uuid("service_offering_id")
      .notNull()
      .references(() => serviceOfferings.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => serviceScheduleRules.id, {
      onDelete: "set null",
    }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    // Capacity is a snapshot from service_offerings.slot_capacity at materialization.
    capacity: integer("capacity").notNull(),
    bookingsCount: integer("bookings_count").notNull().default(0),
    status: text("status").notNull().default("open"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueStarts: uniqueIndex("time_slots_unique_starts").on(
      table.serviceOfferingId,
      table.startsAt,
    ),
    offeringWindowIdx: index("time_slots_offering_window_idx")
      .on(table.serviceOfferingId, table.startsAt)
      .where(sql`${table.status} = 'open'`),
    searchIdx: index("time_slots_search_idx")
      .on(table.serviceOfferingId, table.startsAt)
      .where(sql`${table.status} IN ('open', 'full')`),
    slotWindowSane: check("slot_window_sane", sql`${table.endsAt} > ${table.startsAt}`),
    slotCapacityPositive: check("slot_capacity_positive", sql`${table.capacity} > 0`),
    slotBookingsNonNegative: check("slot_bookings_non_negative", sql`${table.bookingsCount} >= 0`),
    slotBookingsWithinCapacity: check(
      "slot_bookings_within_capacity",
      sql`${table.bookingsCount} <= ${table.capacity}`,
    ),
    slotStatusValid: check(
      "slot_status_valid",
      sql`${table.status} in ('open', 'full', 'cancelled')`,
    ),
  }),
);

export type TimeSlot = typeof timeSlots.$inferSelect;
export type NewTimeSlot = typeof timeSlots.$inferInsert;

// ============================================================================
// Appointments
// ============================================================================
// Owner bookings against time slots. Mutable planning artifact (D6): can be
// cancelled; the outcome pet_event is the immutable medical record (linked via
// outcome_event_id when status = 'attended').

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Short URL-safe token. Format: APT-XXXX-XXXX. Generated in application code.
    publicToken: text("public_token").notNull().unique(),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => timeSlots.id, { onDelete: "restrict" }),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    serviceOfferingId: uuid("service_offering_id")
      .notNull()
      .references(() => serviceOfferings.id, { onDelete: "cascade" }),
    // Denormalized from offering. Null for independent-vet offerings.
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull().default("confirmed"),

    attendedAt: timestamp("attended_at", { withTimezone: true }),
    attendedByUserId: uuid("attended_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    cancellationReason: text("cancellation_reason"),
    noShowMarkedAt: timestamp("no_show_marked_at", { withTimezone: true }),
    outcomeEventId: uuid("outcome_event_id").references(() => petEvents.id, {
      onDelete: "set null",
    }),
    // The parallel private reminder (D7). Set when a reminder is auto-created
    // alongside the booking; owner's reminder view shows both coexisting.
    reminderId: uuid("reminder_id").references(() => reminders.id, {
      onDelete: "set null",
    }),
    notesFromOwner: text("notes_from_owner"),
    notesFromOrg: text("notes_from_org"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // (pet_id, status, created_at): replaces the old (pet_id, created_at) index.
    // Covers the pet-detail confirmed-turnos query and all other pet+status
    // appointment lookups. Migration 0096 drops appointments_pet_idx.
    petStatusIdx: index("appointments_pet_status_idx").on(
      table.petId,
      table.status,
      table.createdAt,
    ),
    ownerIdx: index("appointments_owner_idx").on(table.ownerUserId, table.status),
    orgIdx: index("appointments_org_idx")
      .on(table.organizationId, table.status)
      .where(sql`${table.organizationId} IS NOT NULL`),
    slotIdx: index("appointments_slot_idx")
      .on(table.slotId)
      .where(sql`${table.status} = 'confirmed'`),
    // Org servicios booking summary (migration 0096).
    serviceOfferingIdx: index("appointments_service_offering_idx").on(
      table.serviceOfferingId,
      table.status,
    ),
    // One LIVE booking per (pet, slot) — migration 0177, mirrored here for
    // schema↔migration agreement. Capacity was already guarded (advisory lock +
    // slot_bookings_within_capacity); identity was not, so the same pet could
    // hold the same slot twice and eat a second place in a free campaign.
    // Partial on 'confirmed' because the other four statuses are terminal: a
    // cancelled booking followed by a new one is legitimate, and it is also what
    // let this ship without deleting a single historical row.
    oneLivePerPetSlot: uniqueIndex("appointments_one_live_per_pet_slot")
      .on(table.petId, table.slotId)
      .where(sql`${table.status} = 'confirmed'`),
    // One LIVE booking per (pet, offering/campaign) — migration 0181 (QA A3).
    // 0177 closed identity at the SLOT level; the same pet could still hold
    // the 08:00 AND the 08:15 of the SAME free campaign and eat two places.
    // Partial on 'confirmed' for the same reason as above: cancel-and-rebook
    // stays legitimate, terminal history stays untouched.
    oneLivePerPetOffering: uniqueIndex("appointments_one_live_per_pet_offering")
      .on(table.petId, table.serviceOfferingId)
      .where(sql`${table.status} = 'confirmed'`),
    appointmentStatusValid: check(
      "appointment_status_valid",
      sql`${table.status} in ('confirmed', 'attended', 'no_show', 'cancelled_by_owner', 'cancelled_by_org')`,
    ),
    appointmentOutcomeOnlyWhenAttended: check(
      "appointment_outcome_only_when_attended",
      sql`(${table.outcomeEventId} is null) or (${table.status} = 'attended')`,
    ),
  }),
);

export type Appointment = typeof appointments.$inferSelect;
export type NewAppointment = typeof appointments.$inferInsert;

// ============================================================================
// AR Localities — canonical INDEC catalog
// ============================================================================
// Reference data populated by scripts/import-indec-localities.ts from the
// INDEC CPPDyL dataset. Lives off of `pet_events` and the owner-data tables —
// it is shared catalog data, not user data. RLS allows SELECT for any
// authenticated user; writes only via the service role (the import script).

export const ARGENTINE_LOCALITY_CATEGORIES = [
  "localidad",
  "ciudad",
  "pueblo",
  "comuna",
  "barrio",
  "componente",
] as const;
export type ArgentineLocalityCategory = (typeof ARGENTINE_LOCALITY_CATEGORIES)[number];

export const ARGENTINE_LOCALITY_SOURCES = [
  "indec_cppdyl",
  "bahra",
  "manual",
  // CABA barrios — INDEC treats CABA as one locality; the 48 barrios live
  // in the city's open-data portal (data.buenosaires.gob.ar). Distinct
  // source so re-imports can target this slice independently.
  "caba_open_data",
] as const;
export type ArgentineLocalitySource = (typeof ARGENTINE_LOCALITY_SOURCES)[number];

export const arLocalities = pgTable(
  "ar_localities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provinceCode: text("province_code").notNull(),
    departmentName: text("department_name"),
    departmentCode: text("department_code"),
    localityName: text("locality_name").notNull(),
    localitySlug: text("locality_slug").notNull(),
    // Sargable normalized locality name (migration 0146). Materializes the exact
    // normNameSql() expression the panorama centroid joins apply at query time,
    // so the (province_code, locality_name_norm) index below can serve the join
    // as a plain equality instead of an unindexable per-row unaccent()/regexp.
    localityNameNorm: text("locality_name_norm").generatedAlwaysAs(
      sql`btrim(regexp_replace(lower(translate(public.immutable_unaccent(locality_name), '.', '')), '\\s+', ' ', 'g'))`,
    ),
    indecId: text("indec_id").unique(),
    category: text("category").notNull().$type<ArgentineLocalityCategory>(),
    latitude: numeric("latitude", { precision: 10, scale: 7 }),
    longitude: numeric("longitude", { precision: 10, scale: 7 }),
    source: text("source").notNull().$type<ArgentineLocalitySource>(),
    sourceVersion: text("source_version"),
    lastImportedAt: timestamp("last_imported_at", { withTimezone: true }).notNull().defaultNow(),
    // Soft-delete marker. The import script sets this when a previously-imported
    // INDEC row no longer appears in the dataset. UI filters out non-null rows.
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (table) => ({
    // Non-unique partial index: INDEC legitimately ships duplicates of
    // (province, name) across departments (68 such collisions as of
    // 2026-05-18). Uniqueness is enforced by indec_id alone (column-level).
    provinceSlugIdx: index("ar_localities_province_slug_idx")
      .on(table.provinceCode, table.localitySlug)
      .where(sql`${table.removedAt} IS NULL`),
    provinceIdx: index("ar_localities_province_idx")
      .on(table.provinceCode)
      .where(sql`${table.removedAt} IS NULL`),
    // Sargable centroid-join index (migration 0146): (province, normalized name)
    // resolves the panorama locality rollup joins with an index scan.
    provinceLocalityNormIdx: index("ar_localities_province_locality_norm_idx")
      .on(table.provinceCode, table.localityNameNorm)
      .where(sql`${table.removedAt} IS NULL`),
    // CHECK constraints — also declared inline in migration 0019 (province,
    // category) and 0028 (source). Declared here too so that `drizzle-kit
    // push` against a fresh DB applies them; otherwise migration replay is
    // a no-op (CREATE TABLE IF NOT EXISTS skips the inline constraints when
    // the table already exists from db:push).
    provinceValid: check("ar_localities_province_valid", sql`${table.provinceCode} ~ '^AR-[A-Z]$'`),
    categoryValid: check(
      "ar_localities_category_valid",
      sql`${table.category} IN ('localidad','ciudad','pueblo','comuna','barrio','componente')`,
    ),
    sourceValid: check(
      "ar_localities_source_valid",
      sql`${table.source} IN ('indec_cppdyl','bahra','manual','caba_open_data')`,
    ),
  }),
);

export type ArgentineLocality = typeof arLocalities.$inferSelect;
export type NewArgentineLocality = typeof arLocalities.$inferInsert;

// Where each place-bearing event happened, by catalogue id (migration 0250,
// localidades-por-id B4). A DECLARED PROJECTION of pet_events.payload->place,
// written by trigger in the event's transaction and rebuildable from the spine
// with public.project_event_place. Never written by application code.
export const eventPlaces = pgTable(
  "event_places",
  {
    eventId: uuid("event_id")
      .primaryKey()
      .references(() => petEvents.id, { onDelete: "cascade" }),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    provinceCode: text("province_code"),
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    method: text("method").notNull(),
    entered: jsonb("entered").notNull(),
    projectedAt: timestamp("projected_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    localityIdIdx: index("event_places_locality_id_idx")
      .on(table.localityId)
      .where(sql`${table.localityId} IS NOT NULL`),
    provinceCodeIdx: index("event_places_province_code_idx").on(table.provinceCode),
    petIdIdx: index("event_places_pet_id_idx").on(table.petId),
  }),
);

// The one way a place is resolved after the fact (admin queue, catalogue
// repair) — append-only, UPDATE/DELETE/TRUNCATE refused by trigger (migration
// 0250). A correction is a new row that supersedes the old one.
export const placeResolutions = pgTable(
  "place_resolutions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectTable: text("subject_table").notNull(),
    subjectId: uuid("subject_id").notNull(),
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    method: text("method").notNull(),
    actorUserId: uuid("actor_user_id"),
    reason: text("reason"),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => placeResolutions.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    subjectIdx: index("place_resolutions_subject_idx").on(
      table.subjectTable,
      table.subjectId,
      table.createdAt.desc(),
    ),
  }),
);

// Who governs which localities (migration 0253, localidades-por-id C1). A unit
// is DATA, seeded as draft from INDEC departments by
// scripts/seed-authority-units.ts and confirmed by a platform admin. `level`
// is the cascade position (provincial > regional > municipal > submunicipal);
// `kind` what the unit is (a Santa Fe comuna is municipal, a CABA comuna
// submunicipal). A `region` (0254) groups localities, usually several partidos,
// below its province and above the municipio — a región sanitaria, or a
// province's oversight split across a few accounts. It is the only regional
// kind, so a locality holds a municipal AND a regional membership at once; it
// is created by an admin, never seeded; and an unresolved place never reaches
// it (public.authority_units_for_place). Never deleted (trigger).
export const AUTHORITY_UNIT_KINDS = [
  "provincia",
  "region",
  "municipio",
  "ciudad",
  "comuna",
  "departamento",
] as const;
export type AuthorityUnitKind = (typeof AUTHORITY_UNIT_KINDS)[number];
export const AUTHORITY_UNIT_LEVELS = [
  "provincial",
  "regional",
  "municipal",
  "submunicipal",
] as const;
export type AuthorityUnitLevel = (typeof AUTHORITY_UNIT_LEVELS)[number];

export const authorityUnits = pgTable(
  "authority_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull().$type<AuthorityUnitKind>(),
    level: text("level").notNull().$type<AuthorityUnitLevel>(),
    provinceCode: text("province_code").notNull(),
    name: text("name").notNull(),
    indecDepartmentCode: text("indec_department_code"),
    parentUnitId: uuid("parent_unit_id").references((): AnyPgColumn => authorityUnits.id, {
      onDelete: "restrict",
    }),
    status: text("status").notNull().default("draft").$type<"draft" | "confirmed">(),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    seedKey: text("seed_key").unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneProvincia: uniqueIndex("authority_units_one_provincia")
      .on(table.provinceCode)
      .where(sql`${table.kind} = 'provincia'`),
    provinceIdx: index("authority_units_province_idx").on(table.provinceCode),
    kindLevel: check(
      "authority_units_kind_level",
      sql`(${table.kind} = 'provincia') = (${table.level} = 'provincial') AND (${table.kind} = 'region') = (${table.level} = 'regional')`,
    ),
  }),
);

export type AuthorityUnit = typeof authorityUnits.$inferSelect;

// Which catalogue localities a unit governs, dated (migration 0253). Opened
// and CLOSED, never rewritten or deleted (trigger): the rows are their own
// audit trail. One active membership per (locality, level); a provincial unit
// has no explicit members.
export const authorityUnitLocalities = pgTable(
  "authority_unit_localities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => authorityUnits.id, { onDelete: "restrict" }),
    localityId: uuid("locality_id")
      .notNull()
      .references(() => arLocalities.id, { onDelete: "restrict" }),
    level: text("level").notNull().$type<Exclude<AuthorityUnitLevel, "provincial">>(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    addedBy: uuid("added_by"),
    endedBy: uuid("ended_by"),
  },
  (table) => ({
    activeUnique: uniqueIndex("authority_unit_localities_active_unique")
      .on(table.localityId, table.level)
      .where(sql`${table.validTo} IS NULL`),
    localityActiveIdx: index("authority_unit_localities_locality_active_idx")
      .on(table.localityId)
      .where(sql`${table.validTo} IS NULL`),
    unitIdx: index("authority_unit_localities_unit_idx").on(table.unitId),
  }),
);

export type AuthorityUnitLocality = typeof authorityUnitLocalities.$inferSelect;

// Traceability of every import script execution. Used to debug imports and to
// surface "last successful sync" on a future admin dashboard.
export const arLocalitiesImportRuns = pgTable(
  "ar_localities_import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    source: text("source").notNull(),
    sourceUrl: text("source_url").notNull(),
    sourceVersion: text("source_version"),
    status: text("status").notNull().default("running"),
    insertedCount: integer("inserted_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    noopCount: integer("noop_count").notNull().default(0),
    removedCount: integer("removed_count").notNull().default(0),
    details: jsonb("details").notNull().default({}),
  },
  (table) => ({
    startedAtIdx: index("ar_localities_import_runs_idx").on(table.startedAt),
    arImportsStatusValid: check(
      "ar_imports_status_valid",
      sql`${table.status} in ('running','ok','failed')`,
    ),
  }),
);

export type ArLocalitiesImportRun = typeof arLocalitiesImportRuns.$inferSelect;
export type NewArLocalitiesImportRun = typeof arLocalitiesImportRuns.$inferInsert;

// ============================================================================
// Foster volunteers pool — see specs/2026-05-18-foster-volunteers-pool-design.md
// ============================================================================
//
// foster_volunteers: pool single-row-per-user. D16 slots model — each
// enrollment +1, each accepted proposal -1; only rows with
// status='active' AND available_slots > 0 surface in org searches.
//
// foster_proposals: concrete org→volunteer proposals for a specific pet.
// Two-phase lifecycle (pending → accepted/rejected/cancelled/expired).
// Cancellation can be initiated by the org (cancelled_by_user_id), by the
// D18 cascade auto-cancel when a volunteer's last slot is consumed, or by
// the daily expirer cron at 7 days past proposed_at.

export const fosterVolunteers = pgTable(
  "foster_volunteers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: "cascade" }),

    status: text("status").notNull().default("active"),
    availableSlots: integer("available_slots").notNull().default(0),

    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),

    acceptsDogs: boolean("accepts_dogs").notNull().default(false),
    acceptsCats: boolean("accepts_cats").notNull().default(false),
    acceptsOtherSpecies: boolean("accepts_other_species").notNull().default(false),

    acceptsSizeSmall: boolean("accepts_size_small").notNull().default(true),
    acceptsSizeMedium: boolean("accepts_size_medium").notNull().default(true),
    acceptsSizeLarge: boolean("accepts_size_large").notNull().default(false),

    acceptsPuppies: boolean("accepts_puppies").notNull().default(false),
    acceptsSeniors: boolean("accepts_seniors").notNull().default(true),

    acceptsChronicConditions: boolean("accepts_chronic_conditions").notNull().default(false),
    acceptsDangerousBreeds: boolean("accepts_dangerous_breeds").notNull().default(false),

    maxDurationWeeks: integer("max_duration_weeks"),
    householdOtherPets: boolean("household_other_pets"),
    householdKids: boolean("household_kids"),

    notes: text("notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial indexes match the migration: searchable pool + locality
    // narrowing only consider active rows with slots > 0.
    poolIdx: index("foster_volunteers_pool_idx")
      .on(table.status)
      .where(sql`${table.status} = 'active' AND ${table.availableSlots} > 0`),
    localityIdx: index("foster_volunteers_locality_idx")
      .on(table.jurisdictionProvince, table.jurisdictionLocality)
      .where(sql`${table.status} = 'active' AND ${table.availableSlots} > 0`),
    fosterVolunteersStatusValid: check(
      "foster_volunteers_status_valid",
      sql`${table.status} in ('active','paused','withdrawn')`,
    ),
    fosterVolunteersSlotsNonNegative: check(
      "foster_volunteers_slots_non_negative",
      sql`${table.availableSlots} >= 0`,
    ),
    fosterVolunteersAtLeastOneSpecies: check(
      "foster_volunteers_at_least_one_species",
      sql`${table.status} != 'active' or (${table.acceptsDogs} or ${table.acceptsCats} or ${table.acceptsOtherSpecies})`,
    ),
    fosterVolunteersJurisdictionProvinceCanonical: check(
      "foster_volunteers_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type FosterVolunteer = typeof fosterVolunteers.$inferSelect;
export type NewFosterVolunteer = typeof fosterVolunteers.$inferInsert;

export const fosterProposals = pgTable(
  "foster_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicToken: text("public_token").notNull().unique(),

    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    volunteerUserId: uuid("volunteer_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    proposedByUserId: uuid("proposed_by_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "set null" }),

    proposedAt: timestamp("proposed_at", { withTimezone: true }).notNull().defaultNow(),
    proposedDurationWeeks: integer("proposed_duration_weeks"),
    proposedNotes: text("proposed_notes"),
    matchWarnings: jsonb("match_warnings").notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    status: text("status").notNull().default("pending"),

    respondedAt: timestamp("responded_at", { withTimezone: true }),
    responseNotes: text("response_notes"),
    rejectionReason: text("rejection_reason"),

    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    cancelledByUserId: uuid("cancelled_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    cancellationReason: text("cancellation_reason"),

    resolvedOwnershipId: uuid("resolved_ownership_id").references(() => ownerships.id, {
      onDelete: "set null",
    }),

    // Cases system (migration 0068 + FK added migration 0079). Linked to the
    // foster_proposal case opened atomically by proposeFosterAction. Nullable
    // for historical rows predating the wiring. ON DELETE SET NULL: if a case
    // is ever hard-deleted (admin correction), the proposal loses the link but
    // remains valid (matches welfare_reports.case_id pattern).
    // Forward-reference lambda required because cases is declared after.
    caseId: uuid("case_id").references((): AnyPgColumn => cases.id, {
      onDelete: "set null",
    }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    volunteerIdx: index("foster_proposals_volunteer_idx").on(
      table.volunteerUserId,
      table.status,
      table.proposedAt,
    ),
    orgIdx: index("foster_proposals_org_idx").on(
      table.organizationId,
      table.status,
      table.proposedAt,
    ),
    petIdx: index("foster_proposals_pet_idx")
      .on(table.petId)
      .where(sql`${table.status} IN ('pending','accepted')`),
    statusIdx: index("foster_proposals_status_idx").on(table.status, table.expiresAt),
    proposedByIdx: index("foster_proposals_proposed_by_idx").on(table.proposedByUserId),
    cancelledByIdx: index("foster_proposals_cancelled_by_idx").on(table.cancelledByUserId),
    resolvedOwnershipIdx: index("foster_proposals_resolved_ownership_idx").on(
      table.resolvedOwnershipId,
    ),
    fosterProposalsStatusValid: check(
      "foster_proposals_status_valid",
      sql`${table.status} in ('pending','accepted','rejected','expired','cancelled')`,
    ),
    fosterProposalsRejectionReasonValid: check(
      "foster_proposals_rejection_reason_valid",
      sql`${table.rejectionReason} is null or ${table.rejectionReason} in ('capacity','health_mismatch','timing','distance','household','other')`,
    ),
    fosterProposalsResponseConsistent: check(
      "foster_proposals_response_consistent",
      sql`(${table.status} = 'pending'   and ${table.respondedAt} is null and ${table.cancelledAt} is null) or (${table.status} = 'accepted'  and ${table.respondedAt} is not null and ${table.resolvedOwnershipId} is not null) or (${table.status} = 'rejected'  and ${table.respondedAt} is not null) or (${table.status} = 'expired'   and (${table.respondedAt} is null or ${table.expiresAt} <= ${table.respondedAt})) or (${table.status} = 'cancelled' and ${table.cancelledAt} is not null and ${table.cancelledByUserId} is not null)`,
    ),
  }),
);

export type FosterProposal = typeof fosterProposals.$inferSelect;
export type NewFosterProposal = typeof fosterProposals.$inferInsert;

// ============================================================================
// Cron telemetry — Admin Fase 14
// ============================================================================
// One row per cron invocation. The route handler inserts with status='running'
// and updates to 'ok' or 'failed' on completion. Surfaces in /admin/sistema.

export const cronRuns = pgTable(
  "cron_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cronName: text("cron_name").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull().default("running").$type<"running" | "ok" | "failed">(),
    itemsProcessed: integer("items_processed").notNull().default(0),
    details: jsonb("details").notNull().default({}),
  },
  (table) => ({
    nameStartedIdx: index("cron_runs_name_started_idx").on(table.cronName, table.startedAt),
    cronRunsStatusValid: check(
      "cron_runs_status_valid",
      sql`${table.status} in ('running','ok','failed')`,
    ),
  }),
);

export type CronRun = typeof cronRuns.$inferSelect;
export type NewCronRun = typeof cronRuns.$inferInsert;

// ============================================================================
// Alert subscriptions — Paquete H (threshold alerts on /admin/programa)
// ============================================================================
// Each row represents an admin user's threshold subscription for a program
// metric. When the current value crosses the threshold in the configured
// direction, the subscription is "breaching" and is surfaced on the dashboard.
//
// Metrics: active_zoonosis, eno_sla_ontime_pct, queue_oldest_days,
//          sterilization_coverage_pct, microchip_penetration_pct, open_welfare_reports
//
// Jurisdiction scope is optional — when set, the metric is fetched scoped to
// that jurisdiction. queue_oldest_days is always global (no jurisdiction dim).
//
// RLS: owner SELECT/INSERT/UPDATE/DELETE own; admin SELECT all via RLS.
// Admin writes go through Drizzle BYPASSRLS (no permissive admin write policy).

export const ALERT_METRIC_KEYS = [
  "active_zoonosis",
  "eno_sla_ontime_pct",
  "queue_oldest_days",
  "sterilization_coverage_pct",
  "microchip_penetration_pct",
  "open_welfare_reports",
] as const;

export type AlertMetricKey = (typeof ALERT_METRIC_KEYS)[number];

export const ALERT_DIRECTIONS = ["above", "below"] as const;
export type AlertDirection = (typeof ALERT_DIRECTIONS)[number];

export const alertSubscriptions = pgTable(
  "alert_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    metricKey: text("metric_key").notNull().$type<AlertMetricKey>(),
    direction: text("direction").notNull().$type<AlertDirection>(),
    threshold: numeric("threshold").notNull(),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    label: text("label"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Partial index: fast lookup of a user's active subscriptions.
    actorActiveIdx: index("alert_subscriptions_actor_active_idx")
      .on(table.actorUserId)
      .where(sql`${table.isActive} = true`),
    // CHECK: metric_key must be one of the 6 supported keys.
    metricKeyValid: check(
      "alert_subscriptions_metric_key_valid",
      sql`${table.metricKey} IN ('active_zoonosis','eno_sla_ontime_pct','queue_oldest_days','sterilization_coverage_pct','microchip_penetration_pct','open_welfare_reports')`,
    ),
    // CHECK: direction must be 'above' or 'below'.
    directionValid: check(
      "alert_subscriptions_direction_valid",
      sql`${table.direction} IN ('above','below')`,
    ),
    // CHECK: jurisdiction_province must be null or a canonical Argentine province.
    provinceValid: check(
      "alert_subscriptions_province_valid",
      sql`${table.jurisdictionProvince} IS NULL OR ${table.jurisdictionProvince} IN ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type AlertSubscription = typeof alertSubscriptions.$inferSelect;
export type NewAlertSubscription = typeof alertSubscriptions.$inferInsert;

// ============================================================================
// Alert firings — Paquete K (alert inbox + triage)
// ============================================================================
// One row per OPEN alert raised when an alert_subscriptions threshold is
// crossed during evaluation (on-page or via the daily evaluate-alerts cron).
// Each firing carries a triage lifecycle so an admin can acknowledge it, open
// (or link) an outbreak investigation, contact the jurisdiction's authority,
// and close it. The transition audit lives in the *_at / *_by columns — there
// is intentionally NO new AUDIT_LOG_ACTIONS entry (decision K-D4).
//
// State machine (ALERT_FIRING_STATUSES):
//   disparada → reconocida → en_investigacion → autoridad_contactada → resuelta
//   disparada / reconocida → descartada
//
// Dedup: at most ONE open firing per (subscription_id, jurisdiction) at a time
// (enforced in lib/metrics/alert-firing.ts#shouldOpenFiring + the writer).
//
// RLS: defense-in-depth deny-all for the PostgREST surface. Admin reads/writes
// go through Drizzle (BYPASSRLS service-role). Classified in
// __tests__/rls/coverage.test.ts → RLS_REQUIRED.

export const ALERT_FIRING_STATUSES = [
  "disparada",
  "reconocida",
  "en_investigacion",
  "autoridad_contactada",
  "resuelta",
  "descartada",
] as const;

export type AlertFiringStatus = (typeof ALERT_FIRING_STATUSES)[number];

/** Open (non-terminal) firing statuses — used for dedup + the inbox badge. */
export const ALERT_FIRING_OPEN_STATUSES = [
  "disparada",
  "reconocida",
  "en_investigacion",
  "autoridad_contactada",
] as const satisfies readonly AlertFiringStatus[];

export const alertFirings = pgTable(
  "alert_firings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // The subscription whose threshold was crossed. SET NULL on delete so a
    // firing survives the subscription being removed (its history is audit).
    subscriptionId: uuid("subscription_id").references(() => alertSubscriptions.id, {
      onDelete: "set null",
    }),
    metricKey: text("metric_key").notNull().$type<AlertMetricKey>(),
    direction: text("direction").notNull().$type<AlertDirection>(),
    threshold: numeric("threshold").notNull(),
    observedValue: numeric("observed_value").notNull(),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    status: text("status").notNull().default("disparada").$type<AlertFiringStatus>(),
    firedAt: timestamp("fired_at", { withTimezone: true }).notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: uuid("acknowledged_by").references(() => profiles.id, { onDelete: "set null" }),
    // publicCode of the linked outbreak investigation (active_zoonosis only).
    investigationCode: text("investigation_code"),
    contactedGovtUserId: uuid("contacted_govt_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    contactedAt: timestamp("contacted_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => profiles.id, { onDelete: "set null" }),
    notes: text("notes"),
  },
  (table) => ({
    // Inbox ordering + status filter.
    statusFiredIdx: index("alert_firings_status_fired_idx").on(table.status, table.firedAt),
    // Dedup: fast lookup of open firings for a subscription.
    subscriptionStatusIdx: index("alert_firings_subscription_status_idx").on(
      table.subscriptionId,
      table.status,
    ),
    metricKeyValid: check(
      "alert_firings_metric_key_valid",
      sql`${table.metricKey} IN ('active_zoonosis','eno_sla_ontime_pct','queue_oldest_days','sterilization_coverage_pct','microchip_penetration_pct','open_welfare_reports')`,
    ),
    directionValid: check(
      "alert_firings_direction_valid",
      sql`${table.direction} IN ('above','below')`,
    ),
    statusValid: check(
      "alert_firings_status_valid",
      sql`${table.status} IN ('disparada','reconocida','en_investigacion','autoridad_contactada','resuelta','descartada')`,
    ),
    provinceValid: check(
      "alert_firings_province_valid",
      sql`${table.jurisdictionProvince} IS NULL OR ${table.jurisdictionProvince} IN ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
  }),
);

export type AlertFiring = typeof alertFirings.$inferSelect;
export type NewAlertFiring = typeof alertFirings.$inferInsert;

// ============================================================================
// Custody disputes — Admin Fase 10
// ============================================================================
// Created in lockstep with a `custody_dispute_raised` pet_event; resolved via
// `custody_dispute_resolved`. The unique partial index ensures at most one
// IN-DISPUTE dispute per pet. Parties row records every involved actor.

// 'escalated' is representable since migration 0235 (finding A09-3) so the
// dispute row CAN follow its case. Migration 0242 moved every reader onto
// IN_DISPUTE_STATUSES below, and `escalateDisputeUseCase` now writes it.
export const DISPUTE_STATUSES = ["open", "escalated", "resolved", "withdrawn"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

// THE CUSTODY LOCK, IN ONE PLACE (PO decision 2A, 2026-09-22).
// ---------------------------------------------------------------------------
// "In dispute" is a TWO-state predicate, not the literal 'open'. An escalated
// dispute KEEPS the lock: the pet still cannot be transferred or adopted, its
// `pets.in_custody_dispute` cache stays true, it still shows in the arbiter's
// and the authority's queue, and no second dispute may be opened over it.
// Escalation is a change of CHANNEL (the matter moved to judicial hands), never
// a release.
//
// Every comparison against custody_disputes.status — SQL partial index,
// use-case guard, dashboard read, cache re-derivation — goes through this
// constant or the `disputeHoldsCustodyLock()` predicate below. A bare `'open'`
// comparison is exactly what would silently release the lock, so it is fenced:
// scripts/check-dispute-lock-predicate.ts fails on one.
export const IN_DISPUTE_STATUSES = ["open", "escalated"] as const;
export type InDisputeStatus = (typeof IN_DISPUTE_STATUSES)[number];

/** True while the dispute still holds the custody lock (open OR escalated). */
export function isInDisputeStatus(status: string): status is InDisputeStatus {
  return (IN_DISPUTE_STATUSES as readonly string[]).includes(status);
}

// SQL spelling of IN_DISPUTE_STATUSES, derived from the constant so a future
// third in-dispute state cannot land in the TS list and miss the partial
// indexes. Mirrors the CANONICAL_PROVINCE_SQL_LIST pattern above.
const IN_DISPUTE_STATUS_SQL_LIST = sql.raw(
  `(${IN_DISPUTE_STATUSES.map((s) => `'${s}'`).join(", ")})`,
);

export const DISPUTE_RESOLUTIONS = [
  "ownership_confirmed",
  "ownership_transferred",
  "case_dismissed",
  "other",
] as const;
export type DisputeResolution = (typeof DISPUTE_RESOLUTIONS)[number];

export const DISPUTE_PARTY_ROLES = [
  "current_owner",
  "claimant_owner",
  "current_org_custody",
  "claimant_org",
  "witness",
] as const;
export type DisputePartyRole = (typeof DISPUTE_PARTY_ROLES)[number];

export const custodyDisputes = pgTable(
  "custody_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicToken: text("public_token").notNull().unique(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    raisedByUserId: uuid("raised_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    raisedByOrgId: uuid("raised_by_org_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    raisedByRole: text("raised_by_role").notNull().$type<"owner" | "org" | "govt" | "admin">(),
    raisingEventId: uuid("raising_event_id")
      .notNull()
      .references(() => petEvents.id, { onDelete: "cascade" }),
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province").notNull(),
    jurisdictionLocality: text("jurisdiction_locality").notNull(),
    // Which catalogue row, and how (migration 0248, localidades-por-id B1).
    // Unread until stage D; the name pair above is still the scope key.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    placeMethod: text("place_method"),
    status: text("status").notNull().default("open").$type<DisputeStatus>(),
    resolution: text("resolution").$type<DisputeResolution | null>(),
    resolutionSummary: text("resolution_summary"),
    resolutionEventId: uuid("resolution_event_id").references(() => petEvents.id, {
      onDelete: "set null",
    }),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    // PII baseline (compliance PR 1, migration 0058).
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => profiles.id, { onDelete: "set null" }),
    purpose: dataPurposeEnum("purpose"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    custodyDisputesStatusValid: check(
      "custody_disputes_status_valid",
      sql`${table.status} in ('open','escalated','resolved','withdrawn')`,
    ),
    custodyDisputesResolutionConsistent: check(
      "custody_disputes_resolution_consistent",
      sql`(${table.status} in ('open','escalated') and ${table.resolution} is null and ${table.resolvedByUserId} is null and ${table.resolvedAt} is null) or (${table.status} in ('resolved','withdrawn') and ${table.resolvedByUserId} is not null and ${table.resolvedAt} is not null)`,
    ),
    custodyDisputesResolutionRequiredWhenResolved: check(
      "custody_disputes_resolution_required_when_resolved",
      sql`${table.status} != 'resolved' or (${table.resolution} is not null and ${table.resolutionSummary} is not null)`,
    ),
    custodyDisputesRaisedRoleValid: check(
      "custody_disputes_raised_role_valid",
      sql`${table.raisedByRole} in ('owner','org','govt','admin')`,
    ),
    custodyDisputesJurisdictionProvinceCanonical: check(
      "custody_disputes_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
    // Renamed from public_custody_disputes_deleted_idx → custody_disputes_deleted_idx (migration 0095).
    custodyDisputesDeletedIdx: index("custody_disputes_deleted_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    // Indexes shipped in migration 0025, mirrored here for schema↔migration
    // agreement: per-pet timeline, open-status jurisdiction lookup, and the
    // one-open-dispute-per-pet uniqueness guard.
    // created_at DESC matches migration 0025 exactly — without .desc() the
    // drift check would flag a phantom diff and try to recreate the index.
    custodyDisputesPetIdx: index("custody_disputes_pet_idx").on(
      table.petId,
      table.createdAt.desc(),
    ),
    // Both partial indexes cover the whole in-dispute set (migration 0242).
    // The name still says "open"/"one_open" — renaming a shipped index buys
    // nothing and costs a drift diff on every environment; the predicate is
    // what carries the meaning, and it is derived from IN_DISPUTE_STATUSES.
    custodyDisputesJurisOpenIdx: index("custody_disputes_juris_open_idx")
      .on(table.jurisdictionProvince, table.jurisdictionLocality)
      .where(sql`${table.status} in ${IN_DISPUTE_STATUS_SQL_LIST}`),
    custodyDisputesOneOpenPerPet: uniqueIndex("custody_disputes_one_open_per_pet")
      .on(table.petId)
      .where(sql`${table.status} in ${IN_DISPUTE_STATUS_SQL_LIST}`),
    // V1-8 perf (migration 0090): the public credential / custody UI filters
    // disputes by (pet_id, status) on non-deleted rows. The existing pet_idx
    // (pet_id, created_at) and one_open_per_pet (open only) don't cover status
    // filtering for non-open statuses on live disputes. Partial on the active
    // set (deleted_at IS NULL) keeps it small.
    custodyDisputesPetStatusIdx: index("custody_disputes_pet_status_idx")
      .on(table.petId, table.status)
      .where(sql`${table.deletedAt} IS NULL`),
  }),
);

export const custodyDisputeParties = pgTable(
  "custody_dispute_parties",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    disputeId: uuid("dispute_id")
      .notNull()
      .references(() => custodyDisputes.id, { onDelete: "cascade" }),
    partyUserId: uuid("party_user_id").references(() => profiles.id, { onDelete: "set null" }),
    partyOrganizationId: uuid("party_organization_id"),
    partyRole: text("party_role").notNull().$type<DisputePartyRole>(),
    partyPositionSummary: text("party_position_summary"),
    addedByUserId: uuid("added_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // FK name exceeds 63 chars when drizzle auto-generates; declare it explicitly.
    partyOrganizationFk: foreignKey({
      name: "custody_dispute_parties_party_organization_id_organizations_id_",
      columns: [table.partyOrganizationId],
      foreignColumns: [organizations.id],
    }).onDelete("set null"),
    disputePartyExactlyOneSubject: check(
      "dispute_party_exactly_one_subject",
      sql`(${table.partyUserId} is not null and ${table.partyOrganizationId} is null) or (${table.partyUserId} is null and ${table.partyOrganizationId} is not null)`,
    ),
    disputePartyRoleValid: check(
      "dispute_party_role_valid",
      sql`${table.partyRole} in ('current_owner','claimant_owner','current_org_custody','claimant_org','witness')`,
    ),
    // Indexes shipped in migration 0025, mirrored here for schema↔migration
    // agreement. dispute_id is the hot lookup (list parties for a dispute);
    // party_user_id / party_organization_id are partial (exactly one is set
    // per row, per the dispute_party_exactly_one_subject CHECK).
    disputeIdx: index("custody_dispute_parties_dispute_idx").on(table.disputeId),
    partyUserIdx: index("custody_dispute_parties_user_idx")
      .on(table.partyUserId)
      .where(sql`${table.partyUserId} IS NOT NULL`),
    partyOrganizationIdx: index("custody_dispute_parties_org_idx")
      .on(table.partyOrganizationId)
      .where(sql`${table.partyOrganizationId} IS NOT NULL`),
  }),
);

/**
 * Drizzle predicate for "this dispute still holds the custody lock".
 *
 * The ONE spelling every reader uses (see IN_DISPUTE_STATUSES above). It is a
 * function, not a const, because drizzle SQL objects carry per-query state and
 * a shared instance would be reused across concurrent queries.
 */
export function disputeHoldsCustodyLock() {
  return inArray(custodyDisputes.status, [...IN_DISPUTE_STATUSES]);
}

export type CustodyDispute = typeof custodyDisputes.$inferSelect;
export type CustodyDisputeParty = typeof custodyDisputeParties.$inferSelect;

// ============================================================================
// Service dogs — Ley 26.858 (perro guía o de asistencia)
// ============================================================================
// Sibling table to pets (1-to-1). Owners create the row in
// 'pendiente_verificacion' and submit an approval_request of type
// 'service_dog_credential_verification'. Admin/govt approves → 'vigente'.
// The public banner on /p/[publicToken] renders ONLY for vigente+inService
// rows where public_visibility='full_banner' and serviceType is one of the
// five ANDIS-recognized categories ('otro' is allowed in the form but never
// renders the banner).
//
// Privacy posture: marking a pet as service dog reveals owner disability
// under Ley 25.326 Art. 7. public_visibility defaults to 'private_only'.

export const SERVICE_DOG_TYPES = [
  "guia",
  "asistencia_motriz",
  "alerta_medica",
  "senal_auditiva",
  "asistencia_tea",
  "otro",
] as const;
export type ServiceDogType = (typeof SERVICE_DOG_TYPES)[number];

// `otro` is allowed in the form but never renders the public banner.
export const SERVICE_DOG_BANNER_TYPES = SERVICE_DOG_TYPES.filter((t) => t !== "otro");

export const SERVICE_DOG_STATUSES = [
  "en_entrenamiento",
  "pendiente_verificacion",
  "vigente",
  "vencida",
  "revocada",
] as const;
export type ServiceDogStatus = (typeof SERVICE_DOG_STATUSES)[number];

export const SERVICE_DOG_VISIBILITIES = ["full_banner", "private_only"] as const;
export type ServiceDogVisibility = (typeof SERVICE_DOG_VISIBILITIES)[number];

export const petServiceDog = pgTable(
  "pet_service_dog",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .unique()
      .references(() => pets.id, { onDelete: "cascade" }),
    serviceType: text("service_type").notNull().$type<ServiceDogType>(),
    credentialStatus: text("credential_status")
      .notNull()
      .default("pendiente_verificacion")
      .$type<ServiceDogStatus>(),
    rupgaCredential: text("rupga_credential"),
    trainingCenter: text("training_center").notNull(),
    trainingCertDate: date("training_cert_date"),
    credentialIssueDate: date("credential_issue_date"),
    credentialExpiryDate: date("credential_expiry_date"),
    inService: boolean("in_service").notNull().default(true),
    publicVisibility: text("public_visibility")
      .notNull()
      .default("private_only")
      .$type<ServiceDogVisibility>(),
    notes: text("notes"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedByUserId: uuid("verified_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    revocationReason: text("revocation_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petServiceDogServiceTypeValid: check(
      "pet_service_dog_service_type_valid",
      sql`${table.serviceType} in ('guia','asistencia_motriz','alerta_medica','senal_auditiva','asistencia_tea','otro')`,
    ),
    petServiceDogStatusValid: check(
      "pet_service_dog_status_valid",
      sql`${table.credentialStatus} in ('en_entrenamiento','pendiente_verificacion','vigente','vencida','revocada')`,
    ),
    petServiceDogVisibilityValid: check(
      "pet_service_dog_visibility_valid",
      sql`${table.publicVisibility} in ('full_banner','private_only')`,
    ),
    petServiceDogVigenteRequiresVerification: check(
      "pet_service_dog_vigente_requires_verification",
      sql`${table.credentialStatus} != 'vigente' or (${table.verifiedAt} is not null and ${table.verifiedByUserId} is not null)`,
    ),
    petServiceDogRevokedRequiresMotivo: check(
      "pet_service_dog_revoked_requires_motivo",
      sql`${table.credentialStatus} != 'revocada' or (${table.revokedAt} is not null and ${table.revokedByUserId} is not null and ${table.revocationReason} is not null)`,
    ),
  }),
);

export type PetServiceDog = typeof petServiceDog.$inferSelect;
export type NewPetServiceDog = typeof petServiceDog.$inferInsert;

// ============================================================================
// Rate limit buckets — generic TTL counter for anti-spam
// ============================================================================
// Used by anonymous welfare report submissions today; reusable for any
// endpoint that wants throttling without a Redis dependency. bucketKey
// encodes endpoint + identifier + window so disjoint requesters and
// disjoint windows don't compete.

export const rateLimitBuckets = pgTable("rate_limit_buckets", {
  bucketKey: text("bucket_key").primaryKey(),
  count: integer("count").notNull().default(1),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export type RateLimitBucket = typeof rateLimitBuckets.$inferSelect;

// ============================================================================
// Panorama aggregate cube (road-to-10 infra #1) — migration 0139
// ============================================================================
// Precomputed choropleth aggregate. Built by the TS cube-builder
// (src/modules/panorama/infrastructure/cube-builder.ts), which REUSES the live
// choropleth loaders and writes here in one transaction. Read only via
// analyticsDb (service-role); deny-all RLS to PostgREST. See migration 0139 and
// dim-interno:docs/plans/2026-07-11-cube-design.md (+ the TS-builder amendment).

/** The readable, k-anon'd cube surface. Suppressed department cells carry
 * value = NULL — a sub-k count is NEVER stored here. */
export const panoramaCube = pgTable(
  "panorama_cube",
  {
    metric: text("metric").notNull(),
    /** 'province' | 'department'. */
    unitLevel: text("unit_level").notNull(),
    province: text("province").notNull(),
    /** Unique unit id within (metric, unit_level); the PK's non-null component. */
    unitCode: text("unit_code").notNull(),
    label: text("label"),
    departmentCode: text("department_code"),
    departmentName: text("department_name"),
    centroidLat: numeric("centroid_lat"),
    centroidLng: numeric("centroid_lng"),
    /** department: k-anon count (NULL if suppressed); province: ratePct or count. */
    value: numeric("value"),
    /** REUSED (CB1, 2026-07-11): on PROVINCE rows this carries the department-grain
     * truncation flag (0/1) for that (metric, province) — the province's locality
     * rollup hit PER_LAYER_CAP at build. Originally reserved as a rate denominator
     * (never written); a future rate-by-num/den reader MUST first migrate this
     * flag to its own column. See cube-builder.ts buildProvinceCubeRows. */
    den: integer("den"),
    /** province grain: that province's no-locality residual for the metric. */
    noLocality: integer("no_locality"),
    suppressed: boolean("suppressed").notNull().default(false),
    complementary: boolean("complementary").notNull().default(false),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.metric, table.unitLevel, table.unitCode] }),
    lookupIdx: index("panorama_cube_lookup_idx").on(table.metric, table.unitLevel, table.province),
  }),
);

export type PanoramaCubeRow = typeof panoramaCube.$inferSelect;
export type NewPanoramaCubeRow = typeof panoramaCube.$inferInsert;

/** Cube build metadata singleton (one row, id = 1). */
export const panoramaCubeMeta = pgTable("panorama_cube_meta", {
  id: integer("id").primaryKey().default(1),
  builtAt: timestamp("built_at", { withTimezone: true }),
  watermark: timestamp("watermark", { withTimezone: true }),
  /** 'pending' | 'ok' | 'error'. */
  status: text("status").notNull().default("pending"),
  rowCount: integer("row_count"),
  durationMs: integer("duration_ms"),
});

export type PanoramaCubeMeta = typeof panoramaCubeMeta.$inferSelect;

// ============================================================================
// Panorama KPI-strip cube — migration 0151
// ============================================================================
// Precomputed KPI strip. Built by the TS cube-builder REUSING getPanoramaKpis
// (the exact live fan-out) for the admin-national scope + panorama default
// period, so cube-vs-live drift is structurally impossible. Rows store the
// FINISHED PanoramaKpi tile objects as jsonb — re-deriving tile formatting from
// numeric columns would fork the presentation logic the strip single-sources.
// Read only via analyticsDb (service-role); deny-all RLS to PostgREST.

/** One row per (scope, kpi). Strip tiles carry `position`; non-strip cubed
 * aggregates (kpi='births' — fetchNetGrowth) carry position = NULL. */
export const panoramaKpiCube = pgTable(
  "panorama_kpi_cube",
  {
    /** 'national' (v1). Future: per-province drill scopes without a migration. */
    scope: text("scope").notNull(),
    /** PanoramaKpiId for strip tiles, or a non-strip aggregate id ('births'). */
    kpi: text("kpi").notNull(),
    /** Strip display order (0-based); NULL = not a strip tile (births). */
    position: integer("position"),
    /** Strip tiles: the PanoramaKpi object exactly as getPanoramaKpis built it.
     * births: the raw NetGrowthResult. */
    payload: jsonb("payload").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.scope, table.kpi] }),
  }),
);

export type PanoramaKpiCubeRow = typeof panoramaKpiCube.$inferSelect;
export type NewPanoramaKpiCubeRow = typeof panoramaKpiCube.$inferInsert;

/** KPI cube build metadata singleton (one row, id = 1). The reader gates on
 * status + built_at freshness AND the stored period window (KPIs are
 * period-sensitive, unlike the current-state choropleth cube). */
export const panoramaKpiCubeMeta = pgTable("panorama_kpi_cube_meta", {
  id: integer("id").primaryKey().default(1),
  builtAt: timestamp("built_at", { withTimezone: true }),
  watermark: timestamp("watermark", { withTimezone: true }),
  /** 'pending' | 'ok' | 'error'. */
  status: text("status").notNull().default("pending"),
  rowCount: integer("row_count"),
  durationMs: integer("duration_ms"),
  /** The AnalyticsPeriod the strip was computed for (panorama default preset). */
  periodSince: timestamp("period_since", { withTimezone: true }),
  periodUntil: timestamp("period_until", { withTimezone: true }),
  /** Strip-level PanoramaKpis fields (recalculatedFor, dataAsOf,
   * coverageDenominator) — everything except the tiles. */
  strip: jsonb("strip"),
});

export type PanoramaKpiCubeMeta = typeof panoramaKpiCubeMeta.$inferSelect;

// ============================================================================
// Cases (expedientes) — coordinación liviana sobre el event log
// ============================================================================
// Wrapping object over `pet_events` + `welfare_reports`. Each event row can
// optionally attach to one case (`case_id` nullable). Cases are polymorphic
// in subject (registered pet, unowned animal, location, general).
//
// Source specs:
//   docs/superpowers/specs/2026-05-19-cases-event-attachment-design.md (v1.1+)
//   docs/superpowers/specs/2026-05-19-cases-lifecycles-design.md (v1.0+)
//   docs/superpowers/plans/2026-05-19-cases-system.md
//
// case_kind values are NOT enum-constrained at DB level so adding a new kind
// is one line in lib/case-kinds.ts (no migration). Validated in app code.

export const CASE_STATUSES = ["open", "escalated", "closed", "merged"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_CLOSED_REASONS = ["resolved", "cancelled", "auto_expired", "merged"] as const;
export type CaseClosedReason = (typeof CASE_CLOSED_REASONS)[number];

export const CASE_SUBJECT_KINDS = [
  "registered_pet",
  "unowned_animal",
  "location",
  "general",
] as const;
export type CaseSubjectKind = (typeof CASE_SUBJECT_KINDS)[number];

// ENO processing queue (handoff P4-6). One row per disease-diagnosis
// event that needs the ENO fanout (govt notifications + audit log).
// The event-insert action enqueues here cheaply; the hourly cron
// worker drains the queue. Keeps pet_events itself pure (immutable);
// queue state lives separately so it can be retried on failure.
//
// Status flow:
//   pending → processing (claimed atomically via UPDATE ... RETURNING)
//           → processed  (markEnoProcessed)
//           → pending    (markEnoFailed, retryCount < 2)
//           → failed     (markEnoFailed, retryCount >= 2)
//
// Overlap safety (migration 0089): pickPendingBatch claims rows with a
// single atomic UPDATE ... RETURNING so two concurrent cron runs always
// claim DISJOINT sets. claimed_at enables stale-claim recovery: rows
// stuck in 'processing' for > 10 minutes (crashed run) are eligible
// for re-claim on the next drain cycle.
export const enoProcessingQueue = pgTable(
  "eno_processing_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petEventId: uuid("pet_event_id").notNull(),
    /** pending | processing | processed | failed. */
    status: text("status").notNull().default("pending"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    /** Set when status transitions to 'processing'. Enables stale-claim recovery. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (table) => ({
    statusIdx: index("eno_processing_queue_status_idx").on(table.status, table.queuedAt),
    eventIdIdx: uniqueIndex("eno_processing_queue_event_id_unique").on(table.petEventId),
    statusCheck: check(
      "eno_processing_queue_status_check",
      sql`${table.status} IN ('pending', 'processing', 'processed', 'failed')`,
    ),
  }),
);

export const cases = pgTable(
  "cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Uniqueness is enforced by the `publicCodeIdx` unique index in the table
    // options below; declaring `.unique()` here too would create a duplicate
    // constraint with a conflicting name.
    publicCode: text("public_code").notNull(),
    caseKind: text("case_kind").notNull(),

    status: text("status").notNull().default("open").$type<CaseStatus>(),
    closedReason: text("closed_reason").$type<CaseClosedReason | null>(),
    // Self-reference for merged cases (drizzle handles the FK via DB; no `.references` to avoid cycle).
    supersededByCaseId: uuid("superseded_by_case_id"),

    primarySubjectKind: text("primary_subject_kind").notNull().$type<CaseSubjectKind>(),
    primaryPetId: uuid("primary_pet_id").references(() => pets.id, { onDelete: "cascade" }),
    // Canonical coordinate columns (P3 location convergence, DEPLOY 2).
    // Legacy primary_location_lat/lng dropped in migration 0103.
    locationLat: numeric("location_lat", { precision: 10, scale: 7 }),
    locationLng: numeric("location_lng", { precision: 10, scale: 7 }),

    // Used by adoption_application — write-once at open. No FK because
    // applications live as pet_events rows (no dedicated table).
    applicantUserId: uuid("applicant_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

    // Jurisdicción (denormalized from primary_pet or location)
    jurisdictionCountry: text("jurisdiction_country").notNull().default("AR"),
    jurisdictionProvince: text("jurisdiction_province"),
    jurisdictionLocality: text("jurisdiction_locality"),
    // Structural locality-attribution FK (migration 0147). Nullable + additive —
    // mirrors pets.localityId. References the ar_localities uuid PK.
    localityId: uuid("locality_id").references(() => arLocalities.id, { onDelete: "restrict" }),
    // HOW locality_id was decided (lib/domain/place.ts; CHECK in migration 0248).
    // NULL = not recorded. localidades-por-id B1.
    placeMethod: text("place_method"),

    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    openedByUserId: uuid("opened_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    openedByOrganizationId: uuid("opened_by_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),
    openedReason: text("opened_reason"),
    // Structured opened reason (migration 0149). Additive: `opened_reason`
    // prose keeps being written byte-identical on every open — it is a live
    // SQL query key (surveillance-repository.ts dedupes outbreak
    // investigations with `LIKE 'manual [code]:%'`) and the render source for
    // pre-cutover rows, which stay (null, null) forever (no backfill —
    // retro-translating audit prose would be a retro-edit).
    //
    // `text`, not a PG enum, and NOT `$type`-narrowed — same call as case_kind
    // above, for the same reason: this file imports nothing from src/, so
    // narrowing here would either invert the layering (schema → domain) or
    // duplicate the vocabulary and let it drift with no compile-time link.
    // The closed set lives in src/modules/cases/domain/opened-reason.ts (Zod
    // discriminated union); an unmapped code is a `tsc` error THERE, at the
    // choke point, which is where the fence belongs. Writer #19 is a
    // TypeScript edit, not a gated migration.
    openedReasonCode: text("opened_reason_code"),
    openedReasonParams: jsonb("opened_reason_params"),

    // For custody_transfer_handshake: canonical receiver org (mirrors the
    // proposal payload's to_organization_id). The accept-path authorizes
    // against this column; payload becomes a cross-check. Nullable so
    // other case kinds (which have no receiver concept) leave it blank.
    receiverOrganizationId: uuid("receiver_organization_id").references(() => organizations.id, {
      onDelete: "set null",
    }),

    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedByUserId: uuid("closed_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),

    // Linkbacks to auxiliary tables (optional per kind)
    welfareReportId: uuid("welfare_report_id").references(() => welfareReports.id, {
      onDelete: "set null",
    }),
    // adoption_application_id has no FK until the adoption-listing-public spec lands.
    adoptionApplicationId: uuid("adoption_application_id"),
    custodyDisputeId: uuid("custody_dispute_id").references(() => custodyDisputes.id, {
      onDelete: "set null",
    }),

    // For adoption_application: linkage to its parent listing case.
    parentListingCaseId: uuid("parent_listing_case_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    publicCodeIdx: uniqueIndex("cases_public_code_unique").on(table.publicCode),
    openByJurisdictionIdx: index("cases_open_by_jurisdiction_kind_idx")
      .on(table.jurisdictionLocality, table.caseKind)
      .where(sql`${table.status} IN ('open', 'escalated')`),
    // Partial unique indexes (migration 0033). Modeled here too so that
    // `drizzle-kit push` doesn't drop them — the bootstrap flow runs push
    // AFTER migration replay, and unmodeled indexes silently disappear.
    openPerPetKindIdx: uniqueIndex("cases_open_per_pet_kind_idx")
      .on(table.primaryPetId, table.caseKind)
      .where(
        sql`${table.status} IN ('open', 'escalated') AND ${table.caseKind} NOT IN ('adoption_application', 'adoption_listing', 'welfare_denuncia', 'foster_placement')`,
      ),
    openAdoptionAppPerApplicantIdx: uniqueIndex("cases_open_adoption_app_per_applicant_idx")
      .on(table.primaryPetId, table.applicantUserId)
      .where(
        sql`${table.status} IN ('open', 'escalated') AND ${table.caseKind} = 'adoption_application'`,
      ),
    openByOwnerPetIdx: index("cases_open_by_owner_pet_idx")
      .on(table.primaryPetId)
      .where(sql`${table.status} IN ('open', 'escalated')`),
    receiverOrgOpenIdx: index("cases_receiver_org_open_idx")
      .on(table.receiverOrganizationId, table.caseKind)
      .where(
        sql`${table.status} IN ('open', 'escalated') AND ${table.receiverOrganizationId} IS NOT NULL`,
      ),
    // Keyset composites for the case-queue lists (migration 0126). Both back
    // the shared ORDER BY (opened_at DESC, id DESC) keyset pagination in
    // lib/infra/case-queries.ts: the jurisdiction composite serves
    // listCasesForGovt (/gob/casos), the plain opened_at one serves the
    // unscoped listCasesForAdmin (/admin/casos).
    jurisOpenedAtIdx: index("cases_juris_opened_at_idx").on(
      table.jurisdictionProvince,
      table.jurisdictionLocality,
      table.openedAt.desc(),
      table.id.desc(),
    ),
    openedAtIdIdx: index("cases_opened_at_id_idx").on(table.openedAt.desc(), table.id.desc()),
    // Structured opened-reason code (migration 0149). Partial: pre-cutover
    // rows are all NULL and stay NULL (no backfill). Backs the
    // "casos abiertos por causa" GROUP BY.
    openedReasonCodeIdx: index("cases_opened_reason_code_idx")
      .on(table.openedReasonCode)
      .where(sql`${table.openedReasonCode} IS NOT NULL`),
    // Structural locality-attribution FK index (migration 0147).
    localityIdIdx: index("cases_locality_id_idx")
      .on(table.localityId)
      .where(sql`${table.localityId} IS NOT NULL`),
    // Performance indexes added in migration 0096.
    applicantUserIdx: index("cases_applicant_user_idx").on(table.applicantUserId),
    welfareReportIdx: index("cases_welfare_report_idx")
      .on(table.welfareReportId)
      .where(sql`${table.welfareReportId} IS NOT NULL`),
    custodyDisputeIdx: index("cases_custody_dispute_idx")
      .on(table.custodyDisputeId)
      .where(sql`${table.custodyDisputeId} IS NOT NULL`),
    // CHECK constraints also declared via ALTER in migration 0033.
    casesSubjectPetConsistency: check(
      "cases_subject_pet_consistency",
      sql`(${table.primarySubjectKind} = 'registered_pet') = (${table.primaryPetId} is not null)`,
    ),
    casesSubjectLocationConsistency: check(
      "cases_subject_location_consistency",
      sql`(${table.primarySubjectKind} = 'location') = (${table.locationLat} is not null and ${table.locationLng} is not null)`,
    ),
    casesMergedConsistency: check(
      "cases_merged_consistency",
      sql`(${table.status} = 'merged') = (${table.supersededByCaseId} is not null and ${table.closedReason} = 'merged')`,
    ),
    casesClosedConsistency: check(
      "cases_closed_consistency",
      sql`(${table.status} in ('closed', 'merged')) = (${table.closedAt} is not null)`,
    ),
    casesOpenedReasonMinLength: check(
      "cases_opened_reason_min_length",
      sql`${table.openedReason} is null or length(${table.openedReason}) >= 10`,
    ),
    // Migration 0149. Makes "code without params" unrepresentable at rest;
    // param-less codes store `{}`, not NULL. Legacy rows are (null, null).
    casesOpenedReasonStructuredPair: check(
      "cases_opened_reason_structured_pair",
      sql`${table.openedReasonCode} is null or ${table.openedReasonParams} is not null`,
    ),
    casesJurisdictionProvinceCanonical: check(
      "cases_jurisdiction_province_canonical",
      sql`${table.jurisdictionProvince} is null or ${table.jurisdictionProvince} in ${CANONICAL_PROVINCE_SQL_LIST}`,
    ),
    casesLocationPairCheck: check(
      "cases_location_pair_check",
      sql`(${table.locationLat} IS NULL) = (${table.locationLng} IS NULL)`,
    ),
  }),
);

export type Case = typeof cases.$inferSelect;
export type NewCase = typeof cases.$inferInsert;

// ============================================================================
// CaseEvents — generic pet-independent timeline for any case kind
// ============================================================================
// pet_events.pet_id is NOT NULL at the DB level, so general-subject cases
// (primarySubjectKind = 'general' | 'location' | 'unowned_animal') cannot use
// pet_events for case-scoped entries. This table fills that gap in a
// domain-agnostic way — outbreak_investigation uses it today; decomiso,
// welfare, and foster pet-less cases can reuse it without a new migration.
// Migration: 0069_case_events.sql.
//
// Entry-type values below are the ones outbreak_investigation uses today.
// The table itself is domain-agnostic; new case kinds add their own types.

export const CASE_EVENT_ENTRY_TYPES = [
  "case_opened",
  "case_escalated",
  "case_closed",
  // Reporter comment — welfare_denuncia: reporter adds a free-text note to their case.
  // entryType is a plain string (not an enum) so this is a non-breaking additive change.
  "reporter_comment",
  // Anonymous finder tip on a custody_dispute case — written from the public
  // credential of a disputed pet (report-dispute-tip.ts). Authority-only:
  // CaseDetailView filters these entries for every non-govt/non-admin viewer
  // (the disputing parties can read the case detail, but must never see tips).
  "finder_tip",
  // Nota de operador (#41, 2026-08-10) — un funcionario o admin asienta texto
  // libre en el expediente desde el detalle genérico de caso. Es la única acción
  // legítima para los DOCE kinds: no toca el estado, no pretende ser una
  // transición, y por eso no depende del ciclo de vida de ninguno.
  //
  // Distinta de `reporter_comment`, que es del denunciante sobre su propia
  // denuncia. Se separan porque el lector necesita saber quién habla: una nota
  // de autoridad y un comentario de particular no pesan igual en un expediente.
  "operator_note",
  // outbreak_investigation entry types
  "classification",
  "lab_result",
  "control_action",
  "contact_tracing",
  "final_report",
  "signal_link",
  "system",
] as const;
export type CaseEventEntryType = (typeof CASE_EVENT_ENTRY_TYPES)[number];

export const caseEvents = pgTable(
  "case_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    caseId: uuid("case_id")
      .notNull()
      .references(() => cases.id, { onDelete: "cascade" }),
    entryType: text("entry_type").notNull(),
    payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
    notes: text("notes"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    caseOccurredIdx: index("case_events_case_id_occurred_idx").on(
      table.caseId,
      table.occurredAt.desc(),
    ),
  }),
);

export type CaseEvent = typeof caseEvents.$inferSelect;
export type NewCaseEvent = typeof caseEvents.$inferInsert;

// ============================================================================
// Physical tag interest — §4.20 placeholder for the future physical-QR-tag
// product. Captures demand signal without building manufacturer / serial /
// `/t/[serial]` chain. One row per (pet, user), toggled by the owner.
// ============================================================================

export const physicalTagInterest = pgTable(
  "physical_tag_interest",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    notes: text("notes"),
  },
  (table) => ({
    petUserUnique: uniqueIndex("physical_tag_interest_pet_user_unique").on(
      table.petId,
      table.userId,
    ),
    petActiveIdx: index("physical_tag_interest_pet_active_idx")
      .on(table.petId)
      .where(sql`${table.cancelledAt} IS NULL`),
    activeCreatedIdx: index("physical_tag_interest_active_created_idx")
      .on(table.createdAt)
      .where(sql`${table.cancelledAt} IS NULL`),
  }),
);

export type PhysicalTagInterest = typeof physicalTagInterest.$inferSelect;
export type NewPhysicalTagInterest = typeof physicalTagInterest.$inferInsert;

// ============================================================================
// Pet achievement views — pulse UX (pet-profile-v2 §3 / B-1)
//
// Tracks when an owner first sees an earned achievement badge. The
// `pulse_until` column provides a 7-day window during which the chip
// animates on the profile. Write-once history (no DELETE policy) via
// markAchievementSeenAction.
// ============================================================================

export const petAchievementViews = pgTable(
  "pet_achievement_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    /** Stable slug from ACHIEVEMENTS_CATALOG. */
    achievementId: text("achievement_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Badge-pulse window — defaults to 7 days from first observation. */
    pulseUntil: timestamp("pulse_until", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
  },
  (table) => ({
    ownerPetAchUnique: uniqueIndex("pet_achievement_views_owner_pet_ach_unique").on(
      table.userId,
      table.petId,
      table.achievementId,
    ),
    userPetIdx: index("pet_achievement_views_user_pet_idx").on(table.userId, table.petId),
  }),
);

export type PetAchievementView = typeof petAchievementViews.$inferSelect;
export type NewPetAchievementView = typeof petAchievementViews.$inferInsert;

// ============================================================================
// Operator "Novedades" feed watermark — viz-suite Wave 1 (migration 0143)
// ============================================================================
// Per-operator high-water mark (transaction-time / recorded_at) for the
// session-start "Novedades" orientation feed on the /gob and /admin homes. One
// row per operator (user_id PK); advanced ONLY by the explicit "Marcar como
// visto" action (never on render). Per-user UI state — NOT an event; the
// append-only pet_events log is never touched by the feed. RLS: owner-only for
// every operation (see migration 0143).

export const operatorFeedWatermarks = pgTable("operator_feed_watermarks", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => profiles.id, { onDelete: "cascade" }),
  /** recorded_at high-water mark: the feed shows pet_events strictly newer than this. */
  lastSeenRecordedAt: timestamp("last_seen_recorded_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OperatorFeedWatermark = typeof operatorFeedWatermarks.$inferSelect;
export type NewOperatorFeedWatermark = typeof operatorFeedWatermarks.$inferInsert;

// ============================================================================
// Operator surface visits — per-user "have you been here" watermark
// (migration 0244, gob-onboarding-checklist T4-O3)
// ============================================================================
// Shared infra note (docs/plans/gob-onboarding-scoping.md): a per-user
// "did they ever visit this surface" fact, generalized beyond the Novedades
// feed's single watermark so the /gob first-run checklist (G1/G2/G4) can read
// the SAME idiom for three different surfaces instead of inventing three
// bespoke tables. One row per (user_id, surface); `first_visited_at` never
// moves once set, `last_seen_at` advances on every visit. Recorded
// automatically on render (unlike operator_feed_watermarks, which only moves
// on an explicit "Marcar como visto" click) — this is a passive "have you
// been here" fact, not an acknowledgeable feed position.
// RLS: owner-only for every operation (see migration 0244) — same posture as
// operator_feed_watermarks, for the same reason (purely personal UI state).

export const userSurfaceVisits = pgTable(
  "user_surface_visits",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    /** Short surface key — "gob_home" | "panorama" | "casos" today. Not an enum: new surfaces are expected to be added without a migration. */
    surface: text("surface").notNull(),
    firstVisitedAt: timestamp("first_visited_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.surface] })],
);

export type UserSurfaceVisit = typeof userSurfaceVisits.$inferSelect;
export type NewUserSurfaceVisit = typeof userSurfaceVisits.$inferInsert;

// ============================================================================
// Event notification outbox — ENO Event-Trust Tier 1, Fase C.1
// ============================================================================
// Durable delivery queue for regulated event notifications (ENO and future
// targets). One row per (source_event, target_kind). Inserted in the SAME
// transaction as the source event for atomicity. Drained every 5 minutes by
// /api/cron/drain-outbox.
//
// Spec: docs/superpowers/plans/2026-05-22-event-trust-tier-1.md §4 C.1
// Decisions C1-C9 closed 2026-05-22.
//
// No RLS: system-only table. Admin access goes through service-role Drizzle.
// ============================================================================

export const outboxTargetKindEnum = pgEnum("outbox_target_kind", [
  "govt_webhook",
  "eno_authority",
  "audit_export",
  "internal_dashboard",
]);

// 'merged' (migration 0247): a legacy duplicate folded into the case record
// named by merged_into_id. Kept for audit, never delivered (not pending), never
// counted as delivered or in the on-time period total.
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "delivered",
  "failed",
  "merged",
]);

export type OutboxTargetKind = (typeof outboxTargetKindEnum.enumValues)[number];
export type OutboxStatus = (typeof outboxStatusEnum.enumValues)[number];

export const eventNotificationOutbox = pgTable(
  "event_notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Source event FK. ON DELETE CASCADE so test teardown cascades naturally.
    sourceEventId: uuid("source_event_id")
      .notNull()
      .references(() => petEvents.id, { onDelete: "cascade" }),

    targetKind: outboxTargetKindEnum("target_kind").notNull(),

    // Jurisdiction snapshot at enqueue time — used for webhook routing in v2.
    targetJurisdictionProvince: text("target_jurisdiction_province"),
    targetJurisdictionLocality: text("target_jurisdiction_locality"),
    // The target place by id, snapshotted at event time (migration 0248).
    targetLocalityId: uuid("target_locality_id").references(() => arLocalities.id, {
      onDelete: "restrict",
    }),
    targetPlaceMethod: text("target_place_method"),

    // Snapshot of the source event payload at enqueue time — decoupled from
    // the live event row so the drainer never needs to re-join pet_events.
    payloadSnapshot: jsonb("payload_snapshot").notNull().default(sql`'{}'::jsonb`),

    // Legal SLA deadline. Computed as now() + slaHours at enqueue time.
    slaDueAt: timestamp("sla_due_at", { withTimezone: true }).notNull(),

    // Delivery lifecycle.
    status: outboxStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    lastError: text("last_error"),
    // Initial value is now() so the drainer picks up the row immediately.
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

    // ONE RECORD PER CASE (migration 0247, PO 2026-09-25: "A Case may not be
    // duplicated"). The case this row notifies, when a rule can name one
    // (lib/events/event-outbox-rules.ts `caseKey`) — today only rabies, keyed
    // per animal. NULL = a row with no case identity (every other rule), which
    // keeps the old one-row-per-event behaviour.
    enoCaseKey: text("eno_case_key"),
    // Every LATER source event that belongs to the same case, appended by the
    // second writer instead of a second row: { source_event_id, event_type,
    // linked_at, payload_snapshot, previous_status, previous_delivered_at }.
    // Append-only by construction (the enqueue only ever concatenates).
    linkedSources: jsonb("linked_sources").notNull().default(sql`'[]'::jsonb`),
    // Set only on a row the legacy backfill folded into a case record
    // (status 'merged'): the record that now carries its content.
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => eventNotificationOutbox.id, {
      onDelete: "set null",
    }),
  },
  (table) => ({
    // The DB-level guarantee behind enoCaseKey: two writers racing for one
    // case cannot both insert (the enqueue's ON CONFLICT targets this index).
    enoCaseUnique: uniqueIndex("outbox_eno_case_unique")
      .on(table.targetKind, table.enoCaseKey)
      .where(sql`${table.enoCaseKey} IS NOT NULL`),
    // Drainer: pending rows due for processing.
    drainableIdx: index("outbox_drainable_idx")
      .on(table.nextRetryAt)
      .where(sql`${table.status} = 'pending'`),
    // SLA monitoring: rows approaching or past their legal deadline.
    slaDueIdx: index("outbox_sla_due_idx").on(table.slaDueAt, table.status),
    // Admin UI reverse-lookup from source event.
    sourceEventIdx: index("outbox_source_event_idx").on(table.sourceEventId),
  }),
);

export type EventNotificationOutbox = typeof eventNotificationOutbox.$inferSelect;
export type NewEventNotificationOutbox = typeof eventNotificationOutbox.$inferInsert;

// ============================================================================
// Pet transfers (owner → owner) — handoff P3-2
// ============================================================================
// Owner-to-owner handshake for pet custody transfer. Created by the current
// owner, accepted/rejected by the recipient. Expires 7 days after creation
// via /api/cron/expire-pet-transfers.
//
// to_owner_id is nullable until the recipient signs up + accepts. Lookup at
// accept-time goes through to_owner_email → auth.users.email.

export const PET_TRANSFER_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type PetTransferStatus = (typeof PET_TRANSFER_STATUSES)[number];

export const PET_TRANSFER_REASONS = ["sale", "gift", "inheritance", "other"] as const;
export type PetTransferReason = (typeof PET_TRANSFER_REASONS)[number];

export const petTransfers = pgTable(
  "pet_transfers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicToken: text("public_token").notNull().unique(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    fromOwnerId: uuid("from_owner_id")
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    toOwnerId: uuid("to_owner_id").references(() => profiles.id, { onDelete: "set null" }),
    toOwnerEmail: text("to_owner_email").notNull(),
    status: text("status").notNull().default("pending").$type<PetTransferStatus>(),
    reason: text("reason").$type<PetTransferReason | null>(),
    note: text("note"),
    initiatedAt: timestamp("initiated_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petTransfersStatusValid: check(
      "pet_transfers_status_valid",
      sql`${table.status} in ('pending','accepted','rejected','expired','cancelled')`,
    ),
    petTransfersReasonValid: check(
      "pet_transfers_reason_valid",
      sql`${table.reason} is null or ${table.reason} in ('sale','gift','inheritance','other')`,
    ),
    petTransfersExpiryAfterInit: check(
      "pet_transfers_expiry_after_init",
      sql`${table.expiresAt} > ${table.initiatedAt}`,
    ),
    // At most one pending transfer per pet — concurrent transfers would race
    // on ownership transition. Partial unique index, not a CHECK, so closed
    // transfers (accepted/rejected/expired/cancelled) don't block re-tries.
    onePendingPerPet: uniqueIndex("pet_transfers_one_pending_per_pet")
      .on(table.petId)
      .where(sql`status = 'pending'`),
    fromOwnerIdx: index("pet_transfers_from_owner_idx").on(table.fromOwnerId),
    toOwnerIdx: index("pet_transfers_to_owner_idx").on(table.toOwnerId),
    toEmailIdx: index("pet_transfers_to_email_idx").on(table.toOwnerEmail),
    statusIdx: index("pet_transfers_status_idx").on(table.status, table.expiresAt),
  }),
);

export type PetTransfer = typeof petTransfers.$inferSelect;
export type NewPetTransfer = typeof petTransfers.$inferInsert;

// ============================================================================
// Pet identifications — polymorphic identifier table (compliance PR 0)
// ============================================================================
// Replaces the parallel-column shape on `pets` (microchip_id, tattoo_*).
// Legacy columns stay this sprint; migration 0057 drops them. The compat
// view `pets_with_identifiers` exposes the canonical values alongside the
// legacy ones during the transition.
//
// Why polymorphic: chip replacement needs history; new identifier kinds
// (RFID, anillo, genoprint) shouldn't demand 5+ new columns each; SENASA's
// ISO 11784/11785 contract has structured subfields (country / manufacturer
// / national_id) worth first-class storage.

export const identificationKindEnum = pgEnum("identification_kind", [
  "microchip_iso",
  "tattoo",
  "collar_tag",
  "photo_biometric",
]);

export const identificationStatusEnum = pgEnum("identification_status", [
  "active",
  "replaced",
  "removed",
  "unreadable",
]);

export type IdentificationKind = (typeof identificationKindEnum.enumValues)[number];
export type IdentificationStatus = (typeof identificationStatusEnum.enumValues)[number];

export const petIdentifications = pgTable(
  "pet_identifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    petId: uuid("pet_id")
      .notNull()
      .references(() => pets.id, { onDelete: "cascade" }),
    kind: identificationKindEnum("kind").notNull(),
    status: identificationStatusEnum("status").notNull().default("active"),
    code: text("code"),
    // NULLABLE since migration 0161: "when the identification was MADE", and
    // the spine models genuinely-unknown (tattoo_date_known=false). NOT NULL
    // forced writers to invent a date, and the seed invented the event's own
    // date — which the credential then showed as the tattoo's.
    recordedAt: date("recorded_at"),
    recordedByUserId: uuid("recorded_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    recordedByLabel: text("recorded_by_label"),
    photoId: uuid("photo_id"),
    isoCountryCode: char("iso_country_code", { length: 3 }),
    isoManufacturerCode: char("iso_manufacturer_code", { length: 4 }),
    isoNationalId: char("iso_national_id", { length: 8 }),
    isoCompliant: boolean("iso_compliant"),
    implantationSite: text("implantation_site"),
    tattooLocation: text("tattoo_location"),
    tattooDescription: text("tattoo_description"),
    replacedById: uuid("replaced_by_id").references((): AnyPgColumn => petIdentifications.id, {
      onDelete: "set null",
    }),
    replacementReason: text("replacement_reason"),
    // PII baseline (compliance PR 1, migration 0058).
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => profiles.id, { onDelete: "set null" }),
    purpose: dataPurposeEnum("purpose"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    petIdx: index("pet_identifications_pet_idx").on(table.petId),
    codeIdx: index("pet_identifications_code_idx")
      .on(table.kind, table.code)
      .where(sql`${table.code} IS NOT NULL AND ${table.status} = 'active'`),
    chipUnique: uniqueIndex("pet_identifications_chip_unique")
      .on(table.code)
      .where(sql`${table.kind} = 'microchip_iso' AND ${table.status} = 'active'`),
    chipRequiresIsoFields: check(
      "chip_requires_iso_fields",
      sql`${table.kind} <> 'microchip_iso' OR (${table.code} IS NOT NULL AND length(${table.code}) = 15)`,
    ),
    tattooLocationValid: check(
      "tattoo_location_valid",
      sql`${table.tattooLocation} IS NULL OR ${table.tattooLocation} IN ('inner_ear_left','inner_ear_right','inner_thigh','belly','other')`,
    ),
    implantationSiteValid: check(
      "implantation_site_valid",
      sql`${table.implantationSite} IS NULL OR ${table.implantationSite} IN ('lateral_cuello_izq','lateral_cuello_der','interescapular','otro')`,
    ),
    replacementReasonValid: check(
      "replacement_reason_valid",
      sql`${table.replacementReason} IS NULL OR ${table.replacementReason} IN ('damaged','migrated','illegible','medical','other')`,
    ),
    // Renamed from public_pet_identifications_deleted_idx → pet_identifications_deleted_idx (migration 0095).
    petIdentificationsDeletedIdx: index("pet_identifications_deleted_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
  }),
);

export type PetIdentification = typeof petIdentifications.$inferSelect;
export type NewPetIdentification = typeof petIdentifications.$inferInsert;

// ============================================================================
// Pet tags — physical tag (chapa) lifecycle (migration 0169)
// ============================================================================
// One row per manufactured tag. Serial `TAG-XXXX-XXXX` printed as QR; the
// wrapper-printed activation code is stored ONLY as a peppered HMAC hash
// (lib/utils/tag-code-hash.ts) — the plaintext code exists only in the admin
// issuance CSV response and is NEVER persisted or SELECTed back by app code.
//
// State machine (one-way, CHECK-enforced): unactivated -> active -> revoked.
// `revoked` is terminal (no reuse). A blank tag has no pet_id so it cannot be
// revoked (the tag_revoked spine event needs a pet — design D4). Custody
// transfer never touches this table: the tag stays active on the same pet.

export const PET_TAG_REVOKE_REASONS = [
  "lost",
  "damaged",
  "transfer",
  "fraud",
  "owner_request",
  "other",
] as const;
export type PetTagRevokeReason = (typeof PET_TAG_REVOKE_REASONS)[number];

export type PetTagStatus = "unactivated" | "active" | "revoked";

export const petTags = pgTable(
  "pet_tags",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    serial: text("serial").notNull(),
    // HMAC-SHA256 hex. Never SELECTed by app code — the evidence gate compares
    // inside a SQL predicate (lib/infra/tag-lookup.ts, chip-lookup.ts shape).
    activationCodeHash: text("activation_code_hash").notNull(),
    status: text("status").notNull().default("unactivated").$type<PetTagStatus>(),
    loteId: text("lote_id"),
    petId: uuid("pet_id").references(() => pets.id),
    activatedByUserId: uuid("activated_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    revokedByUserId: uuid("revoked_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason").$type<PetTagRevokeReason | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // PII baseline (pii.apply_baseline in migration 0169).
    createdBy: uuid("created_by").references(() => profiles.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => profiles.id, { onDelete: "set null" }),
    purpose: dataPurposeEnum("purpose"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    retentionUntil: timestamp("retention_until", { withTimezone: true }),
  },
  (table) => ({
    serialUnique: uniqueIndex("pet_tags_serial_unique").on(table.serial),
    petIdx: index("pet_tags_pet_idx").on(table.petId).where(sql`${table.petId} IS NOT NULL`),
    loteIdx: index("pet_tags_lote_idx").on(table.loteId).where(sql`${table.loteId} IS NOT NULL`),
    statusValid: check(
      "pet_tags_status_valid",
      sql`${table.status} IN ('unactivated','active','revoked')`,
    ),
    revokedReasonValid: check(
      "pet_tags_revoked_reason_valid",
      sql`${table.revokedReason} IS NULL OR ${table.revokedReason} IN ('lost','damaged','transfer','fraud','owner_request','other')`,
    ),
    stateMachine: check(
      "pet_tags_state_machine",
      sql`(${table.status} = 'unactivated' AND ${table.petId} IS NULL AND ${table.activatedAt} IS NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'active' AND ${table.petId} IS NOT NULL AND ${table.activatedAt} IS NOT NULL AND ${table.revokedAt} IS NULL)
        OR (${table.status} = 'revoked' AND ${table.petId} IS NOT NULL AND ${table.activatedAt} IS NOT NULL AND ${table.revokedAt} IS NOT NULL AND ${table.revokedReason} IS NOT NULL)`,
    ),
  }),
);

export type PetTag = typeof petTags.$inferSelect;
export type NewPetTag = typeof petTags.$inferInsert;

// ============================================================================
// SENASA reference vocabularies (compliance PR 3, migration 0060)
// ============================================================================
// Tablas semi-estáticas en schema `ref.*` referenciadas por pet_events
// (tipo_evento_code, via_aplicacion_code, vet_jurisdiccion_code) y por
// pet_identifications.kind ↔ norma. Sembradas en la migración; el app code
// las lee sólo (no las muta) por lo que la tabla `ref.*` queda fuera del
// flujo append-only de pet_events.

export const refSchema = pgSchema("ref");

export const refTipoEventoSanitario = refSchema.table("tipo_evento_sanitario", {
  code: text("code").primaryKey(),
  labelEs: text("label_es").notNull(),
  normaOrigen: text("norma_origen").notNull(),
  requiereLote: boolean("requiere_lote").notNull().default(false),
  requiereVia: boolean("requiere_via").notNull().default(false),
  notificableEno: boolean("notificable_eno").notNull().default(false),
});

export const refViaAplicacion = refSchema.table("via_aplicacion", {
  code: text("code").primaryKey(),
  labelEs: text("label_es").notNull(),
});

export const refJurisdiccionSanitaria = refSchema.table("jurisdiccion_sanitaria", {
  code: text("code").primaryKey(),
  labelEs: text("label_es").notNull(),
  colegioVeterinario: text("colegio_veterinario"),
});

export const refIdentificationKindNorma = refSchema.table("identification_kind_norma", {
  kind: identificationKindEnum("kind").primaryKey(),
  normaOrigen: text("norma_origen").notNull(),
  estandarTecnico: text("estandar_tecnico"),
});

export type RefTipoEventoSanitario = typeof refTipoEventoSanitario.$inferSelect;
export type RefViaAplicacion = typeof refViaAplicacion.$inferSelect;
export type RefJurisdiccionSanitaria = typeof refJurisdiccionSanitaria.$inferSelect;
export type RefIdentificationKindNorma = typeof refIdentificationKindNorma.$inferSelect;

// ============================================================================
// jurisdictions_census — INDEC Censo 2022 province-level population totals
// ============================================================================
// Static reference table for official Argentine census populations.
// Keyed by province_name (canonical display name) so it joins directly
// with jurisdiction_province on pets, cases, welfare_reports, etc.
// See lib/jurisdiction-canonical.ts for the canonical name list.
//
// Migration 0067_jurisdictions_census.sql seeds the 24 INDEC 2022 rows.
// Source: INDEC, Censo Nacional de Población, Hogares y Viviendas 2022
// https://www.indec.gob.ar/indec/web/Nivel4-Tema-2-41-165

export const jurisdictionsCensus = pgTable("jurisdictions_census", {
  /** Canonical province display name — same value as jurisdiction_province on pets/cases/welfare_reports. */
  provinceName: text("province_name").primaryKey(),
  /** Total provincial population per official census release. */
  population: integer("population").notNull(),
  /** Four-digit census year (e.g. 2022). */
  censusYear: smallint("census_year").notNull(),
  /** Human-readable source citation. */
  source: text("source").notNull(),
});

export type JurisdictionCensus = typeof jurisdictionsCensus.$inferSelect;
export type NewJurisdictionCensus = typeof jurisdictionsCensus.$inferInsert;

// ============================================================================
// Organization invitations — link-based member invite flow (migration 0071)
// ============================================================================
// Invite is email-tied: acceptance requires the logged-in user's email to match
// the invitation email exactly (case-insensitive). Role is fixed at invite time
// and bounded by the inviter's role rank. Foster is excluded (comes via the
// foster-proposal flow). Delivery is a shareable link; no email in this slice.
//
// Duplicate prevention: partial unique index on (organization_id, lower(email))
// WHERE accepted_at IS NULL AND revoked_at IS NULL. Re-invite is allowed once
// the previous invite is accepted/revoked/expired.

export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    invitedRole: organizationMembershipRoleEnum("invited_role").notNull(),
    canWritePetEvents: boolean("can_write_pet_events").notNull().default(false),
    invitedByUserId: uuid("invited_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    invitationToken: text("invitation_token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '14 days'`),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: uuid("accepted_by_user_id").references(() => profiles.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgIdx: index("org_invitations_org_id_idx").on(table.organizationId),
    // Note: org_invitations_token_idx (non-unique on invitation_token) was dropped
    // in migration 0095 — it is fully covered by the UNIQUE constraint on invitation_token.
    emailIdx: index("org_invitations_email_idx").on(table.email),
    // Partial unique index — exactly one active invite per (org, lower(email)).
    // Mirrors the SQL: CREATE UNIQUE INDEX … WHERE accepted_at IS NULL AND revoked_at IS NULL.
    activeUnique: uniqueIndex("org_invitations_active_unique")
      .on(table.organizationId, sql`lower(${table.email})`)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
  }),
);

export type OrganizationInvitation = typeof organizationInvitations.$inferSelect;
export type NewOrganizationInvitation = typeof organizationInvitations.$inferInsert;
