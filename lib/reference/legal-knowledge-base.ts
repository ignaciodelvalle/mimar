// Public legal knowledge base content — powers /leyes.
//
// This is NOT a database table: it's a curated, human-readable digest of
// `docs/legal-framework-full.md` (the exhaustive internal inventory) and the
// summary table in `AGENTS.md → Legal framework`. Every entry here cites a
// norm that is ALREADY documented in one of those two sources — this file
// does not introduce new legal research, only reformats existing findings
// for a public, plain-language audience.
//
// Grouped by life-moment/topic (not a flat law dump), following the
// argentina.gob.ar service-ficha convention: ¿Qué dice? / ¿A quién aplica? /
// ¿Qué obligación implica en miMAR? / Fuente. See `app/(public)/leyes/page.tsx`
// for the rendering (progressive-disclosure accordion, plain language first).
//
// `sourceUrl` is included ONLY when the exact URL is already vetted in
// `docs/legal-framework-full.md` (last verification pass: 2026-05-18) or in
// `lib/reference/disease-legal-anchors.ts`. Where the repo does not carry a
// verified URL for a norm (e.g. Ley 25.326), the field is omitted rather than
// guessed — same optionality pattern as `LegalReference.fullTextUrl` in
// `disease-legal-anchors.ts`.

export type LegalJurisdictionBadge = "Nacional" | "CABA" | "Buenos Aires" | "Internacional";

export interface LegalKnowledgeEntry {
  /** Stable slug — used for deep-linking / test assertions. */
  id: string;
  /** Formal citation, e.g. "Ley Nacional 14.346 / 1954". */
  lawLabel: string;
  jurisdictionBadge: LegalJurisdictionBadge;
  /** Plain-language "qué significa para vos" — leads the disclosure, es-AR voseo. */
  plainMeaning: string;
  /** ¿Qué dice? */
  whatItSays: string;
  /** ¿A quién aplica? */
  whoItAppliesTo: string;
  /** ¿Qué obligación implica en miMAR? */
  mimarObligation: string;
  sourceLabel: string;
  sourceUrl?: string;
}

export interface LegalKnowledgeGroup {
  id: string;
  title: string;
  /** One-line life-moment framing shown under the group heading. */
  intro: string;
  entries: LegalKnowledgeEntry[];
}

export const LEGAL_KNOWLEDGE_GROUPS: LegalKnowledgeGroup[] = [
  {
    id: "identificacion",
    title: "Identificación y tenencia responsable",
    intro:
      "Qué te exige la ley para que tu mascota tenga una identidad verificable: microchip, tatuaje, registro municipal o provincial.",
    entries: [
      {
        id: "res-senasa-284-2024",
        lawLabel: "Res. SENASA 284 / 2024",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Es el estándar técnico que define cómo debe leerse el chip de tu mascota en cualquier lector, en cualquier veterinaria del país.",
        whatItSays:
          "Fija el estándar ISO 11784/11785 para la identificación electrónica animal (microchips) en la Argentina.",
        whoItAppliesTo:
          "Dueños que identifican a su mascota con microchip, veterinarios que lo implantan y fabricantes/proveedores de chips.",
        mimarObligation:
          "miMAR guarda el identificador de tu mascota separado en país, fabricante y número de serie del chip — el mismo estándar que exige la norma.",
        sourceLabel: "Res. SENASA 284/2024 — texto completo",
        sourceUrl:
          "https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-284-2024-398615/texto",
      },
      {
        // Corrected 2026-08-17. `plainMeaning` used to read "el microchip no es
        // opcional: es obligatorio antes de los 6 meses" — false, and it
        // contradicted this entry's own `whatItSays` two fields below. Art. 8.b
        // of Ley 14.107 requires identification "por medio de un chip O DE UN
        // TATUAJE": the chip is ONE accepted method, never the requirement.
        // Verified against the official text by two independent legal reviews
        // (engram legal/claims-refutadas-2026-08-17 and
        // legal/cruce-dos-fuentes-2026-08-17); SENASA states there is no
        // national electronic-identification regime for dogs and cats at all.
        // The obligation that IS real is narrow: Anexo I breeds, in the
        // provinces that regulate them. Do not re-broaden this copy.
        id: "ley-14107-pba",
        lawLabel: "Ley Provincial 14.107 / 2009",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "Si vivís en la Provincia de Buenos Aires y tu perro es de una raza del Anexo I, tenés que identificarlo e inscribirlo antes de los 6 meses. La ley te deja elegir el método: microchip o tatuaje. El chip es una de las formas aceptadas, no la exigencia.",
        whatItSays:
          "Régimen de tenencia de perros potencialmente peligrosos en la Provincia de Buenos Aires: identificación obligatoria por microchip o tatuaje, inscripción antes de los 6 meses de edad.",
        whoItAppliesTo:
          "Dueños de perros de las razas listadas en el Anexo I, con residencia en la Provincia de Buenos Aires.",
        mimarObligation:
          "miMAR marca automáticamente a tu mascota como raza potencialmente peligrosa según la lista de esta ley, cuando tu jurisdicción es la Provincia de Buenos Aires.",
        sourceLabel: "Ley 14.107/2009 — texto completo",
        sourceUrl: "https://normas.gba.gob.ar/documentos/0PNzEIAB.html",
      },
      {
        // Year convention: sanción (01/12/2011), not publicación (27/01/2012
        // BOCBA). Chosen for consistency with how this file cites every other
        // law by sanction year (e.g. Ley 14.346/1954, Ley 22.953/1983).
        // Verified 2026-07-18 against the research package
        // (umbrales-legales-jurisdiccion.md) — do not revert to "/2012".
        id: "ley-caba-4078",
        lawLabel: "Ley CABA 4078 / 2011",
        jurisdictionBadge: "CABA",
        plainMeaning:
          "En CABA, si tu perro es de una de las 17 razas listadas (o cruza de más de 20 kg), necesitás anotarlo antes de los 3 meses y tener un seguro vigente.",
        whatItSays:
          "Régimen de tenencia de perros potencialmente peligrosos en CABA: Registro de Propietarios, identificación, bozal, correa de hasta 2 m y seguro de responsabilidad civil obligatorio.",
        whoItAppliesTo:
          "Dueños de las 17 razas listadas (o cruzas de más de 20 kg) residentes en CABA.",
        mimarObligation:
          "El registro de raza peligrosa en miMAR guarda el dato de la póliza de responsabilidad civil que exige esta ley, y permite a las autoridades verificar el cumplimiento por jurisdicción.",
        sourceLabel: "Ley CABA 4078/2011 — texto completo",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/302801",
      },
      {
        id: "ord-caba-41831",
        lawLabel: "Ordenanza CABA 41.831 / 1987",
        jurisdictionBadge: "CABA",
        plainMeaning:
          "Es la norma general de tenencia en CABA: registro municipal, vacunación antirrábica desde los 3 meses e identificación por tatuaje o microchip.",
        whatItSays:
          "Tenencia de animales domésticos en CABA: Registro Municipal de Animales Domésticos, vacunación antirrábica obligatoria desde los 3 meses, identificación por tatuaje o microchip.",
        whoItAppliesTo: "Dueños de perros y gatos residentes en CABA.",
        mimarObligation:
          "Es probablemente la norma operativa más cercana a lo que miMAR digitaliza en CABA: el Art. 4° (tatuaje) se cubre con el identificador de tatuaje registrado de tu mascota, y el Art. 9° (observación antirrábica de 10 días) con el evento sanitario de observación antirrábica.",
        sourceLabel: "Ordenanza 41.831/1987 (texto consolidado) — Boletín Oficial CABA",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/30564",
      },
    ],
  },
  {
    id: "bienestar",
    title: "Bienestar animal y maltrato",
    intro:
      "Qué pasa cuando alguien lastima, abandona o descuida a un animal — y cómo se conecta con la denuncia que hacés desde la app.",
    entries: [
      {
        id: "ley-14346",
        lawLabel: "Ley Nacional 14.346 / 1954",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "El maltrato animal es delito en toda la Argentina, no una falta administrativa — se persigue penalmente, en cualquier provincia.",
        whatItSays:
          "Tipifica penalmente los actos de maltrato (Art. 1°) y crueldad (Art. 3°) contra animales; pena de 15 días a 1 año de prisión. Es la base del derecho penal animal argentino.",
        whoItAppliesTo:
          "Cualquier persona en territorio argentino — es una ley penal de alcance nacional.",
        mimarObligation:
          "El evento `maltreatment_reported` ancla la denuncia hecha desde la app a esta ley. El formulario de denuncias no requiere cuenta, para no desalentar el reporte.",
        sourceLabel: "Ley 14.346/1954 — texto completo",
        sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-14346-153011/texto",
      },
      {
        id: "ley-caba-6839",
        lawLabel: "Ley CABA 6839 / 2025 — Ley Huellas",
        jurisdictionBadge: "CABA",
        plainMeaning:
          "Conocida como Ley Huellas: en CABA, las sanciones por maltrato y abandono se endurecieron hace poco, con multas de hasta $8 millones y un registro público de infractores.",
        whatItSays:
          "Endurece sanciones por maltrato, abandono y cría ilegal. Crea el Registro de Infractores a la Ley de Maltrato Animal dentro del Registro de Contravenciones. Multas de hasta $8.000.000 y trabajo comunitario de hasta 60 días.",
        whoItAppliesTo:
          "Personas denunciadas y sancionadas por maltrato, abandono o cría ilegal de animales en CABA.",
        mimarObligation:
          "El registro de infractores es un dato externo que se prevé integrar a futuro en la verificación de adoptantes, cuando exista una vía de acceso institucional a ese registro.",
        sourceLabel: "Ley CABA 6839/2025 — Boletín Oficial CABA",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/819902",
      },
    ],
  },
  {
    id: "zoonosis",
    title: "Zoonosis y salud pública",
    intro:
      "Enfermedades que se transmiten entre animales y personas — por qué existe la vacuna antirrábica obligatoria y qué es la vigilancia ENO.",
    entries: [
      {
        id: "ley-22953",
        lawLabel: "Ley Nacional 22.953 / 1983",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Es la base legal de por qué la vacuna antirrábica es obligatoria y anual desde los 3 meses de vida.",
        whatItSays:
          "Declara de interés nacional la lucha contra la rabia transmitida por perros y gatos; base legal de las campañas antirrábicas.",
        whoItAppliesTo: "Dueños de perros y gatos en todo el país.",
        mimarObligation:
          "Ancla legal del evento `antirabies_vaccinated` y de la obligatoriedad de la vacuna anual desde los 3 meses.",
        sourceLabel: "Ley 22.953/1983 — texto completo",
        sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-22953-184650",
      },
      {
        id: "decreto-4669-1973-pba",
        lawLabel: "Decreto-Ley 8.056/1973 + Decreto 4.669/1973 (PBA)",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "En la Provincia de Buenos Aires, si tu perro muerde a alguien, existe un período de observación obligatoria de 10 días.",
        whatItSays:
          "Profilaxis de la rabia en PBA: vacunación antirrábica obligatoria, dispensarios municipales, notificación obligatoria y observación antirrábica de 10 días para animales mordedores.",
        whoItAppliesTo:
          "Dueños de perros y gatos con asiento habitual, transitorio o circunstancial en la Provincia de Buenos Aires.",
        mimarObligation:
          "Ancla los eventos `bite_inflicted` + `rabies_observation_started` / `rabies_observation_ended` para residentes de PBA.",
        sourceLabel: "Decreto 4.669/1973 — texto completo",
        sourceUrl: "https://normas.gba.gob.ar/documentos/VGOWA8fW.html",
      },
      {
        id: "ley-15465",
        lawLabel: "Ley Nacional 15.465 / 1960",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          'Hay una lista oficial de enfermedades que los veterinarios están obligados a reportar a la autoridad sanitaria — no es que "se enteran y ya".',
        whatItSays:
          "Régimen legal de Enfermedades de Notificación Obligatoria (ENO). Incluye rabia, hidatidosis, leptospirosis, leishmaniasis y brucelosis.",
        whoItAppliesTo: "Veterinarios y establecimientos que diagnostican estas enfermedades.",
        mimarObligation:
          "Sostiene el flag `eno_reportable` en `disease_diagnosed.payload` y el catálogo de anclas legales por enfermedad en `lib/reference/disease-legal-anchors.ts`.",
        sourceLabel: "Ley 15.465/1960 — texto completo",
        sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-15465-195093/texto",
      },
      {
        id: "res-cvpba-05-2020",
        lawLabel: "Resolución CVPBA 05 / 2020",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "En la Provincia de Buenos Aires, hay una lista específica de enfermedades en pequeños animales que se deben denunciar sí o sí.",
        whatItSays:
          "Enfermedades de denuncia obligatoria en pequeños animales: brucelosis canina, clamidiosis aviar, filariasis, esporotricosis, leishmaniasis visceral canina, leptospirosis, micobacterias y rabia animal.",
        whoItAppliesTo: "Veterinarios matriculados en la Provincia de Buenos Aires.",
        mimarObligation:
          "Lista base para `symptom_observed` / `disease_diagnosed` con flag de denuncia obligatoria en jurisdicción PBA.",
        sourceLabel: "Res. CVPBA 05/2020 — texto completo",
        sourceUrl: "https://cvpba.org/wp-content/uploads/2022/03/ENO-05-2020-1.pdf",
      },
      {
        id: "hidatidosis-vigilancia",
        lawLabel: "Res. MS 1811/2011 + Res. MS 546/1985",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "La hidatidosis es una zoonosis de vigilancia principalmente rural — se transmite en el ciclo perro-oveja, típico de zonas de cría. Por eso está en la lista ENO desde hace décadas.",
        whatItSays:
          "El Programa Nacional de Control de Enfermedades Zoonóticas (Res. 1811/2011) y el Manual de procedimientos de control de hidatidosis (Res. 546/1985) definen la vigilancia de hidatidosis, junto con triquinosis, hantavirus, leishmaniasis visceral y psitacosis.",
        whoItAppliesTo:
          "Establecimientos veterinarios y productores en zonas rurales/periurbanas con ciclo de cría — donde el reservorio canino de la hidatidosis es más frecuente.",
        mimarObligation:
          "Anclaje legal de `hydatidosis` en el catálogo de `lib/reference/disease-legal-anchors.ts`, con flag `eno_reportable`.",
        sourceLabel: "Res. MS 1811/2011 — texto completo",
        sourceUrl:
          "https://servicios.infoleg.gob.ar/infolegInternet/anexos/185000-189999/189688/norma.htm",
      },
    ],
  },
  {
    id: "datos-personales",
    title: "Datos personales y privacidad",
    intro:
      "Qué datos tuyos y de tu mascota guarda miMAR, para qué se usan y qué derechos tenés sobre ellos.",
    entries: [
      {
        id: "ley-25326",
        lawLabel: "Ley Nacional 25.326 / 2000",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Es la ley que te da derecho a saber qué datos tuyos tiene miMAR, pedir que se corrijan y pedir que se borren.",
        whatItSays:
          "Ley de Protección de Datos Personales. El Art. 4° exige que el tratamiento de datos tenga una finalidad determinada; el Art. 14° reconoce el derecho de acceso; el Art. 16° reconoce el derecho de supresión.",
        whoItAppliesTo:
          "Cualquier responsable de una base de datos personales en la Argentina, incluida miMAR respecto de los datos de sus usuarios.",
        mimarObligation:
          "Cada dato personal que guardamos (tu perfil, tus mascotas, los identificadores registrados de tu mascota, las disputas de tenencia) queda vinculado a la base legal que lo justifica, y puede eliminarse cuando corresponda. Desde /cuenta/privacidad podés pedir la exportación de tus datos (Art. 14°) o su eliminación (Art. 16°).",
        sourceLabel: "Ley 25.326 — Protección de Datos Personales",
      },
    ],
  },
  {
    id: "fin-de-vida",
    title: "Fin de vida",
    intro:
      "Qué exige la ley cuando una mascota muere, en las jurisdicciones que lo regulan explícitamente.",
    entries: [
      {
        id: "ley-caba-5470",
        lawLabel: "Ley CABA 5470 / 2015",
        jurisdictionBadge: "CABA",
        plainMeaning:
          'En CABA, la cremación de una mascota tiene un proceso reglado: no es "llevarla a cualquier lado".',
        whatItSays:
          "Proceso especial para cremación de caninos y felinos domésticos en CABA. Crea el Registro de Cremaciones; exige un mínimo de 24 hs desde el deceso (salvo causa infectocontagiosa), certificado veterinario y crematorio habilitado.",
        whoItAppliesTo: "Dueños y crematorios habilitados en CABA.",
        mimarObligation:
          "El payload de `death_recorded` lleva `disposition_method` (`cremation_collective` / `cremation_individual_ashes` / `authorized_cemetery` / `owner_burial` / `household_waste` / `rendering` / `unknown`), normalizado por `lib/disposition.ts`, para trazabilidad.",
        sourceLabel: "Ley CABA 5470/2015 — Boletín Oficial CABA",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/302769",
      },
    ],
  },
];

/** Flat list of every entry — used by tests and by a future search/filter UI. */
export function getAllLegalKnowledgeEntries(): LegalKnowledgeEntry[] {
  return LEGAL_KNOWLEDGE_GROUPS.flatMap((group) => group.entries);
}
