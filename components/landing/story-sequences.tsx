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
// actor change (the neighbour's phone, or the refugio's tablet, handing over
// to Martín's phone) slides the outgoing device out and the incoming one in. Each person's device has
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
  PAMPA_VET,
  landingDate,
  pampaEvent,
} from "@/components/landing/landing-content";
import { AppHead, OpHead } from "@/components/landing/story-screens";
import { useChapterSequence } from "@/components/landing/use-chapter-sequence";
import { LnBadge } from "@/components/ui/Badge";
import { LnPetPhoto } from "@/components/ui/RegRow";
import { LnStatusFlag } from "@/components/ui/StatusFlag";
import { eventTypeLabel, sexLabel, situationLabelForSex } from "@/lib/utils/format";
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

// The lost-poster's QR (PO 2026-09-30, second call) — a DECORATIVE mini QR:
// it only has to read as "a QR", not scan. A fixed 13x13 matrix with three
// finder squares, drawn with big modules so it stays legible at 64px. The
// scannable QR on this page is the hero card's; this one is a picture of a
// poster. Being static, it also keeps the qrcode encoder out of this
// "use client" bundle.
export const POSTER_QR_MATRIX: readonly string[] = [
  "1111101011111",
  "1000100010001",
  "1010100010101",
  "1000101010001",
  "1111100011111",
  "0000001000000",
  "1011011101101",
  "0000010110110",
  "1111101011010",
  "1000100110011",
  "1010101101100",
  "1000101001011",
  "1111101110101",
];
// 13 modules inside a 19-unit box: the matrix fills ~68% of the frame.
const POSTER_QR_MARGIN = 3;
const POSTER_QR_BOX = POSTER_QR_MATRIX.length + POSTER_QR_MARGIN * 2;
const POSTER_QR_PATH = POSTER_QR_MATRIX.flatMap((row, y) =>
  [...row].flatMap((cell, x) =>
    cell === "1" ? [`M${x + POSTER_QR_MARGIN} ${y + POSTER_QR_MARGIN}h1v1h-1z`] : [],
  ),
).join("");

const LOST = pampaEvent("status_changed", "lost");
const INTAKE = pampaEvent("shelter_intake_recorded");
const FOUND = pampaEvent("status_changed", "active");
const LOST_PLACE = String(LOST.payload.location_description);

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
          {/* No visible lead or step labels (PO 2026-09-30: "sin
              descripción"); the device tells the story. The device mock is
              aria-hidden, so a screen reader still gets the chapter's lead
              and the current step, here. */}
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
          <p className="sr-only" aria-live={manual ? "polite" : "off"}>
            Paso {activeItem + 1} de {spec.items.length}: {current?.label}
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
// Shared bits: the decorative poster QR, a sentence typed word by word
// ---------------------------------------------------------------------------

/** The decorative mini QR (see POSTER_QR_MATRIX), at whatever size `className` sets. */
function PosterQr({ className }: { className: string }) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      viewBox={`0 0 ${POSTER_QR_BOX} ${POSTER_QR_BOX}`}
      shapeRendering="crispEdges"
    >
      <rect width={POSTER_QR_BOX} height={POSTER_QR_BOX} fill="#fff" />
      <path d={POSTER_QR_PATH} fill="#000" />
    </svg>
  );
}

/**
 * A sentence someone types, word by word (opacity only, staggered by
 * --i). Static — the whole sentence, no class — whenever `typing` is false:
 * SSR, reduced motion, and every step after the one it is typed in.
 */
function Typed({ text, typing }: { text: string; typing: boolean }) {
  if (!typing) return <>{text}</>;
  const words = text.split(" ");
  return (
    <span className="lp-seq-type">
      {words.map((w, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed sentence, words never reorder
          key={i}
          style={{ "--i": i } as CSSProperties}
        >
          {i < words.length - 1 ? `${w} ` : w}
        </span>
      ))}
    </span>
  );
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
    { label: `Busca a ${PAMPA.name} con el código de su credencial.`, at: VET_FOUND },
    { label: "Anota lo que hizo, con sus palabras.", at: VET_TYPE },
    { label: "miMAR reconoce que es una vacuna.", at: VET_READ },
    { label: "El formulario llega completado; lo valida.", at: VET_FORM },
    { label: "Queda firmado con su matrícula.", at: VET_DONE },
  ],
  actor: () => "vet",
  screen: (step, animate) => <VetScreen step={step} animate={animate} />,
  slides: true,
});

// ---------------------------------------------------------------------------
// PS7 · Se pierde — the neighbour's phone, then Martín's (2024-03-10)
// ---------------------------------------------------------------------------

// The citizen circuit (PO 2026-09-30): a neighbour — no account, no app —
// scans the QR, lands on the public credential in its "perdida" state,
// opens its found form and leaves a message; Martín gets the notification
// that form's action writes. His phone then shows the poster whose QR the
// neighbour scanned.
//
// The found form drawn is the credential's own inline one
// (app/(public)/p/[publicToken]/page.tsx:970-987 → FoundPetForm.tsx →
// notify-owner-of-found-pet.ts), because it is the one that writes
// "¡Encontraron a {nombre}!". The sticky "La tengo conmigo" button
// (lib/utils/format.ts:543) opens /encontre instead, whose notification is
// "Alguien tiene a {nombre}" and names where the finder is — a place this
// story may not draw. There is no "La encontré" button on the public page.
//
// Martín's map is left out: the owner's lost case shows scans as a feed and
// counts ("Avistamientos y escaneos"), and a map of where a QR was read is
// exactly what the fence forbids.

/** What the neighbour types — HER words, not product copy. No place, on purpose. */
export const FINDER_MESSAGE = "Está bien y tranquila, tiene su collar puesto";

const LOST_SCAN = 0;
const LOST_PAGE = 1;
const LOST_WRITE = 2;
const LOST_SENT = 3;
const LOST_OWNER = 4; // the actor switch: Martín's phone from here on
const LOST_POSTER = 5;
// Exported so the tests do not re-hardcode the split.
export const LOST_OWNER_FROM = LOST_OWNER;
export const LOST_POSTER_STEP = LOST_POSTER;

/** 1 · The phone's own camera on the poster's QR — no product copy at all. */
function NeighbourScanScreen() {
  return (
    <div className="lp-cam">
      <div className="lp-cam-frame">
        <PosterQr className="lp-cam-qr" />
      </div>
    </div>
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

/** 2 · The public page, lost: name bar and the "¿Encontraste…?" row (page.tsx:711-716, :973-976). */
function PublicLostScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-pub">
          <PublicMasthead />
          <LnPetPhoto src={PHOTO} alt={PAMPA.name} status="lost" size={132} />
          <b className="lp-pub-name">{PAMPA.name}</b>
          <span className="lp-pub-sub">{PUBLIC_BREED_LINE}</span>
          <div className="lp-pub-found">
            <div className="min-w-0 flex-1">
              <b>¿Encontraste a esta mascota?</b>
              <span>Tocá acá para avisarle al dueño.</span>
            </div>
            <span aria-hidden="true">›</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** 3 · The found form, opened (FoundPetForm.tsx: labels :49, :65, :89; placeholders :57, :78; CTA :113). */
function FinderWriteScreen({ typing }: { typing: boolean }) {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-pub">
          <PublicMasthead />
          <b className="lp-pub-q">¿Encontraste a esta mascota?</b>
          <div className="lp-vf-form">
            <div className="lp-vf">
              <span className="lp-vf-l">Tu nombre (opcional)</span>
              <span className="lp-vf-i lp-vf-i--ph">Nombre y apellido</span>
            </div>
            <div className="lp-vf">
              <span className="lp-vf-l">Cómo te contactamos (opcional)</span>
              <span className="lp-vf-i lp-vf-i--ph">Teléfono o email</span>
            </div>
            <div className="lp-vf">
              <span className="lp-vf-l">Mensaje (opcional)</span>
              <span className="lp-vf-i lp-vf-i--area">
                <Typed text={FINDER_MESSAGE} typing={typing} />
              </span>
            </div>
          </div>
          <span
            className={
              typing
                ? "lp-vf-submit lp-vf-submit--warn lp-seq-late"
                : "lp-vf-submit lp-vf-submit--warn"
            }
          >
            Avisar al dueño
          </span>
        </div>
      </div>
    </>
  );
}

/** 4 · Sent (FoundPetForm.tsx:28-31). */
function FinderSentScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-pub">
          <PublicMasthead />
          <div className="lp-match-ok">
            <b>¡Gracias!</b>
            <span>Le avisamos al dueño. Mientras tanto, cuidala lo mejor que puedas.</span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * 5 · Martín's phone. EXACTLY what notifyOwnerOfFoundPet writes
 * (src/modules/pets/application/public/notify-owner-of-found-pet.ts:220-226,
 * title :257, CTA :262) for a finder who leaves a message and neither a
 * name nor a contact: who = "Alguien", body `{who} dejó un mensaje:
 * "{message}".{contactLine}`, contactLine " No dejó datos de contacto.".
 */
export const OWNER_FOUND_BODY = `Alguien dejó un mensaje: "${FINDER_MESSAGE}". No dejó datos de contacto.`;

function OwnerFoundReportScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-notif">
          <span className="lp-notif-app">miMAR</span>
          <b>¡Encontraron a {PAMPA.name}!</b>
          <span>{OWNER_FOUND_BODY}</span>
          <span className="lp-vf-submit">Ver mascota</span>
        </div>
      </div>
    </>
  );
}

/** 6 · The poster (apps/mobile/src/lost/LostScreen.tsx "Cartel para imprimir"). */
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
          {/* Decorative mini QR (PO 2026-09-30) — see POSTER_QR_MATRIX. */}
          <PosterQr className="lp-poster-qr" />
          <span className="lp-poster-hint">Escaneá para más info</span>
        </div>
        <span className="lp-vf-submit">Compartir o imprimir el cartel</span>
      </div>
    </>
  );
}

export const LOST_SEQUENCE: SequenceSpec = sequence({
  total: LOST_POSTER + 1,
  stepMs: 1900,
  items: [
    { label: "Un vecino escanea su QR con la cámara del celular.", at: LOST_SCAN },
    { label: `Ve que ${PAMPA.name} está perdida.`, at: LOST_PAGE },
    { label: `Le deja un mensaje a ${PAMPA_OWNER_NAME}, sin cuenta ni app.`, at: LOST_SENT },
    { label: `${PAMPA_OWNER_NAME} recibe el aviso al instante.`, at: LOST_OWNER },
    { label: "El cartel con su QR, el mismo que escaneó el vecino.", at: LOST_POSTER },
  ],
  actor: (step) => (step >= LOST_OWNER ? "owner" : "neighbour"),
  screen: (step, animate) => {
    switch (step) {
      case LOST_SCAN:
        return <NeighbourScanScreen />;
      case LOST_PAGE:
        return <PublicLostScreen />;
      case LOST_WRITE:
        return <FinderWriteScreen typing={animate} />;
      case LOST_SENT:
        return <FinderSentScreen />;
      case LOST_OWNER:
        return <OwnerFoundReportScreen />;
      default:
        return <LostPosterScreen />;
    }
  },
  slides: true,
});

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
 * "¡Encontraron a {name}!" / "{org} detectó a {name} por su microchip. Coordiná
 * la devolución." with the CTA "Coordinar devolución".
 */
function OwnerNotifiedScreen() {
  return (
    <>
      <div className="lp-scr-top" />
      <div className="lp-app-body lp-ph-pad">
        <div className="lp-notif">
          <span className="lp-notif-app">miMAR</span>
          <b>¡Encontraron a {PAMPA.name}!</b>
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

export const SHELTER_SEQUENCE: SequenceSpec = sequence({
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
  // own tablet for its intake steps, then Martín's phone from OWNER_FROM on;
  // the tablet slides out and the phone slides in (PO 2026-09-30).
  actor: (step) => (step >= OWNER_FROM ? "owner" : "shelter"),
  screen: (step) => {
    const render = SHELTER_SCREENS[step] ?? SHELTER_SCREENS[SHELTER_SCREENS.length - 1];
    return render?.();
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
