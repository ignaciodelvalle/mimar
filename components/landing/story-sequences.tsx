"use client";

// The story's three animated chapters — Veterinaria, Se pierde, Refugio (PS6,
// PS7, PS8; PO 2026-09-25). Each plays ONCE when its chapter is ~40% in view,
// through useChapterSequence (fail-open: SSR and reduced motion render the
// FINAL step with no animation class; see that file).
//
// Two rules every screen below keeps, and the fence in
// __tests__/flagship-pampa-consistency.test.tsx checks:
//  - Every Pampa fact is the seed's (scripts/flagship-pampa-data.ts): dates,
//    the dose, the vet, the lost report, the intake.
//  - Every string drawn INSIDE a device is one the product itself renders, at
//    the file cited next to it. The step list on the left is the landing's own
//    narration, and says so by living outside the device.
//
// Motion: transform/opacity only, inside fixed-size device frames (.lp-scr is
// a fixed height), so nothing outside the phone ever moves.

import { Icon } from "@/components/Icon";
import { PhoneFrame } from "@/components/landing/PhoneFrame";
import { StepButton } from "@/components/landing/StepButton";
import type { LandingChapter } from "@/components/landing/landing-content";
import {
  PAMPA,
  PAMPA_FIRST_DOSE,
  PAMPA_OWNER_NAME,
  PAMPA_VET,
  landingDate,
  pampaEvent,
} from "@/components/landing/landing-content";
import { AppHead } from "@/components/landing/story-screens";
import { useChapterSequence } from "@/components/landing/use-chapter-sequence";
import { LnBadge } from "@/components/ui/Badge";
import { LnPetPhoto } from "@/components/ui/RegRow";
import { LnStatusFlag, LnVstamp } from "@/components/ui/StatusFlag";
import { publicPlaceReference } from "@/lib/domain/public-place-reference";
import { lostTimeLabel } from "@/lib/infra/lost-listing";
import {
  eventTypeLabel,
  foundPossessivePhrase,
  lastSeenHeadingLabel,
  lostBannerHeadline,
  sexLabel,
  sightingPhrase,
} from "@/lib/utils/format";
import { speciesLabel } from "@/lib/utils/species";
import { PAMPA_CHIP, PAMPA_PET } from "@/scripts/flagship-pampa-data";
import type { ReactElement, ReactNode } from "react";

const PHOTO = "/landing/pampa-hero.jpg";

const LOST = pampaEvent("status_changed", "lost");
const SCANNED = pampaEvent("credential_scanned");
const INTAKE = pampaEvent("shelter_intake_recorded");
const FOUND = pampaEvent("status_changed", "active");
const LOST_PLACE = String(LOST.payload.location_description);
const LOST_WEARING = String(
  (LOST.payload.lost_description as Record<string, unknown> | undefined)?.accessories_when_lost ??
    "",
);

function noonUtc(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}

/** "2024-03-09" → "9/3/2024" — what toLocaleDateString("es-AR") prints. */
function numericDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${Number(d)}/${Number(m)}/${y}`;
}

/** Class for a part of a screen that appears at `from` (0-based step). */
function reveal(animate: boolean, step: number, from: number): string {
  if (!animate) return "";
  return step >= from ? "lp-seq-in" : "lp-seq-pending";
}

// ---------------------------------------------------------------------------
// The chapter shell: narration + step list on the left, the device on the right
// ---------------------------------------------------------------------------

type SequenceSpec = {
  /** Number of device steps the sequence plays through. */
  total: number;
  stepMs: number;
  /** Step list items: `at` is the device step the item completes at (and jumps to). */
  items: Array<{ label: string; at: number }>;
  /** Whose device this is, per step (shown above the phone), or none. */
  deviceLabel?: (step: number) => string;
  device: (step: number, animate: boolean) => ReactElement;
};

function SequencedChapter({
  chapter,
  index,
  spec,
}: {
  chapter: LandingChapter;
  index: number;
  spec: SequenceSpec;
}) {
  const { ref, step, animate, goTo } = useChapterSequence(spec.total, spec.stepMs);
  // The item in progress: the first whose completion step is not behind us.
  const activeItem = Math.max(
    0,
    spec.items.findIndex((it) => it.at >= step),
  );
  return (
    <div
      className="lp-chapter"
      data-side={chapter.side}
      id={`cap-${chapter.key}`}
      data-sequence={chapter.key}
      data-step={step}
    >
      <div className="lp-chapter-grid">
        <div>
          <div className="lp-ch-num">
            Capítulo {index + 1} · {chapter.hand}
          </div>
          <h3 className="lp-display lp-h-sub lp-ch-title">{chapter.title}</h3>
          <p className="lp-lead lp-ch-lead">{chapter.lead}</p>
          <ol className="lp-seq-steps" aria-label={`Pasos del capítulo ${index + 1}`}>
            {spec.items.map((it, i) => {
              const state = i < activeItem ? "done" : i === activeItem ? "on" : "todo";
              return (
                <li key={it.label}>
                  <StepButton
                    className="lp-seq-step"
                    active={i === activeItem}
                    data-state={state}
                    onSelect={() => goTo(it.at)}
                  >
                    <span className="lp-seq-n" aria-hidden="true">
                      {state === "done" ? <Icon name="check" size="sm" decorative /> : i + 1}
                    </span>
                    <span>{it.label}</span>
                  </StepButton>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="lp-ch-device lp-seq-device" ref={ref}>
          {spec.deviceLabel && <p className="lp-seq-who">{spec.deviceLabel(step)}</p>}
          {spec.device(step, animate)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PS6 · Veterinaria — "La vacuna queda firmada." (2022-04-12)
// ---------------------------------------------------------------------------

// The vet records a vaccine through the web portal's attendance form
// (app/_components/attendance-forms/VaccinationAttendanceForm.tsx): its real
// field labels, its real submit "Marcar asistencia". Then the libreta's own
// FIRMADO stamp. The product captures no hand-drawn signature, so none is
// drawn: the signature IS the verified author + license + stamp.
const DOSE = PAMPA_FIRST_DOSE.payload;
const VET_FIELDS: Array<[string, string]> = [
  ["Nombre de la vacuna", String(DOSE.vaccine_name)],
  ["Marca / laboratorio", String(DOSE.brand)],
  ["Lote / número de batch", String(DOSE.batch)],
  ["Administrado por", String(DOSE.administered_by)],
  ["Próxima dosis (fecha)", numericDate(String(DOSE.next_due_at))],
];
const VET_PRESS = VET_FIELDS.length; // 5
const VET_STAMP = VET_PRESS + 1; // 6
const VET_ADDED = VET_STAMP + 1; // 7

function VetPortalScreen({ step, animate }: { step: number; animate: boolean }) {
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
        <div className="lp-vf-pet">
          <LnPetPhoto src={PHOTO} alt={PAMPA.name} status="ok" size={36} />
          <b>{PAMPA.name}</b>
          <span className="lp-vf-tag">
            <Icon name="microchip" size="sm" decorative /> Microchip
            <Icon name="check" size="sm" decorative />
          </span>
        </div>
        <div className="lp-vf-form">
          {VET_FIELDS.map(([label, value], i) => (
            <div className="lp-vf" key={label}>
              <span className="lp-vf-l">{label}</span>
              <span className="lp-vf-i">
                <span className={reveal(animate, step, i)}>{value}</span>
              </span>
            </div>
          ))}
          <span
            className={
              animate && step === VET_PRESS ? "lp-vf-submit lp-vf-submit--pressed" : "lp-vf-submit"
            }
          >
            Marcar asistencia
          </span>
        </div>
        <div className="lp-vf-done">
          <span
            className={
              animate ? (step >= VET_STAMP ? "lp-lib-stamp--in" : "lp-seq-pending") : undefined
            }
          >
            <LnVstamp variant="ok" label="FIRMADO" />
          </span>
          <span className={reveal(animate, step, VET_ADDED)}>
            {eventTypeLabel("vaccination_administered")} · Se sumó a la libreta de {PAMPA.name}
          </span>
        </div>
      </div>
    </>
  );
}

export const VET_SEQUENCE: SequenceSpec = {
  total: VET_ADDED + 1,
  stepMs: 650,
  items: [
    { label: "Carga la dosis en el formulario de asistencia.", at: VET_PRESS - 1 },
    { label: "Marca asistencia.", at: VET_PRESS },
    { label: "La dosis queda firmada con su matrícula.", at: VET_STAMP },
    { label: `Se suma a la libreta de ${PAMPA.name}.`, at: VET_ADDED },
  ],
  device: (step, animate) => (
    <PhoneFrame>
      <VetPortalScreen step={step} animate={animate} />
    </PhoneFrame>
  ),
};

// ---------------------------------------------------------------------------
// PS7 · Se pierde — five screens (2024-03-09 → 2024-03-10)
// ---------------------------------------------------------------------------

/** 1 · Martín marks her lost (apps/mobile/src/lost/LostScreen.tsx, the form). */
function LostMarkScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        photo={<LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={40} />}
        title={PAMPA.name}
        right={<LnStatusFlag status="lost" sex={PAMPA.sexEnum} />}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <div className="lp-kv">
            <span>Dónde la viste por última vez</span>
            <b>{LOST_PLACE}</b>
          </div>
          <div className="lp-kv">
            <span>Qué llevaba puesto</span>
            <b>{LOST_WEARING}</b>
          </div>
        </div>
        <span className="lp-vf-submit lp-vf-submit--lost">Marcar como perdida</span>
      </div>
    </>
  );
}

/** 2 · The search is open; verified orgs of her zone are told (lib/infra/lost-pet-broadcast.ts). */
function LostOpenScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        photo={<LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={40} />}
        title={PAMPA.name}
        right={<LnStatusFlag status="lost" sex={PAMPA.sexEnum} />}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <p className="lp-kv-title">Situación</p>
          <div className="lp-kv">
            <span>Perdida desde</span>
            <b>{landingDate(LOST.date)}</b>
          </div>
          <div className="lp-kv">
            <span>Última vez</span>
            <b>{LOST_PLACE}</b>
          </div>
        </div>
      </div>
    </>
  );
}

/** 3 · The poster (apps/mobile/src/lost/LostScreen.tsx "Cartel para imprimir"). */
function LostPosterScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Cartel para imprimir" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-poster">
          <LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={96} />
          <b className="lp-poster-name">{PAMPA.name}</b>
          <LnStatusFlag status="lost" sex={PAMPA.sexEnum} />
          <span className="lp-poster-qr" aria-hidden="true" />
          <span className="lp-poster-hint">Escaneá para más info</span>
        </div>
        <span className="lp-vf-submit">Compartir o imprimir el cartel</span>
      </div>
    </>
  );
}

/**
 * 4 · A neighbour's phone, no app, no account: the PUBLIC page as it renders
 * for Pampa (app/(public)/p/[publicToken] + PublicLostSections.tsx). The name
 * alone is the heading. Her lost report has a place and no coordinates, so the
 * page draws no map: only the place and "Sin punto exacto en el mapa".
 */
function LostPublicScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-lostb">
        {lostBannerHeadline(PAMPA.sexEnum)}
        <small>{lostTimeLabel(noonUtc(LOST.date), noonUtc(SCANNED.date))}</small>
      </div>
      <div className="lp-lost-hero">
        <div className="lp-lh-name">{PAMPA.name}</div>
        <div className="lp-lh-sub">
          {[speciesLabel(PAMPA_PET.species), PAMPA_PET.breed, sexLabel(PAMPA_PET.sex)].join(" · ")}
        </div>
        <div className="lp-lh-sub">Lo busca {PAMPA_OWNER_NAME}.</div>
      </div>
      <div className="lp-lost-actions">
        <span className="lp-lost-btn lp-lost-btn--call">
          <Icon name="telefono" size="sm" decorative /> Llamar
        </span>
        <span className="lp-lost-btn lp-lost-btn--found">
          <Icon name="ubicacion" size="sm" decorative /> {foundPossessivePhrase(PAMPA.sexEnum)}
        </span>
      </div>
      <div className="lp-lost-seen">
        <span className="lp-lost-seen-h">{lastSeenHeadingLabel(PAMPA.sexEnum)}</span>
        <b>{publicPlaceReference(LOST_PLACE)}</b>
        <span className="lp-lost-seen-none">
          <Icon name="ubicacion" size="sm" decorative /> Sin punto exacto en el mapa
        </span>
      </div>
      <p className="lp-lost-sight">{sightingPhrase(PAMPA.sexEnum)}</p>
    </>
  );
}

/**
 * 5 · Back on Martín's phone: the scan in "Avistajes y escaneos"
 * (apps/mobile/src/lost/lost-view-model.ts feedItemTitle). A scan row shows at
 * most an approximate locality, never a street or a pin; the seed's scan has
 * no location at all, so the row shows none.
 */
function LostFeedScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        photo={<LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={40} />}
        title={PAMPA.name}
        right={<LnStatusFlag status="lost" sex={PAMPA.sexEnum} />}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <p className="lp-kv-title">Avistajes y escaneos</p>
          <div className="lp-feed-row">
            <Icon name="qr" size="sm" decorative />
            <div>
              <b>Escanearon su QR</b>
              <span>{landingDate(SCANNED.date)}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const LOST_SCREENS = [
  LostMarkScreen,
  LostOpenScreen,
  LostPosterScreen,
  LostPublicScreen,
  LostFeedScreen,
];
const NEIGHBOUR_STEP = 3;

export const LOST_SEQUENCE: SequenceSpec = {
  total: LOST_SCREENS.length,
  stepMs: 1900,
  items: [
    { label: `${PAMPA_OWNER_NAME} la marca como perdida.`, at: 0 },
    { label: "Avisamos a refugios y veterinarias verificadas de tu zona.", at: 1 },
    { label: "El cartel con su QR, listo para compartir.", at: 2 },
    { label: "Al día siguiente, un vecino escanea su QR.", at: 3 },
    { label: `${PAMPA_OWNER_NAME} ve el escaneo en su búsqueda.`, at: 4 },
  ],
  deviceLabel: (step) =>
    step === NEIGHBOUR_STEP ? "Celular del vecino · sin app" : `App de ${PAMPA_OWNER_NAME}`,
  device: (step, animate) => {
    const Screen = LOST_SCREENS[step] ?? LostFeedScreen;
    return (
      <PhoneFrame lost={step === NEIGHBOUR_STEP}>
        <div key={step} className={animate ? "lp-seq-screen lp-seq-in" : "lp-seq-screen"}>
          <Screen />
        </div>
      </PhoneFrame>
    );
  },
};

// ---------------------------------------------------------------------------
// PS8 · Refugio — "Su chip dice quién es." (2024-03-11 → 2024-03-13)
// ---------------------------------------------------------------------------

const SHELTER = "Refugio Patitas del Barrio";

/** 1 · Ingresos, step 1 "Identificación" (app/org/[orgToken]/intake/IntakeForm.tsx). */
function IntakeChipScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        title="Ingresos"
        sub={SHELTER}
        right={<LnBadge variant="info">Verificada</LnBadge>}
      />
      <div className="lp-app-body lp-ph-pad">
        <p className="lp-kv-title">Paso 1 de 4 · Identificación</p>
        <div className="lp-vf">
          <span className="lp-vf-l">Número de microchip</span>
          <span className="lp-vf-i">{PAMPA_CHIP}</span>
        </div>
        <span className="lp-vf-submit">Continuar (chequearemos el chip al confirmar)</span>
      </div>
    </>
  );
}

/** 2-3 · The chip match card (app/org/[orgToken]/intake/match/…/MatchConfirmationCard.tsx). */
function IntakeMatchScreen({ pressed }: { pressed: boolean }) {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Ingresos" sub={SHELTER} />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-match-breach">
          <b>Posible coincidencia detectada</b>
          <span>El microchip ya figura en miMAR asociado a la siguiente mascota.</span>
        </div>
        <div className="lp-ph-card">
          <b className="lp-match-name">{PAMPA.name}</b>
          <span className="lp-match-sub">
            {speciesLabel(PAMPA_PET.species)}, {PAMPA_PET.breed}
          </span>
          <span className="lp-match-sub">
            {PAMPA_PET.color} · {sexLabel(PAMPA_PET.sex)}
          </span>
          <span className="lp-match-pill">Perdida</span>
          <span className="lp-match-sub">Dueño/a: {PAMPA_OWNER_NAME}</span>
          <span className="lp-match-sub">
            Última ubicación conocida: {LOST_PLACE} ({numericDate(LOST.date)})
          </span>
        </div>
        <span className={pressed ? "lp-vf-submit lp-vf-submit--pressed" : "lp-vf-submit"}>
          Es la misma mascota
        </span>
      </div>
    </>
  );
}

/** 4 · The intake, recorded (org pet list's "Ingreso registrado" notice). */
function IntakeDoneScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Ingresos" sub={SHELTER} />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-match-ok">
          <b>Ingreso registrado</b>
        </div>
        <div className="lp-ph-card">
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
      </div>
    </>
  );
}

/**
 * 5 · Martín's notification — the text confirm-chip-match-refugio.ts writes:
 * "Encontraron a {name}" / "{org} detectó a {name} por su microchip. Coordiná
 * la devolución." with the CTA "Coordinar devolución".
 */
function OwnerNotifiedScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-notif">
          <span className="lp-notif-app">miMAR</span>
          <b>Encontraron a {PAMPA.name}</b>
          <span>
            {SHELTER} detectó a {PAMPA.name} por su microchip. Coordiná la devolución.
          </span>
          <span className="lp-vf-submit">Coordinar devolución</span>
        </div>
      </div>
    </>
  );
}

/**
 * 6 · 13 mar: Martín closes the search — "Marcar como encontrada", then the
 * two-step confirm "Sí, la encontré" (apps/mobile/src/lost/LostScreen.tsx).
 * The return is his entry, not the shelter's.
 */
function OwnerFoundScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        photo={<LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={40} />}
        title={PAMPA.name}
        sub={landingDate(FOUND.date)}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-confirm">
          <b>¿Confirmás?</b>
          <span>
            Se cierra la búsqueda, la credencial pública deja de mostrar el aviso y avisamos a
            quienes la estaban buscando.
          </span>
          <span className="lp-vf-submit lp-vf-submit--pressed">Sí, la encontré</span>
        </div>
      </div>
    </>
  );
}

const SHELTER_SCREENS: Array<() => ReactNode> = [
  () => <IntakeChipScreen />,
  () => <IntakeMatchScreen pressed={false} />,
  () => <IntakeMatchScreen pressed />,
  () => <IntakeDoneScreen />,
  () => <OwnerNotifiedScreen />,
  () => <OwnerFoundScreen />,
];
const OWNER_FROM = 4;

export const SHELTER_SEQUENCE: SequenceSpec = {
  total: SHELTER_SCREENS.length,
  stepMs: 1700,
  items: [
    { label: "El refugio lee su chip y lo carga en Ingresos.", at: 0 },
    { label: "miMAR encuentra la coincidencia: está perdida.", at: 1 },
    { label: "El refugio confirma: es la misma mascota.", at: 2 },
    { label: "Registra el ingreso.", at: 3 },
    { label: `${PAMPA_OWNER_NAME} recibe el aviso.`, at: 4 },
    {
      label: `${landingDate(FOUND.date)}: ${PAMPA_OWNER_NAME} la marca como encontrada.`,
      at: 5,
    },
  ],
  deviceLabel: (step) => (step >= OWNER_FROM ? `App de ${PAMPA_OWNER_NAME}` : "Portal del refugio"),
  device: (step, animate) => {
    const render = SHELTER_SCREENS[step] ?? SHELTER_SCREENS[SHELTER_SCREENS.length - 1];
    return (
      <PhoneFrame>
        <div key={step} className={animate ? "lp-seq-screen lp-seq-in" : "lp-seq-screen"}>
          {render?.()}
        </div>
      </PhoneFrame>
    );
  },
};

// ---------------------------------------------------------------------------
// Entry point for StorySection
// ---------------------------------------------------------------------------

const SEQUENCES: Record<string, SequenceSpec> = {
  vet: VET_SEQUENCE,
  anon: LOST_SEQUENCE,
  refugio: SHELTER_SEQUENCE,
};

export function hasSequence(key: string): boolean {
  return key in SEQUENCES;
}

export function SequenceChapter({ chapter, index }: { chapter: LandingChapter; index: number }) {
  const spec = SEQUENCES[chapter.key];
  if (!spec) return null;
  return <SequencedChapter chapter={chapter} index={index} spec={spec} />;
}
