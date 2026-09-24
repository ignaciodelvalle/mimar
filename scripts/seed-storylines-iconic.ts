/**
 * Iconic-Pet Storylines Seed Script — Workflow Test Fixtures
 *
 * Source bios:        dim-interno:docs/archive/historia otras mascotas.txt
 * Narrative companion: dim-interno:docs/test-storylines-iconic.md
 *
 * Five real / iconic pets relocated to Argentina, designed as workflow
 * stressors for MiMAR/DIM:
 *
 *   1. Laika              — DIM-LAIK-0015 — Liniers CABA → Bariloche → Falda del Carmen
 *   2. Hachikō            — DIM-HACH-0016 — Caballito / Estación Retiro
 *      2b. Hachiko Ni Sei — DIM-HCN2-0016B (replacement to Yaeko Ueno)
 *   3. Pal (Lassie)       — DIM-PAL2-0017 — Tandil → Saavedra
 *   4. Terry (Toto)       — DIM-TRRY-0018 — Olivos → Saavedra
 *   5. Kabosu             — DIM-KABO-0019 — Salta → Belgrano R
 *      5b. Hanako         — DIM-HNKO-0019B (replacement to Atsuko Sato)
 *
 * Rules baked in:
 *   - No microchips for the four pre-2005 pets; only Kabosu and Hanako chipped.
 *   - Full disposition cycle on death (Ley CABA 5470).
 *   - NO RESURRECTION. Replacement pets are separate pet_registered rows under
 *     a canon-friend name, applied only where canon supports it (so Hachikō
 *     and Kabosu, not Laika or the franchise dogs).
 *   - All locations are real Argentine localities or iconic landmarks.
 *   - Every `event_type` string is checked against `EVENT_TYPES` from
 *     `db/schema.ts` via the `EventType` type — typos won't compile.
 *
 * Run with:    pnpm tsx scripts/seed-storylines-iconic.ts --stats
 */

import type { EventType } from "../db/schema";

// ===========================================================================
// Type shapes
// ===========================================================================

export type Species = "dog" | "cat" | "rabbit" | "guinea_pig" | "ferret" | "other";
export type Sex = "male" | "female" | "unknown";
export type PetStatus = "active" | "lost" | "deceased";

export type AuthorRole = "owner" | "vet" | "govt" | "admin" | "system" | "shelter";

export interface PetBio {
  display_name: string;
  public_token: string;
  species: Species;
  breed?: string;
  sex: Sex;
  date_of_birth?: string;
  birth_date_is_estimated?: boolean;
  color?: string;
  distinguishing_features?: string;
  microchip_id?: string;
  microchip_country_code?: string;
  microchip_implanted_at?: string;
  microchip_implanted_by?: string;
  microchip_location?: string;
  estimated_weight_kg?: number;
  favourite_foods?: string[];
  known_allergies?: string[];
  training_level?: "none" | "basic" | "intermediate" | "advanced";
  potentially_dangerous_breed: boolean;
  insurance_company?: string;
  insurance_policy_number?: string;
  jurisdiction_country: string;
  jurisdiction_province?: string;
  jurisdiction_locality?: string;
  acquisition_method?:
    | "adopted"
    | "rescued"
    | "purchased"
    | "bred"
    | "gift"
    | "unknown"
    | "found_stray";
  emergency_info_visible?: boolean;
  status: PetStatus;
  /** Legacy iconic-storyline field — free-text owner description. */
  owner_of_record?: string;
  /** Newer storyline modules: keyed owner reference ("ignacio" / "org:...") */
  owner?: string;
  /** Photo file in scripts/assets/pet-photos/. Uploaded to Supabase Storage on seed run. */
  photo_file?: string;
  notes?: string;
}

export interface PetEvent {
  date: string;
  event_type: EventType;
  location?: { locality?: string; province?: string; landmark?: string };
  payload?: Record<string, unknown>;
  author_role?: AuthorRole;
  uncommon?: true;
  notes?: string;
}

export interface Storyline {
  pet: PetBio;
  events: PetEvent[];
}

// ---------------------------------------------------------------------------
// Helpers for compactness
// ---------------------------------------------------------------------------

const CABA = (locality: string, landmark?: string) => ({
  locality,
  province: "CABA",
  ...(landmark ? { landmark } : {}),
});
const BA = (locality: string, landmark?: string) => ({
  locality,
  province: "Buenos Aires",
  ...(landmark ? { landmark } : {}),
});

// ===========================================================================
// 1. Laika
// ===========================================================================

const laika: Storyline = {
  pet: {
    display_name: "Laika",
    public_token: "DIM-LAIK-0015",
    species: "dog",
    breed: "Mestiza tipo husky/spitz",
    sex: "female",
    date_of_birth: "1954-09-15",
    estimated_weight_kg: 6.0,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "Córdoba",
    jurisdiction_locality: "Falda del Carmen",
    status: "deceased",
    owner_of_record: "Vladimir Yazdovsky (INVAP-Bariloche)",
    acquisition_method: "rescued",
    notes:
      "Aliases: Kudryavka → Zhuchka → Limónchik → Laika. No microchip (predates technology). Dies in orbit aboard Sputnik 2; no body recoverable.",
  },
  events: [
    {
      date: "1957-03-20",
      event_type: "shelter_intake_recorded",
      location: CABA("Liniers"),
      payload: {
        intake_reason: "stray_found",
        intake_condition: "emaciated",
        org: "Refugio Patitas Federales",
      },
      uncommon: true,
    },
    {
      date: "1957-03-20",
      event_type: "pet_registered",
      location: CABA("Liniers"),
      payload: { name: "Kudryavka", acquisition_method: "rescued" },
    },
    {
      date: "1957-03-22",
      event_type: "vet_visit_logged",
      location: CABA("Liniers"),
      payload: { reason: "intake_exam", body_condition_score: 2 },
    },
    {
      date: "1957-03-25",
      event_type: "deworming_administered",
      location: CABA("Liniers"),
      payload: { product: "vermífugo amplio espectro", type: "internal" },
    },
    {
      date: "1957-04-01",
      event_type: "weight_recorded",
      location: CABA("Liniers"),
      payload: { kg: 5.4 },
    },
    {
      date: "1957-04-08",
      event_type: "vaccination_administered",
      location: CABA("Liniers"),
      payload: { vaccine_name: "antirrábica" },
    },
    {
      date: "1957-04-20",
      event_type: "custody_transfer_proposed",
      location: CABA("Liniers"),
      payload: {
        from_organization_id: "Refugio Patitas Federales",
        to_user_id: "V. Yazdovsky",
        reason: "investigación aeroespacial",
      },
      uncommon: true,
    },
    {
      date: "1957-04-25",
      event_type: "custody_transferred",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        from_organization_id: "Refugio Patitas Federales",
        to_user_id: "V. Yazdovsky",
        from_role: "shelter_custody",
        to_role: "owner",
      },
      uncommon: true,
    },
    {
      date: "1957-04-26",
      event_type: "pet_profile_updated",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { changes: [{ field: "name", old: "Kudryavka", new: "Zhuchka" }] },
      uncommon: true,
    },
    {
      date: "1957-05-10",
      event_type: "pet_profile_updated",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { changes: [{ field: "name", old: "Zhuchka", new: "Limónchik" }] },
      uncommon: true,
    },
    {
      date: "1957-05-22",
      event_type: "pet_profile_updated",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { changes: [{ field: "name", old: "Limónchik", new: "Laika" }] },
      uncommon: true,
    },
    {
      date: "1957-06-01",
      event_type: "clinical_info_logged",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { sub_kind: "other", title: "baseline cardiopulmonar pre-entrenamiento" },
    },
    {
      date: "1957-06-15",
      event_type: "clinical_info_logged",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        sub_kind: "lab_work",
        title: "bioquímica basal",
        details: "CK elevada por estrés muscular",
      },
      uncommon: true,
    },
    {
      date: "1957-06-22",
      event_type: "symptom_observed",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        source: "libreta",
        reporter_role: "vet",
        free_text: "taquicardia post-sesión de centrífuga",
        matched_symptom_codes: ["tachycardia"],
        alerted_disease_codes: [],
      },
    },
    {
      date: "1957-07-04",
      event_type: "symptom_observed",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        source: "libreta",
        reporter_role: "vet",
        free_text: "conductas compulsivas (caminata circular en jaula)",
        matched_symptom_codes: ["stereotypy"],
        alerted_disease_codes: [],
      },
      uncommon: true,
    },
    {
      date: "1957-07-15",
      event_type: "medication_started",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        drug_name: "sedante leve",
        dose: "0.5 mg/kg",
        frequency: "pre-training",
        first_dose_at: "1957-07-15",
        schedule_count: 30,
      },
    },
    {
      date: "1957-07-20",
      event_type: "weight_recorded",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { kg: 5.7 },
    },
    {
      date: "1957-08-04",
      event_type: "maltreatment_reported",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        reporter_role: "vet",
        description: "Confinamiento prolongado en cápsula de entrenamiento; estrés crónico",
        severity: "alta",
        kind: "confinamiento",
      },
      uncommon: true,
    },
    {
      date: "1957-08-15",
      event_type: "note_added",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        category: "observación interna",
        text: "Laika es excepcionalmente dócil. Eso la condena. — V. Yazdovsky.",
      },
      uncommon: true,
    },
    {
      date: "1957-08-22",
      event_type: "incident_reported",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        incident_type: "other",
        severity: "moderada",
        injuries_summary: "Síncope durante simulación de aceleración 7G",
      },
    },
    {
      date: "1957-09-01",
      event_type: "medication_stopped",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { reason: "Interfería con respuestas medibles" },
    },
    {
      date: "1957-09-15",
      event_type: "clinical_info_logged",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { sub_kind: "imaging", title: "Rx torácica pre-vuelo" },
    },
    {
      date: "1957-09-30",
      event_type: "vet_visit_logged",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { reason: "pre-mission" },
    },
    {
      date: "1957-10-10",
      event_type: "pet_profile_updated",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { photo_replaced: true },
    },
    {
      date: "1957-10-15",
      event_type: "weight_recorded",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { kg: 6.0 },
    },
    {
      date: "1957-10-20",
      event_type: "note_added",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        category: "trivia",
        text: "Yazdovsky llevó a Laika a casa, la presentó a sus hijos. 'Quería darle algo bueno antes.'",
      },
      uncommon: true,
    },
    {
      date: "1957-10-28",
      event_type: "vaccination_administered",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { vaccine_name: "antirrábica" },
    },
    {
      date: "1957-11-01",
      event_type: "clinical_info_logged",
      location: { locality: "Falda del Carmen", province: "Córdoba" },
      payload: {
        sub_kind: "other",
        title: "Briefing pre-órbita",
        details: "Documentación interna admite que la misión no contempla reentrada segura",
      },
      uncommon: true,
    },
    {
      date: "1957-11-02",
      event_type: "note_added",
      location: { locality: "Falda del Carmen", province: "Córdoba" },
      payload: {
        category: "posthumous_intercalated",
        text: "Pedí perdón. Le pedí perdón. — V. Yazdovsky",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1957-11-03",
      event_type: "status_changed",
      location: { landmark: "Órbita terrestre baja, Sputnik 2" },
      payload: {
        from_status: "active",
        to_status: "lost",
        location_description: "órbita terrestre baja, Sputnik 2",
        reason: "lanzamiento espacial",
      },
      uncommon: true,
    },
    {
      date: "1957-11-03",
      event_type: "incident_reported",
      location: {
        locality: "Falda del Carmen",
        province: "Córdoba",
        landmark: "Centro Espacial Teófilo Tabanera",
      },
      payload: {
        incident_type: "other",
        severity: "fatal",
        injuries_summary:
          "Lanzamiento Sputnik 2 con perro a bordo, sin tecnología de reentrada segura",
      },
      uncommon: true,
    },
    {
      date: "1957-11-03",
      event_type: "symptom_observed",
      location: { landmark: "Órbita Sputnik 2" },
      payload: {
        source: "welfare_report",
        reporter_role: "vet",
        free_text: "telemetría: taquicardia extrema ~240 bpm",
        matched_symptom_codes: ["tachycardia_extreme"],
        alerted_disease_codes: ["stress_cardiomyopathy"],
      },
      uncommon: true,
    },
    {
      date: "1957-11-03",
      event_type: "symptom_observed",
      location: { landmark: "Órbita Sputnik 2" },
      payload: {
        source: "welfare_report",
        reporter_role: "vet",
        free_text: "falla térmica del compartimento; temperatura interna >40 °C",
        matched_symptom_codes: ["hyperthermia"],
        alerted_disease_codes: ["thermal_failure"],
      },
      uncommon: true,
    },
    {
      date: "1957-11-03",
      event_type: "death_recorded",
      location: { landmark: "Órbita Sputnik 2 (~5–7 h post-lanzamiento)" },
      payload: {
        cause: "other",
        cause_detail: "sobrecalentamiento por falla del control térmico del compartimento orbital",
        confirmed_by_vet: false,
        vet_name: null,
        disposition_method: "unknown",
        facility: "Sputnik 2 (incinerado al reingreso atmosférico, 1958-04-14)",
        death_at_clinic: false,
        vet_contacted_owner: "not_applicable",
        vet_decided_alone: null,
        is_reportable: true,
        disease_code: null,
      },
      uncommon: true,
    },
    {
      date: "1957-11-04",
      event_type: "note_added",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: {
        category: "comunicado_oficial",
        text: "Laika sobrevivió 7 días en órbita en condiciones normales. (Reconocido como falso 45 años después.)",
      },
      uncommon: true,
    },
    {
      date: "1957-11-04",
      event_type: "pet_profile_updated",
      location: { locality: "Bariloche", province: "Río Negro" },
      payload: { changes: [{ field: "status", old: "lost", new: "deceased" }] },
    },
    {
      date: "1958-04-14",
      event_type: "incident_reported",
      location: { landmark: "Reingreso atmosférico" },
      payload: {
        incident_type: "other",
        severity: "n/a",
        injuries_summary:
          "Reingreso y desintegración de Sputnik 2 con restos de Laika. Closure record",
      },
    },
    {
      date: "1993-09-22",
      event_type: "note_added",
      location: { locality: "Falda del Carmen", province: "Córdoba" },
      payload: {
        category: "posthumous",
        text: "Cuanto más tiempo pasa, más lo lamento. — Oleg Gazenko, científico",
        author: "O. Gazenko",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "2008-04-11",
      event_type: "note_added",
      location: { locality: "Falda del Carmen", province: "Córdoba" },
      payload: { category: "posthumous_event", text: "Monumento develado en Centro Tabanera." },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "2014-11-03",
      event_type: "note_added",
      payload: {
        category: "system",
        text: "Libreta compartida — libro de investigación 'Laika nunca volvió'",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "2017-11-03",
      event_type: "note_added",
      payload: { category: "aniversario", text: "60° aniversario del lanzamiento." },
      author_role: "system",
    },
    {
      date: "2022-05-15",
      event_type: "outbreak_signal",
      location: { locality: "Falda del Carmen", province: "Córdoba" },
      payload: {
        source_symptom_event_id: "sym-laika-1957-11-03",
        disease_code: "ZOO_TRAUMA_ORBITAL",
        disease_label: "Stress cardiomyopathy (orbital)",
        match_strength: {
          high_count: 1,
          medium_count: 0,
          low_count: 0,
          matched_symptom_codes: ["tachycardia_extreme", "hyperthermia"],
        },
        pet_jurisdiction_country: "AR",
        pet_jurisdiction_province: "Córdoba",
        pet_jurisdiction_locality: "Falda del Carmen",
        pet_species: "dog",
      },
      author_role: "system",
      uncommon: true,
      notes: "False positive on a long-deceased pet. Closed by admin.",
    },
    {
      date: "2023-11-03",
      event_type: "note_added",
      payload: { category: "aniversario", text: "66° aniversario." },
      author_role: "system",
    },
  ],
};

// ===========================================================================
// 2. Hachikō
// ===========================================================================

const hachiko: Storyline = {
  pet: {
    display_name: "Hachikō",
    public_token: "DIM-HACH-0016",
    species: "dog",
    breed: "Akita Inu",
    sex: "male",
    date_of_birth: "1923-11-10",
    estimated_weight_kg: 41.0,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Caballito",
    status: "deceased",
    owner_of_record: "Hidesaburō Ueno (deceased 1925); Kikuzaburō Kobayashi (1925-2025+)",
    acquisition_method: "gift",
    notes:
      "Gift from Tandil estancia. Recurring lost-found loop at Estación Retiro for ~9 years after owner's sudden death. Replacement registered to Yaeko Ueno as Hachiko Ni Sei.",
  },
  events: [
    {
      date: "1923-11-10",
      event_type: "pet_registered",
      location: BA("Tandil", "Estancia La Rinconada"),
      payload: { acquisition_method: "bred" },
    },
    {
      date: "1924-01-14",
      event_type: "custody_transferred",
      location: CABA("Caballito", "Av. Pedro Goyena 1300"),
      payload: {
        from_user_id: "Estancia La Rinconada",
        to_user_id: "H. Ueno",
        from_role: "owner",
        to_role: "owner",
        reason: "regalo",
      },
      uncommon: true,
    },
    {
      date: "1924-01-15",
      event_type: "vet_visit_logged",
      location: CABA("Caballito"),
      payload: { reason: "intake_exam" },
    },
    {
      date: "1924-02-01",
      event_type: "vaccination_administered",
      location: CABA("Caballito"),
      payload: { vaccine_name: "moquillo + parvovirus (baseline)" },
    },
    {
      date: "1924-03-15",
      event_type: "deworming_administered",
      location: CABA("Caballito"),
      payload: { product: "vermífugo", type: "internal" },
    },
    {
      date: "1924-05-22",
      event_type: "note_added",
      location: CABA("Caballito"),
      payload: {
        category: "rutina",
        text: "Hachikō acompaña al profesor cada mañana a Estación Retiro y vuelve a esperarlo cada tarde.",
      },
      uncommon: true,
    },
    {
      date: "1924-07-04",
      event_type: "weight_recorded",
      location: CABA("Caballito"),
      payload: { kg: 14.0 },
    },
    {
      date: "1924-09-09",
      event_type: "vaccination_administered",
      location: CABA("Caballito"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1925-02-15",
      event_type: "weight_recorded",
      location: CABA("Caballito"),
      payload: { kg: 28.0 },
    },
    {
      date: "1925-05-21",
      event_type: "incident_reported",
      location: CABA("Caballito", "UBA-Filo, Puan 480"),
      payload: {
        incident_type: "other",
        severity: "fatal_to_owner",
        injuries_summary: "Owner H. Ueno muere de hemorragia cerebral durante una clase",
      },
      uncommon: true,
    },
    {
      date: "1925-05-21",
      event_type: "custody_dispute_raised",
      location: CABA("Caballito"),
      payload: {
        raised_by_role: "govt",
        raised_by_user_id: "govt-caba-caballito",
        reason: "Owner deceased; sucesión pendiente",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "1925-05-21",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro, andén 1"),
      payload: {
        from_status: "active",
        to_status: "lost",
        location_description: "Estación Retiro, andén 1",
        reason: "owner_did_not_return",
      },
      uncommon: true,
    },
    {
      date: "1925-05-22",
      event_type: "credential_scanned",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "Jefe de estación",
      },
    },
    {
      date: "1925-05-23",
      event_type: "status_changed",
      location: CABA("Caballito"),
      payload: { from_status: "lost", to_status: "active", reason: "returned_to_widow" },
    },
    {
      date: "1925-06-01",
      event_type: "custody_transfer_proposed",
      location: CABA("Caballito"),
      payload: {
        from_user_id: "Yaeko Ueno",
        to_user_id: "K. Kobayashi",
        reason: "Viuda no puede conservarlo por luto",
      },
      uncommon: true,
    },
    {
      date: "1925-06-05",
      event_type: "custody_transferred",
      location: CABA("Boedo", "Av. Boedo 1500"),
      payload: {
        from_user_id: "Yaeko Ueno",
        to_user_id: "K. Kobayashi",
        from_role: "owner",
        to_role: "owner",
      },
    },
    {
      date: "1925-06-05",
      event_type: "custody_dispute_resolved",
      location: CABA("Boedo"),
      payload: {
        raised_event_id: "evt-hachiko-dispute-1925-05-21",
        resolved_by_role: "govt",
        outcome: "ownership_transferred",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "1925-06-15",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        from_status: "active",
        to_status: "lost",
        reason: "escaped_to_station_waiting_for_owner",
      },
      uncommon: true,
    },
    {
      date: "1925-06-15",
      event_type: "credential_scanned",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "don Alfredo (vendedor de diarios)",
      },
    },
    {
      date: "1925-06-16",
      event_type: "status_changed",
      location: CABA("Boedo"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1925-08-22",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro"),
      payload: { from_status: "active", to_status: "lost" },
    },
    {
      date: "1925-08-22",
      event_type: "credential_scanned",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        viewer_name: "Sra. Mitsuko Tanaka",
        is_self_scan: false,
        viewer_authenticated: false,
      },
    },
    {
      date: "1925-08-23",
      event_type: "status_changed",
      location: CABA("Boedo"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1926-03-15",
      event_type: "vaccination_administered",
      location: CABA("Boedo"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1926-09-09",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro"),
      payload: { from_status: "active", to_status: "lost" },
      uncommon: true,
    },
    {
      date: "1926-09-10",
      event_type: "credential_scanned",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        viewer_name: "Carmelo Rossi (limpiabotas)",
        is_self_scan: false,
        viewer_authenticated: false,
      },
    },
    {
      date: "1926-09-11",
      event_type: "status_changed",
      location: CABA("Boedo"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1927-04-22",
      event_type: "weight_recorded",
      location: CABA("Boedo"),
      payload: { kg: 38.0 },
    },
    {
      date: "1927-08-08",
      event_type: "vet_visit_logged",
      location: CABA("Boedo"),
      payload: { reason: "wellness" },
    },
    {
      date: "1928-01-15",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro"),
      payload: { from_status: "active", to_status: "lost" },
    },
    {
      date: "1928-01-16",
      event_type: "credential_scanned",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        viewer_name: "Sra. Esther Goldman (boletera)",
        is_self_scan: false,
        viewer_authenticated: false,
      },
    },
    {
      date: "1928-01-16",
      event_type: "status_changed",
      location: CABA("Boedo"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1929-03-15",
      event_type: "vaccination_administered",
      location: CABA("Boedo"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1930-07-04",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        from_status: "active",
        to_status: "lost",
        reason: "lives_between_station_and_home",
      },
      uncommon: true,
    },
    {
      date: "1930-07-04",
      event_type: "credential_scanned",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        viewer_name: "Conductor del tren",
        is_self_scan: false,
        viewer_authenticated: false,
      },
    },
    {
      date: "1930-07-05",
      event_type: "status_changed",
      location: CABA("Retiro", "Estación Retiro"),
      payload: { from_status: "lost", to_status: "active", reason: "manual_close_kobayashi" },
    },
    {
      date: "1932-10-04",
      event_type: "note_added",
      payload: {
        category: "system",
        text: "Libreta compartida — La Nación: crónica 'El perro que espera en Retiro'",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1932-10-05",
      event_type: "pet_profile_updated",
      location: CABA("Boedo"),
      payload: {
        photo_replaced: true,
        changes: [{ field: "photo", old: "old", new: "la_nacion_1932" }],
      },
      uncommon: true,
    },
    {
      date: "1933-02-22",
      event_type: "note_added",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        category: "reconocimiento",
        text: "Placa conmemorativa instalada por Ferrocarriles: 'Aquí espera Hachikō.'",
      },
      uncommon: true,
    },
    {
      date: "1933-08-15",
      event_type: "vaccination_administered",
      location: CABA("Boedo"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1934-04-22",
      event_type: "note_added",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        category: "reconocimiento",
        text: "Estatua de bronce inaugurada con Hachikō presente. Escultor: Tora Andó-Buenos Aires.",
      },
      uncommon: true,
    },
    {
      date: "1934-09-09",
      event_type: "weight_recorded",
      location: CABA("Boedo"),
      payload: { kg: 36.0 },
    },
    {
      date: "1934-11-30",
      event_type: "symptom_observed",
      location: CABA("Boedo"),
      payload: {
        source: "libreta",
        reporter_role: "owner",
        free_text: "Disnea moderada, tos seca crónica",
        matched_symptom_codes: ["dyspnea", "cough"],
        alerted_disease_codes: [],
      },
      uncommon: true,
    },
    {
      date: "1934-12-04",
      event_type: "clinical_info_logged",
      location: CABA("Boedo"),
      payload: {
        sub_kind: "lab_work",
        title: "Microfilarias positivas en frotis",
        details: "Filariosis cardiaca (Dirofilaria immitis)",
      },
      uncommon: true,
    },
    {
      date: "1934-12-10",
      event_type: "clinical_info_logged",
      location: CABA("Boedo"),
      payload: {
        sub_kind: "imaging",
        title: "Eco cardiaca — dilatación de cavidades derechas, hipertensión pulmonar",
      },
    },
    {
      date: "1934-12-15",
      event_type: "medication_started",
      location: CABA("Boedo"),
      payload: {
        drug_name: "cuidado paliativo (sin tratamiento eficaz disponible)",
        dose: "n/a",
        frequency: "continuous",
        first_dose_at: "1934-12-15",
        schedule_count: 1,
      },
      uncommon: true,
    },
    {
      date: "1935-01-22",
      event_type: "clinical_info_logged",
      location: CABA("Boedo"),
      payload: {
        sub_kind: "other",
        title: "Hallazgo incidental: masa pulmonar caudal derecha — neoplasia probable",
      },
      uncommon: true,
    },
    {
      date: "1935-03-08",
      event_type: "death_recorded",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        cause: "disease",
        cause_detail: "falla cardíaca derecha por filariosis + cáncer pulmonar terminal",
        confirmed_by_vet: true,
        vet_name: "Dr. Tanaka",
        disposition_method: "authorized_cemetery",
        facility: "Cementerio de la Chacarita, sector animales",
        death_at_clinic: false,
        is_reportable: false,
      },
      uncommon: true,
    },
    {
      date: "1935-03-09",
      event_type: "note_added",
      location: CABA("Caballito"),
      payload: {
        category: "despedida",
        text: "Hachikō, esperaste nueve años. Hoy te dejamos descansar a un costado de quien siempre miraste con esperanza. — K. Kobayashi",
      },
      uncommon: true,
    },
    {
      date: "1935-03-15",
      event_type: "pet_registered",
      location: CABA("Caballito"),
      payload: {
        name: "Hachiko Ni Sei",
        acquisition_method: "gift",
        note: "Replacement Akita to Yaeko Ueno from same Tandil estancia. See companion storyline DIM-HCN2-0016B.",
      },
      uncommon: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// 2b. Hachiko Ni Sei (replacement, short storyline)
// ---------------------------------------------------------------------------

const hachikoNiSei: Storyline = {
  pet: {
    display_name: "Hachiko Ni Sei",
    public_token: "DIM-HCN2-0016B",
    species: "dog",
    breed: "Akita Inu",
    sex: "male",
    date_of_birth: "1935-01-22",
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Caballito",
    status: "active",
    owner_of_record: "Yaeko Ueno",
    acquisition_method: "gift",
    notes: "Replacement Akita registered to original co-owner after Hachikō's death.",
  },
  events: [
    {
      date: "1935-03-15",
      event_type: "pet_registered",
      location: CABA("Caballito"),
      payload: { acquisition_method: "gift" },
    },
    {
      date: "1935-04-01",
      event_type: "vet_visit_logged",
      location: CABA("Caballito"),
      payload: { reason: "intake_exam" },
    },
    {
      date: "1935-04-15",
      event_type: "vaccination_administered",
      location: CABA("Caballito"),
      payload: { vaccine_name: "moquillo" },
    },
    {
      date: "1935-09-09",
      event_type: "weight_recorded",
      location: CABA("Caballito"),
      payload: { kg: 18.0 },
    },
    {
      date: "1936-03-22",
      event_type: "vaccination_administered",
      location: CABA("Caballito"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1936-08-15",
      event_type: "vet_visit_logged",
      location: CABA("Caballito"),
      payload: { reason: "wellness" },
    },
    {
      date: "1937-04-04",
      event_type: "note_added",
      location: CABA("Retiro", "Estación Retiro"),
      payload: {
        category: "rutina",
        text: "Hachiko II viene a la estación cada tanto, pero vuelve solo. — Yaeko Ueno",
      },
    },
  ],
};

// ===========================================================================
// 3. Pal (Lassie)
// ===========================================================================

const pal: Storyline = {
  pet: {
    display_name: "Pal",
    public_token: "DIM-PAL2-0017",
    species: "dog",
    breed: "Rough Collie",
    sex: "male",
    date_of_birth: "1940-06-04",
    estimated_weight_kg: 28.0,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Saavedra",
    status: "deceased",
    owner_of_record: "Rudd Weatherwax (Saavedra)",
    acquisition_method: "purchased",
    notes:
      "Behavioral surrender from first owner; trained by Weatherwax for film career as Argentina Sono Film's 'Lassie' from 1943. No replacement registered (franchise rule).",
  },
  events: [
    {
      date: "1940-06-04",
      event_type: "pet_registered",
      location: BA("Tandil", "Estancia Los Eucaliptos"),
      payload: { acquisition_method: "bred" },
    },
    {
      date: "1940-08-22",
      event_type: "custody_transferred",
      location: CABA("San Telmo"),
      payload: {
        from_user_id: "Estancia Los Eucaliptos",
        to_user_id: "H. Peck",
        from_role: "owner",
        to_role: "owner",
      },
    },
    {
      date: "1940-09-15",
      event_type: "vaccination_administered",
      location: CABA("San Telmo"),
      payload: { vaccine_name: "moquillo" },
    },
    {
      date: "1941-02-14",
      event_type: "incident_reported",
      location: CABA("San Telmo"),
      payload: {
        incident_type: "bite_inflicted",
        severity: "leve",
        injuries_summary: "Mordedura provocada al carnicero del barrio (Pal lo persiguió primero)",
        rabies_vaccine_valid_at_incident: false,
      },
      uncommon: true,
    },
    {
      date: "1941-02-14",
      event_type: "rabies_observation_started",
      location: CABA("San Telmo"),
      payload: {
        incident_reported_event_id: "evt-pal-bite-1941-02-14",
        expected_end_at: "1941-02-24",
      },
      uncommon: true,
    },
    {
      date: "1941-02-24",
      event_type: "rabies_observation_ended",
      location: CABA("San Telmo"),
      payload: { outcome: "negative" },
      uncommon: true,
    },
    {
      date: "1941-05-22",
      event_type: "incident_reported",
      location: CABA("San Telmo", "Av. San Juan"),
      payload: {
        incident_type: "traffic_accident",
        severity: "moderada",
        injuries_summary:
          "Persiguió una moto y se llevó por delante un colectivo línea 39. Magulladuras.",
      },
      uncommon: true,
    },
    {
      date: "1941-09-09",
      event_type: "note_added",
      location: CABA("San Telmo"),
      payload: { category: "conducta", text: "Pal persigue motos. Inentrenable por la familia." },
      uncommon: true,
    },
    {
      date: "1942-03-15",
      event_type: "adoption_reversed",
      location: CABA("San Telmo"),
      payload: {
        actor: "shelter",
        reason: "Imposibilidad de manejo por el dueño",
      },
      uncommon: true,
    },
    {
      date: "1942-03-20",
      event_type: "shelter_intake_recorded",
      location: CABA("Saavedra", "Av. Crisólogo Larralde 4500"),
      payload: {
        intake_reason: "surrender",
        intake_condition: "healthy_but_behavioral",
        org: "Escuela canina R. Weatherwax",
      },
    },
    {
      date: "1942-04-01",
      event_type: "custody_transferred",
      location: CABA("Saavedra"),
      payload: {
        from_organization_id: "Escuela canina R. Weatherwax",
        to_user_id: "R. Weatherwax",
        from_role: "shelter_custody",
        to_role: "owner",
      },
      uncommon: true,
    },
    {
      date: "1942-04-15",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: {
        category: "entrenamiento",
        text: "Pal aprende todo en 20 minutos. Lo único difícil es que pare. — R. Weatherwax",
      },
      uncommon: true,
    },
    {
      date: "1942-07-04",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1942-09-30",
      event_type: "weight_recorded",
      location: CABA("Saavedra"),
      payload: { kg: 27.0 },
    },
    {
      date: "1943-01-15",
      event_type: "note_added",
      location: CABA("Saavedra", "Argentina Sono Film"),
      payload: {
        category: "hito_profesional",
        text: "Casting *Lassie Vuelve a Casa* (versión argentina). Seleccionado.",
      },
      uncommon: true,
    },
    {
      date: "1943-04-22",
      event_type: "clinical_info_logged",
      location: CABA("Saavedra"),
      payload: { sub_kind: "other", title: "Examen pre-filmación", details: "apto" },
    },
    {
      date: "1943-09-09",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Estreno de *Lassie Vuelve a Casa*." },
    },
    {
      date: "1944-02-14",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1944-06-22",
      event_type: "incident_reported",
      location: CABA("Saavedra"),
      payload: {
        incident_type: "fall",
        severity: "leve",
        injuries_summary: "Caída de pedestal durante escena. Sin lesiones graves.",
      },
    },
    {
      date: "1944-09-09",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Inicio rodaje *Hijo de Lassie*." },
    },
    {
      date: "1945-03-15",
      event_type: "vet_visit_logged",
      location: CABA("Saavedra"),
      payload: { reason: "wellness" },
    },
    {
      date: "1945-08-08",
      event_type: "weight_recorded",
      location: CABA("Saavedra"),
      payload: { kg: 28.0 },
    },
    {
      date: "1946-04-22",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Rodaje *Coraje de Lassie*." },
    },
    {
      date: "1946-09-09",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1947-05-30",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: {
        category: "trivia",
        text: "Pal aparece en portadas. La gente lo reconoce en la calle. Le pedimos paciencia.",
      },
      uncommon: true,
    },
    {
      date: "1947-12-04",
      event_type: "vet_visit_logged",
      location: CABA("Saavedra"),
      payload: { reason: "pre-rodaje" },
    },
    {
      date: "1948-03-22",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Rodaje *Hills of Home*." },
    },
    {
      date: "1948-09-09",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1949-04-04",
      event_type: "weight_recorded",
      location: CABA("Saavedra"),
      payload: { kg: 29.0 },
    },
    {
      date: "1949-08-22",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Rodaje *The Sun Comes Up*." },
    },
    {
      date: "1950-02-14",
      event_type: "clinical_info_logged",
      location: CABA("Saavedra"),
      payload: { sub_kind: "imaging", title: "Rx columna — discopatía cervical incipiente" },
      uncommon: true,
    },
    {
      date: "1950-04-22",
      event_type: "medication_started",
      location: CABA("Saavedra"),
      payload: {
        drug_name: "antiinflamatorio (época)",
        dose: "n/a",
        frequency: "SID",
        first_dose_at: "1950-04-22",
        schedule_count: 90,
      },
    },
    {
      date: "1950-09-09",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1951-03-30",
      event_type: "medication_stopped",
      location: CABA("Saavedra"),
      payload: { reason: "pausa terapéutica" },
    },
    {
      date: "1951-09-15",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Última película de Pal: *Painted Hills*." },
    },
    {
      date: "1952-04-22",
      event_type: "status_changed",
      location: CABA("Costanera Sur"),
      payload: {
        from_status: "active",
        to_status: "lost",
        reason: "Escapa durante rodaje al aire libre",
      },
      uncommon: true,
    },
    {
      date: "1952-04-23",
      event_type: "credential_scanned",
      location: CABA("Costanera Sur"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "Don Vicente (guardaparque)",
      },
    },
    {
      date: "1952-04-23",
      event_type: "status_changed",
      location: CABA("Saavedra"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1952-09-09",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1953-04-04",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: {
        category: "retiro",
        text: "Retiro profesional. Weatherwax cierra contrato con el estudio.",
      },
      uncommon: true,
    },
    {
      date: "1954-02-22",
      event_type: "weight_recorded",
      location: CABA("Saavedra"),
      payload: { kg: 26.0 },
    },
    {
      date: "1954-09-09",
      event_type: "vaccination_administered",
      location: CABA("Saavedra"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1955-06-22",
      event_type: "symptom_observed",
      location: CABA("Saavedra"),
      payload: {
        source: "libreta",
        reporter_role: "owner",
        free_text: "Disnea de esfuerzo creciente",
        matched_symptom_codes: ["dyspnea_exertion"],
        alerted_disease_codes: ["chf"],
      },
      uncommon: true,
    },
    {
      date: "1955-07-04",
      event_type: "clinical_info_logged",
      location: CABA("Saavedra"),
      payload: { sub_kind: "imaging", title: "Cardiomegalia, derrame pleural leve" },
    },
    {
      date: "1955-07-15",
      event_type: "medication_started",
      location: CABA("Saavedra"),
      payload: {
        drug_name: "Digital + diurético",
        dose: "n/a",
        frequency: "BID",
        first_dose_at: "1955-07-15",
        schedule_count: 365,
      },
    },
    {
      date: "1956-08-08",
      event_type: "vet_visit_logged",
      location: CABA("Saavedra"),
      payload: { reason: "geriatric_exam" },
    },
    {
      date: "1957-03-22",
      event_type: "clinical_info_logged",
      location: CABA("Saavedra"),
      payload: { sub_kind: "lab_work", title: "Función renal deteriorada" },
      uncommon: true,
    },
    {
      date: "1957-09-30",
      event_type: "vet_visit_logged",
      location: CABA("Saavedra"),
      payload: { reason: "quality_of_life_check" },
    },
    {
      date: "1958-04-15",
      event_type: "medication_stopped",
      location: CABA("Saavedra"),
      payload: { reason: "suspensión gradual — quality-of-life" },
    },
    {
      date: "1958-06-18",
      event_type: "death_recorded",
      location: CABA("Saavedra"),
      payload: {
        cause: "disease",
        cause_detail: "insuficiencia cardiaca congestiva + fallo renal crónico",
        confirmed_by_vet: true,
        vet_name: "Dr. Mendoza",
        disposition_method: "owner_burial",
        facility: "Quinta Weatherwax, Saavedra",
        death_at_clinic: false,
        is_reportable: false,
      },
      uncommon: true,
    },
    {
      date: "1958-06-19",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: {
        category: "despedida",
        text: "Pal: enseñaste a Rin Tin Tin a no hacer trampa. Y a mí a quedarme quieto cuando hace falta. — R. Weatherwax",
      },
      uncommon: true,
    },
  ],
};

// ===========================================================================
// 4. Terry (Toto)
// ===========================================================================

const terry: Storyline = {
  pet: {
    display_name: "Terry",
    public_token: "DIM-TRRY-0018",
    species: "dog",
    breed: "Cairn Terrier",
    sex: "female",
    date_of_birth: "1933-11-17",
    estimated_weight_kg: 7.0,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "Buenos Aires",
    jurisdiction_locality: "Olivos",
    status: "deceased",
    owner_of_record: "Carlos Spitz (Olivos)",
    acquisition_method: "rescued",
    notes:
      "Surrendered as puppy for housebreaking issues; rescued and adopted by trainer Carl Spitz. Filmography included Argentine version of *El Mago de Oz*. Stage name 'Toto'.",
  },
  events: [
    {
      date: "1933-11-17",
      event_type: "pet_registered",
      location: BA("Olivos"),
      payload: { acquisition_method: "bred" },
    },
    {
      date: "1933-12-22",
      event_type: "abandonment_reported",
      location: BA("Olivos"),
      payload: { reporter_role: "owner", description: "Family surrenders by housebreaking issues" },
      uncommon: true,
    },
    {
      date: "1933-12-22",
      event_type: "shelter_intake_recorded",
      location: BA("Olivos"),
      payload: {
        intake_reason: "surrender",
        intake_condition: "healthy",
        org: "Patitas de Olivos",
      },
      uncommon: true,
    },
    {
      date: "1934-01-08",
      event_type: "vaccination_administered",
      location: BA("Olivos"),
      payload: { vaccine_name: "moquillo" },
    },
    {
      date: "1934-02-04",
      event_type: "foster_proposed",
      location: BA("Olivos"),
      payload: { foster_user_id: "C. Spitz", expected_weeks: 4 },
      uncommon: true,
    },
    {
      date: "1934-02-05",
      event_type: "foster_proposal_resolved",
      location: BA("Olivos"),
      payload: { proposal_public_token: "prop-terry-1934-02-04", outcome: "accepted" },
      uncommon: true,
    },
    {
      date: "1934-02-05",
      event_type: "foster_assigned",
      location: BA("Olivos"),
      payload: { foster_user_id: "C. Spitz", expected_weeks: 4 },
    },
    {
      date: "1934-02-15",
      event_type: "note_added",
      location: BA("Olivos"),
      payload: {
        category: "entrenamiento",
        text: "Terry resuelve problemas espaciales que no le enseñé. — C. Spitz",
      },
      uncommon: true,
    },
    {
      date: "1934-03-04",
      event_type: "adoption_application_submitted",
      location: BA("Olivos"),
      payload: { applicant_user_id: "C. Spitz", related_organization_id: "Patitas de Olivos" },
    },
    {
      date: "1934-03-08",
      event_type: "adoption_application_resolved",
      location: BA("Olivos"),
      payload: {
        application_event_id: "evt-terry-app-1934-03-04",
        reviewer_user_id: "org-admin",
        outcome: "approved",
      },
    },
    {
      date: "1934-03-08",
      event_type: "foster_ended",
      location: BA("Olivos"),
      payload: { foster_user_id: "C. Spitz", ended_by: "shelter" },
    },
    {
      date: "1934-03-08",
      event_type: "adoption_finalized",
      location: BA("Olivos"),
      payload: {
        previous_owner_organization_id: "Patitas de Olivos",
        adopter_user_id: "C. Spitz",
        post_adoption_followup_months: 6,
      },
    },
    {
      date: "1934-06-22",
      event_type: "vet_visit_logged",
      location: BA("Olivos"),
      payload: { reason: "wellness_post_adoption" },
    },
    {
      date: "1934-09-09",
      event_type: "weight_recorded",
      location: BA("Olivos"),
      payload: { kg: 5.5 },
    },
    {
      date: "1934-12-15",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: {
        category: "hito_profesional",
        text: "Casting *Bright Eyes* (versión argentina). Seleccionada.",
      },
      uncommon: true,
    },
    {
      date: "1935-04-22",
      event_type: "vaccination_administered",
      location: BA("Olivos"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1935-09-09",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Estreno *Bright Eyes*." },
    },
    {
      date: "1936-05-30",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Rodaje *Fury*." },
    },
    {
      date: "1937-03-15",
      event_type: "vaccination_administered",
      location: BA("Olivos"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1937-08-08",
      event_type: "weight_recorded",
      location: BA("Olivos"),
      payload: { kg: 6.8 },
    },
    {
      date: "1938-04-22",
      event_type: "note_added",
      location: CABA("Saavedra", "Argentina Sono Film"),
      payload: {
        category: "hito_profesional",
        text: "Inicio rodaje *El Mago de Oz* (versión argentina).",
      },
      uncommon: true,
    },
    {
      date: "1938-06-15",
      event_type: "incident_reported",
      location: CABA("Saavedra"),
      payload: {
        incident_type: "fall",
        severity: "moderada",
        injuries_summary: "Tramoyista pisa pata derecha. Fractura cerrada metatarso III.",
      },
      uncommon: true,
    },
    {
      date: "1938-06-15",
      event_type: "clinical_info_logged",
      location: CABA("Saavedra"),
      payload: { sub_kind: "imaging", title: "Rx pata: fractura confirmada" },
      uncommon: true,
    },
    {
      date: "1938-06-16",
      event_type: "clinical_info_logged",
      location: CABA("Saavedra"),
      payload: { sub_kind: "surgery", title: "Inmovilización con férula" },
    },
    {
      date: "1938-06-18",
      event_type: "medication_started",
      location: CABA("Saavedra"),
      payload: {
        drug_name: "Sulfonamidas + analgésico",
        dose: "1 g/d",
        frequency: "BID",
        first_dose_at: "1938-06-18",
        schedule_count: 14,
      },
    },
    {
      date: "1938-06-22",
      event_type: "status_changed",
      location: CABA("Saavedra"),
      payload: {
        from_status: "active",
        to_status: "lost",
        reason: "Escape del estudio durante recuperación",
      },
      uncommon: true,
    },
    {
      date: "1938-06-23",
      event_type: "credential_scanned",
      location: CABA("Monserrat", "Plaza de Mayo"),
      payload: {
        viewer_name: "Aída Bruzzese (empleada Casa Rosada)",
        is_self_scan: false,
        viewer_authenticated: false,
      },
    },
    {
      date: "1938-06-23",
      event_type: "status_changed",
      location: CABA("Saavedra"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1938-07-15",
      event_type: "medication_stopped",
      location: CABA("Saavedra"),
      payload: { reason: "Curso completado. Recuperación total." },
    },
    {
      date: "1938-08-04",
      event_type: "pet_profile_updated",
      location: BA("Olivos"),
      payload: { changes: [{ field: "stage_name", old: null, new: "Toto" }] },
      uncommon: true,
    },
    {
      date: "1938-11-09",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Estreno *El Mago de Oz*." },
    },
    {
      date: "1939-04-22",
      event_type: "vaccination_administered",
      location: BA("Olivos"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1940-03-15",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "hito_profesional", text: "Rodaje *The Women*." },
    },
    {
      date: "1941-06-22",
      event_type: "weight_recorded",
      location: BA("Olivos"),
      payload: { kg: 7.0 },
    },
    {
      date: "1942-09-09",
      event_type: "vaccination_administered",
      location: BA("Olivos"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1943-02-14",
      event_type: "note_added",
      location: CABA("Saavedra"),
      payload: { category: "retiro", text: "Última aparición en cine. *Tortilla Flat*. Retiro." },
      uncommon: true,
    },
    {
      date: "1943-08-08",
      event_type: "vet_visit_logged",
      location: BA("Olivos"),
      payload: { reason: "senior_wellness" },
    },
    {
      date: "1944-04-04",
      event_type: "status_changed",
      location: CABA("Palermo", "Plaza Italia"),
      payload: { from_status: "active", to_status: "lost", reason: "Escapa durante paseo" },
      uncommon: true,
    },
    {
      date: "1944-04-05",
      event_type: "credential_scanned",
      location: CABA("Palermo", "Plaza Italia"),
      payload: {
        viewer_name: "Dorothea Garber (vecina)",
        is_self_scan: false,
        viewer_authenticated: false,
      },
    },
    {
      date: "1944-04-05",
      event_type: "status_changed",
      location: BA("Olivos"),
      payload: { from_status: "lost", to_status: "active" },
    },
    {
      date: "1944-09-09",
      event_type: "vaccination_administered",
      location: BA("Olivos"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "1945-03-22",
      event_type: "symptom_observed",
      location: BA("Olivos"),
      payload: {
        source: "libreta",
        reporter_role: "owner",
        free_text: "Decaimiento + anorexia",
        matched_symptom_codes: ["lethargy", "anorexia"],
        alerted_disease_codes: ["neoplasia_oculta"],
      },
      uncommon: true,
    },
    {
      date: "1945-04-04",
      event_type: "clinical_info_logged",
      location: BA("Olivos"),
      payload: {
        sub_kind: "lab_work",
        title: "Anemia normocítica, hallazgos compatibles con neoplasia oculta",
      },
    },
    {
      date: "1945-05-15",
      event_type: "vet_visit_logged",
      location: BA("Olivos"),
      payload: { reason: "quality_of_life_check" },
    },
    {
      date: "1945-09-01",
      event_type: "death_recorded",
      location: BA("Olivos"),
      payload: {
        cause: "disease",
        cause_detail: "neoplasia hematopoyética + falla orgánica multisistémica (edad 11 a)",
        confirmed_by_vet: true,
        vet_name: "Dra. Inés Bardelli",
        disposition_method: "owner_burial",
        facility: "Quinta Spitz, Olivos",
        death_at_clinic: false,
        is_reportable: false,
      },
      uncommon: true,
    },
    {
      date: "1945-09-02",
      event_type: "note_added",
      location: BA("Olivos"),
      payload: {
        category: "despedida",
        text: "Terry: nadie volvió a saltar tan lejos con tan poco peso. Buen viaje. — C. Spitz",
      },
      uncommon: true,
    },
  ],
};

// ===========================================================================
// 5. Kabosu
// ===========================================================================

const kabosu: Storyline = {
  pet: {
    display_name: "Kabosu",
    public_token: "DIM-KABO-0019",
    species: "dog",
    breed: "Shiba Inu",
    sex: "female",
    date_of_birth: "2005-11-02",
    microchip_id: "941300400500001",
    microchip_country_code: "941",
    microchip_implanted_at: "2008-06-15",
    microchip_implanted_by: "Refugio Patitas Salteñas",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 9.2,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Belgrano R",
    status: "deceased",
    owner_of_record: "Atsuko Sato (Belgrano R)",
    acquisition_method: "rescued",
    notes:
      "The only chipped pet in this batch. Modern arc with viral public credential scans (2013 Dogecoin burst) and prolonged terminal-disease workflow.",
  },
  events: [
    {
      date: "2005-11-02",
      event_type: "pet_registered",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { acquisition_method: "unknown", note: "Born in unregistered breeding facility" },
    },
    {
      date: "2006-03-15",
      event_type: "custody_transferred",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        from_user_id: "criadero_salta",
        to_user_id: "Sra. Cardozo",
        from_role: "owner",
        to_role: "owner",
      },
    },
    {
      date: "2006-04-22",
      event_type: "vaccination_administered",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { vaccine_name: "moquillo" },
    },
    {
      date: "2007-08-08",
      event_type: "weight_recorded",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { kg: 8.4 },
    },
    {
      date: "2008-04-15",
      event_type: "abandonment_reported",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        reporter_role: "witness",
        description: "Cardozo cierra criadero por inspección sanitaria; abandona 19 perros",
      },
      uncommon: true,
    },
    {
      date: "2008-04-15",
      event_type: "maltreatment_reported",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        reporter_role: "vet",
        description: "Negligencia + abandono masivo",
        severity: "alta",
        kind: "abandono",
      },
      uncommon: true,
    },
    {
      date: "2008-04-16",
      event_type: "shelter_intake_recorded",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        intake_reason: "seizure",
        intake_condition: "underweight + dermatosis",
        org: "Refugio Patitas Salteñas",
      },
      uncommon: true,
    },
    {
      date: "2008-04-17",
      event_type: "vet_visit_logged",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { reason: "intake_exam", body_condition_score: 3 },
    },
    {
      date: "2008-04-20",
      event_type: "deworming_administered",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { product: "Selamectina", type: "both" },
    },
    {
      date: "2008-05-04",
      event_type: "vaccination_administered",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { vaccine_name: "booster" },
    },
    {
      date: "2008-06-15",
      event_type: "microchip_implanted",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        chip_number: "941300400500001",
        country_code: "941",
        implanted_by: "Refugio Patitas Salteñas",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
      uncommon: true,
    },
    {
      date: "2008-09-22",
      event_type: "weight_recorded",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: { kg: 9.0 },
    },
    {
      date: "2008-10-04",
      event_type: "adoption_application_submitted",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        applicant_user_id: "Atsuko Sato",
        related_organization_id: "Refugio Patitas Salteñas",
        housing_type: "departamento + balcón",
      },
    },
    {
      date: "2008-10-08",
      event_type: "adoption_application_resolved",
      location: { locality: "Salta Capital", province: "Salta" },
      payload: {
        application_event_id: "evt-kabosu-app-2008-10-04",
        reviewer_user_id: "org-admin",
        outcome: "approved",
      },
    },
    {
      date: "2008-11-15",
      event_type: "adoption_finalized",
      location: CABA("Belgrano R"),
      payload: {
        previous_owner_organization_id: "Refugio Patitas Salteñas",
        adopter_user_id: "Atsuko Sato",
        post_adoption_followup_months: 12,
      },
      uncommon: true,
    },
    {
      date: "2009-01-22",
      event_type: "post_adoption_checkin",
      location: CABA("Belgrano R"),
      payload: {
        related_organization_id: "Refugio Patitas Salteñas",
        notes: "2-mes — aclimatación buena",
      },
    },
    {
      date: "2009-05-15",
      event_type: "post_adoption_checkin",
      location: CABA("Belgrano R"),
      payload: { notes: "6-mes — saludable" },
    },
    {
      date: "2009-11-15",
      event_type: "post_adoption_checkin",
      location: CABA("Belgrano R"),
      payload: { notes: "12-mes — cierre followup" },
    },
    {
      date: "2010-02-13",
      event_type: "pet_profile_updated",
      location: CABA("Belgrano R"),
      payload: {
        photo_replaced: true,
        changes: [{ field: "photo", old: "old", new: "kabosu_iconic_sofa" }],
      },
      uncommon: true,
    },
    {
      date: "2010-02-23",
      event_type: "note_added",
      payload: {
        category: "system",
        text: "Libreta compartida — Blog Maru in Jiji: inicio viralización",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "2010-04-22",
      event_type: "vaccination_administered",
      location: CABA("Belgrano R"),
      payload: { vaccine_name: "anual" },
    },
    {
      date: "2011-09-09",
      event_type: "weight_recorded",
      location: CABA("Belgrano R"),
      payload: { kg: 10.1 },
    },
    {
      date: "2012-04-22",
      event_type: "vet_visit_logged",
      location: CABA("Belgrano R"),
      payload: { reason: "wellness" },
    },
    {
      date: "2013-12-08",
      event_type: "credential_scanned",
      location: CABA("Belgrano R"),
      payload: { is_self_scan: false, viewer_authenticated: false, viewer_name: "scan_burst_t0" },
      uncommon: true,
    },
    {
      date: "2013-12-09",
      event_type: "credential_scanned",
      location: CABA("Belgrano R"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "scan_burst_30plus_unique_24h",
        note: "30+ unique scans in 24 h — throughput stress test",
      },
      uncommon: true,
    },
    {
      date: "2013-12-10",
      event_type: "credential_scanned",
      location: CABA("Belgrano R"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "scan_burst_t2_12scans",
      },
    },
    {
      date: "2013-12-11",
      event_type: "credential_scanned",
      location: CABA("Belgrano R"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "scan_burst_t3_8scans",
      },
    },
    {
      date: "2014-01-15",
      event_type: "note_added",
      author_role: "system",
      payload: { category: "system", text: "Libreta compartida — Periodista The Verge" },
      uncommon: true,
    },
    {
      date: "2014-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual" },
    },
    {
      date: "2015-08-08",
      event_type: "weight_recorded",
      author_role: "vet",
      payload: { kg: 10.4 },
    },
    {
      date: "2016-03-15",
      event_type: "incident_reported",
      author_role: "owner",
      payload: {
        incident_type: "escape",
        severity: "leve",
        injuries_summary: "Atrapada en multitud durante evento fan. Recuperada en 2 h.",
      },
      uncommon: true,
    },
    {
      date: "2017-05-30",
      event_type: "symptom_observed",
      author_role: "owner",
      payload: {
        source: "libreta",
        reporter_role: "owner",
        free_text: "Masa palpable region axilar derecha",
        matched_symptom_codes: ["palpable_mass"],
        alerted_disease_codes: [],
      },
      uncommon: true,
    },
    {
      date: "2017-06-04",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "imaging", title: "Eco — masa quistica, sin malignidad" },
    },
    {
      date: "2017-06-15",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "lab_work", title: "Citologia — benigna" },
      uncommon: true,
    },
    {
      date: "2018-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual" },
    },
    {
      date: "2018-12-04",
      event_type: "note_added",
      author_role: "system",
      payload: { category: "system", text: "Libreta compartida — Documentalista" },
    },
    {
      date: "2019-09-30",
      event_type: "weight_recorded",
      author_role: "vet",
      payload: { kg: 10.0 },
    },
    {
      date: "2020-04-22",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "telemed_ASPO" },
    },
    {
      date: "2021-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual" },
    },
    {
      date: "2022-05-15",
      event_type: "symptom_observed",
      author_role: "owner",
      payload: {
        source: "libreta",
        reporter_role: "owner",
        free_text: "Letargo persistente + anorexia parcial",
        matched_symptom_codes: ["lethargy", "anorexia"],
        alerted_disease_codes: ["hematological"],
      },
      uncommon: true,
    },
    {
      date: "2022-05-22",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "lab_work", title: "Hemograma: anemia + plaquetopenia" },
      uncommon: true,
    },
    {
      date: "2022-06-04",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "lab_work", title: "Leucemia cronica + hepatopatia" },
      uncommon: true,
    },
    {
      date: "2022-06-15",
      event_type: "medication_started",
      author_role: "vet",
      payload: {
        drug_name: "Prednisolona + clorambucilo",
        dose: "1 mg/kg",
        frequency: "SID",
        first_dose_at: "2022-06-15",
        schedule_count: 720,
      },
      uncommon: true,
    },
    {
      date: "2022-06-16",
      event_type: "medication_dose_taken",
      author_role: "owner",
      payload: {
        medication_started_event_id: "evt-kabosu-med",
        scheduled_for: "2022-06-16T08:00:00Z",
        reminder_id: "rem-kabosu-d1",
      },
    },
    {
      date: "2022-12-04",
      event_type: "note_added",
      author_role: "system",
      payload: { category: "system", text: "Libreta compartida — Oncólogo especialista" },
      uncommon: true,
    },
    {
      date: "2023-04-22",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "quality_of_life_check" },
    },
    { date: "2023-09-30", event_type: "weight_recorded", author_role: "vet", payload: { kg: 8.8 } },
    {
      date: "2024-02-14",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "imaging", title: "Eco abdominal — hepatomegalia, esplenomegalia" },
    },
    {
      date: "2024-04-22",
      event_type: "medication_stopped",
      author_role: "vet",
      payload: { reason: "suspension gradual — quality-of-life" },
    },
    {
      date: "2024-05-15",
      event_type: "note_added",
      author_role: "owner",
      payload: {
        category: "comunicacion publica",
        text: "Sato anuncia que Kabosu esta en sus ultimos dias",
      },
      uncommon: true,
    },
    {
      date: "2024-05-24",
      event_type: "death_recorded",
      author_role: "vet",
      payload: {
        cause: "disease",
        cause_detail: "Leucemia cronica + hepatopatia terminal",
        confirmed_by_vet: true,
        vet_name: "Dr. Pereyra",
        disposition_method: "cremation_individual_ashes",
        facility: "Crematorio Mascotas Norte, Tigre",
        death_at_clinic: false,
        is_reportable: false,
      },
      uncommon: true,
    },
    {
      date: "2024-05-25",
      event_type: "note_added",
      author_role: "owner",
      payload: {
        category: "despedida",
        text: "Kabosu — gracias por dejarte querer por tanta gente. — Atsuko",
      },
      uncommon: true,
    },
    {
      date: "2024-06-04",
      event_type: "note_added",
      author_role: "system",
      payload: { category: "system", text: "Libreta compartida — Press internacional" },
      uncommon: true,
    },
    {
      date: "2024-08-15",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { name: "Hanako", note: "Replacement to Atsuko Sato. See DIM-HNKO-0019B." },
      uncommon: true,
    },
  ],
};

// ===========================================================================
// Hanako — Kabosu's replacement (registered to Noeli)
// ===========================================================================

const hanako: Storyline = {
  pet: {
    display_name: "Hanako",
    public_token: "DIM-HNKO-0019B",
    species: "dog",
    breed: "Shiba Inu",
    sex: "female",
    date_of_birth: "2024-02-15",
    microchip_id: "941300400500101",
    microchip_country_code: "941",
    microchip_implanted_at: "2024-08-16",
    estimated_weight_kg: 8.5,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Belgrano R",
    status: "active",
    owner_of_record: "Atsuko Sato (mapped to Noeli)",
    acquisition_method: "adopted",
  },
  events: [
    {
      date: "2024-08-15",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "adopted" },
    },
    {
      date: "2024-08-15",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "healthy" },
    },
    {
      date: "2024-08-16",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "941300400500101",
        country_code: "941",
        implant_date_known: true,
      },
    },
    {
      date: "2024-08-20",
      event_type: "adoption_application_submitted",
      author_role: "owner",
      payload: { applicant_user_id: "Atsuko Sato" },
    },
    {
      date: "2024-08-22",
      event_type: "adoption_application_resolved",
      author_role: "shelter",
      payload: {
        application_event_id: "evt-hanako-app-2024-08-20",
        reviewer_user_id: "org-admin",
        outcome: "approved",
      },
    },
    {
      date: "2024-08-22",
      event_type: "adoption_finalized",
      author_role: "shelter",
      payload: { post_adoption_followup_months: 12 },
    },
    {
      date: "2024-09-15",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "wellness" },
    },
    {
      date: "2024-10-20",
      event_type: "post_adoption_checkin",
      author_role: "shelter",
      payload: { notes: "2-mes" },
    },
    { date: "2025-03-22", event_type: "weight_recorded", author_role: "vet", payload: { kg: 8.5 } },
    {
      date: "2025-09-30",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual" },
    },
    {
      date: "2026-04-22",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "wellness" },
    },
  ],
};

// ===========================================================================
// Public export
// ===========================================================================

export const STORYLINES: Storyline[] = [laika, hachiko, hachikoNiSei, pal, terry, kabosu, hanako];
