import type { Metadata } from "next";

// Landing chrome (lp-* layer), same as app/page.tsx. Imported here too on
// purpose: this is a second, legitimate landing-family surface, not an
// arbitrary route reaching for landing styles (see app/landing.css's own
// "promote to globals.css rather than importing this file somewhere else"
// note — that guard is about accidental cost creep).
import "@/app/landing.css";

import { LandingFooter } from "@/components/landing/LandingFooter";
import { LandingNav } from "@/components/landing/LandingNav";

import { PilotRequestForm } from "./PilotRequestForm";

export const metadata: Metadata = {
  title: "miMAR para municipios y provincias",
  description:
    "Para oficinas de Zoonosis y bienestar animal: padrón sanitario, casos, campañas y un mapa de cobertura antirrábica sobre tu jurisdicción. Pedí un piloto sin costo.",
  alternates: { canonical: "/municipios" },
  openGraph: {
    title: "miMAR para municipios y provincias",
    description:
      "Padrón sanitario, casos, campañas y cobertura antirrábica sobre tu jurisdicción. Piloto sin costo.",
    type: "website",
  },
};

// Outside the (public) group nothing here reads the request, so Next would
// prerender it — and a prerendered page cannot carry the per-request CSP
// nonce, so its scripts (the nav's scroll state, the pilot form) would arrive
// dead (scripts/check-csp-prerender.ts).
export const dynamic = "force-dynamic";

/**
 * /municipios — the page for Zoonosis and animal-welfare offices (WU5,
 * landing redesign 2026-09-24; plan in dim-interno:docs/design/handoffs/
 * 2026-09-24-landing-redesign-plan.md).
 *
 * EVERY CAPABILITY SENTENCE HAS A SOURCE, cited in the comment beside its
 * block: a code path, or an entry of dim-interno "límites honestos"
 * (docs/presentation/2026-09-oficiales/limites-honestos.md). A sentence
 * without a source does not belong here. __tests__/landing-honesty-fitness
 * scans this directory for the overclaims that already shipped once.
 *
 * NOT ON THIS PAGE, ON PURPOSE: a price after the pilot (D10), a pilot length
 * (D8), a response time (D9), hosting questions (D11 — /privacidad covers
 * them), and any screenshot of /gob (real captures with seed data are a
 * separate step; a mock tile here would be a picture of a claim).
 */

/**
 * The four questions an office asks, each answered by the screen that
 * exists for it.
 *   Panel: app/gob/page.tsx block 1 + lib/metrics/briefing-alerts.ts (ranked,
 *     capped at five, only KPIs with a target, small-n and 0/0 suppressed).
 *   Cola: app/gob/page.tsx block 3 (Aprobaciones, Habilitación de
 *     organizaciones, Denuncias de maltrato, Casos regulatorios, Pérdidas
 *     activas) + /gob/acciones (the 10-day observation deadline,
 *     briefing-alerts "deadline_breach").
 *   Panorama: app/gob/panorama + src/modules/panorama/domain/presets.ts
 *     ("Cumplimiento": antirrábica, esterilización, desparasitación,
 *     microchip, per locality); cube refreshed daily (vercel.json cron
 *     refresh-cube, 03:00). /gob/operativos carries campañas.
 *   Rendir cuentas: /gob/padron (Población + Censo vistas),
 *     /gob/analytics/export (lote de exportación sanitaria, signed link +
 *     audit row — límites honestos A.4 / B.5), CsvExportLink on dashboards.
 */
const QUESTIONS: ReadonlyArray<{ q: string; screen: string; a: string }> = [
  {
    q: "¿Qué se está poniendo en rojo hoy?",
    screen: "Panel",
    a: "Hasta cinco alertas ordenadas por brecha contra una meta: cobertura antirrábica, microchip, reencuentro de perdidos. Si hay pocos casos para medir, no alerta.",
  },
  {
    q: "¿Qué tengo que cerrar esta semana?",
    screen: "Cola operativa",
    a: "Matrículas veterinarias y organizaciones por aprobar, denuncias de maltrato, casos abiertos, mascotas perdidas y los plazos de observación antirrábica que vencen.",
  },
  {
    q: "¿Dónde mando el camión de vacunación?",
    screen: "Panorama",
    a: "Un mapa por localidad de cobertura antirrábica, esterilización, desparasitación y microchip. Se recalcula una vez por día. Las campañas y operativos se siguen desde el mismo portal.",
  },
  {
    q: "¿Puedo rendir cuentas mañana?",
    screen: "Padrón y exportación",
    a: "El padrón de tu territorio con su crecimiento y la calidad del dato, planillas descargables de cada tablero y el lote de exportación sanitaria de tu jurisdicción.",
  },
];

/**
 * Where the data comes from. Sources:
 *   owner: the libreta is filled by its owner (events spine, AGENTS.md
 *     invariant 2 — append-only).
 *   vet: role_upgrade_vet goes through the approval queue (/gob/cola
 *     "Matrículas veterinarias"); a verified professional's event is what
 *     earns a stamp (AGENTS.md §6, provenance gates the stamps). No automatic
 *     check against the colegio (límites honestos C).
 *   shelter: organization_verification in the same queue; custody events.
 */
const SOURCES: ReadonlyArray<{ who: string; what: string }> = [
  {
    who: "El dueño",
    what: "Registra a su mascota y lleva la libreta: vacunas, controles, cambios de domicilio.",
  },
  {
    who: "La veterinaria",
    what: "Firma lo que aplica. Su matrícula se aprueba en una cola de revisión antes de que su firma cuente.",
  },
  {
    who: "El refugio",
    what: "Asienta ingresos, adopciones y devoluciones, con la organización verificada.",
  },
  {
    who: "Tu oficina",
    what: "Ve todo eso sumado sobre su jurisdicción, sin pedir planillas a nadie.",
  },
];

/**
 * "Disponible hoy" — each row is a /gob route that exists today (see the
 * QUESTIONS sources above, plus /gob/casos, /gob/denuncias, /gob/vigilancia).
 */
const AVAILABLE: readonly string[] = [
  "Padrón y censo de tu jurisdicción",
  "Alertas priorizadas y cola de trabajo",
  "Mapa de cobertura por localidad",
  "Campañas y operativos",
  "Denuncias de maltrato y casos",
  "Vigilancia de mordeduras y zoonosis",
  "Exportación sanitaria y planillas",
];

/**
 * "Todavía no" — worded as límites honestos A.2, A.3, A.4 and C allow.
 */
const NOT_YET: readonly string[] = [
  "Ingreso con Mi Argentina: todavía no está construido. Hoy se entra con correo y contraseña.",
  "Envío automático a SENASA: todavía no. El lote sale en un esquema propio y la homologación del formato está pendiente.",
  "Validación del DNI contra registros estatales: todavía no existe. El documento es un dato declarado.",
  "Importación de padrones municipales que ya tengan en planillas: todavía no existe.",
];

/**
 * The pilot, in order. Step 2: create-institutional-account.ts (account born
 * confirmed, no password) + access-link-mail.ts (first-access link by mail;
 * the person sets their own password at FIRST_ACCESS_PATH). Step 3: PO D8
 * (no stated duration) and D3/D10 (the pilot is free; nothing said after it).
 */
const PILOT_STEPS: readonly string[] = [
  "Nos pasás los correos institucionales de quienes lo van a usar y las localidades de tu jurisdicción.",
  "Creamos las cuentas. Cada persona recibe un enlace de acceso por correo y elige su propia contraseña.",
  "Operás con datos reales: una jurisdicción, sin costo. El plazo lo definimos juntos según tu jurisdicción.",
];

/**
 * Three questions only (D10, D11). "¿Quién ve qué?": every govt reader fails
 * closed without jurisdictions (límites honestos B.5; AGENTS.md §5 omnibox —
 * zero assignments returns empty). Import of existing padrones: límites
 * honestos C (cut from the funcionario guide).
 */
const FAQ: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: "¿Tenemos que cargar todo de nuevo?",
    a: "Para empezar no hace falta cargar nada: el padrón se arma con lo que registran dueños, veterinarias y refugios de tu jurisdicción. Traer padrones que ya tengan en planillas todavía no se puede; si lo necesitan, lo vemos en la demo.",
  },
  {
    q: "¿Quién ve qué?",
    a: "Cada cuenta de tu oficina ve solo la jurisdicción que tiene asignada, y una cuenta sin jurisdicción no ve nada. Las consultas a datos personales y las exportaciones quedan registradas con su autor.",
  },
  {
    q: "¿Se conecta con otros sistemas públicos?",
    a: "Con Mi Argentina y con SENASA todavía no: el detalle está en la lista de lo que hay hoy y lo que todavía no, más arriba.",
  },
];

export default function MunicipiosPage() {
  return (
    <div className="lp flex min-h-screen flex-col" data-landing-root>
      <LandingNav />
      <main id="main-content" className="flex-1">
        {/* 1 · Hero. The headline is the Panorama "Cumplimiento" preset's
            default layer (antirrábica coverage per locality, presets.ts). */}
        <section className="lp-mun-hero" aria-labelledby="mun-title">
          <div className="lp-wrap">
            <p className="lp-mun-kicker">Para oficinas de Zoonosis y bienestar animal</p>
            <h1 id="mun-title" className="lp-display lp-mun-title">
              Dónde falta cobertura antirrábica en tu territorio.
            </h1>
            <p className="lp-mun-hero-lead">
              miMAR junta en una libreta por animal lo que cargan dueños, veterinarias y refugios.
              Tu oficina ve esos datos sumados sobre su jurisdicción: padrón, casos, campañas y un
              mapa de cobertura por localidad.
            </p>
            <div className="lp-mun-hero-cta">
              <a href="#piloto" className="lp-btn lp-btn--primary">
                Solicitar un piloto sin costo
              </a>
              <a href="#que-ves" className="lp-btn lp-mun-btn--line">
                Ver qué muestra
              </a>
            </div>
          </div>
        </section>

        {/* 2 · The four questions, each answered by a screen (sources on QUESTIONS). */}
        <section
          className="lp-section lp-section--paper lp-mun-section"
          id="que-ves"
          aria-labelledby="mun-q-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-q-title" className="lp-display lp-h-sec lp-mun-h">
              Las cuatro preguntas de tu oficina
            </h2>
            <ol className="lp-mun-questions">
              {QUESTIONS.map(({ q, screen, a }) => (
                <li key={q} className="lp-mun-question">
                  <p className="lp-mun-q">{q}</p>
                  <div>
                    <p className="lp-mun-screen">{screen}</p>
                    <p className="lp-mun-a">{a}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 3 · Where the data comes from (sources on SOURCES). */}
        <section
          className="lp-section lp-section--card lp-mun-section"
          aria-labelledby="mun-src-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-src-title" className="lp-display lp-h-sec lp-mun-h">
              Datos de origen, no planillas
            </h2>
            <p className="lp-lead lp-mun-sublead">
              Nadie completa un formulario para tu oficina. Cada dato entra donde ocurre, lo firma
              quien lo hizo y llega a tu tablero.
            </p>
            <ol className="lp-mun-chain">
              {SOURCES.map(({ who, what }) => (
                <li key={who}>
                  <p className="lp-mun-chain-who">{who}</p>
                  <p className="lp-mun-chain-what">{what}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 4 · Privacy, one paragraph. Sources: lib/utils/dni-hash.ts +
            límites honestos A.3 (hash + last 4, self-declared, no RENAPER);
            pii_queried audit rows (logPiiQueryForAuthority, AGENTS.md §5) +
            export audit row (B.5); threshold suppression with written
            exceptions (privacy-known-limitations.md, B.1–B.5); LICENSE
            (inspection and audit only). */}
        <section
          className="lp-section lp-section--paper lp-mun-section"
          aria-labelledby="mun-priv-title"
        >
          <div className="lp-wrap lp-mun-narrow">
            <h2 id="mun-priv-title" className="lp-display lp-h-sub">
              Privacidad y Ley 25.326
            </h2>
            <p className="lp-mun-prose">
              El DNI nunca se guarda en claro: queda una huella criptográfica y los últimos cuatro
              dígitos, y es un dato que declara la persona. Cada consulta a datos personales y cada
              exportación quedan registradas con su autor. Los mapas y tableros ocultan los grupos
              chicos por debajo de un umbral, y las excepciones están escritas: la exportación del
              padrón sale fila por fila, acotada a tu territorio y sin identificadores directos. El
              código es público para inspección y auditoría en{" "}
              <a
                href="https://github.com/ignaciodelvalle/mimar"
                className="underline"
                rel="noopener noreferrer"
                target="_blank"
              >
                github.com/ignaciodelvalle/mimar
              </a>
              .
            </p>
          </div>
        </section>

        {/* 5 · Available today vs not yet (sources on AVAILABLE / NOT_YET). */}
        <section
          className="lp-section lp-section--card lp-mun-section"
          id="hoy"
          aria-labelledby="mun-today-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-today-title" className="lp-display lp-h-sec lp-mun-h">
              Lo que hay hoy, y lo que todavía no
            </h2>
            <div className="lp-mun-today">
              <div>
                <h3 className="lp-mun-col-h">Disponible hoy</h3>
                <ul className="lp-mun-list">
                  {AVAILABLE.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="lp-mun-col-h">Todavía no</h3>
                <ul className="lp-mun-list lp-mun-list--pending">
                  {NOT_YET.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* 6 · How a pilot works (sources on PILOT_STEPS). A real sequence, so
            it is numbered. */}
        <section
          className="lp-section lp-section--paper lp-mun-section"
          aria-labelledby="mun-pilot-title"
        >
          <div className="lp-wrap">
            <h2 id="mun-pilot-title" className="lp-display lp-h-sec lp-mun-h">
              Cómo es un piloto
            </h2>
            <ol className="lp-mun-steps">
              {PILOT_STEPS.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </section>

        {/* 7 · The form (WU6). No response time is promised (D9). */}
        <section className="lp-mun-request" id="piloto" aria-labelledby="mun-form-title">
          <div className="lp-wrap lp-mun-request-grid">
            <div>
              <h2 id="mun-form-title" className="lp-display lp-h-sec">
                Solicitar un piloto
              </h2>
              <p className="lp-mun-request-lead">
                Te respondemos a la brevedad para coordinar una demo de cinco minutos sobre tu
                territorio.
              </p>
              <p className="lp-mun-request-note">
                El pedido nos llega por correo; no lo guardamos en la base de datos de miMAR. No te
                pedimos DNI.
              </p>
            </div>
            <div className="lp-mun-form-card">
              <PilotRequestForm />
            </div>
          </div>
        </section>

        {/* 8 · FAQ, three questions only (sources on FAQ). */}
        <section
          className="lp-section lp-section--paper lp-mun-section"
          aria-labelledby="mun-faq-title"
        >
          <div className="lp-wrap lp-mun-narrow">
            <h2 id="mun-faq-title" className="lp-display lp-h-sub">
              Preguntas frecuentes
            </h2>
            <div className="lp-faq mt-6">
              {FAQ.map(({ q, a }) => (
                <details className="op-disclosure" key={q}>
                  <summary>{q}</summary>
                  <p className="lp-faq-a">{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>
      <LandingFooter />
    </div>
  );
}
