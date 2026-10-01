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
//    the file cited next to it. The step labels are the landing's own
//    narration and live outside the device (for screen readers only: the
//    device mock is aria-hidden, and the PO wants no visible description,
//    "sin descripción", 2026-09-30).
//
// Motion: transform/opacity only. A screen change slides inside the
// fixed-size device (.lp-scr is a fixed height, .lp-tab-scr a fixed inset); an
// actor change (Martín's phone handing over to the neighbour's and back, or
// the refugio's tablet handing over to Martín's phone) slides the outgoing
// device out and the incoming one in. Each person's device has
// its own case colour (data-actor, --lp-case-* in app/landing.css); its SIZE
// never changes.

import { Icon } from "@/components/Icon";
import { PhoneFrame } from "@/components/landing/PhoneFrame";
import { StepButton } from "@/components/landing/StepButton";
import { TabletFrame } from "@/components/landing/TabletFrame";
import type { LandingChapter } from "@/components/landing/landing-content";
import {
  PAMPA,
  PAMPA_FIRST_DOSE,
  PAMPA_OWNER_NAME,
  PAMPA_SHELTER,
  PAMPA_VET,
  pampaEvent,
  seedInstant,
} from "@/components/landing/landing-content";
import { AppHead, OpHead } from "@/components/landing/story-screens";
import { useChapterSequence } from "@/components/landing/use-chapter-sequence";
import { LnBadge } from "@/components/ui/Badge";
import { LnPetPhoto } from "@/components/ui/RegRow";
import {
  AR_TIME_ZONE,
  formatDate,
  foundPossessivePhrase,
  lostLabel,
  markLostActionLabel,
  sexLabel,
  sightedWhenQuestion,
  sightingPhrase,
  situationLabelForSex,
} from "@/lib/utils/format";
import { speciesLabel } from "@/lib/utils/species";
import { PAMPA_CHIP, PAMPA_PET, PAMPA_TOKEN } from "@/scripts/flagship-pampa-data";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const PHOTO = "/landing/pampa-hero.jpg";

const LOST = pampaEvent("status_changed", "lost");
const INTAKE = pampaEvent("shelter_intake_recorded");

// ---------------------------------------------------------------------------
// The chapter shell: number, moment, title and ‹ › on the left, the device on
// the right
// ---------------------------------------------------------------------------

/**
 * Whose device is in hand. One case colour each (--lp-case-* tokens in
 * app/landing.css); the phone/tablet choice follows from it.
 */
export type SequenceActor = "owner" | "neighbour" | "vet" | "shelter";

export const ACTORS: readonly SequenceActor[] = ["owner", "neighbour", "vet", "shelter"];

type Dir = "fwd" | "back";

type SequenceDef = {
  /** Number of device steps the sequence plays through. */
  total: number;
  stepMs: number;
  /** Step items: `at` is the device step the item completes at (‹ › stop there). */
  items: Array<{ label: string; at: number }>;
  actor: (step: number) => SequenceActor;
  screen: (step: number, animate: boolean) => ReactNode;
  /** True when every step is its own screen (it slides); false when one screen fills in. */
  slides: boolean;
};

type SequenceSpec = SequenceDef & {
  device: (step: number, animate: boolean, dir?: Dir) => ReactElement;
};

/** Matches the CSS device switch (--motion-deliberate, 600ms). */
const DEVICE_SWITCH_MS = 600;

function isTablet(actor: SequenceActor): boolean {
  return actor === "vet" || actor === "shelter";
}

function sequence(def: SequenceDef): SequenceSpec {
  return {
    ...def,
    device: (step, animate, dir = "fwd") => {
      const actor = def.actor(step);
      const Frame = isTablet(actor) ? TabletFrame : PhoneFrame;
      const slide = animate && def.slides;
      return (
        <div className="lp-seq-case" data-actor={actor}>
          <Frame>
            <div
              key={def.slides ? step : "screen"}
              className={slide ? "lp-seq-screen lp-seq-slide" : "lp-seq-screen"}
              data-dir={slide ? dir : undefined}
            >
              {def.screen(step, animate)}
            </div>
          </Frame>
        </div>
      );
    },
  };
}

function SequencedChapter({
  chapter,
  index,
  spec,
}: {
  chapter: LandingChapter;
  index: number;
  spec: SequenceSpec;
}) {
  const { ref, step, animate, goTo, dir, manual } = useChapterSequence(spec.total, spec.stepMs);
  // The item in progress: the first whose completion step is not behind us.
  const activeItem = Math.max(
    0,
    spec.items.findIndex((it) => it.at >= step),
  );
  const prevItem = spec.items[activeItem - 1];
  const nextItem = spec.items[activeItem + 1];
  const current = spec.items[activeItem];

  // Actor switch: keep the outgoing device on stage while it slides out. Only
  // a change seen while ALREADY animating counts: the client's first rewind
  // (final step to step 0) is not a switch the visitor ever saw.
  const actor = spec.actor(step);
  const shownRef = useRef({ step, actor, animate });
  const [exiting, setExiting] = useState<{ step: number; dir: Dir } | null>(null);
  useLayoutEffect(() => {
    const prev = shownRef.current;
    shownRef.current = { step, actor, animate };
    if (!animate || !prev.animate || prev.actor === actor) return;
    setExiting({ step: prev.step, dir });
  }, [step, actor, animate, dir]);
  useEffect(() => {
    if (!exiting) return;
    const t = window.setTimeout(() => setExiting(null), DEVICE_SWITCH_MS);
    return () => window.clearTimeout(t);
  }, [exiting]);

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
          {/* No visible chapter lead (PO 2026-09-30: "sin descripción") — the
              device tells the story. The device mock is aria-hidden, so a
              screen reader still gets the chapter's lead here. */}
          <p className="sr-only">{chapter.lead}</p>
          <fieldset className="lp-seq-nav" aria-label={`Pasos del capítulo ${index + 1}`}>
            <StepButton
              className="lp-seq-arrow lp-seq-arrow--back"
              label="Paso anterior"
              disabled={!prevItem}
              onSelect={() => prevItem && goTo(prevItem.at)}
            >
              <Icon name="chevron-right" size="sm" decorative />
            </StepButton>
            <span className="lp-seq-track" aria-hidden="true">
              {spec.items.map((it, i) => (
                <span
                  key={it.label}
                  className="lp-seq-bar"
                  data-state={i < activeItem ? "done" : i === activeItem ? "on" : "todo"}
                />
              ))}
            </span>
            <StepButton
              className="lp-seq-arrow"
              label="Paso siguiente"
              disabled={!nextItem}
              onSelect={() => nextItem && goTo(nextItem.at)}
            >
              <Icon name="chevron-right" size="sm" decorative />
            </StepButton>
          </fieldset>
          {/* The visible step caption (PO 2026-09-30, second call): one line
              under the ‹ › controls, plus a "n/total" counter. It doubles as
              the aria-live carrier (only "polite" once the visitor has taken
              the controls, same as before) so nothing announces twice. */}
          <p className="lp-seq-caption" aria-live={manual ? "polite" : "off"}>
            <span className="lp-seq-caption-count" aria-hidden="true">
              {activeItem + 1}/{spec.items.length}
            </span>
            <span key={activeItem} className="lp-seq-caption-text">
              {current?.label}
            </span>
          </p>
        </div>
        <div className="lp-ch-device lp-seq-device" ref={ref}>
          {/* No caption naming whose device this is (PO 2026-09-29: "sin
              tener que aclarar en cada caso"): the device itself (phone vs
              tablet, and its case colour) and the portal header inside it
              (OpHead) carry that. */}
          <div className="lp-seq-stage">
            {exiting && (
              <div className="lp-seq-dev-out" data-dir={exiting.dir}>
                {spec.device(exiting.step, false)}
              </div>
            )}
            <div
              key={actor}
              className={exiting ? "lp-seq-dev-in" : "lp-seq-dev"}
              data-dir={exiting ? exiting.dir : undefined}
            >
              {spec.device(step, animate, dir)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared bits: a sentence typed word by word, a screen that turns into the
// next one within its step
// ---------------------------------------------------------------------------

/**
 * A sentence someone types, word by word (opacity only, staggered by
 * --i). Static — the whole sentence, no class — whenever `typing` is false:
 * SSR, reduced motion, and every step after the one it is typed in. `from`
 * offsets the stagger, so a second field starts where the first one ended.
 */
function Typed({ text, typing, from = 0 }: { text: string; typing: boolean; from?: number }) {
  if (!typing) return <>{text}</>;
  const words = text.split(" ");
  return (
    <span className="lp-seq-type">
      {words.map((w, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, words never reorder
          key={i}
          style={{ "--i": from + i } as CSSProperties}
        >
          {i < words.length - 1 ? `${w} ` : w}
        </span>
      ))}
    </span>
  );
}

/**
 * A screen that becomes the next one INSIDE its step: a form typed and sent,
 * then the screen the product shows once it went through (the sighting's
 * thanks). While `animate` plays,
 * `before` is drawn, pressed (`lp-seq-late`), then cross-fades into `after`
 * (opacity + transform only, app/landing.css .lp-seq-swap). Static — SSR,
 * reduced motion, and the device sliding out — draws `after` alone: the
 * state the step leaves behind.
 */
function Swap({
  animate,
  before,
  after,
}: {
  animate: boolean;
  before: ReactNode;
  after: ReactNode;
}) {
  if (!animate) return <>{after}</>;
  return (
    <div className="lp-seq-swap">
      <div className="lp-seq-swap-before">{before}</div>
      <div className="lp-seq-swap-after">{after}</div>
    </div>
  );
}

/** A seed day as the product's es-AR short date prints it: "11/03/2024". */
function arShortDate(date: string): string {
  return seedInstant(date).toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: AR_TIME_ZONE,
  });
}

// ---------------------------------------------------------------------------
// PS6 · Veterinaria — "La vacuna queda firmada." (2022-04-12)
// ---------------------------------------------------------------------------

// The vet's real quick-capture flow on the org portal's "Atender mascota"
// (PO 2026-09-30): find the pet by its credential code, write what was done
// in her own words, let the SHARED matcher read it, land on the prefilled
// vaccine form, register it. Every string on these screens is the portal's
// own, cited next to it.
//
// Two things the PO's outline named that the product does not render, so
// they are NOT drawn:
//  - a QR scan: "Atender mascota" takes the credential CODE, typed
//    (app/org/[orgToken]/atender/CodeEntryForm.tsx) — no camera;
//  - an "Anotar" button: that is the owner app's verb. The portal's card is
//    "Registrá lo que atendiste" and its button "Identificar →".
// The old attendance-form mock also drew a FIRMADO stamp no product surface
// prints; the portal's real receipt ("Evento clínico firmado…") replaces it.
const DOSE = PAMPA_FIRST_DOSE.payload;

/**
 * The note the vet types. It is HER text, not product copy; what the product
 * makes of it is fenced: __tests__/flagship-pampa-consistency.test.tsx runs
 * it through the real matcher and asserts the card below is what comes back
 * (event "vacuna", high confidence, Vacuna = VET_NOTE_VACCINE).
 */
export const VET_NOTE = `Le apliqué la ${String(DOSE.vaccine_name)}. ${String(DOSE.brand)}, lote ${String(DOSE.batch)}`;
/** The matcher's vaccineName slot for VET_NOTE (fenced, see above). */
export const VET_NOTE_VACCINE = String(DOSE.vaccine_name);

const VET_CODE = 0; // code entry
const VET_FOUND = 1; // the pet's page: who she is, who signs
const VET_TYPE = 2; // "Registrá lo que atendiste", typed
const VET_READ = 3; // the matcher's card
const VET_FORM = 4; // the prefilled vaccine form
const VET_DONE = 5; // the receipt

/** app/org/[orgToken]/atender/[publicToken]/page.tsx:229-231 — the pet's page h1. */
function VetPetLine({ photo }: { photo?: boolean }) {
  return (
    <div className="lp-vf-pet">
      {photo && <LnPetPhoto src={PHOTO} alt={PAMPA.name} status="ok" size={36} />}
      <b>
        Atendiendo a {PAMPA.name} · {speciesLabel(PAMPA_PET.species)}
      </b>
    </div>
  );
}

/** app/org/[orgToken]/atender/[publicToken]/page.tsx:232-235 (signer.label, atender-access.ts:246-248). */
function VetSignerLine() {
  return (
    <p className="lp-op-signer lp-op-signer--wrap">
      Firmás como <b>matrícula {PAMPA_VET.license}</b> · verificado por profesional
    </p>
  );
}

function VetScreen({ step, animate }: { step: number; animate: boolean }) {
  const typing = animate && step === VET_TYPE;
  const filling = animate && step === VET_FORM;
  return (
    <>
      {/* "Atender mascota": the crumb and h1 of both atender pages
          (app/org/[orgToken]/atender/page.tsx:46-48). */}
      <OpHead orgType="Clínica" orgName={PAMPA_VET.clinic} page="Atender mascota" />
      <div className="lp-app-body lp-ph-pad">
        {step === VET_CODE && (
          // app/org/[orgToken]/atender/page.tsx:57 (card title) and
          // CodeEntryForm.tsx:56 (label), :77-78 (button).
          <div className="lp-ph-card">
            <p className="lp-kv-title">Credencial de la mascota</p>
            <div className="lp-vf">
              <span className="lp-vf-l">Código de la credencial (DIM-XXXX-XXXX)</span>
              <span className="lp-vf-i lp-vf-i--mono">
                <Typed text={PAMPA_TOKEN} typing={animate} />
              </span>
            </div>
            <span className="lp-vf-submit">Buscar mascota</span>
          </div>
        )}

        {step === VET_FOUND && (
          <>
            <VetPetLine photo />
            <VetSignerLine />
            {/* OpCodeBadge, page.tsx:280. */}
            <span className="lp-op-code">{PAMPA_TOKEN}</span>
          </>
        )}

        {step === VET_TYPE && (
          <>
            <VetPetLine />
            {/* page.tsx:349 (card title); AtenderQuickCapture.tsx:91-108
                (the textarea, then "Identificar →"). */}
            <div className="lp-ph-card">
              <p className="lp-kv-title">Registrá lo que atendiste</p>
              <span className="lp-vf-i lp-vf-i--area">
                <Typed text={VET_NOTE} typing={typing} />
              </span>
              <span
                className={
                  animate ? "lp-vf-submit lp-vf-submit--pressed lp-seq-late" : "lp-vf-submit"
                }
              >
                Identificar →
              </span>
            </div>
          </>
        )}

        {step === VET_READ && (
          <>
            <VetPetLine />
            {/* components/ui/CaptureConfidenceCard.tsx: the event label
                (ATENDER_EVENTOS "vacuna" → "Vacuna", atender-eventos.ts:19),
                the badge (:62, "high"), the slot row (SLOT_LABELS.vaccineName,
                AtenderQuickCapture.tsx:28), the two buttons (:94 default
                editLabel; confirmLabel "Asentar vacuna", AtenderQuickCapture.tsx:122). */}
            <div className="lp-cc">
              <div className="lp-cc-head">
                <b>Vacuna</b>
                <LnBadge variant="success" icon="check-circle">
                  Alta confianza
                </LnBadge>
              </div>
              <div className="lp-cc-row">
                <span>Vacuna</span>
                <b>{VET_NOTE_VACCINE}</b>
              </div>
              <div className="lp-cc-actions">
                <span className="lp-cc-ghost">Editar en el formulario</span>
                <span className="lp-vf-submit lp-vf-submit--ok">Asentar vacuna</span>
              </div>
            </div>
          </>
        )}

        {step === VET_FORM && (
          // app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/vacuna/VaccinationForm.tsx:
          // header :172-173, "Vacuna" :183 (prefilled from the card through
          // initialVaccineName, AtenderCaptureMounter.tsx:97), "Marca /
          // laboratorio" :269, "Lote" :281, the CTA :399. Brand and batch are
          // typed by the vet — the matcher prefills only the vaccine.
          <div className="lp-ph-card">
            <p className="lp-kv-title lp-sheet-t">Registrar vacuna</p>
            <p className="lp-sheet-s">Libreta sanitaria oficial</p>
            <div className="lp-vf-form">
              <div className="lp-vf lp-vf--full">
                <span className="lp-vf-l">Vacuna</span>
                <span className="lp-vf-i">{VET_NOTE_VACCINE}</span>
              </div>
              <div className="lp-vf">
                <span className="lp-vf-l">Marca / laboratorio</span>
                <span className="lp-vf-i">
                  <Typed text={String(DOSE.brand)} typing={filling} />
                </span>
              </div>
              <div className="lp-vf">
                <span className="lp-vf-l">Lote</span>
                <span className="lp-vf-i lp-vf-i--mono">
                  <Typed text={String(DOSE.batch)} typing={filling} />
                </span>
              </div>
              <span
                className={
                  animate
                    ? "lp-vf-submit lp-vf-submit--ok lp-vf-submit--pressed lp-seq-late"
                    : "lp-vf-submit lp-vf-submit--ok"
                }
              >
                Registrar vacuna
              </span>
            </div>
          </div>
        )}

        {step >= VET_DONE && (
          <>
            <VetPetLine photo />
            <VetSignerLine />
            {/* The receipt a verified signer gets, page.tsx:291-293. */}
            <div className={animate ? "lp-match-ok lp-seq-in" : "lp-match-ok"}>
              <span>Evento clínico firmado. Podés registrar otro o volver al inicio.</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export const VET_SEQUENCE: SequenceSpec = sequence({
  total: VET_DONE + 1,
  stepMs: 1900,
  items: [
    { label: `Busca a ${PAMPA.name} por su código.`, at: VET_FOUND },
    { label: "Anota con sus palabras.", at: VET_TYPE },
    { label: "miMAR reconoce la vacuna.", at: VET_READ },
    { label: "El formulario llega completo.", at: VET_FORM },
    { label: "Firmado con su matrícula.", at: VET_DONE },
  ],
  actor: () => "vet",
  screen: (step, animate) => <VetScreen step={step} animate={animate} />,
  slides: true,
});

// ---------------------------------------------------------------------------
// PS7 · Se pierde — Martín's phone, the neighbour's, Martín's again
// (2024-03-09 → 2024-03-11)
// ---------------------------------------------------------------------------

// ONE loss told across two chapters (PO 2026-10-01). Here: Martín reports her
// lost on his NATIVE app and shares the poster; a neighbour — no account, no
// app — scans the poster's QR, lands on the public credential in its
// "perdida" state and uses its sighting form ("La vi cerca de acá") to say
// she took her to the refugio, leaving a contact; Martín's inbox gets the
// notification that form's use-case writes. Chapter 4 picks up at the refugio.
//
// The found form ("¿Encontraste a esta mascota?") is no longer drawn: since
// finder-contact (2026-10-01) it requires a contact, and the sighting is the
// flow whose notification this chapter shows.
//
// No map, no point, no street of the sighting: the form's map
// (LocationFields, PetSightingForm.tsx:135-141) and the lost form's point
// picker (LostScreen.tsx:749-755) are omitted, not altered. The public page's
// last-seen mini-map (PublicLostSections.tsx:358-) is not drawn either.

/**
 * What the neighbour types into "Algún detalle" — HER words, landing
 * narration, not product copy. The refugio is the story's own
 * (PAMPA_SHELTER), so chapter 4's tablet is the place she names here.
 */
export const SIGHTING_MESSAGE = `La llevé al ${PAMPA_SHELTER}`;
/** The contact she leaves (a reserved example domain: nobody's real address). */
export const SIGHTING_CONTACT = "vecina@example.com";

/**
 * EXACTLY the body reportPetSighting writes for a message and a contact with
 * no name (src/modules/pets/application/sighting/report-pet-sighting.ts:349-365):
 * the lead line, `Mensaje: "{description}".`, `Contacto de quien la vio:
 * {contact}.`, "Mirá el detalle en su perfil.", joined by spaces (:434).
 */
export const SIGHTING_BODY = [
  `Alguien reportó haber visto a ${PAMPA.name} cerca de un punto.`,
  `Mensaje: "${SIGHTING_MESSAGE}".`,
  `Contacto de quien la vio: ${SIGHTING_CONTACT}.`,
  "Mirá el detalle en su perfil.",
].join(" ");

const LOST_REPORT = 0; // Martín: "Marcar a Pampa como perdida"
const LOST_POSTER = 1; // Martín: the poster card
const LOST_PUBLIC = 2; // the neighbour: the public credential, lost
const LOST_SIGHTING = 3; // the neighbour: the sighting form, sent
const LOST_INBOX = 4; // Martín: the sighting notification
// Exported so the tests do not re-hardcode the split.
export const LOST_REPORT_STEP = LOST_REPORT;
export const LOST_POSTER_STEP = LOST_POSTER;
export const LOST_PUBLIC_STEP = LOST_PUBLIC;
export const LOST_SIGHTING_STEP = LOST_SIGHTING;
export const LOST_INBOX_STEP = LOST_INBOX;

function lostDescription(key: string): string {
  const d = LOST.payload.lost_description;
  const v = d && typeof d === "object" ? (d as Record<string, unknown>)[key] : null;
  return typeof v === "string" ? v : "";
}

/** The seed's "dónde": its location_description. */
const LOST_WHERE = String(LOST.payload.location_description ?? "");
/** The seed's last_seen_context: "Se soltó en la plaza durante un paseo". */
const LOST_CONTEXT = lostDescription("last_seen_context");
/** "perdida" for Pampa (lostLabel, lib/utils/format.ts:372-381; the native lostAdjective agrees). */
const LOST_ADJ = lostLabel(PAMPA_PET.sex).toLowerCase();

/**
 * 1 · Martín's native "Modo perdida" (stack title, apps/mobile/app/_layout.tsx:543),
 * on its mark-lost pane (apps/mobile/src/lost/LostScreen.tsx MarkLostForm): the
 * card title and sentence (:724-728), "Dónde la viste por última vez" (:757),
 * "Contexto del extravío" (:837) and the submit, `Marcar como {lostAdjective}`
 * (:888; lost-view-model.ts:44-53 — markLostActionLabel is the web's same
 * switch). Both values are the seed's lost report. The point picker, the
 * locality picker, the "Cómo reconocerla" fields and the disclosure toggles
 * sit between them and are omitted.
 */
function OwnerReportLostScreen({ animate }: { animate: boolean }) {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Modo perdida" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <p className="lp-kv-title">
            Marcar a {PAMPA.name} como {LOST_ADJ}
          </p>
          <p className="lp-ph-note">
            Su credencial pública va a mostrar el aviso de búsqueda. Abajo elegís qué datos tuyos se
            publican mientras la búsqueda esté activa.
          </p>
        </div>
        <div className="lp-vf-form">
          <div className="lp-vf">
            <span className="lp-vf-l">Dónde la viste por última vez</span>
            <span className="lp-vf-i">{LOST_WHERE}</span>
          </div>
          <div className="lp-vf">
            <span className="lp-vf-l">Contexto del extravío</span>
            <span className="lp-vf-i lp-vf-i--area">
              <Typed text={LOST_CONTEXT} typing={animate} />
            </span>
          </div>
          <span
            className={animate ? "lp-vf-submit lp-vf-submit--pressed lp-seq-late" : "lp-vf-submit"}
          >
            {markLostActionLabel(PAMPA_PET.sex)}
          </span>
        </div>
      </div>
    </>
  );
}

/**
 * 2 · The poster, on the same native "Modo perdida" screen: its PosterCard
 * (apps/mobile/src/lost/LostScreen.tsx:556-573) — title, POSTER_CARD_BODY
 * and POSTER_BUTTON_LABEL (lost-view-model.ts:693-696). The app shares a
 * server-made PDF; it draws no poster preview of its own, so none is drawn
 * here. The rest of the screen (the case card, the state commands, the feed)
 * sits around it and is omitted.
 */
function LostPosterScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Modo perdida" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-ph-card">
          <p className="lp-kv-title">Cartel para imprimir</p>
          <p className="lp-ph-note">
            Un PDF tamaño A4 con su foto, los datos que elegiste mostrar y el QR de su credencial.
            Mandalo por WhatsApp o imprimilo.
          </p>
          <span className="lp-vf-submit lp-vf-submit--ghost">Compartir o imprimir el cartel</span>
        </div>
      </div>
    </>
  );
}

/**
 * The public credential's masthead in its "perdida" state
 * (app/(public)/p/[publicToken]/page.tsx: crest :626, "miMAR" + "Credencial
 * pública" :652-654, situation chip :668-675 with situationLabelForSex).
 */
function PublicMasthead() {
  return (
    <div className="lp-pub-head">
      <span className="lp-pub-crest" aria-hidden="true">
        m
      </span>
      <div className="min-w-0 flex-1">
        <b className="lp-pub-brand">miMAR</b>
        <span className="lp-pub-kind">Credencial pública</span>
      </div>
      <span className="lp-pub-chip">
        <Icon name="perdida" size="sm" decorative />
        {situationLabelForSex("Perdida", PAMPA_PET.sex)}
      </span>
    </div>
  );
}

/** page.tsx:434-436 — species · breed · sex. */
const PUBLIC_BREED_LINE = [
  speciesLabel(PAMPA_PET.species),
  PAMPA_PET.breed,
  sexLabel(PAMPA_PET.sex),
].join(" · ");

/**
 * 3 · The neighbour's phone, on the page the poster's QR opens: the public
 * credential, lost — masthead, name bar (page.tsx:711-716) and the CTA row
 * (components/pet-profile/PublicLostSections.tsx:216-227 "Llamar", :256-262
 * foundPossessivePhrase, :264-270 sightingPhrase). "La vi cerca de acá" is the
 * one she uses, so it is the one highlighted.
 */
function PublicLostScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-pub">
          <PublicMasthead />
          <LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={88} />
          <b className="lp-pub-name">{PAMPA.name}</b>
          <span className="lp-pub-sub">{PUBLIC_BREED_LINE}</span>
          <div className="lp-pub-ctas">
            <span className="lp-pub-cta lp-pub-cta--solid">
              <Icon name="telefono" size="sm" decorative /> Llamar
            </span>
            <span className="lp-pub-cta lp-pub-cta--solid">
              <Icon name="ubicacion" size="sm" decorative /> {foundPossessivePhrase(PAMPA_PET.sex)}
            </span>
            <span className="lp-pub-cta" data-used="true">
              <Icon name="ojo" size="sm" decorative /> {sightingPhrase(PAMPA_PET.sex)}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * 4a · The sighting page (app/(public)/p/[publicToken]/sighting/page.tsx:
 * "← Volver al perfil" :148, the h1 sightingPhrase :150-152, the sentence
 * :154) and its form (PetSightingForm.tsx): "¿Cuándo la viste?" (:145,
 * sightedWhenQuestion) with its "Fecha" half (:153; the intake day, as the
 * seed has it), "Algún detalle (opcional)" (:192), the contact group opened
 * (:241) with "Teléfono o email" (:267), and "Avisar al dueño/a" (:301).
 * Omitted, not altered: the map (:135-141), the "Hora (24 h)" half, the photo
 * group and the "Tu nombre" field (she leaves none).
 */
function SightingFormScreen({ typing }: { typing: boolean }) {
  return (
    <div className="lp-pub lp-pub--form">
      <span className="lp-pub-back">← Volver al perfil</span>
      <b className="lp-pub-q">{sightingPhrase(PAMPA_PET.sex)}</b>
      <span className="lp-pub-sub">
        Marcá dónde y cuándo viste a {PAMPA.name}. El dueño/a recibe el aviso al instante.
      </span>
      <div className="lp-vf-form">
        <div className="lp-vf">
          <span className="lp-vf-l">{sightedWhenQuestion(PAMPA_PET.sex)}</span>
          <span className="lp-vf-l">Fecha</span>
          <span className="lp-vf-i">{arShortDate(INTAKE.date)}</span>
        </div>
        <div className="lp-vf">
          <span className="lp-vf-l">Algún detalle (opcional)</span>
          <span className="lp-vf-i lp-vf-i--area">
            <Typed text={SIGHTING_MESSAGE} typing={typing} />
          </span>
        </div>
        <div className="lp-vf">
          <span className="lp-vf-l">¿Querés que te puedan contactar? (opcional)</span>
          <span className="lp-vf-l">Teléfono o email</span>
          <span className="lp-vf-i">
            <Typed
              text={SIGHTING_CONTACT}
              typing={typing}
              from={SIGHTING_MESSAGE.split(" ").length}
            />
          </span>
        </div>
      </div>
      <span className={typing ? "lp-vf-submit lp-vf-submit--pressed lp-seq-late" : "lp-vf-submit"}>
        Avisar al dueño/a
      </span>
    </div>
  );
}

/** 4b · Sent: the form's own success state (PetSightingForm.tsx:102-120). */
function SightingSentScreen() {
  return (
    <div className="lp-pub">
      <div className="lp-match-ok">
        <b>¡Gracias!</b>
        <span>
          Le avisamos al dueño/a con el punto que marcaste. Cualquier detalle más puede ayudar.
        </span>
      </div>
      <span className="lp-pub-back">Volver al perfil de {PAMPA.name}</span>
    </div>
  );
}

/** 4 · The form, typed and sent, then its thanks — one step (see Swap). */
function NeighbourSightingScreen({ animate }: { animate: boolean }) {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <Swap
          animate={animate}
          before={<SightingFormScreen typing={animate} />}
          after={<SightingSentScreen />}
        />
      </div>
    </>
  );
}

/** The native inbox's severity word (severityLabel, notifications-view-model.ts:97-108). */
const SEVERITY_LABEL = { urgent: "Urgente", warning: "Atención" } as const;

/**
 * One row of the native inbox (apps/mobile/src/notifications/
 * NotificationsScreen.tsx:475-555; stack title "Notificaciones",
 * apps/mobile/app/_layout.tsx:334): title and date (the inbox's dd/mm/aaaa,
 * notifications-view-model.ts:127-131), the severity word, the body, then
 * the row's actions. A CTA the app has a screen for is a button (:509-516);
 * one it has not is inert text that says so (:526-528). Both CTAs here map to
 * native screens (packages/contract/src/links/deep-link-map.ts).
 */
function NativeInboxScreen({
  title,
  date,
  severity,
  body,
  cta,
}: {
  title: string;
  date: string;
  severity: keyof typeof SEVERITY_LABEL;
  body: ReactNode;
  cta: string;
}) {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Notificaciones" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-nat-notif">
          <div className="lp-nat-notif-head">
            <b>{title}</b>
            <span>{arShortDate(date)}</span>
          </div>
          <span className="lp-nat-notif-sev">{SEVERITY_LABEL[severity]}</span>
          <span>{body}</span>
          <div className="lp-nat-notif-actions">
            <span className="lp-nat-action lp-nat-action--em">{cta}</span>
            <span className="lp-nat-action">Marcar como leída</span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * 5 · Martín's phone: the notification reportPetSighting writes
 * (report-pet-sighting.ts:429-445): title `Avistaje de {nombre}` (:433),
 * SIGHTING_BODY (:434), severity "warning" (:435 → "Atención"), CTA "Ver
 * mascota" (:438), whose "/mis-mascotas/{token}" is a native screen
 * (deep-link-map.ts:221), so it is a button. Dated the intake day.
 */
function OwnerSightingScreen() {
  return (
    <NativeInboxScreen
      title={`Avistaje de ${PAMPA.name}`}
      date={INTAKE.date}
      severity="warning"
      body={SIGHTING_BODY}
      cta="Ver mascota"
    />
  );
}

export const LOST_SEQUENCE: SequenceSpec = sequence({
  total: LOST_INBOX + 1,
  // Longer than the other chapters: step 4 types a message and a contact,
  // presses "Avisar al dueño/a" (~1.35s) and only then turns into the thanks
  // (~1.65s, .lp-seq-swap), which needs to stay up a moment before Martín's
  // phone takes over.
  stepMs: 2600,
  items: [
    { label: `${PAMPA_OWNER_NAME} la reporta perdida.`, at: LOST_REPORT },
    { label: "Imprime el cartel con su QR.", at: LOST_POSTER },
    { label: "Un vecino escanea el cartel.", at: LOST_PUBLIC },
    { label: "Avisa: la llevó al refugio.", at: LOST_SIGHTING },
    { label: `${PAMPA_OWNER_NAME} recibe la pista.`, at: LOST_INBOX },
  ],
  actor: (step) => (step === LOST_PUBLIC || step === LOST_SIGHTING ? "neighbour" : "owner"),
  screen: (step, animate) => {
    switch (step) {
      case LOST_REPORT:
        return <OwnerReportLostScreen animate={animate} />;
      case LOST_POSTER:
        return <LostPosterScreen />;
      case LOST_PUBLIC:
        return <PublicLostScreen />;
      case LOST_SIGHTING:
        return <NeighbourSightingScreen animate={animate} />;
      default:
        return <OwnerSightingScreen />;
    }
  },
  slides: true,
});

// ---------------------------------------------------------------------------
// PS8 · Refugio — "Su chip dice quién es." (2024-03-11 → 2024-03-13)
// ---------------------------------------------------------------------------

/**
 * 1 · Ingresos, step 1 "Identificación" (app/org/[orgToken]/intake/IntakeForm.tsx):
 * the wizard's counter and step label (components/ui/WizardShell.tsx:86-92,
 * STEP_LABELS :45), the step's own sentence (:335-338 — it is the one that
 * says a chip match leaves this form for the match flow), the chip and its
 * country (:340, :351) and the step's button (:376). The tattoo field
 * (:362) is omitted. The real match page comes after the wizard's other
 * three steps and its submit; the story cuts from here to it.
 *
 * No "Verificada" badge: nothing under app/org/** prints one here
 * (landing-vs-app audit 2026-09-30).
 *
 * AHEAD OF THE PRODUCT (PO decision 2026-10-01, debt pending): the step's
 * sentence and the "Escanear QR" button are NOT what IntakeForm.tsx:335 prints
 * today (it says "Si la mascota tiene microchip o tatuaje, ingrésalos…" and has
 * no QR entry). The landing shows the chip-or-QR identification the product is
 * about to ship; the gap is logged as debt by the orchestrator.
 */
function IntakeChipScreen() {
  return (
    <>
      <OpHead orgType="Refugio" orgName={PAMPA_SHELTER} page="Ingresos" />
      <div className="lp-app-body lp-ph-pad">
        <div>
          <p className="lp-vf-l">Paso 1 de 4</p>
          <p className="lp-kv-title">Identificación</p>
        </div>
        <p className="lp-ph-note">
          Ingresá su microchip o tatuaje, o escaneá el QR de su chapa si tiene. Si coincide con una
          mascota perdida en miMAR, vamos a redirigirte para confirmar la identidad.
        </p>
        <div className="lp-vf-form">
          <div className="lp-vf">
            <span className="lp-vf-l">Número de microchip</span>
            <span className="lp-vf-i">{PAMPA_CHIP}</span>
          </div>
          <span className="lp-vf-submit lp-vf-submit--ghost">Escanear QR</span>
          <div className="lp-vf">
            <span className="lp-vf-l">País del chip</span>
            <span className="lp-vf-i" />
          </div>
          <span className="lp-vf-submit">Continuar (chequearemos el chip al confirmar)</span>
        </div>
      </div>
    </>
  );
}

/**
 * 2 · The chip match page (app/org/[orgToken]/intake/match/[matchedPetToken]/
 * page.tsx:129 "Coincidencia de microchip"), its MatchConfirmationCard shown
 * and confirmed in one step (merged from the old two static
 * "pressed"/unpressed screens, PO 2026-09-30: they rendered identically under
 * ‹ › since the press only ever read through motion). "Es la misma mascota"
 * animates its press with the same type-then-press pattern as the vet's own
 * buttons (`lp-seq-late`, see VetScreen above): pressed only while `animate`
 * plays.
 *
 * The card, as MatchConfirmationCard.tsx draws it: the breach title (:87-90),
 * the name (:107), the species line "Perro, Caniche" (:80-82, :108) and the
 * details line "blanco · Hembra" (:83, :109) — TWO lines, as the card keeps
 * them — the "Perdida" pill (:113) and both buttons (:148-164). Dropped for
 * the fixed 3∶4 tablet frame (coordinator review, round 3): the breach's
 * explanatory sentence, the owner's first name, the last-known location and
 * the footnote. Nothing dropped was asserted by a test.
 */
function IntakeMatchScreen({ animate }: { animate: boolean }) {
  return (
    <>
      <OpHead orgType="Refugio" orgName={PAMPA_SHELTER} page="Coincidencia de microchip" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-match-breach">
          <b>Posible coincidencia detectada</b>
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
        </div>
        <div className="lp-vf-form">
          <span
            className={animate ? "lp-vf-submit lp-vf-submit--pressed lp-seq-late" : "lp-vf-submit"}
          >
            Es la misma mascota
          </span>
          <span className="lp-vf-submit lp-vf-submit--ghost">No es la misma</span>
        </div>
      </div>
    </>
  );
}

/**
 * 3 · Where "Es la misma mascota" lands: the match page's successRedirect is
 * the intake page (match/[matchedPetToken]/page.tsx:149), whose default tab is
 * the queue (intake/page.tsx:35). The confirm already wrote the intake
 * (confirm-chip-match-refugio.ts:186-213), so Pampa is its newest row:
 * the tabs (:122-138), the "Ingresos recientes" card (:155), the row's name,
 * "{especie} · {fecha}" and "Ver ficha" (:170-187, formatDate). The old
 * "Ingreso registrado" card, with an icon, the condition and the date, was
 * not this page (the org pet list's callout, mascotas/page.tsx:398-409, is a
 * different flow's and shows only the token).
 */
function IntakeDoneScreen() {
  return (
    <>
      <OpHead orgType="Refugio" orgName={PAMPA_SHELTER} page="Ingresos" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-op-tabs">
          <span data-on="true">Cola de ingresos</span>
          <span>Registrar</span>
        </div>
        <div className="lp-ph-card">
          <p className="lp-kv-title">Ingresos recientes</p>
          <div className="lp-intake-row">
            <div className="min-w-0 flex-1">
              <b>{PAMPA.name}</b>
              <span className="lp-intake-sub">
                {speciesLabel(PAMPA_PET.species)} · {formatDate(seedInstant(INTAKE.date))}
              </span>
            </div>
            <span className="lp-op-btn">Ver ficha</span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * 4 · Martín's notification, in the native inbox — the text
 * confirm-chip-match-refugio.ts:234-244 writes (severity "urgent", :237).
 * Its CTA points at "/mis-mascotas/{token}/devolucion", which maps to the
 * native return screen (packages/contract/src/links/deep-link-map.ts,
 * `petReturn`), so the inbox renders it as a button (NotificationsScreen.tsx,
 * RowAction emphasis).
 */
function OwnerNotifiedScreen() {
  return (
    <NativeInboxScreen
      title={`¡Encontraron a ${PAMPA.name}!`}
      date={INTAKE.date}
      severity="urgent"
      body={`${PAMPA.name} está a salvo en ${PAMPA_SHELTER}. La reconocieron por su microchip. Coordiná con ellos para ir a buscarla.`}
      cta="Coordinar devolución"
    />
  );
}

/**
 * 5 · Where "Coordinar devolución" lands: the NATIVE return screen
 * (apps/mobile/app/mascotas/[publicToken]/devolucion.tsx → src/custody/
 * DevolucionScreen.tsx), stack title "Devolución" (app/_layout.tsx:390).
 *
 * THE STATE IS `inbound_pending`. Since 2026-10-01 (PO) the refugio's chip
 * match leaves the return proposal addressed to Martín in the intake's own
 * transaction (confirm-chip-match-refugio.ts:220-228, through
 * writeRefugioReturnProposalInTx), so readPetReturnState finds it pending and
 * names the organization as the proposer
 * (src/modules/return-to-owner/application/read-return-state.ts:143-175,
 * proposerIdentity :192-215, `actorKind` "organization"). The screen reads: the title (DevolucionScreen.tsx:162),
 * the headline (returnStateHeadline, devolucion-view-model.ts:94-101), the
 * "Confirmar la devolución" card with its sentence and "Ya tengo a {nombre}"
 * (:178-189, confirmReturnSentence) — the one he presses — and the "Rechazar la devolución" card's
 * title and sentence (:191-194, rejectReturnSentence; its "Motivo" field and button are below the
 * fold, omitted). The proposal carries no notes, so there is no "Lo que dejó
 * escrito" card (:169-173).
 */
function OwnerDevolucionScreen({ animate }: { animate: boolean }) {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Devolución" />
      <div className="lp-app-body lp-ph-pad">
        <p className="lp-kv-title lp-sheet-t">Devolución de {PAMPA.name}</p>
        <p className="lp-ph-note">
          {PAMPA.name} está en {PAMPA_SHELTER}, a salvo y esperándote.
        </p>
        <div className="lp-ph-card">
          <p className="lp-kv-title">Confirmar la devolución</p>
          <p className="lp-ph-note">
            Tocá el botón cuando ya tengas a {PAMPA.name} con vos. Ahí el refugio deja de cuidarla.
          </p>
          <span
            className={
              animate
                ? "lp-vf-submit lp-vf-submit--pressed lp-seq-late"
                : "lp-vf-submit lp-vf-submit--pressed"
            }
          >
            Ya tengo a {PAMPA.name}
          </span>
        </div>
        <div className="lp-ph-card">
          <p className="lp-kv-title">Rechazar la devolución</p>
          <p className="lp-ph-note">
            Si no es tu mascota o algo no está bien, contale el motivo al refugio.
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * 6 · The payoff (critique 2026-09-29, M5: a chapter ends on its payoff, not on
 * a dialog). Confirming the return IS the end of the search: the accept
 * closes the refugio's custody and flips her lost → active itself
 * (src/modules/return-to-owner/application/owner-accept-return.ts:249-281), so
 * no "Sí, la encontré" follows. The same native screen then shows its notice
 * (DevolucionScreen.tsx:122, :165-169), acceptedMessage's sentence for a
 * return that went through (devolucion-view-model.ts:170-176).
 *
 * Omitted, not altered: the headline the screen re-reads underneath once the
 * return landed (returnStateHeadline for the state after it). No "al día"
 * claim either: on 2024-03-13 her rabies dose had lapsed (the seed's 2022 dose
 * was due 2023-04-12; the next is 2026's).
 */
function OwnerReturnedScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <AppHead title="Devolución" />
      <div className="lp-app-body lp-ph-pad">
        <p className="lp-kv-title lp-sheet-t">Devolución de {PAMPA.name}</p>
        <div className="lp-match-ok">
          <span>¡Listo! {PAMPA.name} ya está en casa con vos.</span>
        </div>
      </div>
    </>
  );
}

// 6 steps (PO 2026-10-01): the refugio's three tablet steps, then Martín's
// phone — the notification, the native Devolución with "Ya tengo a Pampa"
// pressed, and the return it leaves. The old libreta payoff screen is gone:
// the story's libreta chapter (5) right after this one draws the same ledger.
const SHELTER_SCREENS: Array<(animate: boolean) => ReactNode> = [
  () => <IntakeChipScreen />,
  (animate) => <IntakeMatchScreen animate={animate} />,
  () => <IntakeDoneScreen />,
  () => <OwnerNotifiedScreen />,
  (animate) => <OwnerDevolucionScreen animate={animate} />,
  () => <OwnerReturnedScreen />,
];
// Exported so the device-frame guard test (and anything else that needs the
// split) does not re-hardcode this index and drift from it.
export const OWNER_FROM = 3;

export const SHELTER_SEQUENCE: SequenceSpec = sequence({
  total: SHELTER_SCREENS.length,
  stepMs: 1700,
  items: [
    { label: "El refugio lee el chip o el QR.", at: 0 },
    { label: "miMAR avisa: está perdida.", at: 1 },
    { label: "Registra el ingreso.", at: 2 },
    { label: `${PAMPA_OWNER_NAME} recibe el aviso.`, at: 3 },
    { label: "Confirma la devolución.", at: 4 },
    { label: `Vuelve con ${PAMPA_OWNER_NAME}.`, at: 5 },
  ],
  // The device itself switches with who is using it (PO 2026-09-29, and
  // again 2026-09-29 on captions: "sin tener que aclarar en cada caso" — no
  // `deviceLabel` caption names it either; the removed field used to print
  // "Portal del refugio" / "App de Martín" above the device): the refugio's
  // own tablet for its intake steps, then Martín's phone from OWNER_FROM on;
  // the tablet slides out and the phone slides in (PO 2026-09-30).
  actor: (step) => (step >= OWNER_FROM ? "owner" : "shelter"),
  screen: (step, animate) => {
    const render = SHELTER_SCREENS[step] ?? SHELTER_SCREENS[SHELTER_SCREENS.length - 1];
    return render?.(animate);
  },
  slides: true,
});

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
