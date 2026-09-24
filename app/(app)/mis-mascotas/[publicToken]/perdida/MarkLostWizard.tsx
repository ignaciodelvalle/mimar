"use client";

// MarkLostWizard — Libreta Nacional redesign (seal/red tone, §10 handoff).
//
// Collects location + reconocimiento detail, then a MANDATORY affirmative
// disclosure step (privacy hardening 2026-07-04, Ley 25.326 consent gap):
// the DB defaults for disclose_*_when_lost are permissive (first name,
// phone, last location = true), so relying on them meant owner PII went
// public without an explicit consent moment. The wizard now presents the 5
// disclosure choices with PII toggles OFF by default — the owner actively
// picks what to share — and always submits explicit true/false values via
// hidden inputs, so setPetLostAction writes exactly what the owner chose
// instead of falling back to petDefaults. LostDisclosureCard (rendered in
// the lost block post-mark) remains the place to tune prefs afterwards.

import { deepLinkUrl } from "@dim/contract/links";
import { useRef, useState, useTransition } from "react";

import { Icon } from "@/components/Icon";
import { LocationFields } from "@/components/LocationFields";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnGroupLabel, LnSheetBody, LnSheetHeader, LnSubCard } from "@/components/ui/Sheet";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { LnToggleGroup } from "@/components/ui/Toggle";
import { TATTOO_LOCATIONS } from "@/lib/reference/lookups";
import { useStepFocus } from "@/lib/ui/use-step-focus";
import {
  lostThirdPersonPhrase,
  markLostActionLabel,
  markLostTitleForPet,
} from "@/lib/utils/format";
import type { EventFormState } from "@/src/modules/events/actions";

type FormAction = (prev: EventFormState, formData: FormData) => Promise<EventFormState>;

// Affirmative-consent defaults: every owner-PII toggle starts OFF — the owner
// must actively opt in. The finder form starts ON because it exposes no owner
// data (it lets a finder send a message without seeing any contact info).
const DISCLOSURE_DEFAULTS = {
  disclose_first_name_when_lost: false,
  disclose_phone_when_lost: false,
  disclose_email_when_lost: false,
  disclose_last_location_when_lost: false,
  allow_finder_form_when_lost: true,
} as const;

type DisclosureFieldName = keyof typeof DISCLOSURE_DEFAULTS;

const DISCLOSURE_ROWS: Array<{
  key: DisclosureFieldName;
  label: string;
  description: string;
}> = [
  {
    key: "disclose_first_name_when_lost",
    label: "Tu nombre",
    description: "El público ve quién busca a la mascota.",
  },
  {
    key: "disclose_phone_when_lost",
    label: "Tu teléfono",
    description: "Aparece un botón directo de llamada.",
  },
  {
    key: "disclose_email_when_lost",
    label: "Tu email",
    description: "Link de email en la credencial pública.",
  },
  {
    key: "disclose_last_location_when_lost",
    label: "Última ubicación",
    description: "Muestra el mapa con el pin donde se perdió.",
  },
  {
    key: "allow_finder_form_when_lost",
    label: "Formulario para avisarte",
    // Sin pronombre: esta constante es de módulo y no ve `petSex`, y el
    // producto ya prefiere reescribir la frase antes que emitir "lo/la"
    // (ver los helpers de género en lib/utils/format.ts).
    description: "Quien encuentre a tu mascota puede avisarte sin ver tus datos.",
  },
];

// The location-disclosure row also renders inline in the location step (R5.2)
// — same key, label and description, so the two views can never drift.
const LOCATION_DISCLOSURE_ROW = DISCLOSURE_ROWS.find(
  (r) => r.key === "disclose_last_location_when_lost",
) as (typeof DISCLOSURE_ROWS)[number];

export function MarkLostWizard({
  action,
  petName,
  petSex = null,
  petPublicToken,
  petHasMicrochip,
  petHasTattoo,
  petColor,
  petDistinguishingFeatures,
  petJurisdictionProvince,
  petJurisdictionLocality,
  priorAccessoriesWhenLost = null,
  priorBehaviorNotes = null,
  priorLastSeenContext = null,
}: {
  action: FormAction;
  petName: string;
  /** Pet sex ('male' | 'female' | 'unknown') — flexes the submit label. */
  petSex?: string | null;
  petPublicToken: string;
  petHasMicrochip: boolean;
  petHasTattoo: boolean;
  petColor: string | null;
  petDistinguishingFeatures: string | null;
  petJurisdictionProvince: string | null;
  petJurisdictionLocality: string | null;
  /**
   * "Accesorios que llevaba" / "Comportamiento" / "Contexto del último
   * avistaje" from the pet's most recent PRIOR pet_marked_lost episode
   * (fetchLatestLostDescription — events are the source of truth, unlike
   * petColor/petDistinguishingFeatures above which persist on the pet row).
   * Null on a pet's first-ever lost episode. The owner can still edit —
   * these are only DEFAULT values (medianos-sesión-2 finding #3: a second
   * "Marcar como perdida" started these fields blank despite them being
   * entered before).
   */
  priorAccessoriesWhenLost?: string | null;
  priorBehaviorNotes?: string | null;
  priorLastSeenContext?: string | null;
}) {
  // Detail step is conditional — pets with chip or tattoo skip it. The
  // disclosure (affirmative consent) step is ALWAYS the final step.
  const showDetailsStep = !petHasMicrochip && !petHasTattoo;
  const totalSteps = showDetailsStep ? 3 : 2;
  // Etiquetas de paso sin pronombre: el cuerpo de esta hoja estaba fijo en
  // femenino ("¿Dónde la viste?", "reconocerla") mientras el título ya
  // concuerda con petSex, así que para un macho la mitad de la pantalla no
  // coincidía. Reescritas en vez de desdobladas, como el resto del producto.
  const stepLabels = showDetailsStep
    ? ["¿Dónde fue la última vez?", "Señas particulares", "Qué se muestra al público"]
    : ["¿Dónde fue la última vez?", "Qué se muestra al público"];
  const disclosureStep = totalSteps;

  const [step, setStep] = useState(1);
  const [disclosurePrefs, setDisclosurePrefs] = useState<Record<DisclosureFieldName, boolean>>({
    ...DISCLOSURE_DEFAULTS,
  });
  const [isPending, startTransition] = useTransition();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // A11y fix (2026-07 audit): this wizard hand-rolls its own step state (all
  // steps stay mounted, hidden via sr-only/inert) instead of using
  // <LnWizardShell>, so it needs its own focus target. Wraps LnSheetHeader
  // (whose subtitle already reads "Paso X de Y · <label>") — see
  // lib/ui/use-step-focus.ts.
  const stepFocusRef = useRef<HTMLDivElement>(null);
  useStepFocus(step, stepFocusRef);

  function goBack() {
    setErrorMessage(null);
    setStep((s) => Math.max(1, s - 1));
  }

  function goNext() {
    setErrorMessage(null);
    setStep((s) => Math.min(totalSteps, s + 1));
  }

  function handleSubmit() {
    setErrorMessage(null);
    const formData = formRef.current ? new FormData(formRef.current) : new FormData();
    // Disclosure fields are ALWAYS submitted (hidden inputs carry explicit
    // "true"/"false") so setPetLostAction persists the owner's affirmative
    // choices instead of falling back to the permissive petDefaults.
    // Signal to setPetLostAction to skip the redirect.
    formData.set("noRedirect", "1");
    startTransition(async () => {
      // A THROW used to escape this transition unhandled: the network dies, the
      // action rejects, and the wizard showed no error at all while every field
      // the owner had filled sat there with nothing to click. Only an explicit
      // `ok` advances to the success screen; every other outcome (error, throw,
      // or a shape we don't recognise) leaves the form exactly as it is and
      // says so.
      let result: Awaited<ReturnType<FormAction>> | undefined;
      try {
        result = await action({ error: null }, formData);
      } catch {
        setErrorMessage(
          "No pudimos activar la búsqueda. Revisá tu conexión y volvé a intentar. Lo que cargaste sigue acá.",
        );
        return;
      }
      if (result?.error) {
        setErrorMessage(result.error);
        return;
      }
      if (result?.ok) {
        setSubmitted(true);
        return;
      }
      setErrorMessage(
        "No pudimos activar la búsqueda. Volvé a intentar en un momento. Lo que cargaste sigue acá.",
      );
    });
  }

  if (submitted) {
    const profileHref = `/mis-mascotas/${petPublicToken}`;
    const printHref = `/mis-mascotas/${petPublicToken}/cartel`;
    const shareText = lostShareText(petName, petSex);
    // The credential url comes from the deep-link table: this is the link a
    // lost-pet post carries into WhatsApp, so it is the single string in this
    // wizard that has to survive a route rename. `origin` is still empty during
    // SSR, which yields the same relative path this line always produced.
    const credentialUrl = deepLinkUrl(
      typeof window !== "undefined" ? window.location.origin : "",
      "credential",
      { publicToken: petPublicToken },
    );
    const shareUrl = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${credentialUrl}`)}`;
    return (
      <LnSuccessScreen
        title={`Activamos la búsqueda de ${petName}`}
        description="Su perfil público ya muestra el aviso con la información que elegiste compartir. Podés ajustar qué se ve (teléfono, ubicación, email) desde su perfil cuando quieras."
        next={[
          { label: "Compartir por WhatsApp", href: shareUrl },
          { label: "Imprimir cartel A4", href: printHref, variant: "secondary" },
          { label: "Volver al perfil", href: profileHref, variant: "tertiary" },
        ]}
      />
    );
  }

  const isLastStep = step === totalSteps;

  return (
    <>
      <div ref={stepFocusRef} tabIndex={-1} className="focus:outline-none">
        <LnSheetHeader
          tone="seal"
          icon={<Icon name="lupa" decorative />}
          // El género sale de petSex, como el botón de abajo. Estaba fijo en
          // femenino mientras el <h2>/<p> estaban fijos en masculino: siempre
          // había uno mal (S2-F07).
          title={markLostTitleForPet(petName, petSex)}
          subtitle={`Paso ${step} de ${totalSteps} · ${stepLabels[step - 1]}`}
        />
      </div>
      <LnSheetBody>
        {/* Step progress bar */}
        <div className="flex gap-1.5">
          {Array.from({ length: totalSteps }, (_, i) => i + 1).map((n) => (
            <div
              key={`step-${n}`}
              className={[
                "h-[3px] flex-1 rounded-full transition-colors",
                n <= step ? "bg-[var(--color-ln-seal)]" : "bg-[var(--color-ln-line-strong)]",
              ]
                .filter(Boolean)
                .join(" ")}
            />
          ))}
        </div>

        <form ref={formRef} className="contents">
          {/* Step 1 — Location. Always rendered (hidden when inactive) to preserve
              uncontrolled field values across step transitions. */}
          <section
            data-section="step-location"
            className={step === 1 ? "flex flex-col gap-3.5" : "sr-only"}
            aria-hidden={step !== 1}
            inert={step !== 1 ? true : undefined}
          >
            {/* R5.1 (pet-state-header): this copy used to promise the location
                "se vuelve parte de la credencial pública" — contradicting the
                affirmative-consent model where disclose_last_location_when_lost
                defaults OFF. It now states the truth: nothing shows publicly
                unless the owner enables the disclosure below. */}
            <p className="text-md text-[var(--color-ln-mute)]">
              Marcá el lugar y la hora aproximada del último avistaje. La ubicación no se muestra en
              la credencial pública salvo que actives compartirla — podés elegirlo acá abajo o en el
              último paso.
            </p>

            <LocationFields
              mode="l2"
              biasProvince={petJurisdictionProvince}
              biasLocality={petJurisdictionLocality}
              useMyLocationVariant="primary"
            />

            {/* R5.2: the "Última ubicación" disclosure toggle, surfaced where
                the owner is entering that very location. Bound to the SAME
                disclosurePrefs state as the final consent step — one state,
                two views, no divergence (the hidden mirrors below submit it
                exactly once). */}
            <LnToggleGroup
              items={[
                {
                  key: "disclose_last_location_when_lost",
                  label: LOCATION_DISCLOSURE_ROW.label,
                  description: LOCATION_DISCLOSURE_ROW.description,
                  checked: disclosurePrefs.disclose_last_location_when_lost,
                  variant: "amber" as const,
                },
              ]}
              onChange={(key, next) => {
                setDisclosurePrefs((prev) => ({ ...prev, [key]: next }));
              }}
            />

            {/* Asks for what paso 2 does NOT. Its placeholder used to read
                "collar, comportamiento, hora aproximada" — the exact three
                fields paso 2 then asks for one by one, so the owner wrote the
                same thing twice and only the paso-2 version reached the public
                credential (master test CIU, I3-a; it is also cowork's answer to
                "¿hiciste algo dos veces?").

                Not deleted: `reason` is stored as the episode's ownerNote, and
                paso 2 only exists when the animal has no chip or tattoo — for a
                chipped pet this is the only free-text field in the flow. The
                fix is to stop asking twice, and to say where this one goes. */}
            <LnField
              label="Nota para el expediente"
              hint="Queda asentada en el evento, no se publica en la credencial. Las señas para quien la encuentre van en el paso siguiente."
            >
              {({ id, describedBy }) => (
                <LnTextarea
                  id={id}
                  name="reason"
                  rows={3}
                  placeholder="Contexto que quieras dejar registrado (opcional)"
                  aria-describedby={describedBy}
                />
              )}
            </LnField>
          </section>

          {/* Step 2 — Enriched details (conditional — only when no chip/tattoo). */}
          {showDetailsStep && (
            <section
              data-section="step-details"
              className={step === 2 ? "flex flex-col gap-3.5" : "sr-only"}
              aria-hidden={step !== 2}
              inert={step !== 2 ? true : undefined}
            >
              <LnCallout tone="azul" title="Sin chip ni tatuaje, estos detalles son clave">
                Quien encuentre a tu mascota sin documentación va a depender de cómo se ve.
              </LnCallout>

              <LnSubCard heading="Identidad">
                <LnGroupLabel>Aspecto físico</LnGroupLabel>
                <LnField label="Color y pelaje">
                  {({ id, describedBy }) => (
                    <LnInput
                      id={id}
                      name="enriched_color"
                      type="text"
                      defaultValue={petColor ?? ""}
                      placeholder="Ej: marrón con manchas blancas en el pecho"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
                <LnField label="Marcas o características distintivas">
                  {({ id, describedBy }) => (
                    <LnTextarea
                      id={id}
                      name="enriched_distinguishing_features"
                      rows={2}
                      defaultValue={petDistinguishingFeatures ?? ""}
                      placeholder="Ej: mancha negra en la oreja derecha, cola corta"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
              </LnSubCard>

              <LnSubCard heading="Al momento de perderse">
                <LnField label="Accesorios que llevaba">
                  {({ id, describedBy }) => (
                    <LnInput
                      id={id}
                      name="enriched_accessories_when_lost"
                      type="text"
                      defaultValue={priorAccessoriesWhenLost ?? ""}
                      placeholder="Ej: collar rojo con placa, campera azul"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
                <LnField label="Comportamiento y temperamento">
                  {({ id, describedBy }) => (
                    <LnTextarea
                      id={id}
                      name="enriched_behavior_notes"
                      rows={2}
                      defaultValue={priorBehaviorNotes ?? ""}
                      placeholder="Ej: se asusta de los autos, responde a su nombre"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
                <LnField label="Contexto del último avistaje">
                  {({ id, describedBy }) => (
                    <LnTextarea
                      id={id}
                      name="enriched_last_seen_context"
                      rows={2}
                      defaultValue={priorLastSeenContext ?? ""}
                      placeholder="Ej: salió por la puerta cuando abrimos el portón"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
              </LnSubCard>

              <LnSubCard heading="Microchip (opcional)">
                <LnField
                  label="Número de microchip"
                  hint="Si te acordás que tiene chip pero nunca lo cargaste, ingresalo acá."
                >
                  {({ id, describedBy }) => (
                    <LnInput
                      id={id}
                      name="enriched_microchip_id"
                      type="text"
                      mono
                      placeholder="Ej: 982000411234567"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
              </LnSubCard>

              <LnSubCard heading="Tatuaje (opcional)">
                <LnField label="Código del tatuaje">
                  {({ id, describedBy }) => (
                    <LnInput
                      id={id}
                      name="enriched_tattoo_code"
                      type="text"
                      mono
                      placeholder="Ej: K9-2014-A"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
                <LnField label="Ubicación">
                  {({ id, describedBy, invalid }) => (
                    <LnSelect
                      id={id}
                      name="enriched_tattoo_location"
                      defaultValue=""
                      aria-describedby={describedBy}
                      invalid={invalid}
                    >
                      <option value="">Seleccionar</option>
                      {TATTOO_LOCATIONS.map((l) => (
                        <option key={l.value} value={l.value}>
                          {l.label}
                        </option>
                      ))}
                    </LnSelect>
                  )}
                </LnField>
                <LnField label="Descripción">
                  {({ id, describedBy }) => (
                    <LnTextarea
                      id={id}
                      name="enriched_tattoo_description"
                      rows={2}
                      placeholder="Ej: campaña de castración 2018"
                      aria-describedby={describedBy}
                    />
                  )}
                </LnField>
              </LnSubCard>
            </section>
          )}

          {/* Final step — affirmative disclosure consent. The owner actively
              picks what personal data the public credential shows while the
              pet is lost. PII toggles start OFF (opt-in, not opt-out). */}
          <section
            data-section="step-disclosure"
            className={step === disclosureStep ? "flex flex-col gap-3.5" : "sr-only"}
            aria-hidden={step !== disclosureStep}
            inert={step !== disclosureStep ? true : undefined}
          >
            <p className="text-sm text-[var(--color-ln-mute)]">
              Elegí qué información tuya se muestra en la credencial pública mientras {petName} esté
              perdida. No se comparte nada que no actives acá, y podés cambiarlo desde su perfil en
              cualquier momento.
            </p>

            <LnToggleGroup
              items={DISCLOSURE_ROWS.map((row) => ({
                key: row.key,
                label: row.label,
                description: row.description,
                checked: disclosurePrefs[row.key],
                variant: "amber" as const,
              }))}
              onChange={(key, next) => {
                setDisclosurePrefs((prev) => ({ ...prev, [key]: next }));
              }}
            />

            {!disclosurePrefs.disclose_phone_when_lost &&
              !disclosurePrefs.disclose_email_when_lost &&
              !disclosurePrefs.allow_finder_form_when_lost && (
                <LnCallout tone="warn" title="Nadie va a poder contactarte">
                  Sin teléfono, email ni formulario habilitados, quien encuentre a {petName} no
                  tiene forma de avisarte. Te recomendamos habilitar al menos el formulario: no
                  muestra ninguno de tus datos.
                </LnCallout>
              )}
          </section>

          {/* Hidden mirrors of the disclosure toggles. Always present so
              parseDisclosurePrefsFromForm detects the section and persists the
              explicit choices ("true"/"false" both parse via checkboxOn). */}
          {DISCLOSURE_ROWS.map((row) => (
            <input
              key={row.key}
              type="hidden"
              name={row.key}
              value={disclosurePrefs[row.key] ? "true" : "false"}
            />
          ))}

          {errorMessage && (
            <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
              {errorMessage}
            </p>
          )}
        </form>
      </LnSheetBody>

      {/* Footer — step navigation */}
      <div className="flex items-center gap-2.5 border-t border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] px-[18px] py-[13px]">
        {step > 1 && (
          <button
            type="button"
            onClick={goBack}
            className="inline-flex cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-3.5 py-2 text-md font-semibold text-[var(--color-ln-ink)] transition-colors hover:bg-[var(--color-ln-stripe)]"
          >
            ← Atrás
          </button>
        )}
        <div className="flex-1" />
        {!isLastStep ? (
          <button
            type="button"
            onClick={goNext}
            className="inline-flex cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border border-[var(--color-ln-warn)] bg-[var(--color-ln-warn)] px-4 py-[9px] text-md font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Continuar →
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            aria-busy={isPending || undefined}
            className="inline-flex cursor-pointer items-center justify-center gap-[7px] rounded-[var(--radius-pill)] border border-[var(--color-ln-seal)] bg-[var(--color-ln-seal)] px-4 py-[9px] text-md font-semibold text-white transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isPending ? (
              <>
                <span
                  aria-hidden="true"
                  className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                />
                Marcando...
              </>
            ) : (
              markLostActionLabel(petSex)
            )}
          </button>
        )}
      </div>
    </>
  );
}

/**
 * The text the success screen's "Compartir por WhatsApp" pre-fills (T1-L14).
 *
 * It said "{nombre} está perdida — ayudanos a encontrarla" to every animal: a
 * male dog's lost post went out feminine into every group chat it was shared
 * to. The adjective now comes from lostThirdPersonPhrase ("está perdido" /
 * "está perdida" / "se perdió" for an unknown sex), and the second clause is
 * pronoun-free so it needs no gender at all.
 */
export function lostShareText(petName: string, petSex: string | null | undefined): string {
  return `${petName} ${lostThirdPersonPhrase(petSex)} — ayudanos a que vuelva a casa. Su perfil público:`;
}
