/**
 * Dangerous-breed bite-incident storylines.
 *
 *   Cujo — Saint Bernard, Ignacio. Contracts rabies from a bat exposure,
 *          bites his handler, tests positive on PCR, euthanized per protocol.
 *          Exercises the full death/disposition cycle with cause='euthanasia',
 *          confirmed_by_vet=true, vet_decided_alone=false, disease_code='rabies',
 *          is_reportable=true.
 *
 *   Roco — Pit Bull, Noelí. Registration auto-flags potentially_dangerous_breed.
 *          Owner files dangerous_breed_attested (registry='caba_4078'). One
 *          provocation bite on a passerby in Plaza Italia; rabies observation
 *          opens and closes clean after 10 days. Pet alive at end.
 *
 * These two storylines together exercise:
 *   - dangerous_breed_attested
 *   - incident_reported(bite_inflicted) → rabies_observation_started/ended
 *   - death_recorded with is_reportable=true + disease_code
 *   - outbreak_signal triggered by rabies+
 */

import type { Storyline } from "./seed-storylines-iconic";

const CABA = (locality: string, landmark?: string) => ({
  locality,
  province: "CABA",
  ...(landmark ? { landmark } : {}),
});

// ---------------------------------------------------------------------------
// Cujo — Saint Bernard, rabies+ euthanasia
// ---------------------------------------------------------------------------

const cujo: Storyline = {
  pet: {
    display_name: "Cujo",
    public_token: "DIM-CUJO-0020",
    species: "dog",
    breed: "San Bernardo",
    sex: "male",
    date_of_birth: "2018-05-20",
    color: "Marrón y blanco",
    microchip_id: "858700200300400",
    microchip_country_code: "858",
    microchip_implanted_at: "2018-07-15",
    microchip_implanted_by: "Clínica Veterinaria Recoleta",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 68,
    potentially_dangerous_breed: false, // not PPP per CABA 4078 / Prov 14.107
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Puerto Madero",
    acquisition_method: "purchased",
    emergency_info_visible: true,
    status: "deceased",
    owner: "ignacio",
    photo_file: "cujo.jpg",
    notes:
      "Perro guardián grande. Final cycle: rabia confirmada por laboratorio → eutanasia + cremación colectiva por protocolo zoonosis.",
  },
  events: [
    {
      date: "2018-05-20",
      event_type: "pet_registered",
      author_role: "owner",
      location: CABA("Puerto Madero"),
      payload: {
        acquisition_method: "purchased",
        note: "Comprado en criadero responsable, La Rural",
      },
    },
    {
      date: "2018-06-15",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "intake_exam" },
    },
    {
      date: "2018-07-15",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858700200300400",
        country_code: "858",
        implanted_by: "Clínica Veterinaria Recoleta",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2018-08-20",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP #1 + antirrábica" },
    },
    {
      date: "2018-09-15",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP #2" },
    },
    {
      date: "2019-08-20",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2020-08-20" },
    },
    {
      date: "2019-10-22",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration" },
    },
    { date: "2020-04-15", event_type: "weight_recorded", author_role: "vet", payload: { kg: 65 } },
    {
      date: "2020-08-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2021-08-22" },
    },
    {
      date: "2021-03-10",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "displasia codo bilateral" },
    },
    {
      date: "2021-04-05",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: { sub_kind: "imaging", title: "Rx codos — displasia bilateral moderada" },
    },
    {
      date: "2021-04-22",
      event_type: "medication_started",
      author_role: "vet",
      payload: {
        drug_name: "carprofeno",
        dose: "2 mg/kg",
        frequency: "BID",
        first_dose_at: "2021-04-22",
        schedule_count: 365,
      },
    },
    {
      date: "2021-08-25",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2022-08-25" },
    },
    {
      date: "2022-04-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "antirrábica adelantada", next_due_at: "2023-04-22" },
    },
    {
      date: "2023-04-30",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "antirrábica", next_due_at: "2024-04-30" },
    },
    { date: "2023-09-09", event_type: "weight_recorded", author_role: "vet", payload: { kg: 68 } },
    {
      date: "2024-03-15",
      event_type: "incident_reported",
      author_role: "owner",
      location: CABA("Puerto Madero", "quinta familiar San Antonio de Areco"),
      payload: {
        incident_type: "other",
        severity: "leve",
        injuries_summary:
          "Encontrado peleando con murciélago en galpón. Sin heridas visibles en piel — posible exposición salival.",
      },
      uncommon: true,
    },
    {
      date: "2024-03-16",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "post-exposure exam — exposición a murciélago, sin heridas claras" },
      uncommon: true,
    },
    {
      date: "2024-03-16",
      event_type: "note_added",
      author_role: "vet",
      payload: {
        category: "alerta_clínica",
        text: "Refuerzo antirrábico aplicado hoy — vencimiento estaba próximo. Monitoreo de signos sistémicos por 30 días.",
      },
    },
    {
      date: "2024-03-16",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "antirrábica refuerzo post-exposición", next_due_at: "2025-03-16" },
    },
    {
      date: "2024-04-22",
      event_type: "symptom_observed",
      author_role: "owner",
      payload: {
        source: "libreta",
        reporter_role: "owner",
        free_text: "Cambios conductuales — agresividad sin causa, hipersalivación, fotofobia",
        matched_symptom_codes: ["aggression_unprovoked", "hypersalivation", "photophobia"],
        alerted_disease_codes: ["rabies"],
        severity_self_assessed: "alta",
        onset_at: "2024-04-20",
      },
      uncommon: true,
    },
    {
      date: "2024-04-23",
      event_type: "incident_reported",
      author_role: "owner",
      location: CABA("Puerto Madero"),
      payload: {
        incident_type: "bite_inflicted",
        severity: "alta",
        injuries_summary:
          "Mordedura no provocada al cuidador (Ignacio). Heridas perforantes mano derecha — 12 puntos.",
        victim_contact_name: "Ignacio del Valle",
        victim_contact_phone: "+54 9 11 5555-2001",
        rabies_vaccine_valid_at_incident: true,
        context:
          "perro previamente expuesto a murciélago + signos clínicos compatibles con rabia furiosa",
      },
      uncommon: true,
    },
    {
      date: "2024-04-23",
      event_type: "rabies_observation_started",
      author_role: "vet",
      payload: {
        incident_reported_event_id: "evt-cujo-bite-2024-04-23",
        expected_end_at: "2024-05-03",
        isolation_facility: "Clínica Veterinaria Recoleta — sala de aislamiento",
        protocol: "Ley 22.953 — observación 10 días + RIFI",
      },
      uncommon: true,
    },
    {
      date: "2024-04-25",
      event_type: "symptom_observed",
      author_role: "vet",
      payload: {
        source: "libreta",
        reporter_role: "vet",
        free_text: "Empeoramiento — parálisis ascendente día 2 de observación",
        matched_symptom_codes: ["ascending_paralysis", "hypersalivation"],
        alerted_disease_codes: ["rabies"],
      },
      uncommon: true,
    },
    {
      date: "2024-04-26",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: {
        sub_kind: "lab_work",
        title: "RIFI antígeno rábico — POSITIVO",
        details:
          "Inmunofluorescencia directa sobre raspado corneal: positivo. Confirmación por Instituto Pasteur.",
      },
      uncommon: true,
    },
    {
      date: "2024-04-26",
      event_type: "outbreak_signal",
      author_role: "system",
      payload: {
        source_symptom_event_id: "sym-cujo-2024-04-22",
        disease_code: "rabies",
        disease_label: "Rabia canina (confirmada por laboratorio)",
        match_strength: {
          high_count: 3,
          medium_count: 1,
          low_count: 0,
          matched_symptom_codes: [
            "aggression_unprovoked",
            "hypersalivation",
            "ascending_paralysis",
          ],
        },
        pet_jurisdiction_country: "AR",
        pet_jurisdiction_province: "CABA",
        pet_jurisdiction_locality: "Puerto Madero",
        pet_species: "dog",
        severity: "urgent",
      },
      uncommon: true,
    },
    {
      date: "2024-04-26",
      event_type: "rabies_observation_ended",
      author_role: "vet",
      payload: {
        outcome: "positive_rabies",
        lab_result: "RIFI positivo confirmado",
        closed_by_vet: true,
      },
      uncommon: true,
    },
    {
      date: "2024-04-26",
      event_type: "death_recorded",
      author_role: "vet",
      location: CABA("Recoleta"),
      payload: {
        cause: "euthanasia",
        cause_detail:
          "Eutanasia humanitaria por rabia confirmada por laboratorio. Protocolo Ley 22.953 + decisión conjunta con dueño.",
        confirmed_by_vet: true,
        vet_name: "Dra. Lilian Marrone",
        disposition_method: "cremation_collective",
        facility: "Crematorio Mascotas Norte, Tigre (incineración sanitaria)",
        death_at_clinic: true,
        vet_contacted_owner: "yes",
        vet_decided_alone: false,
        owner_to_private_crematorium: false,
        disease_code: "rabies",
        confirmed_by_lab: true,
        is_reportable: true,
      },
      uncommon: true,
    },
    {
      date: "2024-04-27",
      event_type: "note_added",
      author_role: "owner",
      payload: {
        category: "despedida",
        text: "Cujo — fuiste un guardián bueno. No te culpo del murciélago. — Ignacio",
      },
      uncommon: true,
    },
    {
      date: "2024-04-27",
      event_type: "note_added",
      author_role: "govt",
      payload: {
        category: "denuncia_sanitaria",
        text: "Caso reportado a SENASA + Mascotas BA. Vacunación de contactos canino-felinos en radio 5 cuadras coordinada con Lucas Etcheverry (Comuna 1).",
      },
      uncommon: true,
    },
    {
      date: "2024-05-23",
      event_type: "note_added",
      author_role: "vet",
      payload: {
        category: "post-mortem_followup",
        text: "Mordedura humana: Ignacio completó esquema post-exposición. Sin signos.",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Roco — Pit Bull, PPP, bite + clean rabies obs
// ---------------------------------------------------------------------------

const roco: Storyline = {
  pet: {
    display_name: "Roco",
    public_token: "DIM-ROCO-0021",
    species: "dog",
    breed: "Pit Bull Terrier Americano",
    sex: "male",
    date_of_birth: "2022-03-10",
    color: "Atigrado",
    distinguishing_features: "Cicatriz vertical sobre el ojo izquierdo",
    microchip_id: "858800400500600",
    microchip_country_code: "858",
    microchip_implanted_at: "2023-01-20",
    microchip_implanted_by: "Refugio Patitas del Norte",
    microchip_location: "interscapular_left",
    estimated_weight_kg: 32,
    known_allergies: ["pollo"],
    training_level: "intermediate",
    potentially_dangerous_breed: true, // auto-flag por raza
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Palermo",
    acquisition_method: "rescued",
    emergency_info_visible: true,
    status: "active",
    owner: "noeli",
    photo_file: "pitbul.jpg",
    notes:
      "Pit Bull rescatado de la calle. Raza PPP — registrado en Ley CABA 4078. Una mordedura de provocación; observación antirrábica negativa.",
  },
  events: [
    {
      date: "2023-01-15",
      event_type: "shelter_intake_recorded",
      author_role: "shelter",
      location: CABA("Palermo"),
      payload: {
        intake_reason: "stray_found",
        intake_condition: "underweight",
        org: "Refugio Patitas del Norte",
      },
    },
    {
      date: "2023-01-18",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "intake_exam" },
    },
    {
      date: "2023-01-20",
      event_type: "microchip_implanted",
      author_role: "vet",
      payload: {
        chip_number: "858800400500600",
        country_code: "858",
        implanted_by: "Refugio Patitas del Norte",
        location_on_body: "interscapular_left",
        implant_date_known: true,
      },
    },
    {
      date: "2023-01-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "DHPP + antirrábica catch-up" },
    },
    {
      date: "2023-02-04",
      event_type: "adoption_application_submitted",
      author_role: "owner",
      payload: {
        applicant_user_id: "Noelí Assandri",
        related_organization_id: "patitas-del-norte",
        housing_type: "departamento + balcón, pet-friendly",
      },
    },
    {
      date: "2023-02-08",
      event_type: "adoption_application_resolved",
      author_role: "shelter",
      payload: {
        application_event_id: "evt-roco-app-2023-02-04",
        reviewer_user_id: "org-admin",
        outcome: "approved",
      },
    },
    {
      date: "2023-02-15",
      event_type: "adoption_finalized",
      author_role: "shelter",
      location: CABA("Palermo"),
      payload: {
        previous_owner_organization_id: "patitas-del-norte",
        adopter_user_id: "Noelí Assandri",
        post_adoption_followup_months: 6,
      },
      uncommon: true,
    },
    {
      date: "2023-02-15",
      event_type: "pet_registered",
      author_role: "owner",
      payload: {
        acquisition_method: "adopted",
        note: "Auto-flag PPP por raza (CABA 4078 + Prov 14.107)",
      },
      uncommon: true,
    },
    {
      date: "2023-03-01",
      event_type: "dangerous_breed_attested",
      author_role: "owner",
      location: CABA("Palermo"),
      payload: {
        registry: "caba_4078",
        registry_id: "PPP-CABA-2023-001847",
        attested_at: "2023-03-01",
        attestor_dni_verified: true,
      },
      uncommon: true,
    },
    {
      date: "2023-04-22",
      event_type: "post_adoption_checkin",
      author_role: "shelter",
      payload: {
        related_organization_id: "patitas-del-norte",
        notes: "2-mes — aclimatación buena, sociable con humanos",
      },
    },
    {
      date: "2023-05-15",
      event_type: "sterilization_performed",
      author_role: "vet",
      payload: { procedure: "castration", performed_by: "Dra. Lilian Marrone" },
    },
    {
      date: "2023-08-15",
      event_type: "post_adoption_checkin",
      author_role: "shelter",
      payload: { notes: "6-mes — cierre seguimiento" },
    },
    {
      date: "2023-09-09",
      event_type: "clinical_info_logged",
      author_role: "vet",
      payload: {
        sub_kind: "allergy_detection",
        title: "Dermatitis alimentaria — pollo identificado como gatillo",
      },
    },
    {
      date: "2024-01-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2025-01-22" },
    },
    { date: "2024-08-08", event_type: "weight_recorded", author_role: "vet", payload: { kg: 32 } },
    {
      date: "2025-01-22",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2026-01-22" },
    },
    {
      date: "2025-04-30",
      event_type: "incident_reported",
      author_role: "owner",
      location: CABA("Palermo", "Plaza Italia"),
      payload: {
        incident_type: "bite_inflicted",
        severity: "moderada",
        injuries_summary:
          "Mordedura de provocación al transeúnte (el transeúnte intentó tocar al perro sin pedir consentimiento). Herida superficial en antebrazo — 4 puntos.",
        victim_contact_name: "Pablo R.",
        victim_contact_phone: "+54 9 11 4567-8901",
        rabies_vaccine_valid_at_incident: true,
        context: "transeúnte se acercó por detrás y tocó al perro; reacción defensiva",
      },
      uncommon: true,
    },
    {
      date: "2025-04-30",
      event_type: "rabies_observation_started",
      author_role: "vet",
      payload: {
        incident_reported_event_id: "evt-roco-bite-2025-04-30",
        expected_end_at: "2025-05-10",
        isolation_facility: "domicilio del dueño (custodia supervisada)",
        protocol: "Ley 22.953 — observación 10 días en domicilio, vacuna antirrábica válida",
      },
      uncommon: true,
    },
    {
      date: "2025-05-03",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "check-in observación día 4 — asintomático" },
    },
    {
      date: "2025-05-07",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "check-in observación día 8 — asintomático" },
    },
    {
      date: "2025-05-10",
      event_type: "rabies_observation_ended",
      author_role: "vet",
      payload: {
        outcome: "negative",
        closed_by_vet: true,
        notes: "10 días sin signos. Cierre administrativo.",
      },
      uncommon: true,
    },
    {
      date: "2025-05-11",
      event_type: "note_added",
      author_role: "owner",
      payload: {
        category: "seguimiento",
        text: "Tomamos curso de manejo de perros PPP en Patitas del Norte. Bozal obligatorio en vía pública desde hoy.",
      },
    },
    {
      date: "2025-09-22",
      event_type: "weight_recorded",
      author_role: "vet",
      payload: { kg: 32.5 },
    },
    {
      date: "2026-01-25",
      event_type: "vaccination_administered",
      author_role: "vet",
      payload: { vaccine_name: "anual + antirrábica", next_due_at: "2027-01-25" },
    },
    {
      date: "2026-04-04",
      event_type: "vet_visit_logged",
      author_role: "vet",
      payload: { reason: "wellness anual + chequeo conductual" },
    },
    {
      date: "2026-05-12",
      event_type: "credential_scanned",
      author_role: "system",
      location: CABA("Palermo"),
      payload: { is_self_scan: true, viewer_authenticated: true },
    },
  ],
};

export const DANGEROUS_STORYLINES: Storyline[] = [cujo, roco];
