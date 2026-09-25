// Copy for /municipios, kept out of page.tsx so it can be tested (a Next page
// module may only export the page, metadata and route config).
//
// PO lens (review 2026-09-25): "queremos ofrecerle soluciones, no generar
// dudas". Every line says what the office GETS, in the words a Zoonosis
// director uses. Nothing here may be only partly built: a capability that
// does not run end to end (citizen / vet / shelter input → an office view or
// action) is left out, not qualified. Each entry cites the code that backs it.
//
// Honesty fence: __tests__/landing-honesty-fitness.test.ts scans this
// directory (no "inmutable", no "tiempo real", no official-status claims).

export type Question = { q: string; screen: string; a: string };

/**
 * The four questions an office asks, each answered by a screen that exists.
 */
export const QUESTIONS: readonly Question[] = [
  {
    // lib/metrics/briefing-alerts.ts (the /gob home "Alertas priorizadas",
    // app/gob/page.tsx block 1) + src/modules/panorama/domain/presets.ts
    // "tendencia" preset.
    q: "¿Hacia dónde van las tendencias?",
    screen: "Panel y Panorama",
    a: "Alertas que marcan qué indicador se aleja de su meta, y la evolución de cada uno en el tiempo.",
  },
  {
    // app/gob/acciones/page.tsx (observaciones antirrábicas, denuncias y
    // casos, ordenados por vencimiento; approvals are deliberately NOT in it)
    // + app/gob/cola/page.tsx (aprobaciones, its own queue).
    q: "¿Qué tenemos pendiente?",
    screen: "Acciones y cola de aprobaciones",
    a: "Observaciones antirrábicas, denuncias y casos en una sola lista ordenada por vencimiento, y al lado las aprobaciones.",
  },
  {
    // app/gob/panorama + presets.ts "cumplimiento" (antirrábica,
    // esterilización, desparasitación, microchip, por localidad).
    q: "¿Dónde nos falta cobertura?",
    screen: "Panorama",
    a: "Un mapa por localidad de vacunación antirrábica, castración, desparasitación y microchip.",
  },
  {
    // app/gob/padron/page.tsx (vistas Población y Censo; meta programática de
    // esterilización en Población).
    q: "¿Cuántos animales tenemos?",
    screen: "Padrón",
    a: "Cuántos animales hay registrados en tu territorio, cómo crece el padrón y qué parte está castrada.",
  },
];

export type Capability = { title: string; body: string };

/**
 * What the product solves end to end for a municipio. Every row names who
 * feeds it and where the office sees or acts on it — verified in the code.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    // Input: app/(app)/mis-mascotas/nueva (owner registers the pet).
    // Office: app/gob/padron/page.tsx.
    title: "Padrón sanitario",
    body: "Cada mascota que registran los vecinos suma al padrón de tu territorio.",
  },
  {
    // Input: vaccination / sterilization / deworming / microchip events.
    // Office: app/gob/panorama (presets.ts "cumplimiento"), refreshed daily
    // by the refresh-cube cron (vercel.json).
    title: "Cobertura por localidad",
    body: "Vacunación antirrábica, castración, desparasitación y microchip, localidad por localidad.",
  },
  {
    // Office: lib/metrics/briefing-alerts.ts on app/gob/page.tsx.
    title: "Alertas priorizadas",
    body: "Las cinco señales que más se alejan de su meta, primero, cada vez que abrís el panel.",
  },
  {
    // Input: app/org/[orgToken]/servicios/nuevo (offering) +
    // app/(app)/turnos/buscar/[offeringToken]/reservar (citizen booking).
    // Office: app/gob/operativos (CampanasScreen: inscriptos, asistencia,
    // alcance; "alcance" vista: target lists).
    title: "Campañas y operativos",
    body: "Las organizaciones publican la campaña, los vecinos sacan turno y tu oficina ve inscriptos y asistencia.",
  },
  {
    // Input: app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/mordedura +
    // app/org/[orgToken]/mordedura/nuevo; closure by the vet in
    // app/org/[orgToken]/atender (rabies close).
    // Office: app/gob/vigilancia + app/gob/acciones (10-day deadline).
    title: "Mordeduras y observación antirrábica",
    body: "Cada mordedura abre su observación, con su plazo a la vista hasta que la veterinaria la cierra.",
  },
  {
    // Input: app/(public)/denuncias/nueva. Office: app/gob/denuncias
    // (moderación + triage) → app/gob/casos.
    title: "Denuncias de maltrato",
    body: "Los vecinos denuncian desde la web y tu oficina las toma, las resuelve o abre un caso.",
  },
  {
    // Input: app/(app)/mis-mascotas/[publicToken]/perdida (owner) +
    // app/(public)/p/[publicToken]/encontre (finder). Office: app/gob/perdidas.
    title: "Mascotas perdidas y reencuentros",
    body: "El aviso de pérdida, quien la encuentra escaneando su QR, y cuántas vuelven a casa.",
  },
  {
    // Input: app/org/[orgToken]/intake + app/org/[orgToken]/adopciones,
    // public app/(public)/adoptar. Office: app/gob/adopciones.
    title: "Adopciones y refugios",
    body: "Ingresos, tránsitos y adopciones de los refugios, con su ocupación.",
  },
  {
    // Input: request-vet-upgrade.ts + organization verification requests.
    // Office: app/gob/cola (Matrículas veterinarias, Verificación de
    // organizaciones).
    title: "Veterinarias y organizaciones",
    body: "Tu oficina aprueba las matrículas y las organizaciones de su jurisdicción.",
  },
  {
    // Office: app/gob/analytics/export (lote de exportación sanitaria) +
    // CsvExportLink on the dashboards.
    title: "Exportación y planillas",
    body: "El lote sanitario de tu jurisdicción y cada tablero, descargables.",
  },
];

/**
 * The pilot, in order. Step 2: create-institutional-account.ts + access-link-
 * mail.ts. Step 3: citizens use the web portal; the Android app is named ONLY
 * when a Play listing exists (lib/ui/play-store.ts), so an unpublished app is
 * never promised.
 */
export function pilotSteps(playStoreUrl: string | null): string[] {
  const citizens = playStoreUrl
    ? "Los vecinos se suman desde el portal web o descargando la app de Android, y lo que cargan llega al tablero de tu oficina."
    : "Los vecinos se suman desde el portal web, y lo que cargan llega al tablero de tu oficina.";
  return [
    "Nos pasás los correos institucionales de quienes lo van a usar y las localidades de tu jurisdicción.",
    "Creamos las cuentas. Cada persona recibe un enlace de acceso por correo y elige su propia contraseña.",
    citizens,
  ];
}

export type Faq = { q: string; a: string };

/**
 * Questions that remove friction. Each answer is true in the code.
 */
export function faqs(playStoreUrl: string | null): Faq[] {
  return [
    {
      // Step 1 of pilotSteps; create-institutional-account.ts.
      q: "¿Qué necesita mi oficina para empezar?",
      a: "Los correos institucionales de quienes lo van a usar y las localidades de tu jurisdicción. Con eso creamos las cuentas.",
    },
    {
      // /gob is a web portal (app/gob); no install step exists.
      q: "¿Hay que instalar algo?",
      a: "No. El portal de tu oficina funciona en el navegador, desde cualquier computadora con internet.",
    },
    {
      // Citizen web portal (app/(app)); Android app only when listed.
      q: "¿Cómo se suman los vecinos?",
      a: playStoreUrl
        ? "Registran a sus mascotas en el portal web o en la app de Android. Veterinarias y refugios cargan lo suyo con su propia cuenta."
        : "Registran a sus mascotas en el portal web. Veterinarias y refugios cargan lo suyo con su propia cuenta.",
    },
    {
      // CsvExportLink on the dashboards + app/gob/analytics/export.
      q: "¿Podemos llevarnos los datos?",
      a: "Sí. Cada tablero se descarga como planilla y la exportación sanitaria arma el lote de tu jurisdicción.",
    },
    {
      // vercel.json cron /api/cron/refresh-cube at 03:00.
      q: "¿Cuándo vemos nuestra jurisdicción en el mapa?",
      a: "El mapa se recalcula todos los días con lo cargado hasta el día anterior.",
    },
  ];
}
