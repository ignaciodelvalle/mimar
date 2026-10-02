"use client";

// Story device screens — illustrative renders of the real product surfaces.
// Martín's phone is the NATIVE owner app (apps/mobile) in every chapter (PO
// 2026-09-30): each screen below cites the native file it transcribes.
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
  mapTintStep,
} from "@/components/landing/landing-content";
import { useChapterSequence } from "@/components/landing/use-chapter-sequence";
import { LnPetPhoto } from "@/components/ui/RegRow";
import { OpKpiSm } from "@/components/ui/dashboard/OpKpiSm";
import { formatRate, pluralizeEs } from "@/lib/utils/format";
import { speciesLabel } from "@/lib/utils/species";
import { PAMPA_PET } from "@/scripts/flagship-pampa-data";
import Link from "next/link";
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

/**
 * The org portal's own header, for the tablet screens (vet, refugio): an
 * eyebrow + the org's display name as the h1, exactly the pattern
 * `app/org/[orgToken]/page.tsx` renders ("Panel de {orgType}" over
 * `organization.displayName`, both in ln-op-mute/ln-op-ink) — the org
 * identity a real member sees is constant across the portal, unlike the
 * page-specific title underneath, which stays whatever that real page calls
 * itself (e.g. "Ingresos", `app/org/[orgToken]/intake/page.tsx`).
 *
 * `right` (e.g. the "Matrícula verificada" badge) renders on its own row
 * below the title, not beside it: a badge sharing the title's row squeezed
 * the column at the tablet's width and broke "PANEL DE / CLÍNICA" and
 * "Atender / mascota" mid-phrase (coordinator review, round 3).
 */
export function OpHead({
  orgType,
  orgName,
  page,
  right,
}: {
  orgType: string;
  orgName: string;
  page?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="lp-op-head">
      <p className="lp-op-eyebrow">Panel de {orgType}</p>
      <div className="lp-op-title">{orgName}</div>
      {page && <p className="lp-op-page">{page}</p>}
      {right && <div className="lp-op-badge-row">{right}</div>}
    </div>
  );
}

/**
 * The native pet screen's document band, back face
 * (apps/mobile/src/pets/DocumentChromeNative.tsx:386-396): "Libreta Sanitaria"
 * over "Libreta · dorso". No situation chip: an active pet has none (:402).
 */
export function NativeLibretaBand() {
  return (
    <div className="lp-nat-band">
      <b>Libreta Sanitaria</b>
      <span>Libreta · dorso</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dueño — the sign-up moment (2022-03-14): only Pampa, no chip yet
// ---------------------------------------------------------------------------

// The native "Mis mascotas" list the day Martín registers her: one row,
// transcribed from apps/mobile/src/pets/PetRow.tsx:82-136 — photo, the name
// in serif, the species, the status chip (petStatusLabel("active") →
// "Activa", apps/mobile/src/credential/credential-view-model.ts:258-262) —
// and the list footer's "Registrar otra mascota"
// (apps/mobile/app/mascotas/index.tsx:431). The stack title is
// apps/mobile/app/_layout.tsx:288.
//
// Removed (landing-vs-app audit 2026-09-30): the "Credencial y QR creados ·
// sin chip todavía" line, and the "Compartir miMAR" / "Modo perdido" chips —
// no list the product draws carries them.
export function DuenoScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Mis mascotas" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-nat-petrow">
          <LnPetPhoto src="/landing/pampa-hero.jpg" alt={PAMPA.name} size={52} radius="md" />
          <div className="min-w-0 flex-1">
            <b className="lp-nat-petname">{PAMPA.name}</b>
            <span className="lp-nat-petsp">{speciesLabel(PAMPA_PET.species)}</span>
          </div>
          <span className="lp-nat-chip">Activa</span>
        </div>
        <span className="lp-vf-submit">Registrar otra mascota</span>
      </div>
    </>
  );
}

// The vet, lost and shelter chapters are animated sequences: see
// story-sequences.tsx.

// ---------------------------------------------------------------------------
// La libreta — the seed's entries (minus the purged scan), newest first
// ---------------------------------------------------------------------------

// The native pet screen turned to its libreta face: the stack title "Mascota"
// (apps/mobile/app/_layout.tsx:302), the document band, and the "Asientos"
// card with its count (apps/mobile/src/pets/LibretaScreen.tsx:316-335,
// ledgerCountLabel in libreta-view-model.ts:222-224). The face's "Anotar"
// button and its identity, vaccination and "Próximo" cards sit above the
// ledger in the app; they are omitted here, not altered.
//
// The old footer badge ("Historial que solo se agrega") was the landing's own
// wording. The native face prints LIBRETA_IMMUTABILITY_NOTE instead, which
// says the events are never deleted — the overclaim the honesty pass removed
// from this page (límites honestos A.1), so neither is drawn.
export function LibretaScreen() {
  // The moment this chapter depicts is today: its last asiento is 2026's.
  const now = new Date();
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Mascota" />
      <NativeLibretaBand />
      <span className="lp-nat-card-t">Asientos</span>
      <span className="lp-nat-count">
        {LIBRETA_EVENTS.length} {pluralizeEs(LIBRETA_EVENTS.length, "registro")}
      </span>
      <LibretaFeed events={LIBRETA_EVENTS_NEWEST_FIRST} now={now} />
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
          title={`${t.name} · ${formatRate(t.v)}%`}
        >
          <span className="lp-ab">{t.ab}</span>
          <span className="lp-mv">{formatRate(t.v)}</span>
        </div>
      ))}
    </div>
  );
}

const LEGEND_STEPS: Array<[0 | 1 | 2 | 3 | 4, string]> = [
  [0, "<45%"],
  [1, "45–55%"],
  [2, "55–65%"],
  [3, "65–75%"],
  [4, "≥75%"],
];

const LEGEND_TINT: Record<number, string> = {
  0: "color-mix(in srgb, var(--color-ln-celeste) 12%, transparent)",
  1: "color-mix(in srgb, var(--color-ln-celeste) 28%, transparent)",
  2: "color-mix(in srgb, var(--color-ln-celeste) 48%, transparent)",
  3: "color-mix(in srgb, var(--color-ln-celeste) 70%, transparent)",
  // Same fill as .lp-mtile[data-q="4"] in app/landing.css (see its contrast note).
  4: "color-mix(in srgb, var(--color-ln-celeste) 55%, var(--color-ln-celeste-100))",
};

// M7 (critique 2026-09-29, PO-approved): the chapter was a 1,200px dark
// console with zoonotic signals, a cartogram and four KPIs, and the one line
// an owner cares about ("solo datos agregados, nunca individuales") was its
// third bullet. It now opens on that line, keeps a small console (the map and
// two KPIs) as a glimpse, and sends whoever wants more to /municipios.
export function EstadoConsole({ bridge }: { bridge?: string }) {
  return (
    <div className="lp-estado lp-estado--compact" data-section="estado-console">
      <div className="lp-estado-copy">
        {/* "Vista · Estado" was cut (copy review 2026-09-30): redundant with
            the "Capítulo 6 · Estado" number right above the chapter. */}
        {/* Copy review 2026-09-30 (the state-access claim, minimal option):
            the chapter used to claim "totales, nunca a tu mascota" / "solo
            datos agregados, nunca individuales" — false. A funcionario can
            open any pet's file in their own jurisdiction (see
            lib/infra/omnibox-search.ts, lib/infra/gob-pet-subview.ts); what is
            true is narrower and stronger: only their own zone, and every
            access is logged. */}
        <h3 className="lp-display lp-h-sub mt-3">Tu comuna cuida la salud de todos.</h3>
        {/* The chapter's bridge from the libreta, as the heading's own
            standfirst (critique 2026-09-29, m8). It used to float as plain
            text above the dark card, with no heading, and did not read as
            part of the chapter. */}
        {bridge && <p className="lp-estado-bridge">{bridge}</p>}
        <p className="lp-estado-privacy" data-section="estado-privacy">
          <Icon name="candado" size="sm" decorative />
          <span>
            La autoridad de tu zona accede a lo que necesita para cuidar la salud pública, y cada
            acceso queda registrado.
          </span>
        </p>
        <Link href="/municipios" className="lp-estado-more">
          Ver más para municipios
        </Link>
      </div>

      <div className="lp-estado-glimpse">
        <div className="lp-mac" aria-hidden="true">
          <div className="lp-mac-bar">
            <span className="lp-mac-dot" />
            <span className="lp-mac-dot" />
            <span className="lp-mac-dot" />
            <span className="lp-mac-title">miMAR · Consola de vigilancia</span>
          </div>
          <div className="lp-con">
            <div className="lp-con-kpis">
              {CONSOLE_KPIS.map((k) => (
                <div className="lp-navy-card op-surface" key={k.label}>
                  <OpKpiSm label={k.label} value={<CountUp value={k.value} />} tone={k.tone} />
                </div>
              ))}
            </div>
            <div className="lp-con-map">
              <div className="lp-con-map-h">
                {/* The panorama's rabies-coverage layer, under the KPI's own label
                    (lib/metrics/kpi-catalog.ts:377). */}
                <b>Cobertura antirrábica — perros (12 meses)</b>
                <span className="lp-con-map-sub">por jurisdicción</span>
              </div>
              <ConsoleCartogram />
              <div className="lp-legend">
                {LEGEND_STEPS.map(([q, label]) => (
                  <span className="lp-lg" key={q}>
                    <span className="lp-sw" style={{ background: LEGEND_TINT[q] }} /> {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <p className="lp-con-note">consola ilustrativa · datos de demostración</p>
      </div>
    </div>
  );
}
