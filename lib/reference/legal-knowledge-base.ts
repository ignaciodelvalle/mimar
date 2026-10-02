// Public legal knowledge base content — powers /leyes.
//
// This is NOT a database table: it's a curated, human-readable digest of
// `docs/legal-framework-full.md` (the exhaustive internal inventory) and the
// summary table in `AGENTS.md → Legal framework`. Every entry here cites a
// norm that is ALREADY documented in one of those two sources — this file
// does not introduce new legal research, only reformats existing findings
// for a public, plain-language audience.
//
// REVISION OF 2026-10 (the page says "Última revisión: octubre de 2026").
// Rewritten after the October legal review and the errata it produced in
// `docs/legal-framework-full.md`. Three rules came out of it, and the
// content tests pin the mechanical ones:
//   1. Only norms the review could read in an official text enter as fact.
//      What it marked unverified (CCyC articles, Res. MS 546/1985, the "Ley
//      Huellas" nickname) is left out, not hedged in.
//   2. No code identifiers in public copy — no snake_case, no backticks, no
//      file paths. Each field is plain Spanish and at most 45 words.
//   3. Describe what a norm says, and what miMAR does; never apply a norm to
//      miMAR's own records where that application is still a question for
//      counsel (e.g. Ley 25.326 art. 16 inc. 5 is described, not invoked).
//
// Grouped by topic (not a flat law dump), following the argentina.gob.ar
// service-ficha convention: ¿Qué dice? / ¿A quién aplica? / ¿Qué obligación
// implica en miMAR? / Fuente. See `app/(institucional)/leyes/page.tsx` for the
// rendering (progressive-disclosure accordion, plain language first).
//
// `sourceUrl` is included ONLY when the exact URL is vetted in
// `docs/legal-framework-full.md` or in `lib/reference/disease-legal-anchors.ts`.
// Where the repo does not carry a verified URL for a norm, the field is
// omitted rather than guessed — same optionality pattern as
// `LegalReference.fullTextUrl` in `disease-legal-anchors.ts`.
//
// Entry ids are stable anchors (/leyes#id): an id survives a relabel when the
// norm is the same one (e.g. `res-cvpba-05-2020` now labels the CVPBA manual).

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
  /** One-line framing shown under the group heading. */
  intro: string;
  entries: LegalKnowledgeEntry[];
}

/** Shown in the page header; bump it with every content revision. */
export const LEGAL_KNOWLEDGE_REVIEWED_LABEL = "octubre de 2026";

export const LEGAL_KNOWLEDGE_GROUPS: LegalKnowledgeGroup[] = [
  {
    id: "identificacion",
    title: "Identificación y registro",
    intro:
      "Qué normas regulan la identificación y el registro de perros y gatos, y en qué casos son obligatorios.",
    entries: [
      {
        // Replaces the former `res-senasa-284-2024` entry, which presented a
        // resolution centred on equines as the standard for reading a pet's
        // chip. There is no general national microchip duty (SENASA; Ley
        // 14.107 art. 8 b admits chip OR tattoo, and only for PPP).
        id: "microchip-obligacion",
        lawLabel: "Microchip: qué es obligatorio y qué no",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "En la Argentina no hay una obligación nacional general de identificar con microchip a perros y gatos.",
        whatItSays:
          "En la Provincia de Buenos Aires, los perros potencialmente peligrosos deben identificarse con chip o con tatuaje (Ley 14.107, art. 8 inc. b). Algunos municipios lo exigen por ordenanza. Cuando hay chip, se usa el estándar internacional ISO 11784/11785.",
        whoItAppliesTo:
          "Dueños de perros potencialmente peligrosos en la Provincia de Buenos Aires y vecinos de municipios con ordenanza propia.",
        mimarObligation:
          "miMAR registra el microchip o el tatuaje si tu mascota lo tiene, pero no lo exige para crear la credencial.",
        sourceLabel: "Ley 14.107/2009 (PBA) — texto completo",
        sourceUrl: "https://normas.gba.gob.ar/documentos/0PNzEIAB.html",
      },
      {
        // Corrected 2026-08-17. `plainMeaning` used to read "el microchip no es
        // opcional: es obligatorio antes de los 6 meses" — false. Art. 8.b of
        // Ley 14.107 requires identification "por medio de un chip O DE UN
        // TATUAJE": the chip is ONE accepted method, never the requirement.
        // Do not re-broaden this copy.
        id: "ley-14107-pba",
        lawLabel: "Ley Provincial 14.107 / 2009",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "Si vivís en la Provincia de Buenos Aires y tu perro es de una raza del Anexo I, tenés que identificarlo e inscribirlo antes de los 6 meses. La ley admite dos métodos: microchip o tatuaje.",
        whatItSays:
          "Régimen de los perros potencialmente peligrosos: identificación, inscripción antes de los 6 meses, bozal y correa. Crea un registro provincial con delegaciones municipales, pero todavía no fue reglamentada. También prohíbe abandonar a estos perros (art. 8 inc. f).",
        whoItAppliesTo:
          "Dueños de perros de las razas del Anexo I con residencia en la Provincia de Buenos Aires.",
        mimarObligation:
          "miMAR te avisa si tu perro entra en esta lista. Como no hay un trámite provincial publicado, consultá en tu municipio cómo inscribirlo.",
        sourceLabel: "Ley 14.107/2009 — texto completo",
        sourceUrl: "https://normas.gba.gob.ar/documentos/0PNzEIAB.html",
      },
      {
        // Year convention: sanción (01/12/2011), not publicación (27/01/2012
        // BOCBA), consistent with how this file cites every other law.
        id: "ley-caba-4078",
        lawLabel: "Ley CABA 4.078 / 2011 + Res. 93/APRA/2021",
        jurisdictionBadge: "CABA",
        plainMeaning:
          "En la Ciudad de Buenos Aires, si tu perro es de una de las 17 razas listadas, o una cruza de más de 20 kg, tenés que inscribirlo antes de los 3 meses y tener un seguro vigente.",
        whatItSays:
          "Crea el Registro de Propietarios de Perros Potencialmente Peligrosos: identificación con chapa, bozal, correa de hasta 2 metros y seguro de responsabilidad civil. El trámite se hace en línea ante la Agencia de Protección Ambiental (Res. 93/APRA/2021).",
        whoItAppliesTo:
          "Dueños de las razas listadas, o de cruzas de más de 20 kg, que viven en la Ciudad de Buenos Aires.",
        mimarObligation:
          "miMAR guarda los datos de la póliza y arma una constancia en PDF para que la presentes vos en el registro de la Ciudad.",
        sourceLabel: "Ley CABA 4.078/2011 — texto completo",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/302801",
      },
      {
        // Article numbers removed 2026-10: the ones this entry cited (4° and
        // 9°) did not match those the legal review found (arts. 23 and 25),
        // and the consolidated text was not re-read. Say what is safe.
        id: "ord-caba-41831",
        lawLabel: "Ordenanza CABA 41.831 / 1987",
        jurisdictionBadge: "CABA",
        plainMeaning:
          "Es la norma general de tenencia de perros y gatos en la Ciudad de Buenos Aires.",
        whatItSays:
          "Crea el Registro Municipal de Animales Domésticos, hace obligatoria la vacuna antirrábica desde los 3 meses y pide identificar al animal.",
        whoItAppliesTo: "Dueños de perros y gatos que viven en la Ciudad de Buenos Aires.",
        mimarObligation:
          "Es la norma de la Ciudad que más se relaciona con lo que registra miMAR: la identificación de tu mascota, sus vacunas y los períodos de observación antirrábica.",
        sourceLabel: "Ordenanza 41.831/1987 (texto consolidado) — Boletín Oficial CABA",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/30564",
      },
    ],
  },
  {
    id: "bienestar",
    title: "Bienestar, maltrato y abandono",
    intro:
      "Qué pasa cuando alguien maltrata o abandona a un animal, y cómo se relaciona con las denuncias que se hacen en miMAR.",
    entries: [
      {
        id: "ley-14346",
        lawLabel: "Ley Nacional 14.346 / 1954",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "El maltrato y la crueldad contra los animales son delito en toda la Argentina y se persiguen penalmente.",
        whatItSays:
          "Castiga los actos de maltrato (art. 1) y de crueldad (art. 3) con prisión de 15 días a 1 año. No castiga el abandono de mascotas como figura propia; en la Ciudad de Buenos Aires, el abandono es una contravención.",
        whoItAppliesTo: "Cualquier persona en el territorio argentino.",
        mimarObligation:
          "Las denuncias de maltrato que se hacen en miMAR se registran con referencia a esta ley. Desde la web se puede denunciar sin crear una cuenta.",
        sourceLabel: "Ley 14.346/1954 — texto completo",
        sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-14346-153011/texto",
      },
      {
        // Relabelled 2026-10. The former label carried a nickname ("Ley
        // Huellas") no official source uses, a peso figure that is really a
        // conversion of unidades fijas, and "hasta 60 días" where the
        // abandonment article says 60 to 90. Id kept: docs cite it.
        id: "ley-caba-6839",
        lawLabel: "Código Contravencional de CABA, art. 141 (texto según Ley CABA 6.839/2025)",
        jurisdictionBadge: "CABA",
        plainMeaning:
          "En la Ciudad de Buenos Aires, abandonar a un animal doméstico es una contravención y se sanciona con trabajo de utilidad pública, multa o arresto.",
        whatItSays:
          "El abandono se sanciona con 60 a 90 días de trabajo de utilidad pública, o multa de 3.000 a 5.000 unidades fijas, o 15 a 30 días de arresto. La misma ley de 2025 actualizó las sanciones por maltrato y cría ilegal.",
        whoItAppliesTo: "Cualquier persona en la Ciudad de Buenos Aires.",
        mimarObligation:
          "Las denuncias por abandono en la Ciudad se registran en miMAR y se derivan a la autoridad que corresponde según el lugar del hecho. En la Provincia de Buenos Aires no hay una figura general de abandono.",
        sourceLabel: "Ley CABA 6.839/2025 — Boletín Oficial CABA",
        sourceUrl: "https://boletinoficial.buenosaires.gob.ar/normativaba/norma/819902",
      },
    ],
  },
  {
    id: "zoonosis",
    title: "Rabia y zoonosis",
    intro:
      "Enfermedades que se transmiten entre animales y personas: la vacuna antirrábica, la observación tras una mordedura y la notificación obligatoria.",
    entries: [
      {
        id: "ley-22953",
        lawLabel: "Ley Nacional 22.953 / 1983",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Declara de interés nacional la lucha contra la rabia que transmiten perros y gatos, y es la base de las campañas antirrábicas.",
        whatItSays:
          "Declara de interés nacional la lucha contra la rabia transmitida por perros y gatos. La edad mínima y la frecuencia de la vacuna las fijan las normas de cada provincia y municipio.",
        whoItAppliesTo:
          "Es una ley nacional: rige en todo el país y es la base de las campañas antirrábicas.",
        mimarObligation:
          "miMAR registra cada vacuna antirrábica en la libreta de tu mascota y te recuerda cuándo vence.",
        sourceLabel: "Ley 22.953/1983 — texto completo",
        sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-22953-184650",
      },
      {
        id: "decreto-4669-1973-pba",
        lawLabel: "Decreto-Ley 8.056/1973 + Decreto 4.669/1973 (PBA)",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "En la Provincia de Buenos Aires, si tu perro o tu gato muerde a alguien, tiene que cumplir un período de observación obligatorio de no menos de 10 días.",
        whatItSays:
          "Profilaxis de la rabia en la Provincia: vacunación antirrábica obligatoria, dispensarios municipales, notificación obligatoria y observación de los animales mordedores por no menos de 10 días.",
        whoItAppliesTo:
          "Dueños de perros y gatos con asiento habitual, transitorio o circunstancial en la Provincia de Buenos Aires.",
        mimarObligation:
          "miMAR registra la mordedura y el período de observación, con su apertura y su cierre.",
        sourceLabel: "Decreto 4.669/1973 — texto completo",
        sourceUrl: "https://normas.gba.gob.ar/documentos/VGOWA8fW.html",
      },
      {
        id: "ley-15465",
        lawLabel: "Ley Nacional 15.465 / 1960 + Disp. DE-MSAL 1/2026",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Hay enfermedades que, por su riesgo para la salud pública, los profesionales deben informar a la autoridad sanitaria. Esta ley define cuáles y quiénes tienen ese deber.",
        whatItSays:
          "Régimen de las enfermedades de notificación obligatoria. El Manual nacional vigente (Disp. DE-MSAL 1/2026) fija los plazos: la notificación inmediata, dentro de las 24 horas de la atención; la semanal, dentro de los 7 días.",
        whoItAppliesTo:
          "Médicos, veterinarios y laboratorios que diagnostican estas enfermedades (art. 4).",
        mimarObligation:
          "Cuando una veterinaria registra en miMAR una de estas enfermedades, el sistema le recuerda que debe notificarla y por qué canal. La notificación sigue siendo responsabilidad del profesional.",
        sourceLabel: "Ley 15.465/1960 — texto completo",
        sourceUrl: "https://www.argentina.gob.ar/normativa/nacional/ley-15465-195093/texto",
      },
      {
        // Was labelled "Resolución CVPBA 05/2020": it is a manual of the
        // Colegio updated in 05/2020, which cites Res. CVPBA 44/2016. Id kept.
        id: "res-cvpba-05-2020",
        lawLabel: "Manual de enfermedades de notificación obligatoria del CVPBA (act. 05/2020)",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "En la Provincia de Buenos Aires, el Colegio de Veterinarios publica la lista de enfermedades de pequeños animales que sus matriculados deben notificar.",
        whatItSays:
          "Incluye, entre otras, brucelosis canina, dirofilariosis, esporotricosis, leishmaniasis visceral canina, leptospirosis, micobacteriosis, rabia animal y la sospecha de SARS-CoV-2. Pide notificar de forma inmediata al Centro de Zoonosis municipal.",
        whoItAppliesTo: "Veterinarios matriculados en la Provincia de Buenos Aires.",
        mimarObligation:
          "Cuando una veterinaria de la Provincia registra una enfermedad de esta lista que está en el catálogo de miMAR, el sistema le muestra el plazo y el canal de notificación. La sospecha de SARS-CoV-2 todavía no está en ese catálogo.",
        sourceLabel: "Manual ENO del CVPBA (act. 05/2020) — documento",
        sourceUrl: "https://cvpba.org/wp-content/uploads/2022/03/ENO-05-2020-1.pdf",
      },
      {
        // Res. MS 546/1985 removed 2026-10: no official source carries it.
        // Res. 1811/2011 is a ministerial programme, not a duty on clinics.
        id: "hidatidosis-vigilancia",
        lawLabel: "Res. MS 1811/2011 (Programa Nacional de Control de Enfermedades Zoonóticas)",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "La hidatidosis es una zoonosis que se transmite entre perros y ovejas, sobre todo en zonas rurales. El Ministerio de Salud tiene un programa nacional para vigilarla y controlarla.",
        whatItSays:
          "Crea el Programa Nacional de Control de Enfermedades Zoonóticas, que incluye la hidatidosis, la triquinosis, el hantavirus, la leishmaniasis visceral y la psitacosis.",
        whoItAppliesTo:
          "Es un programa del Ministerio de Salud de la Nación, que se ejecuta junto con las provincias.",
        mimarObligation:
          "miMAR registra los diagnósticos de hidatidosis que carga una veterinaria, para que la autoridad sanitaria de la zona pueda verlos.",
        sourceLabel: "Res. MS 1811/2011 — texto completo",
        sourceUrl:
          "https://servicios.infoleg.gob.ar/infolegInternet/anexos/185000-189999/189688/norma.htm",
      },
    ],
  },
  {
    id: "atencion-veterinaria",
    title: "Atención veterinaria y recetas",
    intro:
      "Qué registros llevan las veterinarias por ley y qué parte de ese trabajo no reemplaza miMAR.",
    entries: [
      {
        id: "res-senasa-80-2025-654-2026",
        lawLabel: "Res. SENASA 80/2025 y 654/2026",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Algunos medicamentos veterinarios solo se pueden recetar con una receta electrónica emitida en el sistema de SENASA, también para perros y gatos.",
        whatItSays:
          "La Res. 80/2025 creó la receta electrónica veterinaria. La 654/2026 la extiende a los animales de compañía, según los principios activos que SENASA vaya incorporando, y pide los datos del titular y un código único por receta.",
        whoItAppliesTo: "Veterinarios que recetan y farmacias veterinarias que despachan.",
        mimarObligation:
          "miMAR no emite recetas electrónicas ni reemplaza el sistema de SENASA. Una receta registrada en la libreta es solo una referencia a la emitida allí.",
        sourceLabel: "Res. SENASA 654/2026 — Boletín Oficial",
        sourceUrl: "https://www.boletinoficial.gob.ar/detalleAviso/primera/344632/20260721",
      },
      {
        id: "decreto-154-1989-pba",
        lawLabel: "Decreto 154/1989 (PBA), art. 16",
        jurisdictionBadge: "Buenos Aires",
        plainMeaning:
          "En la Provincia de Buenos Aires, las clínicas veterinarias llevan un registro oficial de historias clínicas.",
        whatItSays:
          "Las clínicas, hospitales y sanatorios veterinarios deben llevar un registro foliado y rubricado de historias clínicas. Los consultorios no están alcanzados por esta obligación.",
        whoItAppliesTo:
          "Clínicas, hospitales y sanatorios veterinarios de la Provincia de Buenos Aires.",
        mimarObligation:
          "La libreta de miMAR no es ese registro y no lo reemplaza: la veterinaria lo sigue llevando por su cuenta.",
        sourceLabel: "Decreto 154/1989 — texto completo",
        sourceUrl: "https://normas.gba.gob.ar/documentos/0zQGbwT8.html",
      },
    ],
  },
  {
    id: "viajes",
    title: "Viajes",
    intro:
      "Qué documentación piden para viajar con tu mascota. El semáforo de viajes de miMAR es orientativo: lo que vale es lo que pida cada empresa y SENASA.",
    entries: [
      {
        id: "res-mecon-2076-2025",
        lawLabel: "Res. Ministerio de Economía 2076/2025",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Podés viajar con tu perro o tu gato en ómnibus y trenes de larga distancia de jurisdicción nacional, con su constancia antirrábica.",
        whatItSays:
          "Autoriza el traslado de animales domésticos en ómnibus y trenes de larga distancia. Pide portar la constancia antirrábica y admite un animal por pasajero adulto. Cada empresa fija sus restricciones de especie, raza, peso y tamaño.",
        whoItAppliesTo:
          "Pasajeros que viajan con su mascota y empresas de transporte de larga distancia de jurisdicción nacional.",
        mimarObligation:
          "miMAR muestra las vacunas de tu mascota, pero no reemplaza la constancia antirrábica que extiende tu veterinaria.",
        sourceLabel: "Res. 2076/2025 — Boletín Oficial",
        sourceUrl: "https://www.boletinoficial.gob.ar/detalleAviso/primera/336643/20251223",
      },
      {
        id: "res-magyp-727-2015",
        lawLabel: "Res. MAGyP 727/2015 (Res. GMC Mercosur 17/2015)",
        jurisdictionBadge: "Internacional",
        plainMeaning:
          "Para viajar con tu mascota a Brasil, Paraguay o Uruguay necesitás el Certificado Veterinario Internacional que emite SENASA.",
        whatItSays:
          "Incorpora los requisitos del Mercosur para el ingreso de perros y gatos: el certificado lo emite la autoridad del país de salida, vale 60 días y exige un examen clínico dentro de los 10 días previos.",
        whoItAppliesTo: "Dueños que viajan con su perro o su gato entre los países del Mercosur.",
        mimarObligation:
          "miMAR te ayuda a ordenar lo que vas a necesitar, pero no reemplaza el certificado de SENASA ni los certificados de tu veterinaria.",
        sourceLabel: "Res. GMC 17/2015 — SENASA",
        sourceUrl: "https://www.argentina.gob.ar/senasa/resolucion-172015",
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
        // Describes art. 16 inc. 5; does NOT invoke it against a request —
        // whether it covers records signed by a professional is a question
        // for counsel. So the law's text (whatItSays) and miMAR's practice
        // (mimarObligation) are kept apart: the practice sentence names no
        // legal basis and says a request is reviewed. Matches /privacidad.
        id: "ley-25326",
        lawLabel: "Ley Nacional 25.326 / 2000",
        jurisdictionBadge: "Nacional",
        plainMeaning:
          "Te da derecho a saber qué datos tuyos guarda miMAR, a pedir que se corrijan y a pedir que se eliminen, con las excepciones que fija la ley.",
        whatItSays:
          "Ley de Protección de Datos Personales: acceso (art. 14) y rectificación y supresión (art. 16). La supresión no procede si perjudica derechos o intereses legítimos de terceros, o si hay una obligación legal de conservar los datos (art. 16 inc. 5).",
        whoItAppliesTo:
          "Cualquier responsable de una base de datos personales en la Argentina, incluida miMAR. El órgano de control es la Agencia de Acceso a la Información Pública (AAIP).",
        mimarObligation:
          "Desde tu cuenta podés descargar tus datos o eliminar tu cuenta; tus datos personales se anonimizan. Los registros sanitarios de tu mascota no se borran: un error se corrige con un registro nuevo. Si tenés un pedido sobre un registro, lo revisamos con vos.",
        sourceLabel: "Ley 25.326 — texto actualizado",
        sourceUrl:
          "https://servicios.infoleg.gob.ar/infolegInternet/anexos/60000-64999/64790/texact.htm",
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
          "En la Ciudad de Buenos Aires, la cremación de perros y gatos sigue un procedimiento reglado: certificado veterinario, crematorio habilitado y un plazo mínimo desde el fallecimiento.",
        whatItSays:
          "Regula la cremación de perros y gatos en la Ciudad y crea el Registro de Cremaciones. Exige 24 horas desde el fallecimiento, salvo causa infectocontagiosa, certificado veterinario y crematorio habilitado.",
        whoItAppliesTo: "Dueños y crematorios habilitados de la Ciudad de Buenos Aires.",
        mimarObligation:
          "Al registrar el fallecimiento, miMAR deja constancia del destino del cuerpo, por ejemplo cremación individual o colectiva, o cementerio habilitado.",
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
