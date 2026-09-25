"use client";

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
  PAMPA_SIGNUP_LINE,
  landingDate,
  mapTintStep,
  pampaEvent,
} from "@/components/landing/landing-content";
import { useChapterSequence } from "@/components/landing/use-chapter-sequence";
import { LnPetPhoto, LnRegRow, LnRegistry } from "@/components/ui/RegRow";
import { LnStatusFlag } from "@/components/ui/StatusFlag";
import { OpKpiSm } from "@/components/ui/dashboard/OpKpiSm";
import { formatRate } from "@/lib/utils/format";
import { speciesLabel } from "@/lib/utils/species";
import { PAMPA_PET } from "@/scripts/flagship-pampa-data";
import type React from "react";
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

export function AppHead({
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

// The vet, lost and shelter chapters are animated sequences: see
// story-sequences.tsx.

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

// PS9 (PO, 2026-09-25): the map fills in once, north to south — each row of
// tiles fades up ~40ms after the one above it, as the chapter's counters run.
// Fail-open through useChapterSequence: SSR, no-JS and reduced motion get the
// tinted map with no animation class; only a live observer, with motion
// allowed, dims the tiles first. Opacity only (the tint is the tile's own
// background, which never animates).
const WAVE_STEP_MS = 80;

function ConsoleCartogram() {
  const { ref, step, animate } = useChapterSequence(2, WAVE_STEP_MS);
  const waveClass = animate
    ? step >= 1
      ? "lp-map-grid lp-map-grid--in"
      : "lp-map-grid lp-map-grid--pending"
    : "lp-map-grid";
  return (
    <div className={waveClass} ref={ref} data-section="estado-map">
      {MAP_TILES.map((t) => (
        <div
          key={t.ab}
          className="lp-mtile"
          data-q={mapTintStep(t.v)}
          style={
            {
              gridColumn: t.c + 1,
              gridRow: t.r + 1,
              "--row": t.r,
            } as React.CSSProperties
          }
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
