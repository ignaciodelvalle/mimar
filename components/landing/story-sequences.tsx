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
import { TabletFrame } from "@/components/landing/TabletFrame";
import type { LandingChapter } from "@/components/landing/landing-content";
import {
  PAMPA,
  PAMPA_FIRST_DOSE,
  PAMPA_OWNER_NAME,
  PAMPA_VET,
  landingDate,
  pampaEvent,
} from "@/components/landing/landing-content";
import { AppHead, OpHead } from "@/components/landing/story-screens";
import { useChapterSequence } from "@/components/landing/use-chapter-sequence";
import { LnBadge } from "@/components/ui/Badge";
import { LnPetPhoto } from "@/components/ui/RegRow";
import { LnStatusFlag, LnVstamp } from "@/components/ui/StatusFlag";
import { credentialQrUrl } from "@/lib/infra/site-url";
import { eventTypeLabel } from "@/lib/utils/format";
import { speciesLabel } from "@/lib/utils/species";
import { PAMPA_CHIP, PAMPA_PET } from "@/scripts/flagship-pampa-data";
import QRCode from "qrcode";
import type { ReactElement, ReactNode } from "react";

const PHOTO = "/landing/pampa-hero.jpg";

// The lost-poster's QR (PO 2026-09-30) — REAL, not decorative: it must encode
// the SAME public credential URL the hero QR does (app/page.tsx +
// credentialQrUrl, both built on lib/infra/site-url.ts's resolveSiteUrl), so
// the two QRs on the page are identical for a given deployment. Built from
// QRCode.create() — the package's synchronous, public matrix API — rather
// than QRCode.toString() (Promise-only): this stays a plain string computed
// once at module load, with no client-only effect/state for a chapter that
// SSR and reduced motion already render statically (see the file header).
// resolveSiteUrl() reads NEXT_PUBLIC_SITE_URL, which Next.js inlines into the
// client bundle too, so this is safe to compute in a "use client" module.
export const POSTER_QR_URL = credentialQrUrl(PAMPA_PET.publicToken);
function posterQrSvg(url: string): string {
  const qr = QRCode.create(url, { errorCorrectionLevel: "Q" });
  const size = qr.modules.size;
  const margin = 1;
  const dim = size + margin * 2;
  let cells = "";
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (qr.modules.get(row, col)) {
        cells += `<rect x="${col + margin}" y="${row + margin}" width="1" height="1"/>`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" width="64" height="64" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${cells}</g></svg>`;
}
const POSTER_QR_SVG = posterQrSvg(POSTER_QR_URL);

const LOST = pampaEvent("status_changed", "lost");
const INTAKE = pampaEvent("shelter_intake_recorded");
const FOUND = pampaEvent("status_changed", "active");
const LOST_PLACE = String(LOST.payload.location_description);
const LOST_WEARING = String(
  (LOST.payload.lost_description as Record<string, unknown> | undefined)?.accessories_when_lost ??
    "",
);

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
            Capítulo {index + 1} · {chapter.moment}
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
          {/* No caption naming whose device this is (PO 2026-09-29: "sin
              tener que aclarar en cada caso") — the device itself (phone vs
              tablet) and the portal header inside it (OpHead) carry that,
              same as every other chapter. The removed `deviceLabel` field
              used to print "Portal del refugio" / "App de Martín" here. */}
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
// Trimmed to 3 fields, not the form's real 5 (coordinator review, round 3):
// a fixed 3∶4 tablet frame has real height limits, and "vaccine name, brand,
// lot, plus the button" is enough to read as the attendance form without
// inventing anything — every field shown is still one of the form's own real
// labels (app/_components/attendance-forms/VaccinationAttendanceForm.tsx).
// "Administrado por" and "Próxima dosis (fecha)" are the two dropped;
// __tests__/flagship-pampa-consistency.test.tsx no longer requires them.
const VET_FIELDS: Array<[string, string]> = [
  ["Nombre de la vacuna", String(DOSE.vaccine_name)],
  ["Marca / laboratorio", String(DOSE.brand)],
  ["Lote / número de batch", String(DOSE.batch)],
];
const VET_PRESS = VET_FIELDS.length; // 3
const VET_STAMP = VET_PRESS + 1; // 4
const VET_ADDED = VET_STAMP + 1; // 5

function VetPortalScreen({ step, animate }: { step: number; animate: boolean }) {
  return (
    <>
      {/* No `page` caption here ("Atender mascota") — dropped to buy back
          vertical space inside the fixed 3∶4 frame (coordinator review,
          round 3); the "Firmás como…" line below still says what screen this
          is. */}
      <OpHead
        orgType="Clínica"
        orgName={PAMPA_VET.clinic}
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
        {/* The real signing page's own line (app/org/[orgToken]/atender/[publicToken]/page.tsx:165-167:
            "Firmás como <signer.label> ... verificado por profesional").
            .lp-op-signer itself forces one line (white-space: nowrap). */}
        <p className="lp-op-signer">
          Firmás como <b>{PAMPA_VET.name}</b> · {PAMPA_VET.license}
        </p>
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
    <TabletFrame>
      <VetPortalScreen step={step} animate={animate} />
    </TabletFrame>
  ),
};

// ---------------------------------------------------------------------------
// PS7 · Se pierde — four screens, one phone throughout (2024-03-09 → 2024-03-10)
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
          {/* Real QR (PO 2026-09-30) — see POSTER_QR_SVG above: the same
              credential URL the hero card's QR encodes for this deployment,
              never a decorative pattern. */}
          <span
            className="lp-poster-qr"
            role="img"
            aria-label={`Código QR de la credencial pública de ${PAMPA.name}`}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: locally generated QR SVG from qrcode's create() (public API), encoding this deployment's own public credential URL — no user input.
            dangerouslySetInnerHTML={{ __html: POSTER_QR_SVG }}
          />
          <span className="lp-poster-hint">Escaneá para más info</span>
        </div>
        <span className="lp-vf-submit">Compartir o imprimir el cartel</span>
      </div>
    </>
  );
}

/**
 * 4 · Someone finds Pampa and reports it — the notification lands on
 * ${PAMPA_OWNER_NAME}'s OWN phone, the same device as every other step in this
 * chapter (PO 2026-09-29: the neighbour's own phone, shown separately with a
 * "Celular del vecino · sin app" label, read as two devices in one chapter).
 * The copy is EXACTLY what notifyOwnerOfFoundPet writes
 * (src/modules/pets/application/public/notify-owner-of-found-pet.ts) for an
 * anonymous finder who leaves no name or contact — the honest default, not an
 * invented message: title `¡Encontraron a {name}!` (PO 2026-09-30 — same
 * title for every finder, named or anonymous), body
 * `{who} encontró a {name}.{contactLine}` with who="Alguien" and
 * contactLine=" No dejó datos de contacto.". Styled like the SAME `.lp-notif`
 * card the refugio chapter's own found-notification uses below, for one
 * consistent in-app-notification look across the story.
 */
function OwnerFoundReportScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-notif">
          <span className="lp-notif-app">miMAR</span>
          <b>¡Encontraron a {PAMPA.name}!</b>
          <span>Alguien encontró a {PAMPA.name}. No dejó datos de contacto.</span>
          <span className="lp-vf-submit">Ver mascota</span>
        </div>
      </div>
    </>
  );
}

const LOST_SCREENS = [LostMarkScreen, LostOpenScreen, LostPosterScreen, OwnerFoundReportScreen];

export const LOST_SEQUENCE: SequenceSpec = {
  total: LOST_SCREENS.length,
  stepMs: 1900,
  items: [
    { label: `${PAMPA_OWNER_NAME} la marca como perdida.`, at: 0 },
    { label: "Avisamos a refugios y veterinarias verificadas de tu zona.", at: 1 },
    { label: "El cartel con su QR, listo para compartir.", at: 2 },
    { label: `Alguien la encuentra: ${PAMPA_OWNER_NAME} recibe el aviso al instante.`, at: 3 },
  ],
  device: (step, animate) => {
    const Screen = LOST_SCREENS[step] ?? OwnerFoundReportScreen;
    return (
      <PhoneFrame>
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
      <OpHead
        orgType="Refugio"
        orgName={SHELTER}
        page="Ingresos"
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

/**
 * 2-3 · The chip match card (app/org/[orgToken]/intake/match/…/MatchConfirmationCard.tsx).
 * Trimmed to 2 lines under the pet's name, not the card's real 4 (coordinator
 * review, round 3 — the fixed 3∶4 tablet frame has real height limits): the
 * explanatory sentence, the owner name and the last-known location are
 * dropped; species/breed/color/sex merge into one line. Nothing dropped was
 * asserted by a test.
 */
function IntakeMatchScreen({ pressed }: { pressed: boolean }) {
  return (
    <>
      <OpHead orgType="Refugio" orgName={SHELTER} page="Ingresos" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-match-breach">
          <b>Posible coincidencia detectada</b>
        </div>
        <div className="lp-ph-card">
          <b className="lp-match-name">{PAMPA.name}</b>
          <span className="lp-match-sub">
            {speciesLabel(PAMPA_PET.species)}, {PAMPA_PET.breed} · {PAMPA_PET.color}
          </span>
          <span className="lp-match-pill">Perdida</span>
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
      <OpHead orgType="Refugio" orgName={SHELTER} page="Ingresos" />
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

/**
 * 7 · The payoff (critique 2026-09-29, M5): the chapter used to end on the
 * "¿Confirmás?" dialog, never showing her home. After the confirm, Martín's
 * app shows Pampa back AL DÍA (the flag the product renders for an active
 * pet) and the three entries the search left in her libreta, newest first,
 * worded as chapter 5's libreta words them: lost, taken in, found. Copy
 * review 2026-09-30: "Volvió a casa" / "EN CASA" is not a label any product
 * surface prints, and reads as a claim this deployment cannot back for every
 * pet — "Encontrada · devuelta a su dueño" states the same fact without it.
 */
function OwnerHomeScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead
        photo={<LnPetPhoto src={PHOTO} alt={PAMPA.name} status="ok" size={40} />}
        title={PAMPA.name}
        sub={landingDate(FOUND.date)}
        right={<LnStatusFlag status="ok" />}
      />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <div className="lp-intake-row" data-t="ok">
            <span className="lp-iic">
              <Icon name="casa" size="sm" decorative />
            </span>
            <div className="min-w-0">
              <b>Encontrada · devuelta a su dueño</b>
              <span className="lp-intake-sub">{landingDate(FOUND.date)}</span>
            </div>
          </div>
          <div className="lp-intake-row">
            <span className="lp-iic">
              <Icon name="edificio" size="sm" decorative />
            </span>
            <div className="min-w-0">
              <b>Ingresó a un refugio</b>
              <span className="lp-intake-sub">
                {String(INTAKE.payload.intake_condition)} · {landingDate(INTAKE.date)}
              </span>
            </div>
          </div>
          <div className="lp-intake-row" data-t="err">
            <span className="lp-iic">
              <Icon name="perdida" size="sm" decorative />
            </span>
            <div className="min-w-0">
              <b>Reportada perdida</b>
              <span className="lp-intake-sub">
                {LOST_PLACE} · {landingDate(LOST.date)}
              </span>
            </div>
          </div>
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
  () => <OwnerHomeScreen />,
];
// Exported so the device-frame guard test (and anything else that needs the
// split) does not re-hardcode this index and drift from it.
export const OWNER_FROM = 4;

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
    {
      label: `${PAMPA.name} está de vuelta con ${PAMPA_OWNER_NAME}, y su credencial vuelve a estar al día.`,
      at: 6,
    },
  ],
  // The device itself switches with who is using it (PO 2026-09-29, and
  // again 2026-09-29 on captions: "sin tener que aclarar en cada caso" — no
  // `deviceLabel` caption names it either; the removed field used to print
  // "Portal del refugio" / "App de Martín" above the device): the refugio's
  // own tablet for its intake steps, then Martín's phone from OWNER_FROM on.
  device: (step, animate) => {
    const render = SHELTER_SCREENS[step] ?? SHELTER_SCREENS[SHELTER_SCREENS.length - 1];
    const Frame = step >= OWNER_FROM ? PhoneFrame : TabletFrame;
    return (
      <Frame>
        <div key={step} className={animate ? "lp-seq-screen lp-seq-in" : "lp-seq-screen"}>
          {render?.()}
        </div>
      </Frame>
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
