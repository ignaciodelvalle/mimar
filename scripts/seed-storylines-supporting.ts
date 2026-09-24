/**
 * Supporting cast — 17 ordinary pets that populate the demo.
 *
 * Distributed across CABA Comunas 1 (Retiro / Puerto Madero / San Nicolás),
 * 2 (Recoleta), 14 (Palermo) to give the sanitary-authority dashboards real
 * rows to render. Designed to fill specific holes left by the iconic + named
 * pets:
 *
 *   Open-state work the institutional users need to act on:
 *     - 1 pet currently status='lost'             → Luna (DIM-S005)
 *     - 1 mid-rabies-observation in progress      → Pelusa (DIM-S006)
 *     - 1 pending adoption_application_submitted  → Negro (DIM-S012)
 *     - 1 expired/cancelled foster proposals      → Lola (DIM-S009)
 *     - 1 vet owning their own pet (dual-hat)     → Pampita (DIM-S010, Lilian)
 *     - 1 recent deceased pet                     → Maximus (DIM-S015)
 *
 *   Workflow gaps covered by this batch:
 *     - foster_proposed / foster_proposal_accepted / foster_assigned (Toby)
 *     - foster_proposed / foster_proposal_expired                    (Lola)
 *     - foster_proposed / foster_proposal_cancelled                  (Bichita)
 *     - foster_co_foster_allowed                                     (Toby)
 *     - adoption_application_submitted (pending)                     (Negro)
 *     - adoption_application_rejected                                (Pelusa, prior applicant)
 *     - adoption_withdrawn                                           (Coco, prior applicant)
 *     - adoption_eligibility_set                          (Lola, Bichita, Milanesa, Pochoclo)
 *     - microchip_revoked                                            (Coco — duplicate fraud)
 *     - sterilization_performed (multiple)
 *
 *   Species mix: 9 dogs, 6 cats, 1 rabbit, 1 guinea pig.
 *
 *   Recent activity: every active pet gets at least one event in the last
 *   60 days so the "hoy / esta semana / próximos recordatorios" widgets
 *   have content.
 */

import type { Storyline } from "./seed-storylines-iconic";

const CABA = (locality: string, landmark?: string) => ({
  locality,
  province: "CABA",
  ...(landmark ? { landmark } : {}),
});

// ---------------------------------------------------------------------------
// DIM-S001 — Firulais (Ignacio) — Palermo
// ---------------------------------------------------------------------------

const firulais: Storyline = {
  pet: {
    display_name: "Firulais",
    public_token: "DIM-S001-PLRM",
    species: "dog",
    breed: "Mestizo",
    sex: "male",
    date_of_birth: "2019-08-12",
    color: "Marrón claro",
    microchip_id: "858001000000001",
    microchip_country_code: "858",
    microchip_implanted_at: "2019-10-15",
    microchip_implanted_by: "Clínica Veterinaria Recoleta",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 18,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "adopted",
    status: "active",
    owner: "ignacio",
  },
  events: [
    {
      date: "2019-09-12",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "adopted" },
    },
    {
      date: "2019-10-15",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858001000000001",
        country_code: "858",
        implanted_by: "Clínica Veterinaria Recoleta",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2019-11-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica" },
    },
    {
      date: "2020-05-20",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    {
      date: "2024-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2025-04-22" },
    },
    {
      date: "2025-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-04-22" },
    },
    {
      date: "2026-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2027-04-22" },
    },
    { date: "2026-05-08", event_type: "weight_recorded", author_role: "vet", payload: { kg: 18 } },
    {
      date: "2026-05-15",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "wellness" },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S002 — Michi (Ignacio) — Recoleta, no chip
// ---------------------------------------------------------------------------

const michi: Storyline = {
  pet: {
    display_name: "Michi",
    public_token: "DIM-S002-RECO",
    species: "cat",
    breed: "Común europeo",
    sex: "female",
    date_of_birth: "2018-04-22",
    color: "Blanco y negro",
    estimated_weight_kg: 4.5,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Recoleta",
    acquisition_method: "rescued",
    status: "active",
    owner: "ignacio",
  },
  events: [
    {
      date: "2018-06-15",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2018-07-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "FVRCP + antirrábica" },
    },
    {
      date: "2018-09-10",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2024-09-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2025-09-22" },
    },
    {
      date: "2025-09-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-09-22" },
    },
    { date: "2026-04-30", event_type: "weight_recorded", author_role: "vet", payload: { kg: 4.5 } },
    {
      date: "2026-05-11",
      event_type: "credential_scanned",
      author_role: "system",
      payload: { is_self_scan: true, viewer_authenticated: true },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S003 — Romeo (Ignacio) — Recoleta, Caniche
// ---------------------------------------------------------------------------

const romeo: Storyline = {
  pet: {
    display_name: "Romeo",
    public_token: "DIM-S003-RECO",
    species: "dog",
    breed: "Caniche Toy",
    sex: "male",
    date_of_birth: "2021-11-04",
    color: "Blanco",
    microchip_id: "858003000000003",
    microchip_country_code: "858",
    microchip_implanted_at: "2022-01-15",
    microchip_implanted_by: "Clínica Veterinaria Recoleta",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 4.5,
    favourite_foods: ["pollo hervido", "zanahoria"],
    potentially_dangerous_breed: false,
    insurance_company: "Mascotas Seguras",
    insurance_policy_number: "MS-2024-9981",
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Recoleta",
    acquisition_method: "purchased",
    status: "active",
    owner: "ignacio",
  },
  events: [
    {
      date: "2021-12-01",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "purchased" },
    },
    {
      date: "2022-01-15",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858003000000003",
        country_code: "858",
        implanted_by: "Clínica Veterinaria Recoleta",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2022-02-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP #1" },
    },
    {
      date: "2022-02-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP #2 + antirrábica" },
    },
    {
      date: "2022-09-15",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    {
      date: "2024-02-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2025-02-15" },
    },
    {
      date: "2025-02-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-02-15" },
    },
    {
      date: "2025-12-22",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "other", title: "Profilaxis dental + 1 extracción" },
    },
    {
      date: "2026-02-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2027-02-15" },
    },
    { date: "2026-05-09", event_type: "weight_recorded", author_role: "vet", payload: { kg: 4.5 } },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S004 — Hércules (Ignacio) — Palermo, senior cat, active medication
// ---------------------------------------------------------------------------

const hercules: Storyline = {
  pet: {
    display_name: "Hércules",
    public_token: "DIM-S004-PLRM",
    species: "cat",
    breed: "Persa",
    sex: "male",
    date_of_birth: "2014-06-08",
    color: "Crema",
    microchip_id: "858004000000004",
    microchip_country_code: "858",
    microchip_implanted_at: "2014-09-22",
    microchip_implanted_by: "Clínica Veterinaria Recoleta",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 6.2,
    known_allergies: ["pescado azul"],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "purchased",
    status: "active",
    owner: "ignacio",
  },
  events: [
    {
      date: "2014-08-01",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "purchased" },
    },
    {
      date: "2014-09-22",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858004000000004",
        country_code: "858",
        implanted_by: "Clínica Veterinaria Recoleta",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2014-10-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "FVRCP + antirrábica" },
    },
    {
      date: "2015-04-10",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    {
      date: "2024-04-22",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "lab_work", title: "Senior panel — ERC estadio II" },
    },
    {
      date: "2024-05-01",
      event_type: "medication_started",
      author_role: "vet",
      payload: {
        drug_name: "benazepril + dieta renal",
        dose: "0.5 mg/kg",
        frequency: "SID",
        first_dose_at: "2024-05-01",
        schedule_count: 730,
      },
    },
    {
      date: "2024-05-02",
      event_type: "medication_dose_taken",
      author_role: "owner",
      payload: {
        medication_started_event_id: "evt-hercules-med-2024-05-01",
        scheduled_for: "2024-05-02T08:00:00Z",
        reminder_id: "rem-hercules-d1",
      },
    },
    {
      date: "2025-04-22",
      event_type: "medication_dose_taken",
      author_role: "owner",
      payload: {
        medication_started_event_id: "evt-hercules-med-2024-05-01",
        scheduled_for: "2025-04-22T08:00:00Z",
        reminder_id: "rem-hercules-d356",
      },
    },
    {
      date: "2025-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual senior", next_due_at: "2026-04-22" },
    },
    {
      date: "2026-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual senior", next_due_at: "2027-04-22" },
    },
    {
      date: "2026-05-10",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "control ERC trimestral" },
    },
    {
      date: "2026-05-10",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "lab_work", title: "Panel renal — estable" },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S005 — Luna (Noelí) — CURRENTLY LOST as of 2026-05-08
// ---------------------------------------------------------------------------

const luna: Storyline = {
  pet: {
    display_name: "Luna",
    public_token: "DIM-S005-PLRM",
    species: "dog",
    breed: "Mestiza pequeña",
    sex: "female",
    date_of_birth: "2023-05-12",
    color: "Negra",
    microchip_id: "858005000000005",
    microchip_country_code: "858",
    microchip_implanted_at: "2023-07-20",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 8.5,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "adopted",
    status: "lost", // <-- currently lost
    owner: "noeli",
    notes: "STATUS=LOST as of 2026-05-08. Active lost-pet broadcast.",
  },
  events: [
    {
      date: "2023-06-15",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "adopted" },
    },
    {
      date: "2023-07-20",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858005000000005",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2023-08-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica" },
    },
    {
      date: "2024-03-15",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2024-08-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2025-08-01" },
    },
    {
      date: "2025-08-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-08-01" },
    },
    { date: "2026-04-04", event_type: "weight_recorded", author_role: "vet", payload: { kg: 8.5 } },
    {
      date: "2026-05-08",
      event_type: "status_changed",
      author_role: "owner",
      location: CABA("Palermo", "Bosques de Palermo — Plaza Holanda"),
      payload: {
        from_status: "active",
        to_status: "lost",
        location_description:
          "Bosques de Palermo, Plaza Holanda. Se escapó persiguiendo un gato. Collar verde con chapa.",
        reason: "escapó durante paseo",
        disclosure_prefs_snapshot: { phone: true, last_location: true, finder_form: true },
      },
      uncommon: true,
    },
    {
      date: "2026-05-12",
      event_type: "credential_scanned",
      author_role: "system",
      location: CABA("Palermo"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "anonimo desde Plaza Italia",
      },
    },
    {
      date: "2026-05-15",
      event_type: "credential_scanned",
      author_role: "system",
      location: CABA("Recoleta"),
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "anonimo desde Plaza Vicente López",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S006 — Pelusa (Noelí) — MID-RABIES-OBSERVATION (started 2026-05-15)
// ---------------------------------------------------------------------------

const pelusa: Storyline = {
  pet: {
    display_name: "Pelusa",
    public_token: "DIM-S006-RECO",
    species: "dog",
    breed: "Caniche Toy",
    sex: "female",
    date_of_birth: "2020-09-30",
    color: "Blanca",
    microchip_id: "858006000000006",
    microchip_country_code: "858",
    microchip_implanted_at: "2020-12-01",
    microchip_implanted_by: "Clínica Veterinaria Recoleta",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 6,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Recoleta",
    acquisition_method: "adopted",
    status: "active",
    owner: "noeli",
    notes:
      "Mid-rabies-observation: started 2026-05-15, expected end 2026-05-25. Observation in progress in DB right now.",
  },
  events: [
    {
      date: "2020-11-01",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "adopted" },
    },
    {
      date: "2020-12-01",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858006000000006",
        country_code: "858",
        implanted_by: "Clínica Veterinaria Recoleta",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2020-12-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica" },
    },
    {
      date: "2021-06-22",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2021-09-15",
      event_type: "adoption_application_resolved",
      author_role: "shelter",
      payload: {
        application_event_id: "evt-pelusa-app-prior",
        reviewer_user_id: "alejo",
        outcome: "rejected",
        reason: "Solicitante inicial tenía vivienda no apta — reasignada a Noelí",
      },
      uncommon: true,
    },
    {
      date: "2024-12-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2025-12-15" },
    },
    {
      date: "2025-12-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2026-12-15" },
    },
    { date: "2026-04-10", event_type: "weight_recorded", author_role: "vet", payload: { kg: 6 } },
    {
      date: "2026-05-15",
      event_type: "incident_reported",
      author_role: "owner",
      location: CABA("Recoleta", "Plaza Francia"),
      payload: {
        incident_type: "bite_inflicted",
        severity: "leve",
        injuries_summary:
          "Mordedura de provocación a niño que intentó tocarla por detrás. Herida superficial en mano.",
        victim_contact_name: "Madre del niño (anónimo)",
        rabies_vaccine_valid_at_incident: true,
      },
      uncommon: true,
    },
    {
      date: "2026-05-15",
      event_type: "rabies_observation_started",
      author_role: "vet",
      payload: {
        incident_reported_event_id: "evt-pelusa-bite-2026-05-15",
        expected_end_at: "2026-05-25",
        isolation_facility: "domicilio supervisado (Noelí)",
        protocol: "Ley 22.953 — 10 días, vacuna válida",
      },
      uncommon: true,
    },
    {
      date: "2026-05-18",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "check-in observación día 3 — asintomática" },
    },
    // NOTE: observation ends 2026-05-25, but today is 2026-05-18. Cron will close it.
  ],
};

// ---------------------------------------------------------------------------
// DIM-S007 — Cielo (Noelí) — Palermo cat
// ---------------------------------------------------------------------------

const cielo: Storyline = {
  pet: {
    display_name: "Cielo",
    public_token: "DIM-S007-PLRM",
    species: "cat",
    breed: "Siamés",
    sex: "female",
    date_of_birth: "2020-02-14",
    color: "Crema con puntos marrones",
    microchip_id: "858007000000007",
    microchip_country_code: "858",
    microchip_implanted_at: "2020-04-22",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 4.2,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "adopted",
    status: "active",
    owner: "noeli",
  },
  events: [
    {
      date: "2020-03-01",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "adopted" },
    },
    {
      date: "2020-04-22",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858007000000007",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2020-05-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "FVRCP + antirrábica" },
    },
    {
      date: "2020-09-15",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2024-05-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2025-05-01" },
    },
    {
      date: "2025-05-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-05-01" },
    },
    {
      date: "2026-05-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2027-05-01" },
    },
    { date: "2026-05-13", event_type: "weight_recorded", author_role: "vet", payload: { kg: 4.2 } },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S008 — Toby (foster_assigned to Graciela, owned by Patitas del Norte)
// ---------------------------------------------------------------------------

const toby: Storyline = {
  pet: {
    display_name: "Toby",
    public_token: "DIM-S008-PLRM",
    species: "dog",
    breed: "Mestizo Labrador",
    sex: "male",
    date_of_birth: "2024-01-20",
    color: "Negro",
    microchip_id: "858008000000008",
    microchip_country_code: "858",
    microchip_implanted_at: "2024-05-10",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 22,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes: "Shelter custody — foster_assigned a Graciela. Exercises foster_co_foster_allowed.",
  },
  events: [
    {
      date: "2024-05-01",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "underweight" },
    },
    {
      date: "2024-05-01",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2024-05-10",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858008000000008",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2024-05-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica catch-up" },
    },
    {
      date: "2024-08-22",
      event_type: "foster_proposed",
      author_role: "shelter",
      payload: { foster_user_id: "graciela", expected_weeks: 8 },
      uncommon: true,
    },
    {
      date: "2024-08-23",
      event_type: "foster_proposal_resolved",
      author_role: "owner",
      payload: { proposal_public_token: "prop-toby-2024-08-22", outcome: "accepted" },
      uncommon: true,
    },
    {
      date: "2024-08-23",
      event_type: "foster_assigned",
      author_role: "shelter",
      payload: { foster_user_id: "graciela", expected_weeks: 8 },
    },
    {
      date: "2024-09-01",
      event_type: "foster_co_foster_allowed",
      author_role: "shelter",
      payload: {
        primary_foster_user_id: "graciela",
        co_foster_user_id: "noeli",
        reason: "ayuda durante viaje del foster principal",
      },
      uncommon: true,
    },
    {
      date: "2024-12-01",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    {
      date: "2025-05-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-05-15" },
    },
    {
      date: "2026-05-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2027-05-15" },
    },
    { date: "2026-05-14", event_type: "weight_recorded", author_role: "vet", payload: { kg: 22 } },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S009 — Lola (Patitas del Norte) — adoption_eligibility_set + expired foster
// ---------------------------------------------------------------------------

const lola: Storyline = {
  pet: {
    display_name: "Lola",
    public_token: "DIM-S009-PLRM",
    species: "dog",
    breed: "Mestiza",
    sex: "female",
    date_of_birth: "2022-07-04",
    color: "Marrón con blanco",
    microchip_id: "858009000000009",
    microchip_country_code: "858",
    microchip_implanted_at: "2024-11-15",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 15,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes:
      "Shelter custody. Foster proposal a Graciela expiró sin respuesta. adoption_eligibility_set TRUE.",
  },
  events: [
    {
      date: "2024-11-01",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "healthy" },
    },
    {
      date: "2024-11-01",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2024-11-15",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858009000000009",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2024-11-20",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica" },
    },
    {
      date: "2024-12-15",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2025-02-10",
      event_type: "foster_proposed",
      author_role: "shelter",
      payload: { foster_user_id: "graciela", expected_weeks: 6, deadline_to_respond: "2025-02-13" },
      uncommon: true,
    },
    {
      date: "2025-02-13",
      event_type: "foster_proposal_resolved",
      author_role: "shelter",
      payload: {
        proposal_public_token: "prop-lola-2025-02-10",
        outcome: "expired",
        response_notes: "no_response_within_72h",
      },
      uncommon: true,
    },
    {
      date: "2025-03-15",
      event_type: "adoption_eligibility_set",
      author_role: "shelter",
      payload: {
        eligible: true,
        set_by_user_id: "alejo",
        reason: "evaluación temperamento completa — apta",
      },
      uncommon: true,
    },
    {
      date: "2026-05-12",
      event_type: "credential_scanned",
      author_role: "system",
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "interesado en adopción desde /adoptar",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S010 — Pampita (Lilian's own pet — vet owning a pet)
// ---------------------------------------------------------------------------

const pampita: Storyline = {
  pet: {
    display_name: "Pampita",
    public_token: "DIM-S010-RECO",
    species: "cat",
    breed: "Común europeo",
    sex: "female",
    date_of_birth: "2019-03-30",
    color: "Atigrada marrón",
    microchip_id: "858010000000010",
    microchip_country_code: "858",
    microchip_implanted_at: "2019-06-15",
    microchip_implanted_by: "Clínica Veterinaria Recoleta",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 4.8,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Recoleta",
    acquisition_method: "rescued",
    status: "active",
    owner: "lilian",
    notes:
      "Vet owns her own pet — exercises profiles.role='vet' + pet_events.author_role='owner' decoupling.",
  },
  events: [
    {
      date: "2019-05-10",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2019-06-15",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858010000000010",
        country_code: "858",
        implanted_by: "Clínica Veterinaria Recoleta",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2019-07-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "FVRCP + antirrábica" },
    },
    {
      date: "2019-09-22",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2025-05-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2026-05-15" },
    },
    {
      date: "2026-05-01",
      event_type: "weight_recorded",
      author_role: "owner",
      payload: { kg: 4.8 },
      notes: "Recorded by Lilian acting as owner — author_role!=vet despite profiles.role=vet",
    },
    {
      date: "2026-05-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2027-05-15" },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S011 — Coco (Patitas del Norte) — microchip_revoked + adoption_withdrawn
// ---------------------------------------------------------------------------

const coco: Storyline = {
  pet: {
    display_name: "Coco",
    public_token: "DIM-S011-PLRM",
    species: "cat",
    breed: "Común europeo",
    sex: "male",
    date_of_birth: "2023-04-20",
    color: "Naranja",
    microchip_id: "858011000000011",
    microchip_country_code: "858",
    microchip_implanted_at: "2024-12-05",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 5,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes:
      "Shelter custody. Chip revocado por fraude (chip duplicado detectado). Adoption_application_submitted retirada por solicitante.",
  },
  events: [
    {
      date: "2024-11-30",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "healthy" },
    },
    {
      date: "2024-11-30",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2024-12-05",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858011000000011",
        country_code: "858",
        implant_date_known: true,
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
      },
    },
    {
      date: "2024-12-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "FVRCP + antirrábica" },
    },
    {
      date: "2025-03-22",
      event_type: "microchip_replaced",
      author_role: "system",
      payload: {
        previous_chip_number: "858011000000011",
        new_chip_number: null,
        reason: "fraud_detected",
        replaced_by: "admin",
        replaced_at: "2025-03-22",
        actor_role: "admin",
        notes: "Chip duplicado detectado tras inspección sanitaria. Revocado pending re-implant.",
      },
      uncommon: true,
    },
    {
      date: "2025-03-25",
      event_type: "foster_proposed",
      author_role: "shelter",
      payload: { foster_user_id: "noeli", expected_weeks: 6 },
    },
    {
      date: "2025-03-27",
      event_type: "foster_proposal_resolved",
      author_role: "owner",
      payload: {
        proposal_public_token: "prop-coco-2025-03-25",
        outcome: "rejected",
        rejection_reason: "household",
        response_notes: "incompatibilidad con co-mascota actual (Pelusa)",
      },
      uncommon: true,
    },
    {
      date: "2025-04-04",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    {
      date: "2025-09-10",
      event_type: "adoption_application_submitted",
      author_role: "owner",
      payload: {
        applicant_user_id: "external_user_404",
        related_organization_id: "patitas-del-norte",
        housing_type: "departamento",
      },
    },
    {
      date: "2025-09-22",
      event_type: "adoption_reversed",
      author_role: "owner",
      payload: {
        actor: "adopter",
        reason: "Mudanza al exterior",
      },
      uncommon: true,
    },
    {
      date: "2026-04-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual", next_due_at: "2027-04-15" },
    },
    {
      date: "2026-05-09",
      event_type: "credential_scanned",
      author_role: "system",
      payload: {
        is_self_scan: false,
        viewer_authenticated: false,
        viewer_name: "potencial adoptante",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S012 — Negro (Patitas del Norte) — adoption_application_submitted PENDING
// ---------------------------------------------------------------------------

const negro: Storyline = {
  pet: {
    display_name: "Negro",
    public_token: "DIM-S012-RECO",
    species: "dog",
    breed: "Mestizo",
    sex: "male",
    date_of_birth: "2023-09-12",
    color: "Negro con pecho blanco",
    microchip_id: "858012000000012",
    microchip_country_code: "858",
    microchip_implanted_at: "2025-01-10",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 16,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Recoleta",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes:
      "Shelter custody. adoption_application_submitted PENDING Alejo's review at the time of the seed.",
  },
  events: [
    {
      date: "2024-12-22",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "underweight" },
    },
    {
      date: "2024-12-22",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2025-01-10",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858012000000012",
        country_code: "858",
        implant_date_known: true,
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
      },
    },
    {
      date: "2025-01-20",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica catch-up" },
    },
    {
      date: "2025-04-15",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    {
      date: "2025-10-22",
      event_type: "adoption_eligibility_set",
      author_role: "shelter",
      payload: { eligible: true, set_by_user_id: "alejo" },
    },
    {
      date: "2026-05-10",
      event_type: "adoption_application_submitted",
      author_role: "owner",
      location: CABA("Recoleta"),
      payload: {
        applicant_user_id: "external_user_512",
        related_organization_id: "patitas-del-norte",
        housing_type: "casa con jardín",
        other_pets: false,
        daily_routine: "WFH, paseos 2x día",
      },
      uncommon: true,
    },
    {
      date: "2026-05-11",
      event_type: "credential_scanned",
      author_role: "system",
      payload: {
        is_self_scan: false,
        viewer_authenticated: true,
        viewer_name: "external_user_512 (revisando)",
      },
    },
    // application is PENDING — no _approved or _rejected event yet
  ],
};

// ---------------------------------------------------------------------------
// DIM-S013 — Bichita (Patitas del Norte) — guinea pig, foster_proposal_cancelled
// ---------------------------------------------------------------------------

const bichita: Storyline = {
  pet: {
    display_name: "Bichita",
    public_token: "DIM-S013-PLRM",
    species: "guinea_pig",
    breed: "Cobayo americano",
    sex: "female",
    date_of_birth: "2024-11-10",
    color: "Tricolor",
    estimated_weight_kg: 0.9,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes:
      "Shelter custody. Foster proposal cancelled. adoption_eligibility_set TRUE — listed on /adoptar.",
  },
  events: [
    {
      date: "2025-02-15",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "healthy" },
    },
    {
      date: "2025-02-15",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2025-03-01",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "intake_exam" },
    },
    {
      date: "2025-09-22",
      event_type: "foster_proposed",
      author_role: "shelter",
      payload: { foster_user_id: "noeli", expected_weeks: 4 },
    },
    {
      date: "2025-09-24",
      event_type: "foster_proposal_resolved",
      author_role: "shelter",
      payload: {
        proposal_public_token: "prop-bichita-2025-09-22",
        outcome: "cancelled",
        cancellation_reason: "Refugio cancela — voluntaria asignada a urgencia previa",
      },
      uncommon: true,
    },
    {
      date: "2025-10-05",
      event_type: "adoption_eligibility_set",
      author_role: "shelter",
      payload: {
        eligible: true,
        set_by_user_id: "alejo",
        reason: "evaluación completa — apta para adopción",
      },
      uncommon: true,
    },
    { date: "2026-04-20", event_type: "weight_recorded", author_role: "vet", payload: { kg: 0.9 } },
  ],
};

// ---------------------------------------------------------------------------
// DIM-S014 — Pepito (Ignacio) — rabbit, Palermo
// ---------------------------------------------------------------------------

const pepito: Storyline = {
  pet: {
    display_name: "Pepito",
    public_token: "DIM-S014-PLRM",
    species: "rabbit",
    breed: "Conejo común",
    sex: "male",
    date_of_birth: "2024-08-20",
    color: "Gris azulado",
    estimated_weight_kg: 2.1,
    known_allergies: ["apio"],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "adopted",
    status: "active",
    owner: "ignacio",
  },
  events: [
    {
      date: "2024-10-15",
      event_type: "pet_registered",
      author_role: "owner",
      payload: { acquisition_method: "adopted" },
    },
    {
      date: "2024-11-01",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "Mixomatosis + RHD2" },
    },
    {
      date: "2024-12-22",
      event_type: "deworming_administered",
      author_role: "vet",
      payload: { product: "fenbendazol", type: "internal" },
    },
    {
      date: "2025-10-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "Mixomatosis + RHD2 anual", next_due_at: "2026-10-15" },
    },
    {
      date: "2026-03-22",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: {
        sub_kind: "allergy_detection",
        title: "Dermatitis de contacto por apio confirmada",
      },
    },
    { date: "2026-04-30", event_type: "weight_recorded", author_role: "vet", payload: { kg: 2.1 } },
    {
      date: "2026-05-10",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "wellness" },
    },
  ],
};

// ===========================================================================
// Aggregated export — Maximus removed due to in-flight truncation.
// Recent-mortality datapoints come from Brian (2023), Tom (2024), Cujo (2024),
// Scooby (2025), Puss (2026) across the other files.
// ===========================================================================

// ---------------------------------------------------------------------------
// DIM-S016 — Milanesa (Patitas del Norte) — gata joven, apta y publicada
// DIM-S017 — Pochoclo (Patitas del Norte) — gatito, apto y publicado
//
// Blind QA 2026-08-19 (O8): a citizen came to adopt a young cat, filtered
// ESPECIE = Gatos on /adoptar and got "No hay mascotas con esos filtros" — the
// whole published catalog was two dogs and a guinea pig. Not a bug in the
// filter: there was not one cat to find. Cats are the most common adoption
// search in Argentina, so the demo answered the single most likely question
// with an empty page.
//
// Two, not one, and in different age buckets: one cat makes the filter return
// a list of length one, which reads as a placeholder rather than a catalog.
// ---------------------------------------------------------------------------

const milanesa: Storyline = {
  pet: {
    display_name: "Milanesa",
    public_token: "DIM-S016-PLRM",
    species: "cat",
    breed: "Común europeo",
    sex: "female",
    date_of_birth: "2025-04-12",
    color: "Atigrada marrón",
    microchip_id: "858016000000016",
    microchip_country_code: "858",
    microchip_implanted_at: "2025-09-30",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 3.4,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes:
      "Shelter custody. adoption_eligibility_set TRUE — listed on /adoptar as the young-cat option.",
  },
  events: [
    {
      date: "2025-09-28",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "healthy" },
    },
    {
      date: "2025-09-28",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2025-09-30",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858016000000016",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2025-10-05",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "Triple felina" },
    },
    {
      date: "2025-10-05",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "Antirrábica" },
    },
    {
      date: "2025-11-18",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "spay" },
    },
    {
      date: "2025-12-02",
      event_type: "adoption_eligibility_set",
      author_role: "shelter",
      payload: {
        eligible: true,
        set_by_user_id: "alejo",
        reason: "evaluación de temperamento completa — sociable, apta para departamento",
      },
      uncommon: true,
    },
    {
      date: "2026-07-28",
      event_type: "weight_recorded",
      author_role: "shelter",
      payload: { kg: 3.4 },
    },
  ],
};

const pochoclo: Storyline = {
  pet: {
    display_name: "Pochoclo",
    public_token: "DIM-S017-PLRM",
    species: "cat",
    breed: "Común europeo",
    sex: "male",
    date_of_birth: "2026-04-20",
    color: "Negro con pecho blanco",
    microchip_id: "858017000000017",
    microchip_country_code: "858",
    microchip_implanted_at: "2026-07-10",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 1.6,
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    status: "active",
    owner: "org:patitas-del-norte",
    notes:
      "Shelter custody. Gatito rescatado de una camada. Sin castrar por edad — adoption_eligibility_set TRUE.",
  },
  events: [
    {
      date: "2026-07-08",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      payload: { intake_reason: "stray_found", intake_condition: "healthy" },
    },
    {
      date: "2026-07-08",
      event_type: "pet_registered",
      author_role: "shelter",
      payload: { acquisition_method: "rescued" },
    },
    {
      date: "2026-07-10",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858017000000017",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2026-07-12",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "Triple felina" },
    },
    {
      date: "2026-07-25",
      event_type: "adoption_eligibility_set",
      author_role: "shelter",
      payload: {
        eligible: true,
        set_by_user_id: "alejo",
        reason: "camada sana — apto para adopción con seguimiento",
      },
      uncommon: true,
    },
    {
      date: "2026-08-05",
      event_type: "weight_recorded",
      author_role: "shelter",
      payload: { kg: 1.6 },
    },
  ],
};

export const SUPPORTING_STORYLINES: Storyline[] = [
  firulais,
  michi,
  romeo,
  hercules,
  luna,
  pelusa,
  cielo,
  toby,
  lola,
  pampita,
  coco,
  negro,
  bichita,
  pepito,
  milanesa,
  pochoclo,
];
