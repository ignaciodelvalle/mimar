"use client";

// IntakeForm — 4-step wizard for org-side intake.
// Trilogy unification handoff §4 PR-030.
//
// Steps:
//   1. Microchip — quick chip lookup (optional). If chip matches a lost pet,
//      createIntakeAction redirects to the match flow on submit. If the user
//      has no chip number, they advance to step 2 with the field empty.
//   2. Identidad — name, species, sex, age, breed, color, distinguishing
//      features. CTA Continuar.
//   3. Estado del ingreso — reason, custody role, occurredAt, condition,
//      jurisdiction. CTA Continuar.
//   4. Confirmar — recap of what's about to land + Crear ingreso CTA.
//      On success → SuccessScreen "Mascota ingresada: [name]" with three
//      actions (Asignar tránsito, Publicar adopción, Ver ficha).
//
// State stays controlled at the wizard top — same pattern as
// FosterVolunteerWizard. Submit builds a FormData manually and posts it
// to createIntakeAction with noRedirect=1.

import { useState, useTransition } from "react";

import { type IntakeFormState, createIntakeAction } from "@/app/actions/intake";
import { LnRadio } from "@/components/ui/Field";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton, OpSelect } from "@/components/ui/dashboard";
import { breedsForSpecies } from "@/lib/reference/breeds";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { formatDate, speciesLabel, todayIsoInAr } from "@/lib/utils/format";

// "seizure" is intentionally absent: a decomiso is a State act (DC1),
// not something a refugio self-records through this form. Seizures go
// through the government decomiso flow (welfare.decomiso.execute).
const INTAKE_REASONS = [
  { value: "rescue", label: "Rescate" },
  { value: "surrender", label: "Entrega del dueño" },
  { value: "stray_found", label: "Animal en la vía pública" },
  { value: "other", label: "Otro" },
] as const;

const TOTAL_STEPS = 4;
const STEP_LABELS = ["Identificación", "Identidad", "Estado", "Confirmar"];

// min-h-[44px] is the field floor Field.tsx has enforced since Wave 2 and that
// OpField mirrors. Without it this recipe rendered at 38px — the longest form in
// the org portal, and the only one measurably below the floor while
// servicios/nuevo and mascotas/…/adoptar sat at 44px (adversarial review
// 2026-08-08, S3-F08).
//
// DEBT, stated plainly: the real fix is to route these 16 controls through
// OpField, the primitive db16c8a6 introduced precisely to kill hand-rolled
// operator input recipes — it migrated 92 and this form was left behind. Adding
// the floor here fixes the measured defect without pretending the recipe should
// exist. Tracked separately; do not treat this comment as approval to add a
// 94th recipe.
const inputCls =
  "w-full min-h-[44px] rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card px-3 py-2 text-md text-ln-op-ink focus:outline-none focus:ring-1 focus:ring-ln-op-azul";

/** Fields the action reads. Always sent, even when empty. */
const REQUIRED_KEYS = [
  "name",
  "species",
  "sex",
  "intakeReason",
  "custodyRole",
  "occurredAt",
] as const;

/** Fields the action treats as absent when empty — omitted rather than blanked. */
const OPTIONAL_KEYS = [
  "ageYears",
  "ageMonths",
  "breed",
  "estimatedWeightKg",
  "color",
  "distinguishingFeatures",
  "microchipId",
  "microchipCountryCode",
  "tattooCode",
  "intakeCondition",
  "rescueJurisdiction",
  "tattooAckToken",
] as const;

type IntakeFields = Record<
  (typeof REQUIRED_KEYS)[number] | (typeof OPTIONAL_KEYS)[number],
  string | undefined
> & { idempotencyKey: string };

/**
 * Translate the wizard's controlled state into the FormData shape
 * createIntakeAction expects. Extracted from submit() so the handler stays
 * under the cognitive-complexity fence once its step guard was added — the
 * twenty field-presence branches were all this function, none of them logic
 * the submit path needs to reason about.
 *
 * `tattooAckToken` rides along as an ordinary optional field: it threads the
 * ack from a previous server response so a re-submit skips the already
 * acknowledged advisory. (There is no chip-force token — an active-chip match
 * is a hard block, not a "continue anyway" warning.)
 */
function buildIntakeFormData(fields: IntakeFields): FormData {
  const fd = new FormData();
  for (const key of REQUIRED_KEYS) fd.set(key, fields[key] ?? "");
  for (const key of OPTIONAL_KEYS) {
    const value = fields[key];
    if (value) fd.set(key, value);
  }
  fd.set("noRedirect", "1");
  fd.set("clientIdempotencyKey", fields.idempotencyKey);
  return fd;
}

/**
 * Species-scoped breed CATALOG select — not free text (QA A4, 2026-08-13):
 * the server now rejects off-catalog breeds, so a free input here would only
 * manufacture rejections with no list to pick from. OpSelect (the sanctioned
 * primitive), not a raw <select> — the lint:select ratchet stays flat.
 * Extracted from IntakeForm to keep the wizard under the cognitive-complexity
 * fence (same reason buildIntakeFormData exists).
 */
function BreedSelectField({
  species,
  breed,
  onChange,
}: {
  species: string;
  breed: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1" htmlFor="intake-breed">
      <span className="text-md text-ln-op-ink">Raza</span>
      <OpSelect
        id="intake-breed"
        value={breed}
        onChange={(e) => onChange(e.target.value)}
        disabled={!species}
      >
        <option value="">{species ? "Sin especificar" : "Elegí la especie primero"}</option>
        {breedsForSpecies(species).map((b) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </OpSelect>
    </label>
  );
}

/**
 * Submit CTA label. Extracted for the same reason buildIntakeFormData and
 * BreedSelectField are: IntakeForm sits right at the cognitive-complexity
 * fence, and the wizard's submit path should not spend its budget on a
 * two-flag label. `navigating` shares the busy label with `pending` because
 * from the operator's side they are one wait — the request, then the document
 * load that follows it.
 */
function submitCtaLabel(pending: boolean, navigating: boolean): string {
  return pending || navigating ? "Registrando…" : "Crear ingreso";
}

export function IntakeForm({ orgToken }: { orgToken: string }) {
  const action = createIntakeAction.bind(null, orgToken);
  const [step, setStep] = useState(1);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<IntakeFormState>({ error: null });

  // Nav contract N3. The chip cross-check can answer "this animal is somebody's
  // lost pet" and send the operator to the match-confirmation page. The
  // use-case used to call redirect() itself, which the App Router drops
  // intermittently in production — on this branch that reads as pressing
  // "Crear ingreso" and watching nothing happen. It now REPORTS the
  // destination and the navigation is a full document load from here.
  //
  // `state` is the fire key: two consecutive submits can resolve to the same
  // match URL, and without it the effect would not re-fire on the second.
  const navigating = useActionRedirect(state.redirectTo, state);

  // Stable per-animal idempotency key: a double-tap on "Crear ingreso" (or a
  // retry after a network hiccup) re-sends the same key, so the server returns
  // the already-created pet instead of registering a duplicate. Reset when the
  // operator starts loading another animal.
  const { key: idempotencyKey, reset: resetIdempotencyKey } = useIdempotencyKey();

  // Controlled state for every field. Strings throughout; the action
  // does its own parsing and coercion.
  const today = todayIsoInAr();
  const [name, setName] = useState("");
  const [species, setSpecies] = useState("");
  const [sex, setSex] = useState<"unknown" | "male" | "female">("unknown");
  const [ageYears, setAgeYears] = useState("");
  const [ageMonths, setAgeMonths] = useState("");
  const [breed, setBreed] = useState("");
  const [estimatedWeightKg, setEstimatedWeightKg] = useState("");
  const [color, setColor] = useState("");
  const [distinguishingFeatures, setDistinguishingFeatures] = useState("");
  const [microchipId, setMicrochipId] = useState("");
  // 032 = ISO 3166 numeric code for Argentina. 858 (previously used here)
  // is Uruguay's code — a mislabel fixed in the QA nits sweep 2026-07.
  const [microchipCountryCode, setMicrochipCountryCode] = useState("032");
  const [tattooCode, setTattooCode] = useState("");
  const [intakeReason, setIntakeReason] = useState("");
  const [custodyRole, setCustodyRole] = useState<"shelter_custody" | "owner">("shelter_custody");
  const [occurredAt, setOccurredAt] = useState(today);
  const [intakeCondition, setIntakeCondition] = useState("");
  const [rescueJurisdiction, setRescueJurisdiction] = useState("");

  function submit() {
    // Step gate in the HANDLER, not only on the button. Inactive steps are
    // hidden with `inert`, which does block clicks — but it is one a11y
    // attribute standing alone: add a step and forget it, or run where `inert`
    // is unsupported, and the summary CTA becomes reachable from step 1, firing
    // an intake built from half-empty state. The commit that introduced `inert`
    // (c5994e62) was fixing WCAG 4.1.2, not defending this submit.
    if (step !== TOTAL_STEPS) return;
    setState({ error: null });
    const fd = buildIntakeFormData({
      name,
      species,
      sex,
      ageYears,
      ageMonths,
      breed,
      estimatedWeightKg,
      color,
      distinguishingFeatures,
      microchipId,
      microchipCountryCode,
      tattooCode,
      intakeReason,
      custodyRole,
      occurredAt,
      intakeCondition,
      rescueJurisdiction,
      idempotencyKey,
      tattooAckToken: state.tattooAckToken,
    });
    startTransition(async () => {
      const result = await action({ error: null }, fd);
      setState(result);
    });
  }

  function loadAnother() {
    // UX 3.6 (e): "Guardar y cargar otro" — preserve the batch-shared fields
    // (intake reason, custody role, date, jurisdiction, chip country) and clear
    // the per-animal fields, then return to step 1 for the next animal of the
    // same intake (e.g. a litter or a multi-animal rescue).
    setName("");
    setSpecies("");
    setSex("unknown");
    setAgeYears("");
    setAgeMonths("");
    setBreed("");
    setEstimatedWeightKg("");
    setColor("");
    setDistinguishingFeatures("");
    setMicrochipId("");
    setTattooCode("");
    setIntakeCondition("");
    setState({ error: null });
    // Next animal = a distinct intake — it must get its own idempotency key.
    resetIdempotencyKey();
    setStep(1);
  }

  if (state.ok && state.createdPetToken && state.createdPetName) {
    const orgRoot = `/org/${orgToken}`;
    return (
      <LnSuccessScreen
        title={`Mascota ingresada: ${state.createdPetName}`}
        code={state.createdPetToken}
        codeLabel="Credencial de la mascota"
        official
        description="Quedó registrada bajo custodia del refugio. Podés continuar el flujo desde acá."
        next={[
          {
            // Foster placement is initiated from the volunteer pool: ?pet=<token>
            // preselects this pet and match-scores volunteers for it, then each
            // row's "Proponer tránsito" sends the proposal (proposeFosterAction).
            label: "Asignar tránsito",
            href: `${orgRoot}/voluntarios?pet=${state.createdPetToken}`,
          },
          {
            // Batch intake: clears per-animal fields, keeps the shared ones.
            label: "Guardar y cargar otro",
            onClick: loadAnother,
            variant: "secondary",
          },
          {
            label: "Publicar adopción",
            href: `${orgRoot}/mascotas/${state.createdPetToken}/adoptar`,
            variant: "secondary",
          },
          {
            label: "Ver ficha",
            href: `${orgRoot}/mascotas/${state.createdPetToken}`,
            variant: "tertiary",
          },
        ]}
      />
    );
  }

  // Field-completeness only — step gating lives in `submit()`. A `step ===
  // TOTAL_STEPS` term here would be invisible in a browser (the CTA is inside
  // an `inert` section until step 4 anyway) while masking the handler guard
  // from tests: a disabled button never dispatches a click, so the assertion
  // "a premature click submits nothing" would pass with the guard deleted.
  // `navigating` never comes back down: window.location.assign() returns
  // immediately, so without it the CTA re-enables over the old page while the
  // document is already leaving, and an impatient second tap fires a second
  // intake (lib/ui/use-action-redirect.ts X1-F1).
  const canSubmit =
    !!name && !!species && !!intakeReason && !!occurredAt && !pending && !navigating;

  return (
    <LnWizardShell
      currentStep={step}
      totalSteps={TOTAL_STEPS}
      stepLabels={STEP_LABELS}
      onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
    >
      {/* Step 1 — Identificación */}
      <section
        className={step === 1 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 1}
        inert={step !== 1 ? true : undefined}
      >
        <p className="text-md text-ln-op-ink-2">
          Si la mascota tiene microchip o tatuaje, ingrésalos. Si el chip coincide con una mascota
          perdida en miMAR, vamos a redirigirte al flujo de match para confirmar la identidad.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">Número de microchip</span>
            <input
              type="text"
              value={microchipId}
              onChange={(e) => setMicrochipId(e.target.value)}
              maxLength={20}
              placeholder="985141004321456"
              className={inputCls}
            />
          </label>
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">País del chip</span>
            <input
              type="text"
              value={microchipCountryCode}
              onChange={(e) => setMicrochipCountryCode(e.target.value)}
              maxLength={3}
              className={inputCls}
            />
          </label>
        </div>
        <label className="block space-y-1">
          <span className="text-md text-ln-op-ink">Código de tatuaje</span>
          <input
            type="text"
            value={tattooCode}
            onChange={(e) => setTattooCode(e.target.value)}
            maxLength={60}
            placeholder="Ej: K9-2014, A1B2"
            className={inputCls}
          />
          <span className="text-sm text-ln-op-mute">
            Opcional. Se verificará contra registros existentes antes de guardar.
          </span>
        </label>
        <OpButton type="button" onClick={() => setStep(2)} block>
          {microchipId ? "Continuar (chequearemos el chip al confirmar)" : "Continuar sin chip"}
        </OpButton>
      </section>

      {/* Step 2 — Identidad */}
      <section
        className={step === 2 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 2}
        inert={step !== 2 ? true : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">Nombre o alias temporal *</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              className={inputCls}
              placeholder="Ej: Negrita, Sin nombre, Marrón #4"
            />
          </label>
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">Especie *</span>
            <select
              value={species}
              onChange={(e) => {
                setSpecies(e.target.value);
                // The breed catalog is species-scoped — a lingering dog breed
                // under "cat" would bounce server-side (QA A4 catalog gate).
                setBreed("");
              }}
              required
              className={inputCls}
            >
              <option value="" disabled>
                Seleccionar
              </option>
              <option value="dog">Perro</option>
              <option value="cat">Gato</option>
              <option value="other">Otra</option>
            </select>
          </label>
        </div>

        <fieldset className="space-y-1">
          <legend className="text-md text-ln-op-ink">Sexo</legend>
          <div className="flex flex-wrap gap-3 text-md">
            {/* LnRadio, not a raw input: the bare control renders at the
                browser default (~13px) while "Rol de la organización" below
                uses LnRadio at 16px — two radio sizes in one form
                (adversarial review 2026-08-08, S3-F08). */}
            {(["unknown", "male", "female"] as const).map((v) => (
              <LnRadio key={v} name="sex" value={v} checked={sex === v} onChange={() => setSex(v)}>
                {v === "unknown" ? "Desconocido" : v === "male" ? "Macho" : "Hembra"}
              </LnRadio>
            ))}
          </div>
        </fieldset>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">Edad — años</span>
            <input
              type="number"
              min={0}
              max={40}
              value={ageYears}
              onChange={(e) => setAgeYears(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">Edad — meses</span>
            <input
              type="number"
              min={0}
              max={11}
              value={ageMonths}
              onChange={(e) => setAgeMonths(e.target.value)}
              className={inputCls}
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <BreedSelectField species={species} breed={breed} onChange={setBreed} />
          <label className="space-y-1">
            <span className="text-md text-ln-op-ink">Color / pelaje</span>
            <input
              type="text"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              maxLength={120}
              className={inputCls}
            />
          </label>
        </div>

        <label className="block space-y-1 sm:w-1/2">
          <span className="text-md text-ln-op-ink">Peso estimado (kg)</span>
          <input
            type="number"
            step="0.1"
            min="0"
            value={estimatedWeightKg}
            onChange={(e) => setEstimatedWeightKg(e.target.value)}
            placeholder="Ej: 24.5"
            className={inputCls}
          />
          <span className="text-sm text-ln-op-mute">
            Ayuda a evaluar razas potencialmente peligrosas (PPP) por peso.
          </span>
        </label>

        <label className="block space-y-1">
          <span className="text-md text-ln-op-ink">Señas particulares</span>
          <textarea
            value={distinguishingFeatures}
            onChange={(e) => setDistinguishingFeatures(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Cicatrices, manchas, oreja cortada, etc."
            className={inputCls}
          />
        </label>

        <OpButton type="button" onClick={() => setStep(3)} disabled={!name || !species} block>
          Continuar
        </OpButton>
      </section>

      {/* Step 3 — Estado */}
      <section
        className={step === 3 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 3}
        inert={step !== 3 ? true : undefined}
      >
        <fieldset className="space-y-1">
          <legend className="text-md text-ln-op-ink">Motivo del ingreso *</legend>
          <div className="flex flex-col gap-1 text-md">
            {INTAKE_REASONS.map((r) => (
              <LnRadio
                key={r.value}
                name="intakeReason"
                value={r.value}
                checked={intakeReason === r.value}
                onChange={() => setIntakeReason(r.value)}
              >
                {r.label}
              </LnRadio>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="text-md text-ln-op-ink">Rol de la organización</legend>
          <div className="flex flex-col gap-2">
            <LnRadio
              name="custodyRole"
              value="shelter_custody"
              checked={custodyRole === "shelter_custody"}
              onChange={() => setCustodyRole("shelter_custody")}
            >
              <span className="space-y-0.5">
                <span className="block font-medium">Custodia temporal</span>
                <span className="block text-sm! text-ln-op-mute!">
                  El animal queda bajo cuidado del refugio hasta que se concrete una adopción.
                </span>
              </span>
            </LnRadio>
            <LnRadio
              name="custodyRole"
              value="owner"
              checked={custodyRole === "owner"}
              onChange={() => setCustodyRole("owner")}
            >
              <span className="space-y-0.5">
                <span className="block font-medium">Dueño/a permanente</span>
                <span className="block text-sm! text-ln-op-mute!">
                  El animal queda registrado a nombre de la organización (santuario, adopción
                  institucional).
                </span>
              </span>
            </LnRadio>
          </div>
        </fieldset>

        <label className="block space-y-1">
          <span className="text-md text-ln-op-ink">Fecha del ingreso</span>
          <input
            type="date"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value)}
            className={`${inputCls} sm:w-auto`}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-md text-ln-op-ink">Condición al ingreso</span>
          <textarea
            value={intakeCondition}
            onChange={(e) => setIntakeCondition(e.target.value)}
            rows={3}
            maxLength={500}
            placeholder="Estado nutricional, lesiones, enfermedades aparentes…"
            className={inputCls}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-md text-ln-op-ink">Jurisdicción / lugar de rescate</span>
          <input
            type="text"
            value={rescueJurisdiction}
            onChange={(e) => setRescueJurisdiction(e.target.value)}
            maxLength={200}
            placeholder="Ej: Mataderos, CABA"
            className={inputCls}
          />
        </label>

        <OpButton type="button" onClick={() => setStep(4)} disabled={!intakeReason} block>
          Continuar
        </OpButton>
      </section>

      {/* Step 4 — Confirmar */}
      <section
        className={step === 4 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 4}
        inert={step !== 4 ? true : undefined}
      >
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe p-4 space-y-2">
          <p className="text-md font-semibold text-ln-op-ink">Resumen del ingreso</p>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
            <dt className="text-ln-op-mute">Nombre</dt>
            <dd className="col-span-2 text-ln-op-ink">{name || "—"}</dd>
            <dt className="text-ln-op-mute">Especie</dt>
            <dd className="col-span-2 text-ln-op-ink">{species ? speciesLabel(species) : "—"}</dd>
            <dt className="text-ln-op-mute">Peso</dt>
            <dd className="col-span-2 text-ln-op-ink">
              {estimatedWeightKg ? `${estimatedWeightKg} kg` : "—"}
            </dd>
            <dt className="text-ln-op-mute">Microchip</dt>
            <dd className="col-span-2 font-ln-mono text-ln-op-ink">
              {microchipId || "(sin chip)"}
            </dd>
            <dt className="text-ln-op-mute">Tatuaje</dt>
            <dd className="col-span-2 font-ln-mono text-ln-op-ink">
              {tattooCode || "(sin tatuaje)"}
            </dd>
            <dt className="text-ln-op-mute">Motivo</dt>
            <dd className="col-span-2 text-ln-op-ink">
              {INTAKE_REASONS.find((r) => r.value === intakeReason)?.label ?? "—"}
            </dd>
            <dt className="text-ln-op-mute">Rol</dt>
            <dd className="col-span-2 text-ln-op-ink">
              {custodyRole === "shelter_custody" ? "Custodia temporal" : "Dueño/a permanente"}
            </dd>
            <dt className="text-ln-op-mute">Fecha</dt>
            {/* Anchor the bare YYYY-MM-DD at local noon before formatting so the
                AR-timezone formatter renders the picked day, not the day before. */}
            <dd className="col-span-2 text-ln-op-ink">
              {occurredAt ? formatDate(`${occurredAt}T12:00:00`) : "—"}
            </dd>
          </dl>
        </div>

        {state.warning === "TATTOO_MATCH_POSSIBLE" && state.matchedPetToken && (
          <div className="rounded-[var(--radius-md)] border border-ln-op-warn bg-ln-op-warn/10 p-3 text-sm text-ln-op-ink-2 space-y-2">
            <p>
              <strong>Posible coincidencia por tatuaje.</strong> El código que ingresaste coincide
              con una mascota ya registrada en miMAR. Verificá con la foto antes de continuar.
            </p>
            <p>
              <a
                href={`/p/${state.matchedPetToken}`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline font-medium text-ln-op-azul"
              >
                Ver credencial pública de la mascota coincidente
              </a>
            </p>
            <p className="text-ln-op-mute">
              Si confirmás que son animales distintos, hacé clic en &ldquo;Crear ingreso&rdquo; para
              continuar.
            </p>
          </div>
        )}

        {state.error && (
          <p className="rounded-[var(--radius-md)] border border-ln-op-danger bg-ln-op-danger/10 px-3 py-2 text-md text-ln-op-danger">
            {state.error}
          </p>
        )}

        <OpButton type="button" onClick={submit} disabled={!canSubmit} block>
          {submitCtaLabel(pending, navigating)}
        </OpButton>
      </section>
    </LnWizardShell>
  );
}
