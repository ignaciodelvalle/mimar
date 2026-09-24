"use client";

// ApplicationForm — 5-step adoption application wizard.
// Steps:
//   1. Por qué querés adoptar — motivation textarea (required, min 30 chars).
//   2. Tu experiencia — priorPets radio + otherPets textarea.
//   3. Tu casa — housing type radio.
//   4. Tu día a día — dailyRoutine + notes textareas (optional).
//   5. Confirmar — consent checkbox + privacy modal + summary recap.

import { useEffect, useRef, useState, useTransition } from "react";

import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { submitAdoptionApplicationAction } from "@/src/modules/adoption/actions";
import type { PriorPets } from "@/src/modules/adoption/domain/types";

type HousingType = "casa_con_patio" | "casa_sin_patio" | "departamento" | "otro";

const HOUSING_OPTIONS: Array<{ value: HousingType; label: string }> = [
  { value: "casa_con_patio", label: "Casa con patio" },
  { value: "casa_sin_patio", label: "Casa sin patio" },
  { value: "departamento", label: "Departamento" },
  { value: "otro", label: "Otra" },
];

const PRIOR_PETS_OPTIONS: Array<{ value: PriorPets; label: string }> = [
  { value: "yes_currently", label: "Sí, actualmente tengo mascotas" },
  { value: "yes_before", label: "Sí, tuve antes" },
  { value: "no", label: "No, nunca tuve" },
];

const TOTAL_STEPS = 5;
const STEP_LABELS = [
  "Por qué querés adoptar",
  "Tu experiencia",
  "Tu casa",
  "Tu día a día",
  "Confirmar",
];

const MIN_MOTIVATION_LEN = 30;

// ---------------------------------------------------------------------------
// Shared style helpers
// ---------------------------------------------------------------------------

const CARD_STYLE: React.CSSProperties = {
  background: "var(--color-ln-card)",
  borderColor: "var(--color-ln-line)",
};

const TEXTAREA_STYLE: React.CSSProperties = {
  background: "var(--color-ln-card)",
  borderColor: "var(--color-ln-line-strong)",
  color: "var(--color-ln-ink)",
};

const LABEL_STYLE: React.CSSProperties = {
  color: "var(--color-ln-ink)",
};

const HINT_STYLE: React.CSSProperties = {
  color: "var(--color-ln-mute)",
};

const STEP_NUM_STYLE: React.CSSProperties = {
  color: "var(--color-ln-azul)",
  fontFamily: "var(--font-ln-mono)",
};

function StepQuestion({
  num,
  label,
  hint,
  children,
}: {
  num: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-[var(--radius-lg)] border px-5 py-[18px] space-y-[10px]"
      style={CARD_STYLE}
    >
      <p className="text-base font-semibold" style={LABEL_STYLE}>
        <span className="mr-[7px] text-sm font-semibold" style={STEP_NUM_STYLE}>
          {num}
        </span>
        {label}
      </p>
      {hint && (
        <p className="text-sm" style={HINT_STYLE}>
          {hint}
        </p>
      )}
      {children}
    </div>
  );
}

function RadioCard<T extends string>({
  name,
  groupLabel,
  options,
  value,
  onChange,
  required,
}: {
  name: string;
  /** Accessible group label for the fieldset legend (visually hidden). */
  groupLabel: string;
  options: Array<{ value: T; label: string }>;
  value: T | "";
  onChange: (v: T) => void;
  required?: boolean;
}) {
  return (
    <fieldset className="border-0 m-0 p-0">
      <legend className="sr-only">{groupLabel}</legend>
      <div className="grid grid-cols-1 gap-2">
        {options.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2.5 rounded-[var(--radius-md)] border px-3 py-2.5 text-md cursor-pointer"
            style={
              value === opt.value
                ? {
                    borderColor: "var(--color-ln-azul)",
                    background: "var(--color-ln-celeste-050)",
                    color: "var(--color-ln-ink)",
                  }
                : {
                    borderColor: "var(--color-ln-line)",
                    background: "var(--color-ln-card)",
                    color: "var(--color-ln-ink)",
                  }
            }
          >
            <input
              type="radio"
              name={name}
              value={opt.value}
              checked={value === opt.value}
              onChange={() => onChange(opt.value)}
              aria-required={required ? "true" : undefined}
              className="sr-only"
            />
            <span
              className="flex-shrink-0 w-[16px] h-[16px] rounded-full border-2"
              style={
                value === opt.value
                  ? {
                      borderColor: "var(--color-ln-azul)",
                      background: "var(--color-ln-azul)",
                      boxShadow: "inset 0 0 0 3px #fff",
                    }
                  : {
                      borderColor: "var(--color-ln-line-strong)",
                      background: "transparent",
                    }
              }
            />
            <span>{opt.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function ApplicationForm({
  petPublicToken,
  petName,
  applicantEmail,
}: {
  petPublicToken: string;
  petName: string;
  applicantEmail: string;
}) {
  const [pending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [motivation, setMotivation] = useState("");
  const [priorPets, setPriorPets] = useState<PriorPets | "">("");
  const [otherPets, setOtherPets] = useState("");
  const [housingType, setHousingType] = useState<HousingType | "">("");
  const [dailyRoutine, setDailyRoutine] = useState("");
  const [notes, setNotes] = useState("");
  const [profileSharingConsent, setProfileSharingConsent] = useState(false);
  const [privacyModalOpen, setPrivacyModalOpen] = useState(false);
  const privacyDialogRef = useRef<HTMLDialogElement | null>(null);

  // Drive the native <dialog> open/close via showModal()/close() so the browser
  // provides a focus trap and Esc-key dismissal (WCAG 2.1.2 / UX 2.4).
  useEffect(() => {
    const dialog = privacyDialogRef.current;
    if (!dialog) return;
    if (privacyModalOpen) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  }, [privacyModalOpen]);
  const [submittedCode, setSubmittedCode] = useState<string | null>(null);

  function advanceStep1() {
    const trimmed = motivation.trim();
    if (trimmed.length < MIN_MOTIVATION_LEN) {
      setError(`Contanos un poco más — mínimo ${MIN_MOTIVATION_LEN} caracteres.`);
      return;
    }
    setError(null);
    setStep(2);
  }

  function advanceStep2() {
    if (!priorPets) {
      setError("Seleccioná si tuviste mascotas antes.");
      return;
    }
    setError(null);
    setStep(3);
  }

  function submit() {
    // Step gate in the handler, not only on the button — see the sibling guards
    // in IntakeForm/AdoptionListingForm. Without it the only thing stopping a
    // step-1 click on "Enviar postulación" is the `inert` attribute on the
    // inactive sections.
    if (step !== TOTAL_STEPS) return;
    setError(null);
    if (!housingType) {
      setError("Elegí el tipo de vivienda.");
      setStep(3);
      return;
    }
    if (motivation.trim().length < MIN_MOTIVATION_LEN) {
      setError(`Contanos por qué querés adoptar (mínimo ${MIN_MOTIVATION_LEN} caracteres).`);
      setStep(1);
      return;
    }
    if (!priorPets) {
      setError("Seleccioná si tuviste mascotas antes.");
      setStep(2);
      return;
    }
    startTransition(async () => {
      // A THROW used to escape this transition unhandled: the network dies, the
      // action rejects, and the applicant saw no error while the three steps of
      // answers they had just typed sat there with nothing to click. Only a
      // successful result advances to the success screen; a rejection leaves
      // every field exactly as it was and says what happened.
      let result: Awaited<ReturnType<typeof submitAdoptionApplicationAction>>;
      try {
        result = await submitAdoptionApplicationAction({
          petPublicToken,
          housingType,
          otherPets: otherPets.trim() || null,
          dailyRoutine: dailyRoutine.trim() || null,
          notes: notes.trim() || null,
          profileSharingConsent,
          motivation: motivation.trim() || null,
          priorPets: priorPets || null,
        });
      } catch {
        setError(
          "No pudimos enviar tu postulación. Revisá tu conexión y volvé a intentar. Lo que escribiste sigue acá.",
        );
        return;
      }
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const short = result.applicationEventId.slice(0, 8).toUpperCase();
      setSubmittedCode(`APP-${short.slice(0, 4)}-${short.slice(4, 8)}`);
    });
  }

  if (submittedCode) {
    return (
      <LnSuccessScreen
        title={`Tu postulación a ${petName} fue enviada`}
        description={`Te van a contactar a ${applicantEmail} cuando tengan novedades. Podés seguir el estado desde "Mis postulaciones".`}
        code={submittedCode}
        codeLabel="Referencia de tu postulación"
        codeWarning="Es un número de referencia interno: no hace falta guardarlo. Seguí tu postulación desde tu cuenta."
        next={[
          {
            label: "Ver mis postulaciones",
            href: "/mis-mascotas/postulaciones",
          },
          {
            label: `Volver a la ficha de ${petName}`,
            href: `/adoptar/${petPublicToken}`,
            variant: "secondary",
          },
        ]}
      />
    );
  }

  const motivationChars = motivation.trim().length;

  return (
    <LnWizardShell
      currentStep={step}
      totalSteps={TOTAL_STEPS}
      stepLabels={STEP_LABELS}
      onBack={
        step > 1
          ? () => {
              setError(null);
              setStep((s) => s - 1);
            }
          : undefined
      }
    >
      <p className="text-sm" style={HINT_STYLE}>
        Te van a contactar a{" "}
        <span className="font-semibold" style={{ color: "var(--color-ln-ink)" }}>
          {applicantEmail}
        </span>{" "}
        para coordinar los próximos pasos.
      </p>

      {/* Step 1 — Motivación */}
      <section
        className={step === 1 ? "space-y-[14px]" : "sr-only"}
        aria-hidden={step !== 1}
        inert={step !== 1 ? true : undefined}
      >
        <StepQuestion
          num="01"
          label={`¿Por qué querés adoptar a ${petName}?`}
          hint="Contale al refugio qué te llevó a postularte. Mientras más específico, mejor."
        >
          <textarea
            id="motivation"
            value={motivation}
            onChange={(e) => setMotivation(e.target.value)}
            rows={4}
            placeholder={`Ej: "Siempre tuve perros y ahora que me mudé a una casa con patio quiero darle una familia a ${petName}..."`}
            className="w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-md outline-none focus:ring-2"
            style={TEXTAREA_STYLE}
          />
          <p
            className="text-sm text-right"
            style={{
              color:
                motivationChars >= MIN_MOTIVATION_LEN
                  ? "var(--color-ln-ok)"
                  : "var(--color-ln-mute)",
            }}
          >
            {motivationChars} / {MIN_MOTIVATION_LEN} caracteres mínimo
          </p>
        </StepQuestion>
        {error && (
          <output className="block text-md" style={{ color: "var(--color-ln-err)" }}>
            {error}
          </output>
        )}
        <button
          type="button"
          onClick={advanceStep1}
          disabled={motivationChars < MIN_MOTIVATION_LEN}
          className="w-full rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-md font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Continuar →
        </button>
      </section>

      {/* Step 2 — Experiencia + otros animales */}
      <section
        className={step === 2 ? "space-y-[14px]" : "sr-only"}
        aria-hidden={step !== 2}
        inert={step !== 2 ? true : undefined}
      >
        <StepQuestion num="02" label="¿Tuviste mascotas antes?">
          <RadioCard
            name="prior_pets"
            groupLabel="¿Tuviste mascotas antes?"
            options={PRIOR_PETS_OPTIONS}
            value={priorPets}
            onChange={setPriorPets}
            required
          />
        </StepQuestion>
        <StepQuestion
          num="03"
          label="¿Tenés otras mascotas actualmente?"
          hint="Opcional — contale al refugio si hay animales en casa."
        >
          <textarea
            id="other-pets"
            value={otherPets}
            onChange={(e) => setOtherPets(e.target.value)}
            rows={3}
            placeholder='Ej: "un gato castrado adulto, sociable"'
            className="w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-md outline-none focus:ring-2"
            style={TEXTAREA_STYLE}
          />
        </StepQuestion>
        {error && (
          <output className="block text-md" style={{ color: "var(--color-ln-err)" }}>
            {error}
          </output>
        )}
        <button
          type="button"
          onClick={advanceStep2}
          disabled={!priorPets}
          className="w-full rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-md font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Continuar →
        </button>
      </section>

      {/* Step 3 — Tu casa */}
      <section
        className={step === 3 ? "space-y-[14px]" : "sr-only"}
        aria-hidden={step !== 3}
        inert={step !== 3 ? true : undefined}
      >
        <StepQuestion num="04" label="¿Cómo es tu vivienda?">
          <RadioCard
            name="housing"
            groupLabel="¿Cómo es tu vivienda?"
            options={HOUSING_OPTIONS}
            value={housingType}
            onChange={setHousingType}
            required
          />
        </StepQuestion>
        {error && (
          <output className="block text-md" style={{ color: "var(--color-ln-err)" }}>
            {error}
          </output>
        )}
        <button
          type="button"
          onClick={() => setStep(4)}
          disabled={!housingType}
          className="w-full rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-md font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Continuar →
        </button>
      </section>

      {/* Step 4 — Tu día a día */}
      <section
        className={step === 4 ? "space-y-[14px]" : "sr-only"}
        aria-hidden={step !== 4}
        inert={step !== 4 ? true : undefined}
      >
        <StepQuestion
          num="05"
          label="Cómo es tu día a día"
          hint="Opcional — quién está en casa, si hay nenes, cómo se organiza el cuidado."
        >
          <textarea
            id="daily-routine"
            value={dailyRoutine}
            onChange={(e) => setDailyRoutine(e.target.value)}
            rows={3}
            placeholder="¿Quién está en casa durante el día? ¿Hay nenes? ¿Alguien la cuida si viajás?"
            className="w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-md outline-none focus:ring-2"
            style={TEXTAREA_STYLE}
          />
        </StepQuestion>
        <StepQuestion num="06" label="Algo más que quieras contar" hint="Opcional.">
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full rounded-[var(--radius-md)] border px-3 py-2.5 text-md outline-none focus:ring-2"
            style={TEXTAREA_STYLE}
          />
        </StepQuestion>
        <button
          type="button"
          onClick={() => setStep(5)}
          className="w-full rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-md font-semibold text-white"
          style={{ background: "var(--color-ln-azul)" }}
        >
          Continuar →
        </button>
      </section>

      {/* Step 5 — Confirmar */}
      <section
        className={step === 5 ? "space-y-[14px]" : "sr-only"}
        aria-hidden={step !== 5}
        inert={step !== 5 ? true : undefined}
      >
        {/* Summary recap */}
        <div
          className="rounded-[var(--radius-lg)] border px-5 py-4 space-y-[10px]"
          style={CARD_STYLE}
        >
          <p
            className="font-ln-serif text-base font-semibold"
            style={{ color: "var(--color-ln-ink)" }}
          >
            Resumen
          </p>
          <dl
            className="grid gap-x-3.5 gap-y-1.5 text-sm"
            style={{ gridTemplateColumns: "auto 1fr" }}
          >
            <dt className="font-ln-mono text-xs uppercase tracking-[.06em]" style={HINT_STYLE}>
              Por qué adoptás
            </dt>
            <dd className="m-0 line-clamp-2" style={{ color: "var(--color-ln-ink)" }}>
              {motivation.trim() || "—"}
            </dd>
            <dt className="font-ln-mono text-xs uppercase tracking-[.06em]" style={HINT_STYLE}>
              Experiencia con mascotas
            </dt>
            <dd className="m-0" style={{ color: "var(--color-ln-ink)" }}>
              {PRIOR_PETS_OPTIONS.find((o) => o.value === priorPets)?.label ?? "—"}
            </dd>
            <dt className="font-ln-mono text-xs uppercase tracking-[.06em]" style={HINT_STYLE}>
              Vivienda
            </dt>
            <dd className="m-0" style={{ color: "var(--color-ln-ink)" }}>
              {HOUSING_OPTIONS.find((o) => o.value === housingType)?.label ?? "—"}
            </dd>
            <dt className="font-ln-mono text-xs uppercase tracking-[.06em]" style={HINT_STYLE}>
              Otras mascotas
            </dt>
            <dd className="m-0" style={{ color: "var(--color-ln-ink)" }}>
              {otherPets || "—"}
            </dd>
            <dt className="font-ln-mono text-xs uppercase tracking-[.06em]" style={HINT_STYLE}>
              Día a día
            </dt>
            <dd className="m-0" style={{ color: "var(--color-ln-ink)" }}>
              {dailyRoutine || "—"}
            </dd>
            <dt className="font-ln-mono text-xs uppercase tracking-[.06em]" style={HINT_STYLE}>
              Notas
            </dt>
            <dd className="m-0" style={{ color: "var(--color-ln-ink)" }}>
              {notes || "—"}
            </dd>
          </dl>
        </div>

        {/* Consent */}
        <div className="rounded-[var(--radius-lg)] border px-5 py-4" style={CARD_STYLE}>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={profileSharingConsent}
              onChange={(e) => setProfileSharingConsent(e.target.checked)}
              className="mt-0.5 h-[16px] w-[16px] rounded border flex-shrink-0"
              style={{
                borderColor: "var(--color-ln-line-strong)",
                accentColor: "var(--color-ln-azul)",
              }}
            />
            <span className="text-md" style={{ color: "var(--color-ln-ink-2)" }}>
              Acepto compartir con el refugio mi historial de adopciones, fosters y mascotas en
              miMAR para que tomen una mejor decisión.{" "}
              <button
                type="button"
                onClick={() => setPrivacyModalOpen(true)}
                className="underline underline-offset-2 font-semibold"
                style={{ color: "var(--color-ln-azul)" }}
              >
                Más info sobre tu privacidad
              </button>
            </span>
          </label>
        </div>

        {/* Privacy modal — native <dialog> with showModal() for browser-managed
            focus trap and Esc dismissal. Always rendered in the DOM; open/close
            is driven imperatively via ref + useEffect (see above).
            The ::backdrop pseudo-element provides the dimming overlay. */}
        <dialog
          ref={privacyDialogRef}
          className="w-full overflow-y-auto rounded-[var(--radius-lg)] border px-6 py-[22px] shadow-xl"
          style={{
            maxWidth: 480,
            background: "var(--color-ln-card)",
            borderColor: "var(--color-ln-line-strong)",
          }}
          aria-labelledby="privacy-modal-title"
          onClose={() => setPrivacyModalOpen(false)}
        >
          <h2
            id="privacy-modal-title"
            className="font-ln-serif text-lg font-semibold mb-3.5"
            style={{ color: "var(--color-ln-ink)" }}
          >
            Información sobre privacidad — Ley 25.326
          </h2>
          <div className="text-md space-y-[10px]" style={{ color: "var(--color-ln-ink-2)" }}>
            <p>
              Bajo la Ley 25.326 (Protección de Datos Personales), tus datos solo pueden compartirse
              con consentimiento informado y para un propósito específico.
            </p>
            <p>
              <strong style={{ color: "var(--color-ln-ink)" }}>Qué compartirías:</strong> la lista
              de tus adopciones previas en miMAR (con outcome — exitosa, revertida, etc.), tus
              fosters previos, tus mascotas registradas actualmente. NO compartirías: tus
              notificaciones, otras postulaciones, denuncias, dirección exacta.
            </p>
            <p>
              <strong style={{ color: "var(--color-ln-ink)" }}>Por cuánto tiempo:</strong> solo
              mientras tu postulación a {petName} esté abierta. Al cerrarse, el refugio pierde
              acceso inmediatamente.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPrivacyModalOpen(false)}
            className="mt-[18px] w-full rounded-[var(--radius-md)] border-0 px-4 py-[11px] text-md font-semibold text-white"
            style={{ background: "var(--color-ln-azul)" }}
          >
            Entendido
          </button>
        </dialog>

        {error && (
          <output className="block text-md" style={{ color: "var(--color-ln-err)" }}>
            {error}
          </output>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={pending || !profileSharingConsent}
          className="w-full rounded-[var(--radius-md)] border-0 px-4 py-[13px] text-md font-semibold text-white transition-opacity disabled:opacity-60"
          style={{ background: "var(--color-ln-azul)" }}
        >
          {pending ? "Enviando postulación..." : "Enviar postulación"}
        </button>
      </section>
    </LnWizardShell>
  );
}
