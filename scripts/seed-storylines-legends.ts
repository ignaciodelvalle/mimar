/**
 * Legends Batch Storylines — Demo Dataset Seed Fixtures
 *
 * Three historically iconic dogs relocated to Argentina, designed as
 * workflow stressors covering the 5 previously-missing event types:
 *   tattoo_recorded, tattoo_updated, ownership_claimed,
 *   custody_transfer_cancelled, disease_reported
 *
 * Characters:
 *   1. Bobbie el Maravilla — DIM-BOBB-0020 — Mar del Plata → Salta → regreso
 *   2. Frida la Rescatista — DIM-FRID-0021 — Defensa Civil CABA / Catamarca
 *   3. Owney el Perro Postal — DIM-OWNY-0022 — Correo Argentino, Retiro
 *
 * Token collision check (2026-06-12):
 *   Existing: 0001-0010, 0015-0019B (iconic), 0020 (Cujo), 0021 (Roco), S001-S014
 *   Safe new: 0020 IS taken by Cujo → reassign: BOBB-0022 not taken;
 *   Correct assignments: DIM-BOBB-0022, DIM-FRID-0023, DIM-OWNY-0024
 *
 * Owner mapping:
 *   Bobbie  → "graciela"  (family owner persona)
 *   Frida   → "org:mascotas-ba-centro"  (government/civil-defense org)
 *   Owney   → "org:rescate-puerto-madero"  (closest postal/public-service org)
 *
 * Run via:  pnpm tsx scripts/seed-demo.ts
 */

import type { PetBio, Storyline } from "./seed-storylines-iconic";

// Extended bio for service-dog pets — adds the optional `service_dog` block
// picked up by loadStoryline to insert a pet_service_dog row.
type PetBioWithServiceDog = PetBio & {
  service_dog?: {
    service_type: string;
    credential_status: string;
    training_center: string;
    training_cert_date?: string;
    in_service?: boolean;
    notes?: string;
  };
};

// ---------------------------------------------------------------------------
// Location helpers (mirrors seed-storylines-iconic.ts)
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
const loc = (locality: string, province: string, landmark?: string) => ({
  locality,
  province,
  ...(landmark ? { landmark } : {}),
});

// ===========================================================================
// 1. Bobbie el Maravilla
//    Canon: 1923 scotch collie, lost 4,000 km from home, walked back in 6 months.
//    Relocation: familia Brazier-Nores de Mar del Plata; perdido en Salta
//    agosto 1923; reaparece en Mar del Plata febrero 1924.
//    Owner: "graciela" (Graciela Saavedra)
// ===========================================================================

const bobbie: Storyline = {
  pet: {
    display_name: "Bobbie",
    public_token: "DIM-BOBB-0022",
    species: "dog",
    breed: "Scotch Collie",
    sex: "male",
    date_of_birth: "1921-09-01",
    birth_date_is_estimated: true,
    color: "Sable y blanco",
    estimated_weight_kg: 14.0,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "Buenos Aires",
    jurisdiction_locality: "Mar del Plata",
    status: "deceased",
    owner: "graciela",
    acquisition_method: "purchased",
    notes:
      "Scotch collie macho, perdido en Salta en agosto 1923 durante viaje vacacional, " +
      "regresó solo a Mar del Plata en febrero 1924 tras recorrer ~4000 km. " +
      "Murió en 1927. Fixture: custody_transfer_cancelled (refugio Tucumán), " +
      "ownership_claimed al retornar, sightings vía note_added a lo largo de la ruta.",
  },
  events: [
    // ----- Registro y vida normal en Mar del Plata -----
    {
      date: "1921-09-15",
      event_type: "pet_registered",
      location: BA("Mar del Plata"),
      payload: {
        name: "Bobbie",
        species: "dog",
        sex: "male",
        breed: "Scotch Collie",
        date_of_birth: "1921-09-01",
        birth_date_is_estimated: true,
        color: "Sable y blanco",
        microchip_id: null,
        microchip_country_code: null,
        microchip_implanted_at: null,
        microchip_implanted_by: null,
        microchip_location: null,
        estimated_weight_kg: "8.0",
        favourite_foods: [],
        known_allergies: [],
        training_level: "basic",
        insurance_company: null,
        insurance_policy_number: null,
        jurisdiction_province: "Buenos Aires",
        jurisdiction_locality: "Mar del Plata",
        potentially_dangerous_breed: false,
        acquisition_method: "purchased",
        has_photo: false,
        has_microchip: false,
        custody_kind: "owner",
      },
    },
    {
      date: "1921-10-01",
      event_type: "vet_visit_logged",
      location: BA("Mar del Plata"),
      payload: { reason: "intake_exam", diagnosis: null, vet_name: "Dr. Aldao", clinic: null },
    },
    {
      date: "1921-10-15",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1922-03-10",
      event_type: "weight_recorded",
      location: BA("Mar del Plata"),
      payload: { kg: "11.0" },
    },
    {
      date: "1922-06-15",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "moquillo + parvovirus",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1922-09-01",
      event_type: "note_added",
      location: BA("Mar del Plata"),
      payload: {
        category: "comportamiento",
        text: "Bobbie siempre vuelve a casa solo, no importa cuánto se aleje en la costa.",
      },
      uncommon: true,
    },
    {
      date: "1923-01-22",
      event_type: "weight_recorded",
      location: BA("Mar del Plata"),
      payload: { kg: "14.0" },
    },
    {
      date: "1923-04-08",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1923-07-15",
      event_type: "vet_visit_logged",
      location: BA("Mar del Plata"),
      payload: {
        reason: "wellness",
        diagnosis: "sano, excelente condición física",
        vet_name: "Dr. Aldao",
        clinic: null,
      },
    },
    // ⚑ tattoo_recorded — visita pre-viaje al Dr. Aldao; familia tatúa a Bobbie en Mar del Plata
    //    antes de partir hacia Salta para asegurar identificación permanente fuera de la ciudad.
    {
      date: "1923-07-20",
      event_type: "tattoo_recorded",
      location: BA("Mar del Plata"),
      payload: {
        tattoo_code: "MDP-1923-BOB",
        location_on_body: "inner_ear_left",
        description:
          "Tatuaje de identificación aplicado por el Dr. Aldao en consulta pre-viaje; código MDP asignado por la Municipalidad de Mar del Plata. Registrado antes del viaje vacacional a Salta.",
        recorded_by: "Dr. Aldao",
        recorded_at: "1923-07-20",
        tattoo_date_known: true,
      },
      uncommon: true,
    },
    // ----- Viaje vacacional a Salta — se pierde -----
    {
      date: "1923-08-15",
      event_type: "status_changed",
      location: loc("Salta Capital", "Salta", "Av. Entre Ríos y Balcarce"),
      payload: {
        from_status: "active",
        to_status: "lost",
        location_description:
          "Salta Capital, Av. Entre Ríos y Balcarce — se perdió durante parada de viaje",
        reason: "separado_familia_viaje",
      },
      uncommon: true,
    },
    // ----- Finder lo lleva al refugio de Tucumán -----
    {
      date: "1923-08-22",
      event_type: "note_added",
      location: loc("Tucumán Capital", "Tucumán", "Refugio Municipal El Colmenar"),
      payload: {
        category: "otro",
        text: "Avistamiento confirmado: vecino Ramón Díaz lo encontró errante en calle Córdoba y lo llevó al refugio municipal de Tucumán. Collar visible con dirección Mar del Plata.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    // ⚑ custody_transfer_proposed (refugio Tucumán → familia Nores, Mar del Plata)
    {
      date: "1923-08-25",
      event_type: "custody_transfer_proposed",
      location: loc("Tucumán Capital", "Tucumán", "Refugio Municipal El Colmenar"),
      payload: {
        // Placeholder principals for a 1923 paper-era proposal; schema XOR demands exactly one side each.
        from_user_id: null,
        from_organization_id: "f1cde500-0000-4000-8000-000000000001", // placeholder finder/refugio UUID
        to_user_id: null,
        to_organization_id: "0e5f0610-0000-4000-8000-000000000002", // placeholder refugio destino UUID
        reason: "return_to_original_owner",
        proposed_at: "1923-08-25T14:00:00Z",
        notes:
          "Perro identificado por collar con dirección Mar del Plata. Propuesta de devolución a familia Nores.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    // ⚑ custody_transfer_cancelled — el perro ya escapó del refugio antes de que la familia llegue
    {
      date: "1923-09-02",
      event_type: "custody_transfer_cancelled",
      location: loc("Tucumán Capital", "Tucumán"),
      payload: {
        // Deterministic UUID linking narratively to the custody_transfer_proposed of 1923-08-25.
        proposal_event_id: "b0bb1e00-0000-4000-8000-000000000001",
        cancelled_by: "auto_cancel",
        reason:
          "El perro escapó del refugio la noche del 01/09. La propuesta de devolución ya no es ejecutable.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    // ----- Avistamientos a lo largo de la ruta (Tucumán → Córdoba → Rosario → Mar del Plata) -----
    {
      date: "1923-09-10",
      event_type: "note_added",
      location: loc("Santiago del Estero Capital", "Santiago del Estero"),
      payload: {
        category: "otro",
        text: "Avistamiento: Sra. Dolores Paéz vio a un collie sable-blanco cruzar la plaza central en dirección sur.",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1923-09-28",
      event_type: "note_added",
      location: loc("Córdoba Capital", "Córdoba"),
      payload: {
        category: "otro",
        text: "Avistamiento: policía municipal registra perro grande collie, pelaje sable-blanco, pasando por Av. Colón hacia el sur. Collar visible.",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1923-10-20",
      event_type: "note_added",
      location: loc("Villa María", "Córdoba"),
      payload: {
        category: "otro",
        text: "Avistamiento: carnicero Evaristo Solís le dio carne; el perro siguió caminando sin detenerse más de una hora.",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1923-11-14",
      event_type: "note_added",
      location: loc("Rosario", "Santa Fe"),
      payload: {
        category: "otro",
        text: "Avistamiento múltiple: tres vecinos del barrio Abasto reportan collie cruzando la ciudad de oeste a este.",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1923-12-05",
      event_type: "note_added",
      location: loc("Venado Tuerto", "Santa Fe"),
      payload: {
        category: "otro",
        text: "Avistamiento: veterinario rural Dr. Fontana le curó una pata lastimada. El perro partió al día siguiente.",
      },
      author_role: "system",
      uncommon: true,
    },
    {
      date: "1924-01-10",
      event_type: "note_added",
      location: BA("Tandil"),
      payload: {
        category: "otro",
        text: "Avistamiento: hacendado Luis Pereyra lo identificó por el collar. Se negó a quedarse.",
      },
      author_role: "system",
      uncommon: true,
    },
    // ----- Regreso a Mar del Plata — ownership_claimed -----
    {
      date: "1924-02-04",
      event_type: "status_changed",
      location: BA("Mar del Plata", "frente al hogar de la familia Nores"),
      payload: {
        from_status: "lost",
        to_status: "active",
        location_description:
          "Mar del Plata — regresó a la puerta de su casa tras ~4000 km en 6 meses",
        reason: "self_return",
      },
      uncommon: true,
    },
    // ⚑ ownership_claimed: familia reclamó al perro como suyo usando el collar como identificador
    {
      date: "1924-02-04",
      event_type: "ownership_claimed",
      location: BA("Mar del Plata"),
      payload: {
        claimed_by_user_id: "00000000-0000-0000-0000-000000000000", // placeholder; loader skips FK validation
        identifier_kind: "tattoo",
      },
      author_role: "owner",
      uncommon: true,
    },
    {
      date: "1924-02-05",
      event_type: "note_added",
      location: BA("Mar del Plata"),
      payload: {
        category: "otro",
        text: "Bobbie llegó flaco, con patas callosas, pero sano. La familia Nores lo reconoció de inmediato. La noticia salió en el diario El Atlántico: 'El perro que caminó solo desde Salta'.",
      },
      uncommon: true,
    },
    {
      date: "1924-02-10",
      event_type: "vet_visit_logged",
      location: BA("Mar del Plata"),
      payload: {
        reason: "post_return_exam",
        diagnosis: "Desnutrición moderada, callosidades en almohadillas, sin signos de infección",
        vet_name: "Dr. Aldao",
        clinic: null,
      },
      uncommon: true,
    },
    {
      date: "1924-02-12",
      event_type: "weight_recorded",
      location: BA("Mar del Plata"),
      payload: { kg: "11.5" },
    },
    {
      date: "1924-02-15",
      event_type: "medication_started",
      location: BA("Mar del Plata"),
      payload: {
        drug_name: "Suplemento vitamínico + refuerzo proteico",
        dose: "n/a",
        frequency: "once_daily",
        prescribed_by: "Dr. Aldao",
        drug_code: null,
        first_dose_at: "1924-02-15",
        duration_days: 30,
        custom_hours: null,
        schedule_count: 30,
      },
    },
    {
      date: "1924-03-20",
      event_type: "medication_stopped",
      location: BA("Mar del Plata"),
      payload: {
        medication_started_event_id: "00000000-0000-0000-0000-000000000001",
        reason: "Recuperación completa",
      },
    },
    {
      date: "1924-04-22",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "antirrábica (dosis de reingreso)",
        brand: null,
        batch: null,
        administered_by: "Dr. Aldao",
        next_due_at: null,
      },
    },
    {
      date: "1924-06-01",
      event_type: "weight_recorded",
      location: BA("Mar del Plata"),
      payload: { kg: "13.8" },
    },
    {
      date: "1924-09-15",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1924-11-03",
      event_type: "note_added",
      location: BA("Mar del Plata"),
      payload: {
        category: "comportamiento",
        text: "La Municipalidad de Mar del Plata otorgó a Bobbie una placa de reconocimiento: 'El Perro Viajero'. Ceremonia en la plaza San Martín.",
      },
      uncommon: true,
    },
    {
      date: "1925-04-15",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1925-08-08",
      event_type: "vet_visit_logged",
      location: BA("Mar del Plata"),
      payload: { reason: "wellness", diagnosis: null, vet_name: "Dr. Aldao", clinic: null },
    },
    // ⚑ tattoo_updated — el tatuaje perdió contraste tras la exposición solar; se retoca
    {
      date: "1925-11-10",
      event_type: "tattoo_updated",
      location: BA("Mar del Plata"),
      payload: {
        previous_tattoo_code: "MDP-1923-BOB",
        new_tattoo_code: "MDP-1923-BOB",
        reason: "Re-tatuaje preventivo por fading solar: código idéntico, trazo más profundo.",
      },
      uncommon: true,
    },
    {
      date: "1926-04-22",
      event_type: "vaccination_administered",
      location: BA("Mar del Plata"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1926-08-15",
      event_type: "weight_recorded",
      location: BA("Mar del Plata"),
      payload: { kg: "13.2" },
    },
    {
      date: "1926-11-20",
      event_type: "symptom_observed",
      location: BA("Mar del Plata"),
      payload: {
        source: "libreta",
        welfare_report_id: null,
        reporter_role: "owner",
        free_text: "Cojera miembro posterior izquierdo, probable artritis senil",
        matched_symptom_codes: ["lameness_hind"],
        alerted_disease_codes: [],
        severity_self_assessed: "mild",
        onset_at: "1926-11-15",
      },
      uncommon: true,
    },
    {
      date: "1926-12-01",
      event_type: "medication_started",
      location: BA("Mar del Plata"),
      payload: {
        drug_name: "Aspirina compuesta (paliativos de época)",
        dose: "0.5 g/día",
        frequency: "once_daily",
        prescribed_by: "Dr. Aldao",
        drug_code: null,
        first_dose_at: "1926-12-01",
        duration_days: 60,
        custom_hours: null,
        schedule_count: 60,
      },
    },
    // ----- Muerte 1927 -----
    {
      date: "1927-03-18",
      event_type: "death_recorded",
      location: BA("Mar del Plata"),
      payload: {
        cause: "natural",
        cause_detail:
          "Vejez natural; artritis senil avanzada + fallo orgánico múltiple (edad estimada 5-6 años)",
        confirmed_by_vet: true,
        vet_name: "Dr. Aldao",
        disposition_method: "owner_burial",
        facility: "Jardín de la familia Nores, Mar del Plata",
        death_at_clinic: false,
        clinic_name: null,
        vet_contacted_owner: "yes",
        vet_decided_alone: null,
        owner_to_private_crematorium: null,
        disease_code: null,
        confirmed_by_lab: null,
        is_reportable: false,
        during_rabies_observation: false,
      },
      uncommon: true,
    },
    {
      date: "1927-03-19",
      event_type: "note_added",
      location: BA("Mar del Plata"),
      payload: {
        category: "otro",
        text: "Bobbie descansa en el jardín de la familia. La placa de la Municipalidad sigue en la puerta de casa. Caminaste más que ninguno. — Familia Nores",
      },
      uncommon: true,
    },
  ],
};

// ===========================================================================
// 2. Frida la Rescatista
//    Canon: labradora parda, perra de USAR/Defensa Civil; 52 rescates;
//    retiro 2019, muerte 2022-11-15.
//    Relocation: Defensa Civil CABA; despliegue en sismo Catamarca 2017 +
//    derrumbes CABA. Owner: "org:mascotas-ba-centro" (sanitary authority)
// ===========================================================================

const fridaBio: PetBioWithServiceDog = {
  display_name: "Frida",
  public_token: "DIM-FRID-0023",
  species: "dog",
  breed: "Labrador Retriever",
  sex: "female",
  date_of_birth: "2009-04-15",
  birth_date_is_estimated: false,
  color: "Castaña (chocolate)",
  estimated_weight_kg: 32.0,
  known_allergies: [],
  potentially_dangerous_breed: false,
  jurisdiction_country: "AR",
  jurisdiction_province: "CABA",
  jurisdiction_locality: "Retiro",
  status: "deceased",
  owner: "org:mascotas-ba-centro",
  acquisition_method: "bred",
  notes:
    "Perra de búsqueda y rescate (USAR) de Defensa Civil CABA. " +
    "52 rescates confirmados. Desplegada en sismo Catamarca 2017. " +
    "Fixture: pet_service_dog registry, disease_reported (leishmaniasis), vet followup arc, " +
    "retirement ceremony, death 2022-11-15.",
  // Picked up by loadStoryline to insert a pet_service_dog row.
  service_dog: {
    service_type: "otro", // USAR / búsqueda-rescate; no ANDIS enum maps exactly
    credential_status: "vencida", // credential expired at death
    training_center: "Escuela Canina Defensa Civil CABA — Unidad USAR",
    training_cert_date: "2011-04-15",
    in_service: false, // retired 2019, deceased 2022
    notes:
      "Unidad USAR Defensa Civil CABA — 52 rescates certificados 2012–2018. " +
      "Desplegada en sismo Catamarca enero 2017. Retiro con honores junio 2019. " +
      "Leishmaniasis visceral crónica (exposición ocupacional). " +
      "Credential_status=vencida: carnet vencido al fallecimiento; no vigente por DB constraint.",
  },
};

const frida: Storyline = {
  pet: fridaBio as PetBio,
  events: [
    // ----- Registro -----
    {
      date: "2009-06-10",
      event_type: "pet_registered",
      location: CABA("Retiro", "Sede Defensa Civil CABA, Av. Leandro N. Alem 110"),
      payload: {
        name: "Frida",
        species: "dog",
        sex: "female",
        breed: "Labrador Retriever",
        date_of_birth: "2009-04-15",
        birth_date_is_estimated: false,
        color: "Castaña (chocolate)",
        microchip_id: null,
        microchip_country_code: null,
        microchip_implanted_at: null,
        microchip_implanted_by: null,
        microchip_location: null,
        estimated_weight_kg: "7.5",
        favourite_foods: [],
        known_allergies: [],
        training_level: "none",
        insurance_company: null,
        insurance_policy_number: null,
        jurisdiction_province: "CABA",
        jurisdiction_locality: "Retiro",
        potentially_dangerous_breed: false,
        acquisition_method: "born_in_litter",
        has_photo: false,
        has_microchip: false,
        custody_kind: "owner_by_org",
      },
      author_role: "govt",
    },
    {
      date: "2009-06-10",
      event_type: "microchip_implanted",
      location: CABA("Retiro"),
      payload: {
        chip_number: "985170007654321",
        country_code: "985",
        implanted_by: "Dra. Marcela Ruíz (veterinaria Defensa Civil)",
        location_on_body: "interscapular",
        implant_date_known: true,
      },
      uncommon: true,
    },
    {
      date: "2009-06-15",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "intake_exam",
        diagnosis: "cachorra sana, BCS 5/9",
        vet_name: "Dra. Ruíz",
        clinic: "Veterinaria Defensa Civil CABA",
      },
      author_role: "vet",
    },
    {
      date: "2009-07-01",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "moquillo + parvovirus + hepatitis",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2009-07-15",
      event_type: "deworming_administered",
      location: CABA("Retiro"),
      payload: {
        product: "fenbendazol",
        type: "internal",
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2009-09-22",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "13.0" },
    },
    {
      date: "2010-01-15",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2010-04-01",
      event_type: "note_added",
      location: CABA("Retiro"),
      payload: {
        category: "comportamiento",
        text: "Frida completó el módulo de agility básico. Rendimiento destacado en búsqueda de víctimas bajo escombros. Se recomienda avanzar a nivel intermedio.",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "2010-08-15",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "21.0" },
    },
    {
      date: "2011-01-20",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "wellness_anual",
        diagnosis: "sana",
        vet_name: "Dra. Ruíz",
        clinic: null,
      },
      author_role: "vet",
    },
    {
      date: "2011-02-10",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual pentavalente + antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2011-06-22",
      event_type: "sterilization_performed",
      location: CABA("Retiro"),
      payload: {
        procedure: "spay",
        performed_by: "Dra. Ruíz",
        clinic: "Veterinaria Defensa Civil CABA",
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2012-02-08",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2012-04-15",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "30.5" },
    },
    {
      date: "2012-09-10",
      event_type: "note_added",
      location: CABA("San Nicolás", "Edificio colapsado, Viamonte y Reconquista"),
      payload: {
        category: "comportamiento",
        text: "RESCATE #1 documentado. Derrumbe por explosión de gas. Frida localizó a 2 sobrevivientes bajo 3 m de escombros en 18 minutos. Personal de USAR-CABA certificó el rescate.",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "2013-03-01",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2013-08-22",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: { reason: "wellness", diagnosis: null, vet_name: "Dra. Ruíz", clinic: null },
      author_role: "vet",
    },
    {
      date: "2014-02-10",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2014-06-15",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "32.0" },
    },
    {
      date: "2015-02-08",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2015-09-30",
      event_type: "note_added",
      location: CABA("Puerto Madero", "Torre en construcción Av. Alicia M. de Justo"),
      payload: {
        category: "comportamiento",
        text: "RESCATE #18. Accidente laboral, derrumbe parcial de andamio. Frida localizó a un operario inconsciente en 8 minutos bajo vigas. Equipo de trauma confirmó que llegó a tiempo.",
      },
      author_role: "govt",
      uncommon: true,
    },
    // ----- Despliegue en sismo Catamarca 2017 -----
    {
      date: "2017-01-18",
      event_type: "status_changed",
      location: loc("San Fernando del Valle de Catamarca", "Catamarca"),
      payload: {
        from_status: "active",
        to_status: "active",
        reason: "desplegada_emergencia_nacional_sismo_catamarca",
        location_description:
          "San Fernando del Valle de Catamarca — despliegue USAR por sismo Mw 6.2",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "2017-01-20",
      event_type: "note_added",
      location: loc("San Fernando del Valle de Catamarca", "Catamarca"),
      payload: {
        category: "comportamiento",
        text: "RESCATE #37-#42 (6 sobrevivientes en 4 días). Sismo Catamarca 18/01/2017. Frida trabajó 72 h con pausas mínimas. Fue la unidad más eficiente del operativo. 6 vidas confirmadas.",
      },
      author_role: "govt",
      uncommon: true,
    },
    // ⚑ disease_reported — leishmaniasis visceral (exposición ocupacional norte argentino)
    {
      date: "2017-03-15",
      event_type: "symptom_observed",
      location: CABA("Retiro"),
      payload: {
        source: "libreta",
        welfare_report_id: null,
        reporter_role: "vet",
        free_text:
          "Pérdida de peso, linfadenopatía periférica, úlceras en hocico. Antecedente: despliegue Catamarca (zona endémica leishmaniasis). Alta sospecha clínica.",
        matched_symptom_codes: ["weight_loss", "lymphadenopathy", "skin_ulcers"],
        alerted_disease_codes: ["leishmaniasis"],
        severity_self_assessed: "moderate",
        onset_at: "2017-03-01",
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2017-03-20",
      event_type: "clinical_info_logged",
      location: CABA("Retiro"),
      payload: {
        sub_kind: "lab_work",
        title: "Serología leishmaniasis — ELISA + PCR",
        details:
          "ELISA positivo, PCR confirmatorio positivo. Leishmaniasis visceral canina (LVC) — exposición ocupacional en zona norte.",
        performed_by: "Dra. Ruíz",
      },
      author_role: "vet",
      uncommon: true,
    },
    // ⚑ disease_reported — el caso zoonótico pasa a la vigilancia gubernamental
    {
      date: "2017-03-22",
      event_type: "disease_reported",
      location: CABA("Retiro"),
      payload: {
        disease: "other",
        confirmed_by_lab: true,
        date_of_onset: "2017-03-01",
        clinical_notes:
          "Leishmaniasis visceral canina (Leishmania infantum). Exposición ocupacional confirmada: despliegue USAR en Catamarca enero 2017, zona endémica. Caso reportado a SENASA y Ministerio de Salud CABA para vigilancia zoonótica.",
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2017-03-25",
      event_type: "medication_started",
      location: CABA("Retiro"),
      payload: {
        drug_name: "Miltefosina + alopurinol (protocolo LVC SENASA)",
        dose: "2 mg/kg/día + 10 mg/kg BID",
        frequency: "twice_daily",
        prescribed_by: "Dr. Fausto Peralta (especialista parasitología)",
        drug_code: null,
        first_dose_at: "2017-03-25",
        duration_days: 180,
        custom_hours: null,
        schedule_count: 360,
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2017-05-10",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "followup_leishmaniasis_mes2",
        diagnosis: "Respuesta parcial al tratamiento: linfadenopatía regresó, peso estable",
        vet_name: "Dr. Peralta",
        clinic: "Hospital Veterinario UBA",
      },
      author_role: "vet",
    },
    {
      date: "2017-07-20",
      event_type: "clinical_info_logged",
      location: CABA("Retiro"),
      payload: {
        sub_kind: "lab_work",
        title: "Control serológico post-tratamiento mes 4",
        details:
          "ELISA cuantitativo: títulos en descenso. Remisión clínica. Continuar alopurinol indefinido como supresor.",
        performed_by: "Dr. Peralta",
      },
      author_role: "vet",
    },
    {
      date: "2017-09-30",
      event_type: "medication_stopped",
      location: CABA("Retiro"),
      payload: {
        medication_started_event_id: "00000000-0000-0000-0000-000000000002",
        reason:
          "Ciclo miltefosina completado. Continúa alopurinol mantenimiento (iniciado en nuevo evento).",
      },
      author_role: "vet",
    },
    {
      date: "2017-10-01",
      event_type: "medication_started",
      location: CABA("Retiro"),
      payload: {
        drug_name: "Alopurinol (mantenimiento LVC)",
        dose: "10 mg/kg",
        frequency: "twice_daily",
        prescribed_by: "Dr. Peralta",
        drug_code: null,
        first_dose_at: "2017-10-01",
        duration_days: null,
        custom_hours: null,
        schedule_count: 9999,
      },
      author_role: "vet",
    },
    {
      date: "2017-11-15",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "29.8" },
    },
    {
      date: "2018-02-20",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual + antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2018-06-05",
      event_type: "note_added",
      location: CABA("Retiro"),
      payload: {
        category: "comportamiento",
        text: "RESCATE #52 (último documentado). Derrumbe de medianera en Villa Lugano. Frida localizó a dos adultos mayores atrapados. Fue su último operativo de búsqueda activa.",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "2018-09-15",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "evaluacion_capacidad_operativa",
        diagnosis:
          "LVC en remisión clínica. Artritis leve bilateral caderas. Capacidad operativa reducida. Se recomienda iniciar proceso de retiro.",
        vet_name: "Dra. Ruíz",
        clinic: null,
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2018-12-01",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "31.5" },
    },
    {
      date: "2019-03-22",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    // ----- Retiro con honores -----
    {
      date: "2019-06-14",
      event_type: "note_added",
      location: CABA("Retiro", "Sede Defensa Civil CABA"),
      payload: {
        category: "comportamiento",
        text: "Ceremonia de retiro de Frida. El Jefe de Gobierno presidió el acto. Frida recibió la Distinción Defensa Civil en grado Extraordinario (Res. 2019-0614-GCABA). 52 rescates certificados, 10 años de servicio activo. Retiro activo con cuidado veterinario de por vida.",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "2019-09-01",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "control_post_retiro",
        diagnosis: "Estable. LVC en remisión mantenida. Artritis leve manejada.",
        vet_name: "Dra. Ruíz",
        clinic: null,
      },
      author_role: "vet",
    },
    {
      date: "2020-02-20",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2020-06-10",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "30.0" },
    },
    {
      date: "2021-02-15",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2021-07-01",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "geriatric_exam",
        diagnosis: "LVC crónica compensada. Artritis moderada. Función renal normal.",
        vet_name: "Dra. Ruíz",
        clinic: null,
      },
      author_role: "vet",
    },
    {
      date: "2021-09-10",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "29.0" },
    },
    {
      date: "2022-01-20",
      event_type: "symptom_observed",
      location: CABA("Retiro"),
      payload: {
        source: "libreta",
        welfare_report_id: null,
        reporter_role: "vet",
        free_text:
          "Letargo marcado, disminución del apetito, pérdida de peso 2 kg en 30 días. LVC reactivada probable.",
        matched_symptom_codes: ["lethargy", "anorexia", "weight_loss"],
        alerted_disease_codes: [],
        severity_self_assessed: "moderate",
        onset_at: "2022-01-05",
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2022-02-10",
      event_type: "clinical_info_logged",
      location: CABA("Retiro"),
      payload: {
        sub_kind: "lab_work",
        title: "Serología leishmaniasis control",
        details:
          "Títulos ELISA nuevamente elevados. Reactivación LVC confirmada. Reintroducir miltefosina; pronóstico reservado en paciente de 13 años.",
        performed_by: "Dr. Peralta",
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2022-02-15",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "anual",
        brand: null,
        batch: null,
        administered_by: "Dra. Ruíz",
        next_due_at: null,
      },
      author_role: "vet",
    },
    {
      date: "2022-03-01",
      event_type: "medication_stopped",
      location: CABA("Retiro"),
      payload: {
        medication_started_event_id: "00000000-0000-0000-0000-000000000003",
        reason:
          "Suspensión alopurinol de mantenimiento — reinicio con miltefosina por reactivación.",
      },
      author_role: "vet",
    },
    {
      date: "2022-03-01",
      event_type: "medication_started",
      location: CABA("Retiro"),
      payload: {
        drug_name: "Miltefosina 2° ciclo (paliativo)",
        dose: "2 mg/kg/día",
        frequency: "once_daily",
        prescribed_by: "Dr. Peralta",
        drug_code: null,
        first_dose_at: "2022-03-01",
        duration_days: 120,
        custom_hours: null,
        schedule_count: 120,
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2022-07-15",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "26.5" },
    },
    {
      date: "2022-10-01",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "quality_of_life_check",
        diagnosis:
          "Deterioro progresivo. Fallo renal incipiente + LVC activa. Calidad de vida comprometida.",
        vet_name: "Dra. Ruíz",
        clinic: null,
      },
      author_role: "vet",
      uncommon: true,
    },
    {
      date: "2022-11-01",
      event_type: "medication_stopped",
      location: CABA("Retiro"),
      payload: {
        medication_started_event_id: "00000000-0000-0000-0000-000000000004",
        reason: "Suspensión por deterioro renal — calidad de vida sobre cantidad.",
      },
      author_role: "vet",
    },
    // ----- Muerte 2022-11-15 -----
    {
      date: "2022-11-15",
      event_type: "death_recorded",
      location: CABA("Retiro", "Veterinaria Defensa Civil CABA"),
      payload: {
        cause: "disease",
        cause_detail:
          "Fallo renal + reactivación Leishmaniasis visceral canina — eutanasia humanitaria decidida colectivamente por el equipo veterinario y la jefatura de Defensa Civil",
        confirmed_by_vet: true,
        vet_name: "Dra. Ruíz",
        disposition_method: "cremation_individual_ashes",
        facility: "Crematorio Municipal Buenos Aires",
        death_at_clinic: true,
        clinic_name: "Veterinaria Defensa Civil CABA",
        vet_contacted_owner: "not_applicable",
        vet_decided_alone: null,
        owner_to_private_crematorium: null,
        disease_code: null,
        confirmed_by_lab: true,
        is_reportable: false,
        during_rabies_observation: false,
      },
      uncommon: true,
    },
    {
      date: "2022-11-16",
      event_type: "note_added",
      location: CABA("Retiro"),
      payload: {
        category: "otro",
        text: "Frida: 52 veces dijiste dónde estaban. Nunca te rendiste. Las cenizas descansan en la sede de Defensa Civil. — Equipo USAR-CABA",
      },
      uncommon: true,
    },
  ],
};

// ===========================================================================
// 3. Owney el Perro Postal
//    Canon: 1888, terrier mestizo, perro mascota del Correo de Albany, viajó
//    en vagones de correo. Relocation: Correo Argentino, base Retiro.
//    Owner: "org:rescate-puerto-madero" (mejor aproximación a org de base Retiro)
//    Note: Owney represents a pre-digital, pre-microchip pet (1888-1897).
//    Tattoo in ear as canonical identifier.
// ===========================================================================

const owney: Storyline = {
  pet: {
    display_name: "Owney",
    public_token: "DIM-OWNY-0024",
    species: "dog",
    breed: "Terrier mestizo",
    sex: "male",
    date_of_birth: "1887-08-01",
    birth_date_is_estimated: true,
    color: "Marrón oscuro con manchas blancas",
    estimated_weight_kg: 8.5,
    known_allergies: [],
    potentially_dangerous_breed: false,
    jurisdiction_country: "AR",
    jurisdiction_province: "CABA",
    jurisdiction_locality: "Retiro",
    status: "deceased",
    owner: "org:rescate-puerto-madero",
    acquisition_method: "found_stray",
    notes:
      "Terrier mestizo adoptado de manera informal por el personal del Correo Argentino " +
      "en la estación de tren de Retiro, 1888. Viajó en vagones de correo por todo el país " +
      "y realizó un viaje internacional a Montevideo. Cargaba medallas/tags de cada jurisdicción " +
      "como identificación. Tattoo de identificación en oreja izquierda. " +
      "Murió 1897. Fixture: tattoo_recorded, tattoo_updated, extreme multi-jurisdiction movement.",
  },
  events: [
    // ----- Registro -----
    {
      date: "1888-02-14",
      event_type: "pet_registered",
      location: CABA("Retiro", "Estación Retiro — Correo Argentino"),
      payload: {
        name: "Owney",
        species: "dog",
        sex: "male",
        breed: "Terrier mestizo",
        date_of_birth: "1887-08-01",
        birth_date_is_estimated: true,
        color: "Marrón oscuro con manchas blancas",
        microchip_id: null,
        microchip_country_code: null,
        microchip_implanted_at: null,
        microchip_implanted_by: null,
        microchip_location: null,
        estimated_weight_kg: "5.5",
        favourite_foods: [],
        known_allergies: [],
        training_level: "none",
        insurance_company: null,
        insurance_policy_number: null,
        jurisdiction_province: "CABA",
        jurisdiction_locality: "Retiro",
        potentially_dangerous_breed: false,
        acquisition_method: "found_stray",
        has_photo: false,
        has_microchip: false,
        custody_kind: "owner_by_org",
      },
      author_role: "shelter",
    },
    {
      date: "1888-02-20",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "intake_exam",
        diagnosis: "sano, leve desnutrición",
        vet_name: "Dr. Mansilla",
        clinic: null,
      },
    },
    {
      date: "1888-03-01",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica (preparado de época)",
        brand: null,
        batch: null,
        administered_by: "Dr. Mansilla",
        next_due_at: null,
      },
    },
    {
      date: "1888-03-10",
      event_type: "deworming_administered",
      location: CABA("Retiro"),
      payload: {
        product: "extracto de ajenjo (vermífugo de época)",
        type: "internal",
        next_due_at: null,
      },
    },
    // ⚑ tattoo_recorded — identificación en oreja izquierda (primer registro; pre-chip era)
    {
      date: "1888-04-01",
      event_type: "tattoo_recorded",
      location: CABA("Retiro", "Correo Argentino Retiro"),
      payload: {
        tattoo_code: "CAR-1888-OWN",
        location_on_body: "inner_ear_left",
        description:
          "Tatuaje de identificación oficial del Correo Argentino Retiro. Código: CAR (Correo Argentino Retiro) — 1888 — OWN (Owney). Aplicado por el jefe de despacho Sr. Benedicto Valdés.",
        recorded_by: "Sr. Benedicto Valdés (jefe despacho Correo Argentino)",
        recorded_at: "1888-04-01",
        tattoo_date_known: true,
      },
      uncommon: true,
    },
    {
      date: "1888-04-10",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "5.8" },
    },
    // ----- Primeros viajes en el ferrocarril postal -----
    {
      date: "1888-05-15",
      event_type: "note_added",
      location: BA("Rosario", "Estación del Ferrocarril Mitre"),
      payload: {
        category: "comportamiento",
        text: "Primera travesía documentada fuera de CABA. Owney viajó en el vagón de correo Retiro-Rosario, guardado junto a las valijas. Los carteros del Ferrocarril Mitre lo adoptaron de inmediato.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1888-07-04",
      event_type: "note_added",
      location: loc("Córdoba Capital", "Córdoba", "Estación Ferrocarril Central Argentino"),
      payload: {
        category: "comportamiento",
        text: "Llegó a Córdoba en el vagón postal. El Administrador de Correos de Córdoba le colgó la primera medalla identificatoria: plaquita de cobre 'Correo Córdoba 1888'.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1888-09-20",
      event_type: "note_added",
      location: loc("Mendoza Capital", "Mendoza", "Estación del Ferrocarril Gran Oeste Argentino"),
      payload: {
        category: "comportamiento",
        text: "Owney llegó a Mendoza. Segunda medalla: 'Correo Mendoza — Bienvenido'. El jefe de estación declaró: 'Este perro trae suerte a las valijas'.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1888-11-01",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "7.2" },
    },
    {
      date: "1889-02-15",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Mansilla",
        next_due_at: null,
      },
    },
    {
      date: "1889-04-22",
      event_type: "note_added",
      location: loc("Tucumán Capital", "Tucumán"),
      payload: {
        category: "comportamiento",
        text: "Owney completó el circuito norte. Tucumán es la provincia número 7 visitada. Medalla local: 'Tucumán Postal — Perro viajero'.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1889-06-01",
      event_type: "note_added",
      location: loc("Resistencia", "Chaco"),
      payload: {
        category: "comportamiento",
        text: "Primer viaje al NEA. Owney llegó a Resistencia en vagón mixto pasajeros-correo. Personal de la oficina postal local le cosió una etiqueta con nombre y dirección de retiro.",
      },
      author_role: "shelter",
    },
    {
      date: "1889-08-08",
      event_type: "note_added",
      location: loc("Posadas", "Misiones"),
      payload: {
        category: "comportamiento",
        text: "Posadas, Misiones — 9.° jurisdicción. Llegó en canoa postal tras desborde del río. Los misioneros lo bautizaron informalmente 'El Cartero Lanudo'.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1889-10-15",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "wellness_tras_viajes",
        diagnosis:
          "Excelente estado general. Almohadillas reforzadas por caminata. Sin parásitos externos.",
        vet_name: "Dr. Mansilla",
        clinic: null,
      },
    },
    {
      date: "1890-01-20",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "8.5" },
    },
    {
      date: "1890-03-01",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Mansilla",
        next_due_at: null,
      },
    },
    // ⚑ tattoo_updated — el tatuaje se borra por el pelaje y el roce del arnes de medallas
    {
      date: "1890-05-10",
      event_type: "tattoo_updated",
      location: CABA("Retiro"),
      payload: {
        previous_tattoo_code: "CAR-1888-OWN",
        new_tattoo_code: "CAR-1888-OWN-V2",
        reason:
          "Tatuaje original desgastado por años de viaje y roce del arnés con medallas. Re-tatuaje con código actualizado; tinta más resistente. Autorizado por la Dirección de Correos.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1890-07-15",
      event_type: "note_added",
      location: loc("Bahía Blanca", "Buenos Aires"),
      payload: {
        category: "comportamiento",
        text: "Owney en Bahía Blanca — 10.° provincia/ciudad. El Inspector de Correos del sur bonaerense anotó: 'Porta 14 medallas. Cada una es un pueblo que lo conoce'.",
      },
      author_role: "shelter",
    },
    {
      date: "1891-02-10",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Mansilla",
        next_due_at: null,
      },
    },
    {
      date: "1891-06-20",
      event_type: "note_added",
      location: loc("Montevideo", "Uruguay"),
      payload: {
        category: "comportamiento",
        text: "Viaje internacional a Montevideo en el barco postal Río de la Plata. El Director General de Correos del Uruguay le entregó una medalla especial: 'Correo Oriental — Huésped de Honor'. Primera (y única) salida del país.",
      },
      author_role: "shelter",
      uncommon: true,
    },
    {
      date: "1891-09-01",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "8.8" },
    },
    {
      date: "1892-03-01",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Mansilla",
        next_due_at: null,
      },
    },
    {
      date: "1892-07-04",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "wellness",
        diagnosis: "Sano. Leve tartrato dental por edad. Sin parásitos.",
        vet_name: "Dr. Mansilla",
        clinic: null,
      },
    },
    {
      date: "1893-03-15",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1893-08-22",
      event_type: "note_added",
      location: loc("Santa Rosa", "La Pampa"),
      payload: {
        category: "comportamiento",
        text: "Owney llegó a La Pampa con el correo de la nueva gobernación. 14.° jurisdicción registrada. El gobernador lo nombró 'Correo Honorario de La Pampa'.",
      },
      author_role: "shelter",
    },
    {
      date: "1894-01-10",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "8.2" },
    },
    {
      date: "1894-04-01",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1895-02-20",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: "Dr. Mansilla",
        next_due_at: null,
      },
    },
    {
      date: "1895-09-08",
      event_type: "symptom_observed",
      location: CABA("Retiro"),
      payload: {
        source: "libreta",
        welfare_report_id: null,
        reporter_role: "vet",
        free_text:
          "Cojera miembro anterior derecho, leve. Probable artritis senil incipiente. Come bien.",
        matched_symptom_codes: ["lameness_front"],
        alerted_disease_codes: [],
        severity_self_assessed: "mild",
        onset_at: "1895-09-01",
      },
    },
    {
      date: "1896-02-10",
      event_type: "vaccination_administered",
      location: CABA("Retiro"),
      payload: {
        vaccine_name: "antirrábica",
        brand: null,
        batch: null,
        administered_by: null,
        next_due_at: null,
      },
    },
    {
      date: "1896-06-01",
      event_type: "vet_visit_logged",
      location: CABA("Retiro"),
      payload: {
        reason: "geriatric_exam",
        diagnosis:
          "Artritis leve en carpo derecho. Función cardiorrespiratoria aceptable para la edad. Reducir viajes largos.",
        vet_name: "Dr. Mansilla",
        clinic: null,
      },
      uncommon: true,
    },
    {
      date: "1896-07-15",
      event_type: "weight_recorded",
      location: CABA("Retiro"),
      payload: { kg: "7.6" },
    },
    // ----- Incidente final — muerte 1897 -----
    {
      date: "1897-06-11",
      event_type: "incident_reported",
      location: CABA("Retiro", "Estación de Retiro — andén ferroviario"),
      payload: {
        incident_type: "other",
        severity: "severe",
        injuries_summary:
          "Owney mordió a un empleado postal que intentó quitarle el arnés de medallas en disputa. El empleado reclamó lesiones. Se emitió orden de sacrificio por mandato administrativo.",
        vet_involved: true,
        location_description: "Andén 3, Estación Retiro — Ferrocarril Mitre",
      },
      author_role: "govt",
      uncommon: true,
    },
    {
      date: "1897-06-11",
      event_type: "death_recorded",
      location: CABA("Retiro"),
      payload: {
        cause: "violent",
        cause_detail:
          "Sacrificio administrativo por mandato del Inspector de Correos Sr. Domínguez tras mordedura a empleado. Canon original: disparado. Adaptación sobria: eutanasia administrativa.",
        confirmed_by_vet: true,
        vet_name: "Dr. Mansilla",
        disposition_method: "authorized_cemetery",
        facility:
          "Depósito Correo Argentino Retiro — restos preservados y enviados al archivo histórico postal",
        death_at_clinic: false,
        clinic_name: null,
        vet_contacted_owner: "not_applicable",
        vet_decided_alone: null,
        owner_to_private_crematorium: null,
        disease_code: null,
        confirmed_by_lab: null,
        is_reportable: false,
        during_rabies_observation: false,
      },
      uncommon: true,
    },
    {
      date: "1897-06-12",
      event_type: "note_added",
      location: CABA("Retiro"),
      payload: {
        category: "otro",
        text: "Owney portaba 23 medallas de provincias y territorios al momento de su muerte. El personal de Retiro firmó un petitorio para que sus restos quedaran en el archivo histórico del Correo. Portó más credenciales que cualquier empleado del servicio. — Sr. Benedicto Valdés",
      },
      uncommon: true,
    },
  ],
};

// ===========================================================================
// Export
// ===========================================================================

export const LEGEND_STORYLINES: Storyline[] = [bobbie, frida, owney];
