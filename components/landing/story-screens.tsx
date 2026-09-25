// Story device screens — illustrative renders of the real product surfaces,
// built from the shipped DS components (LnRegistry/LnRegRow/LnBadge/
// LnStatusFlag/LnVstamp/LnPetPhoto). Ported from the handoff prototype
// (landing2/screens.jsx, story-screens.jsx, console.jsx).
//
// All screens live inside an aria-hidden PhoneFrame / console window: they
// are decorative illustrations; the narrative copy lives in the chapters.
//
// The console KPI tile below uses OpKpiSm imported directly from its own
// module (components/ui/dashboard/OpKpiSm.tsx, W5c) — NOT from OpKpi.tsx or
// the components/ui/dashboard barrel, both of which also pull in the full
// admin OpKpi tile (metric-contract engine, ProvenanceCard, KPI_CATALOG, a
// dynamic-imported chart module). Importing OpKpi.tsx here previously shipped
// ~35KB of unrelated operator-dashboard code to every anonymous landing
// visitor (LCP fix, R-2, 2026-09-23 mobile audit) — see
// __tests__/landing-kpi-module-graph.test.ts for the regression guard.

import { Icon } from "@/components/Icon";
import { CountUp } from "@/components/landing/CountUp";
import { LibretaFeed } from "@/components/landing/LibretaFeed";
import {
  CONSOLE_KPIS,
  LIBRETA_EVENTS,
  MAP_TILES,
  PAMPA,
  PAMPA_FIRST_DOSE,
  PAMPA_OWNER_NAME,
  PAMPA_SIGNUP_LINE,
  PAMPA_VET,
  formatChip,
  landingDate,
  mapTintStep,
  pampaEvent,
} from "@/components/landing/landing-content";
import { LnBadge } from "@/components/ui/Badge";
import { LnHero } from "@/components/ui/Hero";
import { LnPetPhoto, LnRegRow, LnRegistry } from "@/components/ui/RegRow";
import { LnStatusFlag, LnVstamp } from "@/components/ui/StatusFlag";
import { OpKpiSm } from "@/components/ui/dashboard/OpKpiSm";
import { publicPlaceReference } from "@/lib/domain/public-place-reference";
import { lostTimeLabel } from "@/lib/infra/lost-listing";
import {
  eventTypeLabel,
  formatRate,
  foundPossessivePhrase,
  lastSeenHeadingLabel,
  lostBannerHeadline,
} from "@/lib/utils/format";
import { speciesLabel } from "@/lib/utils/species";
import { PAMPA_CHIP, PAMPA_PET } from "@/scripts/flagship-pampa-data";
import type { ReactNode } from "react";

// Newest first (WU3 — "the libreta fills up" animation): the feed reads as an
// activity log, most recent entry on top, both statically and while it plays
// in. LIBRETA_EVENTS itself stays chronological (oldest → newest) since that
// is the natural authoring order in landing-content.ts; the reversal is a
// presentation choice made once, here.
const LIBRETA_EVENTS_NEWEST_FIRST = [...LIBRETA_EVENTS].reverse();

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function AppHead({
  title,
  sub,
  photo,
  right,
}: {
  title: string;
  sub?: ReactNode;
  photo?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="lp-app-head">
      {photo}
      <div className="min-w-0 flex-1">
        <div className="lp-ah-t">{title}</div>
        {sub && <div className="lp-ah-s">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dueño — the sign-up moment (2022-03-14): only Pampa, no chip yet
// ---------------------------------------------------------------------------

// The screen shows Pampa as she was on the chapter's date. It used to be a
// 2026 list with a Beagle and a rabbit the seed never created and "1 alerta
// activa"; on the day Martín signed up there was one pet, a credential and a
// QR, and no chip (the seed's pet_registered has has_microchip: false).
const REGISTERED = pampaEvent("pet_registered");

export function DuenoScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Mis mascotas" sub={`Alta · ${landingDate(REGISTERED.date)}`} />
      <div className="lp-app-body px-3 pt-2.5">
        <LnRegistry>
          <LnRegRow
            name={PAMPA.name}
            status="registered"
            sex={PAMPA.sexEnum}
            species={speciesLabel(PAMPA_PET.species)}
            breed={PAMPA_SIGNUP_LINE}
            nextLine="Credencial y QR creados · sin chip todavía"
            photoSrc="/landing/pampa-hero.jpg"
            photoSize={46}
          />
        </LnRegistry>
        <div className="lp-ph-caps mt-3">
          <span className="lp-ph-cap">
            <Icon name="share" size="sm" decorative className="text-[var(--color-ln-azul)]" />
            Compartir miMAR
          </span>
          <span className="lp-ph-cap">
            <Icon name="perdida" size="sm" decorative className="text-[var(--color-ln-err)]" />
            Modo perdido
          </span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Veterinaria — the 2022-04-12 rabies dose, signed with a verified license
// ---------------------------------------------------------------------------

// The vet chapter leans on the SAME credential object the app ships (LnHero,
// the identity face of CredentialFace) plus the real vaccination stamp
// (LnVstamp). Every fact is the seed's: the vet, her license and clinic, and
// the first dose's brand, batch and next due date. The chip tag is true on
// this date (implanted 2022-04-05); a "vigente" tag is not a product string.
export function VetVaccineScreen() {
  const dose = PAMPA_FIRST_DOSE.payload;
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        title={PAMPA_VET.name}
        sub={
          <>
            <span className="whitespace-nowrap">{PAMPA_VET.license}</span> · {PAMPA_VET.clinic}
          </>
        }
        right={<LnBadge variant="success">Matrícula verificada</LnBadge>}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-cred-embed">
          <LnHero
            name={PAMPA.name}
            status="ok"
            photoSrc="/landing/pampa-hero.jpg"
            tags={[
              {
                key: "chip",
                label: "Microchip",
                icon: <Icon name="microchip" size="sm" decorative />,
              },
            ]}
          />
        </div>

        <div className="lp-ph-ok">
          <Icon name="vacuna" size="sm" decorative className="mt-0.5 text-[var(--color-ln-ok)]" />
          <div className="min-w-0 flex-1">
            <div className="lp-t">
              {String(dose.vaccine_name)} · {String(dose.brand)}
            </div>
            <div className="lp-lib-meta">
              Lote {String(dose.batch)} · próxima {landingDate(String(dose.next_due_at))}
            </div>
            <div className="lp-lib-foot mt-1">
              <span className="lp-lib-type">{eventTypeLabel("vaccination_administered")}</span>
              <span className="lp-lib-by">
                {PAMPA_VET.shortName} ·{" "}
                <span className="whitespace-nowrap">{PAMPA_VET.license}</span>
              </span>
            </div>
          </div>
          <LnVstamp variant="ok" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Se pierde — the public credential in lost mode, as a neighbour sees it
// ---------------------------------------------------------------------------

// The finder's view the day after she got loose (the seed's anonymous scan is
// 2024-03-10, one day after the lost report). Every string is one the public
// page (app/(public)/p/[publicToken] + components/pet-profile/
// PublicLostSections.tsx) renders for Pampa: the name alone as the heading,
// "Lo busca Martín.", "Llamar" (her phone is disclosed in the seed) and the
// finder's "La tengo conmigo". The seed's lost report carries a place name but
// NO coordinates, so the public page shows no pinned map, only the place and
// "Sin punto exacto en el mapa". The panel below says exactly that.
const LOST = pampaEvent("status_changed", "lost");
const SCANNED = pampaEvent("credential_scanned");

function noonUtc(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

export function AnonLostScreen() {
  const place = publicPlaceReference(String(LOST.payload.location_description));
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-lostb">
        {lostBannerHeadline(PAMPA.sexEnum)}
        <small>{lostTimeLabel(noonUtc(LOST.date), noonUtc(SCANNED.date))}</small>
      </div>
      <div className="lp-lost-hero lp-lost-hero--map">
        <div className="lp-lh-name">{PAMPA.name}</div>
        <div className="lp-lh-sub">Lo busca {PAMPA_OWNER_NAME}.</div>
      </div>

      {/* Last-seen panel: the place name, no pinned map (the seed's lost
          report has no coordinates). A lightweight static panel, so the
          landing never pulls the maplibre-gl runtime for a decorative frame. */}
      <figure className="lp-minimap" aria-hidden="true">
        <span className="lp-minimap-pin">
          <Icon name="ubicacion" size="sm" decorative />
        </span>
        <figcaption className="lp-minimap-cap">
          <b>{lastSeenHeadingLabel(PAMPA.sexEnum)}</b>
          <span>{place}</span>
          <span className="lp-minimap-coord">Sin punto exacto en el mapa</span>
        </figcaption>
      </figure>

      <div className="lp-lost-actions">
        <span className="lp-lost-btn lp-lost-btn--call">
          <Icon name="telefono" size="sm" decorative /> Llamar
        </span>
        <span className="lp-lost-btn lp-lost-btn--found">
          <Icon name="ubicacion" size="sm" decorative /> {foundPossessivePhrase(PAMPA.sexEnum)}
        </span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Refugio — the chip match and the intake the shelter signs
// ---------------------------------------------------------------------------

// The shelter's own portal (so its name may show here; Pampa's libreta entry
// carries none). Two real steps: the org intake's chip match card
// ("Posible coincidencia detectada" → "Es la misma mascota",
// app/org/[orgToken]/intake/match) and the intake it records. The return home
// is NOT a shelter action: Martín marks her found two days later.
const INTAKE = pampaEvent("shelter_intake_recorded");

export function OrgIntakeScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        title="Refugio Patitas del Barrio"
        sub="Panel de ingresos"
        right={<LnBadge variant="info">Verificada</LnBadge>}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <div className="lp-intake-row">
            <span className="lp-iic">
              <Icon name="microchip" size="sm" decorative />
            </span>
            <div className="min-w-0">
              <b>Posible coincidencia detectada</b>
              <span className="lp-intake-sub">
                Microchip {formatChip(PAMPA_CHIP)}: es <strong>{PAMPA.name}</strong>.
              </span>
              <span className="lp-intake-sub">
                <span className="lp-lib-type">Es la misma mascota</span>
              </span>
            </div>
          </div>
          <div className="lp-intake-row" data-t="ok">
            <span className="lp-iic">
              <Icon name="casa" size="sm" decorative />
            </span>
            <div className="min-w-0">
              <b>{eventTypeLabel("shelter_intake_recorded")}</b>
              <span className="lp-intake-sub">
                {String(INTAKE.payload.intake_condition)} · {landingDate(INTAKE.date)}
              </span>
            </div>
          </div>
        </div>
        <p className="lp-ph-note">
          Refugio, veterinaria o municipio: el acceso llega por solicitud verificada. El público ve
          un solo sello.
        </p>
        <div className="lp-ph-caps mt-auto">
          <span className="lp-ph-cap">
            <Icon name="check" size="sm" decorative /> Custodia trazable
          </span>
          <span className="lp-ph-cap">
            <Icon name="check" size="sm" decorative /> Adopciones y tránsitos
          </span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// La libreta — the seed's entries (minus the purged scan), append-only
// ---------------------------------------------------------------------------

export function LibretaScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        photo={<LnPetPhoto alt={PAMPA.name} status="ok" size={40} />}
        title={PAMPA.name}
        sub={`${PAMPA.sex} · ${PAMPA.age}`}
        right={<LnStatusFlag status="ok" />}
      />
      <LibretaFeed events={LIBRETA_EVENTS_NEWEST_FIRST} />
      {/* Honesty pass (WU1; caught by the fence's extended ban list,
          2026-09-24 review): "nada se edita, nada se borra" was a second
          instance of the same A.1 overclaim already fixed on
          CHAPTERS.libreta.lead — missed here because it lives in the phone
          mock's own badge, not the chapter copy. Same A.1 wording. */}
      <div className="lp-lib-lock">
        <Icon name="candado" size="sm" decorative /> append-only — una corrección es un asiento
        nuevo, nunca una edición
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Cap 6 · Estado — navy console with the celeste silhouette cartogram
// ---------------------------------------------------------------------------

function ConsoleCartogram() {
  return (
    <div className="lp-map-grid">
      {MAP_TILES.map((t) => (
        <div
          key={t.ab}
          className="lp-mtile"
          data-q={mapTintStep(t.v)}
          style={{ gridColumn: t.c + 1, gridRow: t.r + 1 }}
          title={`${t.name} · ${formatRate(t.v)} /100k`}
        >
          <span className="lp-ab">{t.ab}</span>
          <span className="lp-mv">{formatRate(t.v)}</span>
        </div>
      ))}
    </div>
  );
}

const LEGEND_STEPS: Array<[0 | 1 | 2 | 3 | 4, string]> = [
  [0, "<1,5"],
  [1, "1,5–4"],
  [2, "4–6"],
  [3, "6–8"],
  [4, "≥8"],
];

const LEGEND_TINT: Record<number, string> = {
  0: "color-mix(in srgb, var(--color-ln-celeste) 12%, transparent)",
  1: "color-mix(in srgb, var(--color-ln-celeste) 28%, transparent)",
  2: "color-mix(in srgb, var(--color-ln-celeste) 48%, transparent)",
  3: "color-mix(in srgb, var(--color-ln-celeste) 70%, transparent)",
  4: "var(--color-ln-celeste)",
};

export function EstadoConsole() {
  return (
    <div className="lp-estado" data-section="estado-console">
      <div className="lp-estado-head">
        <div>
          <p className="lp-eyebrow">Vista · Estado</p>
          <h3 className="lp-display lp-h-sub mt-3">Tendencias, no planillas.</h3>
          {/* Honesty pass (WU1, landing redesign 2026-09-24; corrected
              2026-09-24 review): dropped "del país" (no jurisdiction has
              onboarded the whole country) and "en tiempo real". The first
              draft's replacement — "actualizadas todos los días" — was ALSO
              wrong: panorama_cube (the daily cron) only serves 5 CHOROPLETH
              layers {cobertura, esterilizacion, microchip, ppp, mortalidad}
              to ADMIN actors on a COMPLETE national/province slice
              (src/modules/panorama/application/load-layer-features-cube.ts).
              A municipio/provincia's own scoped view — what this chapter
              speaks to — "stays live in v1" per that same file, and the
              zoonotic-signals KPI itself (active_zoonosis_signals,
              lib/metrics/kpi-catalog.ts:576-585, fetcherName
              "fetchActiveZoonosis") is a live "'now' snapshot", not a daily
              batch. No cadence claim now — just automatic vs. manual. */}
          <p className="lp-lead mt-3.5 text-lg">
            Cada libreta suma a la foto sanitaria de cada jurisdicción. La consola llega
            prefiltrada: señales zoonóticas, sin planillas.
          </p>
        </div>
        <div className="lp-kicks">
          <div className="lp-kick">
            <span className="lp-kic">
              <Icon name="chart-line" size="sm" decorative />
            </span>
            <div>
              <b>Señales tempranas</b>
              <span className="lp-kick-sub">
                Síntomas y diagnósticos agregados detectan patrones antes.
              </span>
            </div>
          </div>
          <div className="lp-kick">
            <span className="lp-kic">
              <Icon name="map-pin" size="sm" decorative />
            </span>
            <div>
              <b>Por jurisdicción</b>
              <span className="lp-kick-sub">Cobertura, denuncias y brotes, comuna por comuna.</span>
            </div>
          </div>
          <div className="lp-kick">
            <span className="lp-kic">
              <Icon name="candado" size="sm" decorative />
            </span>
            <div>
              <b>Anonimizado por diseño</b>
              <span className="lp-kick-sub">Solo datos agregados — nunca individuales.</span>
            </div>
          </div>
        </div>
      </div>

      <div className="lp-mac" aria-hidden="true">
        <div className="lp-mac-bar">
          <span className="lp-mac-dot" />
          <span className="lp-mac-dot" />
          <span className="lp-mac-dot" />
          <span className="lp-mac-title">miMAR · Consola de vigilancia</span>
        </div>
        <div className="lp-con">
          <div className="lp-con-bar">
            <span className="lp-con-title">
              <Icon name="shield" size="sm" decorative /> Señales zoonóticas
            </span>
            <span className="lp-fpill">Últimos 12 meses</span>
            <span className="lp-fpill">Rabia + leptospirosis</span>
            <span className="lp-fpill">Confirmadas y sospechosas</span>
          </div>
          <div className="lp-con-body">
            <div className="lp-con-rail">
              {CONSOLE_KPIS.map((k) => (
                <div className="lp-navy-card op-surface" key={k.label}>
                  <OpKpiSm label={k.label} value={<CountUp value={k.value} />} tone={k.tone} />
                </div>
              ))}
              <div className="lp-con-railnote">
                fuente: miMAR + campañas oficiales
                <br />
                agregado y anónimo por diseño
                <br />
                datos ilustrativos · demo
              </div>
            </div>
            <div className="lp-con-map">
              <div className="lp-con-map-h">
                <b>Señales por 100 mil habitantes</b>
                <span className="lp-con-map-sub">por jurisdicción</span>
              </div>
              <ConsoleCartogram />
              <div className="lp-legend">
                {LEGEND_STEPS.map(([q, label]) => (
                  <span className="lp-lg" key={q}>
                    <span className="lp-sw" style={{ background: LEGEND_TINT[q] }} /> {label}
                  </span>
                ))}
                <span className="flex-1" />
                <span>actualizado hoy · 07:00</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="lp-con-note">consola ilustrativa · datos de demostración</p>
    </div>
  );
}
