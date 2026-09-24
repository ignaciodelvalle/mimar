"use client";

// Owner pet alta — 2-step client wizard (PO decision 2026-07-08).
//
// Motivation: in the old single-screen "minimal" alta, foto and raza were
// buried ~5 clicks deep (only reachable later via the profile edit), so owners
// never loaded them. New shape brings both forward:
//
//   Paso 1 — Identidad : nombre, especie, raza, sexo, provincia → localidad.
//                        PPP notice fires live the moment a dog breed on the
//                        canonical PPP list is picked.
//   Paso 2 — Foto y más: foto prominently (camera OR gallery), then a
//                        "Más datos (opcional)" block (color / señas). Fully
//                        skippable — finishing without a foto is fine.
//
// Atomicity: this stays ONE <form action> that submits ONCE. Both steps are
// kept MOUNTED (toggled with the `hidden` attribute), never conditionally
// unmounted, for three reasons:
//   1. every field — including paso-1 fields — is present in the FormData at
//      the single final submit (no half-created pet, no create-then-attach;
//      the photo is uploaded inside createPetAction from the `photo` field);
//   2. entered values survive back-navigation between steps;
//   3. every field survives the React 19 post-action reset: text/textarea
//      fields via plain useState control, `breed`/`acquisitionMethod`/the
//      "otra especie" select via `useKeptFields`'s defaultValue+key remount,
//      and the `sex` radios via `useKeptFields`'s defaultChecked (a
//      CONTROLLED select or radio resets anyway — see
//      __tests__/react19-form-reset-contract.test.tsx — a mistake this file
//      itself made until 2026-09-22, this comment included).

import Link from "next/link";
import {
  type FormEvent,
  type KeyboardEvent,
  useActionState,
  useEffect,
  useRef,
  useState,
} from "react";

import { CustodyKindToggle } from "@/components/CustodyKindToggle";
import { Icon } from "@/components/Icon";
import { LocationFields } from "@/components/LocationFields";
import { LnButton } from "@/components/ui/Button";
import { LnCallout } from "@/components/ui/DocElements";
import { LnField, LnInput, LnRadio, LnSelect } from "@/components/ui/Field";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { breedsForSpecies, isPotentiallyDangerousBreed } from "@/lib/reference/breeds";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import { speciesLabel, speciesOptions } from "@/lib/utils/format";
import { speciesInProse } from "@/lib/utils/species";
import type { NewPetFormState } from "@/src/modules/pets/actions";

// TERCER mapa de especies que vivía en este archivo — en minúsculas, para la
// confirmación de dedupe (gate P2). El fence no lo veía: sus etiquetas están
// capitalizadas y sus regex eran sensibles a mayúsculas, así que el baseline
// quedó en CERO mientras éste seguía vivo, desdoblando "perro/a" justo después
// de que el selector de arriba dejara de hacerlo. Ahora sale de speciesInProse.

const SEX_LABEL: Record<string, string> = {
  female: "hembra",
  male: "macho",
  unknown: "sexo sin especificar",
};

const initialState: NewPetFormState = { error: null };

type FormAction = (prev: NewPetFormState, formData: FormData) => Promise<NewPetFormState>;

// Species values accepted by parsePetForm.
// "dog" and "cat" map directly; for the "other" branch the sub-select
// value IS the stored species (rabbit, guinea_pig, ferret, other).
// Decisión del PO (2026-08-09): sin desdoblamiento y sin variante regional.
// "Conejo/a" y "Perro/a" desdoblaban en un selector de ESPECIE, que es un error
// de categoría —ahí no se habla de personas, y el sexo del animal tiene su
// propio campo— y "Cobayo / Cuy" duplicaba el término que ya usa SENASA.
// La ortografía sale de speciesLabel, la única fuente.
const OTHER_SPECIES = speciesOptions(["rabbit", "guinea_pig", "ferret", "other"]);

type SpeciesPick = "dog" | "cat" | "other" | null;

const TOTAL_STEPS = 2;

// ---------------------------------------------------------------------------
// MinimalNewPetForm
// ---------------------------------------------------------------------------

export function MinimalNewPetForm({
  action,
  isFirstPet = false,
  chipConflict,
}: {
  action: FormAction;
  isFirstPet?: boolean;
  /**
   * Adjudication receipt carried back from the vecino chip-match card after
   * the finder answered "No es la misma" (RA-2 F6). Pre-fills the disputed
   * code and posts the signed force token, so createPetAction registers the
   * animal without that code instead of running the same cross-check and
   * bouncing the finder to the match page again — the closed loop that made
   * the product's central use case impossible to complete.
   */
  chipConflict?: { microchipId: string; forceToken: string };
}) {
  // PO bug 2026-07-18, "se salta la foto" second cause: React 19 resets
  // uncontrolled fields after EVERY action return — the photo <input
  // type=file> included — while the preview (React state) kept showing the
  // picked image. A resubmission after any server round-trip (duplicate
  // prompt, error) therefore posted an EMPTY photo and the pet was created
  // without it. File inputs can't be controlled, so the picked File lives
  // HERE as the reset-safe source of truth (the same posture as the
  // controlled text fields) and the action wrapper below re-attaches it
  // whenever the reset emptied the posted entry. The ONE-form/ONE-submit
  // design is untouched — the single final FormData just stays whole.
  const [photoFile, setPhotoFile] = useState<File | null>(null);

  // The header comment above claimed the form was reset-safe because "text
  // fields are also controlled via useState" — true, and incomplete. Per
  // __tests__/react19-form-reset-contract.test.tsx a CONTROLLED select or
  // radio (value/checked + onChange) is reset ANYWAY: react-dom only writes
  // defaultSelected/defaultChecked on mount, so `breed`, `acquisitionMethod`,
  // the "otra especie" sub-select and the `sex` radios all lost their pick on
  // a rejected submit despite being controlled. `useKeptFields` fixes it.
  const { boundAction, kept, keptChecked } = useKeptFields<NewPetFormState>(action);
  const [state, formAction, isPending] = useActionState(
    (prev: NewPetFormState, formData: FormData) => {
      const posted = formData.get("photo");
      if (photoFile && (!(posted instanceof File) || posted.size === 0)) {
        formData.set("photo", photoFile);
      }
      return boundAction(prev, formData);
    },
    initialState,
  );
  // `navigating` outlives the action: assign() does not block, so a button
  // gated on isPending alone comes back to life over the old page while the
  // credential screen is still in flight (X1-F1).
  const navigating = useActionRedirect(state.redirectTo, state);
  const busy = isPending || navigating;

  const formRef = useRef<HTMLFormElement>(null);

  // Double-submit idempotency (gate P1): a stable UUID per form mount, posted
  // as a hidden field. A network retry / bounce re-submits the SAME key, so the
  // server resolves to the already-created pet instead of minting a duplicate.
  const { key: idempotencyKey } = useIdempotencyKey();

  const [step, setStep] = useState<1 | 2>(1);
  const [clientError, setClientError] = useState<string | null>(null);

  // Soft same-owner dedupe (gate P2). When the owner confirms "no, es otra", we
  // resubmit with duplicateOverride=1 to skip the P2 check (but NOT P1). The
  // effect fires the resubmit only after the hidden input has re-rendered to "1".
  const [overrideDuplicate, setOverrideDuplicate] = useState(false);
  const resubmitAfterOverride = useRef(false);

  useEffect(() => {
    if (overrideDuplicate && resubmitAfterOverride.current) {
      resubmitAfterOverride.current = false;
      formRef.current?.requestSubmit();
    }
  }, [overrideDuplicate]);

  function createAnyway() {
    resubmitAfterOverride.current = true;
    setOverrideDuplicate(true);
  }

  // PO bug 2026-07-18: the duplicatePrompt lives in SERVER state, which never
  // clears on client edits. After Volver + changing the identity, the stale
  // banner kept hiding the normal submit, leaving "crear igual" as the only
  // affirmative action — an IMMEDIATE submit that skipped the P2 re-check for
  // an identity the server never evaluated. Editing any P2-relevant field
  // (name / species / sex) marks the prompt STALE: a stale prompt stops
  // rendering and stops gating, and the fresh submit re-runs the cheap,
  // authoritative server-side P2 check (a changed identity that still collides
  // re-prompts with fresh data). Staleness resets whenever a NEW prompt
  // arrives — the effect is keyed on the action-state identity because every
  // action return builds a fresh state object.
  const [duplicatePromptStale, setDuplicatePromptStale] = useState(false);

  useEffect(() => {
    if (state.duplicatePrompt) setDuplicatePromptStale(false);
  }, [state]);

  function markIdentityEdited() {
    if (state.duplicatePrompt) setDuplicatePromptStale(true);
  }

  const duplicatePrompt =
    !overrideDuplicate && !duplicatePromptStale ? state.duplicatePrompt : undefined;

  // Controlled field state — survives the React 19 form-reset on a server-error
  // return and preserves values across step back-navigation.
  const [name, setName] = useState("");
  const [speciesPick, setSpeciesPick] = useState<SpeciesPick>(null);
  const [otherSpecies, setOtherSpecies] = useState("");
  const [sex, setSex] = useState<"female" | "male" | "unknown">("unknown");
  const [breed, setBreed] = useState("");
  const [color, setColor] = useState("");
  // Custody kind (P1 fix, 2026-07-19 audit): defaults to "owner" — parsePetForm
  // does the same when the field is absent — so this restore is additive and
  // never changes behavior for an owner who doesn't touch the toggle.
  const [custodyKind, setCustodyKind] = useState<"owner" | "foster_in_transit">("owner");
  // Acquisition method (V8 fix): optional, left blank/null unless picked — the
  // alta must stay just as easy to complete as before this field existed.
  // A chip-conflict return arrives from the "encontré una mascota" path by
  // definition, so pre-select it (RA-2 F6).
  const [acquisitionMethod, setAcquisitionMethod] = useState(chipConflict ? "found_stray" : "");

  // Everything the chip cross-check needs — the field itself and both escape
  // hatches — lives in one hook (RA-2 F6). See useChipConflict below.
  const { microchipId, setMicrochipId, postedForceToken, chipMatchActive, registerWithoutChip } =
    useChipConflict({ chipConflict, state, formRef });

  // Resolved species string as parsePetForm expects it.
  const species = speciesPick === "other" ? otherSpecies : (speciesPick ?? "");
  const breedOptions = breedsForSpecies(species);

  // PPP notice — reacts live to breed/species. Uses the canonical country-wide
  // PPP list (lib/reference/breeds.ts). Display-only; the server-side
  // jurisdiction-aware classification at submit time stays authoritative.
  const breedIsDangerous = isPotentiallyDangerousBreed(species, breed);

  function localityResolved(): boolean {
    const form = formRef.current;
    if (!form) return false;
    // Read via FormData exactly as the server does. A genuinely picked
    // ar_localities row (LocalityPickerAcross) writes BOTH the localityName AND
    // its provinceCode into hidden inputs; free-typed text writes only the raw
    // localityName and leaves provinceCode empty. provinceCode is therefore the
    // SAME "was it resolved?" signal the server uses to reject with
    // LOCALITY_UNRESOLVED — gating step 1 on localityName alone let a hand-typed
    // "Palermo" advance past paso 1 and only fail at submit (Cowork B9).
    const data = new FormData(form);
    const localityName = String(data.get("localityName") ?? "").trim();
    const provinceCode = String(data.get("provinceCode") ?? "").trim();
    return localityName.length > 0 && provinceCode.length > 0;
  }

  // Paso 1 required-field guard. Advancing is blocked until nombre + especie +
  // localidad (a resolved ar_localities pick) are present. Sexo defaults to
  // "unknown" and raza is optional, mirroring the rest of the app.
  function goToStep2() {
    if (!name.trim()) {
      setClientError("Escribí el nombre de tu mascota.");
      return;
    }
    if (!species) {
      setClientError("Elegí la especie antes de continuar.");
      return;
    }
    if (!localityResolved()) {
      setClientError("Elegí la localidad/barrio de la lista de sugerencias.");
      return;
    }
    setClientError(null);
    setStep(2);
  }

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    // Defensive: the paso-1 fields live in a hidden block on paso 2, so revalidate
    // and bounce back to paso 1 if anything required is missing.
    if (!name.trim() || !species || !localityResolved()) {
      e.preventDefault();
      setStep(1);
      setClientError("Completá los datos de identidad antes de crear la mascota.");
      return;
    }
    setClientError(null);
  }

  // Paso 1 has no submit button, so Enter must never fall through to an
  // implicit form submission (nor dead-end): route it to the same guard as
  // the "Continuar" button. Skips events a child already consumed (the
  // locality LnCombobox preventDefaults Enter to pick the active option).
  function handleFormKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key !== "Enter" || step !== 1 || e.defaultPrevented) return;
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      e.preventDefault();
      goToStep2();
    }
  }

  const errorText = clientError ?? state?.error ?? null;

  return (
    <form ref={formRef} action={formAction} onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
      {/* Data-quality gates: stable idempotency key (P1) + soft-dedupe override (P2). */}
      <input type="hidden" name="clientIdempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="duplicateOverride" value={overrideDuplicate ? "1" : "0"} />
      {/* Chip-conflict adjudication receipt (RA-2 F6) — see chipConflict prop. */}
      {postedForceToken && <input type="hidden" name="forceToken" value={postedForceToken} />}
      <LnWizardShell
        currentStep={step}
        totalSteps={TOTAL_STEPS}
        stepLabels={["Identidad", "Foto y más"]}
        onBack={step > 1 ? () => setStep(1) : undefined}
      >
        {/* ── Header ─────────────────────────────────────────────────── */}
        <div className="mb-6">
          <h1 className="m-0 font-ln-serif text-2xl font-semibold leading-tight tracking-[-0.02em] text-[var(--color-ln-ink)]">
            {isFirstPet ? "Registrar tu primera mascota" : "Registrar mascota"}
          </h1>
          <p className="mt-1 text-md text-[var(--color-ln-mute)]">
            {step === 1
              ? "Empezamos por lo que la identifica."
              : "Sumá una foto y algún dato más. Podés hacerlo ahora o más tarde."}
          </p>
        </div>

        {/* ── Paso 1 — Identidad ─────────────────────────────────────── */}
        <div hidden={step !== 1} className="flex flex-col gap-5">
          {/* Custody kind — "es mi mascota" vs "la estoy cuidando" (vecino en
              tránsito / foster). Defaults to owner; restores the foster path
              that the alta previously had no way to reach. */}
          <CustodyKindToggle value={custodyKind} onChange={setCustodyKind} />

          {/* Name */}
          <LnField label="Nombre" required>
            {({ id, describedBy, invalid }) => (
              <LnInput
                id={id}
                name="name"
                type="text"
                required
                placeholder="Luna, Milo, Chicho…"
                aria-describedby={describedBy}
                invalid={invalid}
                autoComplete="off"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  markIdentityEdited();
                }}
              />
            )}
          </LnField>

          {/* Species */}
          <SpeciesField
            picked={speciesPick}
            otherSpecies={otherSpecies}
            kept={kept}
            onPick={(p) => {
              setSpeciesPick(p);
              setBreed("");
              markIdentityEdited();
            }}
            onOtherSpeciesChange={(v) => {
              setOtherSpecies(v);
              setBreed("");
              markIdentityEdited();
            }}
          />

          {/* Breed — optional, species-dependent CATALOG select (QA A4,
              2026-08-13). This was an <input list="breed-options">, i.e. a
              datalist: it suggests catalog entries but accepts ANY text, and
              "Raza-Falsa-CW0813" reached the database through it. Same
              catalog-not-free-text conversion PetForm.tsx (edición) got on
              2026-08-13 — the server now rejects off-catalog breeds, so a
              permissive control here would only manufacture rejections. */}
          <LnField
            label="Raza"
            hint={
              speciesPick === "dog"
                ? "En perros, la raza (y el peso) definen si entra en el régimen PPP."
                : undefined
            }
          >
            {({ id, describedBy }) => (
              <LnSelect
                key={`breed-${kept("breed")}`}
                id={id}
                name="breed"
                defaultValue={kept("breed") || breed}
                onChange={(e) => setBreed(e.target.value)}
                disabled={!species}
                aria-describedby={describedBy}
              >
                <option value="">{species ? "Elegí una raza…" : "Elegí la especie primero"}</option>
                {breedOptions.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </LnSelect>
            )}
          </LnField>

          {/* PPP notice — appears/disappears live with the breed selection. */}
          {breedIsDangerous && (
            <LnCallout tone="warn" title="Raza potencialmente peligrosa">
              Esta raza está en el registro de razas potencialmente peligrosas (CABA: Ley 4078 ·
              PBA: Ley 14.107). Registrate en el registro provincial correspondiente.
            </LnCallout>
          )}

          {/* Sex */}
          <div className="flex flex-col gap-1.5">
            <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
              Sexo
            </p>
            <div className="flex flex-col gap-1.5">
              <LnRadio
                name="sex"
                value="female"
                defaultChecked={keptChecked("sex", sex === "female", "female")}
                onChange={() => {
                  setSex("female");
                  markIdentityEdited();
                }}
              >
                Hembra
              </LnRadio>
              <LnRadio
                name="sex"
                value="male"
                defaultChecked={keptChecked("sex", sex === "male", "male")}
                onChange={() => {
                  setSex("male");
                  markIdentityEdited();
                }}
              >
                Macho
              </LnRadio>
              <LnRadio
                name="sex"
                value="unknown"
                defaultChecked={keptChecked("sex", sex === "unknown", "unknown")}
                onChange={() => {
                  setSex("unknown");
                  markIdentityEdited();
                }}
              >
                No sé
              </LnRadio>
            </div>
          </div>

          {/* Location — REQUIRED. Province-first cascade (commit 38fb1f44). */}
          <div className="flex flex-col gap-1.5">
            <LocationFields mode="l1" required cascade />
            <p className="font-ln-mono text-sm text-[var(--color-ln-mute)]">
              Requerido. Ayuda a las campañas regionales de salud animal.
            </p>
          </div>
        </div>

        {/* ── Paso 2 — Foto y más ────────────────────────────────────── */}
        <div hidden={step !== 2} className="flex flex-col gap-5">
          {/* Chip-conflict return (RA-2 F6): say plainly what is about to
              happen, so "registrar igual" is not a leap of faith. */}
          {chipConflict && (
            <LnCallout tone="azul" title="Seguimos con el registro">
              Confirmaste que no es la misma mascota. Ese número de chip ya figura asignado a otro
              animal, así que vamos a registrarla <strong>sin el chip</strong>. Una vez creada la
              ficha vas a poder cargar el número correcto.
            </LnCallout>
          )}

          <PhotoField file={photoFile} onFileChange={setPhotoFile} />

          <MoreDetailsFields
            color={color}
            onColorChange={setColor}
            microchipId={microchipId}
            onMicrochipIdChange={setMicrochipId}
            microchipReadOnly={chipConflict !== undefined}
            kept={kept}
            acquisitionMethod={acquisitionMethod}
            onAcquisitionMethodChange={setAcquisitionMethod}
          />
        </div>

        {/* ── Error ──────────────────────────────────────────────────── */}
        {errorText && (
          <p className="mt-4 font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
            {errorText}
          </p>
        )}

        {/* ── Soft same-owner dedupe confirm (gate P2) ───────────────── */}
        {step === 2 && duplicatePrompt && (
          <DuplicateOwnerPrompt prompt={duplicatePrompt} onCreateAnyway={createAnyway} />
        )}

        {/* ── Chip matches an ACTIVE pet (RA-2 F6) ───────────────────── */}
        {step === 2 && chipMatchActive && (
          <ChipMatchActivePrompt
            matchedPetToken={state.matchedPetToken}
            onRegisterWithoutChip={registerWithoutChip}
          />
        )}

        {/* ── Footer actions ─────────────────────────────────────────── */}
        {/* PO bug 2026-08-11, "el paso de la foto se pasa volando": ONE click on
            "Continuar" created the pet and jumped straight to the credencial —
            paso 2 never rendered, so no owner could ever attach a photo during
            the alta.

            Cause: both footer buttons occupied the SAME slot with no `key`, so
            React reconciled them as one <button> and merely PATCHED `type` from
            "button" to "submit". A click's activation behaviour runs AFTER the
            listeners, and by then React had already flipped the very node being
            activated into a submit button — so the browser submitted the form.
            Note this reproduces ONLY in a real browser: jsdom/RTL flush on a
            different tick and report the flow as healthy (verified 2026-08-11).

            Two independent guards, because one silent regression here costs the
            photo on every pet created: distinct `key`s so React builds a FRESH
            node per step instead of mutating the clicked one, and an explicit
            preventDefault so a cancelled click has no activation behaviour to
            run even if the keys are ever dropped. */}
        <div className="mt-6">
          {step === 1 ? (
            <button
              key="wizard-continue"
              type="button"
              onClick={(e) => {
                e.preventDefault();
                goToStep2();
              }}
              className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] px-4 py-2.5 text-md font-semibold text-white transition-colors hover:border-[var(--color-ln-azul-700)] hover:bg-[var(--color-ln-azul-700)]"
            >
              Continuar
            </button>
          ) : duplicatePrompt || chipMatchActive ? null : (
            <button
              key="wizard-submit"
              type="submit"
              disabled={busy}
              className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] px-4 py-2.5 text-md font-semibold text-white transition-colors hover:border-[var(--color-ln-azul-700)] hover:bg-[var(--color-ln-azul-700)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (
                <>
                  <span
                    aria-hidden="true"
                    className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
                  />
                  Guardando...
                </>
              ) : (
                // The same screen's H1 says "Registrar mascota" (D.8): a
                // submit button that renames the act mid-form makes a user
                // wonder whether it does the same thing.
                "Registrar mascota"
              )}
            </button>
          )}
        </div>
      </LnWizardShell>
    </form>
  );
}

// ---------------------------------------------------------------------------
// DuplicateOwnerPrompt — soft same-owner dedupe confirm (gate P2).
//
// Extracted verbatim from MinimalNewPetForm alongside ChipMatchActivePrompt
// below: the two are the same shape (a callout offering "open the existing
// record" or "no, it's another — continue"), and pulling both out keeps the
// form function under the complexity fence.
// ---------------------------------------------------------------------------

function DuplicateOwnerPrompt({
  prompt,
  onCreateAnyway,
}: {
  prompt: NonNullable<NewPetFormState["duplicatePrompt"]>;
  onCreateAnyway: () => void;
}) {
  return (
    <div className="mt-4" role="alert">
      <LnCallout tone="azul" title="¿Es la misma mascota?">
        <p className="m-0">
          Ya tenés registrada a <strong>{prompt.name}</strong> ({speciesInProse(prompt.species)},{" "}
          {SEX_LABEL[prompt.sex] ?? prompt.sex}). ¿Es la misma?
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <Link
            href={`/mis-mascotas/${prompt.publicToken}`}
            className="inline-flex w-full items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] px-4 py-2.5 text-md font-semibold text-white no-underline transition-colors hover:border-[var(--color-ln-azul-700)] hover:bg-[var(--color-ln-azul-700)]"
          >
            Ver a {prompt.name}
          </Link>
          <button
            type="button"
            onClick={onCreateAnyway}
            className="inline-flex w-full cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] px-4 py-2.5 text-md font-semibold text-[var(--color-ln-ink-2)] transition-colors hover:border-[var(--color-ln-azul)] hover:bg-[var(--color-ln-celeste-050)]"
          >
            No, es otra — crear igual
          </button>
        </div>
      </LnCallout>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useChipConflict — the microchip field and both of its escape hatches (RA-2 F6)
//
// One hook because the three concerns are one concern: the chip the alta posts,
// the receipt that says a conflict on it was already adjudicated, and the two
// ways an actor can obtain that receipt —
//
//   1. carried in from the vecino match card ("No es la misma" on a LOST match);
//   2. minted inline by createPetAction when the chip matches an ACTIVE pet.
//
// Both resolve to the same posted `forceToken`, which createPetAction reads as
// "register this animal WITHOUT the disputed code". Kept out of the form
// function so the component stays under the complexity fence.
// ---------------------------------------------------------------------------

function useChipConflict({
  chipConflict,
  state,
  formRef,
}: {
  chipConflict?: { microchipId: string; forceToken: string };
  state: NewPetFormState;
  formRef: React.RefObject<HTMLFormElement | null>;
}) {
  const [microchipId, setMicrochipId] = useState(chipConflict?.microchipId ?? "");

  // Same resubmit-with-a-hidden-field shape as the duplicate prompt: flip the
  // token into state, then let the effect fire the submit once the hidden input
  // has re-rendered with it.
  const [activeMatchToken, setActiveMatchToken] = useState<string | null>(null);
  const resubmitAfterOverride = useRef(false);

  useEffect(() => {
    if (activeMatchToken && resubmitAfterOverride.current) {
      resubmitAfterOverride.current = false;
      formRef.current?.requestSubmit();
    }
  }, [activeMatchToken, formRef]);

  function registerWithoutChip() {
    if (!state.forceToken) return;
    resubmitAfterOverride.current = true;
    setActiveMatchToken(state.forceToken);
  }

  return {
    microchipId,
    setMicrochipId,
    /** Receipt posted with the NEXT submit — from the card, or just accepted here. */
    postedForceToken: activeMatchToken ?? chipConflict?.forceToken ?? "",
    /** Server state: stops showing (and stops gating submit) once accepted. */
    chipMatchActive: state.warning === "CHIP_MATCH_ACTIVE" && !activeMatchToken,
    registerWithoutChip,
  };
}

// ---------------------------------------------------------------------------
// ChipMatchActivePrompt — the chip belongs to an ACTIVE pet (RA-2 F6).
//
// createPetAction answers that case with warning:"CHIP_MATCH_ACTIVE" plus a
// signed force token. Before this existed the form rendered nothing for that
// warning: a silent no-op with no affirmative action on screen. The override
// registers the animal WITHOUT the disputed code — pet_identifications
// chip_unique (migration 0056) makes a second active claim impossible, so
// "register it anyway with the same chip" was never a real option.
// ---------------------------------------------------------------------------

function ChipMatchActivePrompt({
  matchedPetToken,
  onRegisterWithoutChip,
}: {
  matchedPetToken: string | undefined;
  onRegisterWithoutChip: () => void;
}) {
  return (
    <div className="mt-4" role="alert">
      <LnCallout tone="warn" title="Ese chip ya está registrado">
        <p className="m-0">
          El número de microchip que cargaste figura asignado a otra mascota activa en miMAR. Si es
          la misma, no hace falta que la registres de nuevo. Si es otro animal, registrala sin el
          chip y cargá el número correcto después.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          {/* LnButton rather than the hand-rolled element pair the sibling
              duplicate prompt still uses: check-raw-buttons.mjs allows exactly
              two button radii in the app, and a new raw one here would have
              pushed the citizen count past its baseline. */}
          {matchedPetToken && (
            <LnButton href={`/p/${matchedPetToken}`} variant="primary" size="lg" block>
              Ver la mascota de ese chip
            </LnButton>
          )}
          <LnButton type="button" variant="ghost" size="lg" block onClick={onRegisterWithoutChip}>
            Es otro animal — registrar sin el chip
          </LnButton>
        </div>
      </LnCallout>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MoreDetailsFields — the collapsible "Más datos (opcional)" block of paso 2.
//
// Extracted from MinimalNewPetForm when the microchip field (RA-2 F6) pushed
// that function past the complexity fence. Pure presentation over controlled
// values; the form still owns every piece of state.
// ---------------------------------------------------------------------------

function MoreDetailsFields({
  color,
  onColorChange,
  microchipId,
  onMicrochipIdChange,
  microchipReadOnly,
  kept,
  acquisitionMethod,
  onAcquisitionMethodChange,
}: {
  color: string;
  onColorChange: (v: string) => void;
  microchipId: string;
  onMicrochipIdChange: (v: string) => void;
  /** True on the chip-conflict return path: the code is the one already adjudicated. */
  microchipReadOnly: boolean;
  /** From useKeptFields — re-seeds the acquisitionMethod select after a reset. */
  kept: (name: string) => string;
  acquisitionMethod: string;
  onAcquisitionMethodChange: (v: string) => void;
}) {
  return (
    <details className="group rounded-[var(--radius-sm)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-3 text-sm font-semibold text-[var(--color-ln-ink-2)] select-none">
        <span>Más datos (opcional)</span>
        <span
          aria-hidden="true"
          className="text-[var(--color-ln-faint)] transition-transform group-open:rotate-180"
        >
          ▾
        </span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-[var(--color-ln-line)] px-3.5 py-3">
        <LnField label="Color / señas">
          {({ id, describedBy }) => (
            <LnInput
              id={id}
              name="color"
              type="text"
              placeholder="Atigrado, mancha blanca en el pecho…"
              value={color}
              onChange={(e) => onColorChange(e.target.value)}
              aria-describedby={describedBy}
              autoComplete="off"
            />
          )}
        </LnField>

        {/* Microchip (RA-2 F6) — optional. This is the field the whole
            found_stray chip cross-check in createPetAction was written for;
            without it the alta posted no microchipId, so the cross-check, the
            vecino match page and its escape hatch were all unreachable from
            the only form that renders at /mis-mascotas/nueva. */}
        <LnField
          label="Número de microchip"
          hint="15 dígitos (ISO). Si la encontraste en la calle, buscá que la lean en una veterinaria."
        >
          {({ id, describedBy }) => (
            <LnInput
              id={id}
              name="microchipId"
              type="text"
              inputMode="numeric"
              placeholder="Opcional"
              value={microchipId}
              onChange={(e) => onMicrochipIdChange(e.target.value)}
              readOnly={microchipReadOnly}
              aria-describedby={describedBy}
              autoComplete="off"
            />
          )}
        </LnField>

        {/* Acquisition method (V8 fix) — optional; feeds the /gob acquisition
            dashboard. Left blank = not specified, same as before it existed. */}
        <LnField label="¿Cómo te encontraste con esta mascota?">
          {({ id, describedBy }) => (
            <LnSelect
              // `value=`+`onChange=` alone falls back to its FIRST option on
              // React 19's post-action reset regardless (react-dom's UPDATE
              // path never rewrites `defaultSelected`, only MOUNT does — see
              // lib/ui/use-kept-fields.ts). `key` from `kept()` (not from
              // `acquisitionMethod`) so the remount happens exactly once, at
              // the post-action reset — not on every pick.
              key={`acquisition-method-${kept("acquisitionMethod")}`}
              id={id}
              name="acquisitionMethod"
              defaultValue={kept("acquisitionMethod") || acquisitionMethod}
              onChange={(e) => onAcquisitionMethodChange(e.target.value)}
              aria-describedby={describedBy}
            >
              <option value="">No especificar</option>
              <option value="adopted">Adoptado/a</option>
              <option value="purchased">Comprado/a</option>
              <option value="found_stray">Encontrado/a en la calle</option>
              <option value="gift">Regalado/a</option>
              <option value="born_in_litter">Nacido/a en casa (camada propia)</option>
              <option value="other">Otro</option>
            </LnSelect>
          )}
        </LnField>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// SpeciesField — dog / cat chip buttons + other sub-select (controlled)
// ---------------------------------------------------------------------------

function SpeciesField({
  picked,
  otherSpecies,
  kept,
  onPick,
  onOtherSpeciesChange,
}: {
  picked: SpeciesPick;
  otherSpecies: string;
  /** From useKeptFields — re-seeds the "otra especie" select after a reset. */
  kept: (name: string) => string;
  onPick: (p: SpeciesPick) => void;
  onOtherSpeciesChange: (v: string) => void;
}) {
  const chipBase =
    "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-[var(--radius-md)] border-2 px-3.5 py-3.5 text-md font-semibold transition-colors select-none";
  const chipActive =
    "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] text-[var(--color-ln-azul)]";
  const chipIdle =
    "border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)] text-[var(--color-ln-ink-2)] hover:border-[var(--color-ln-azul)] hover:bg-[var(--color-ln-celeste-050)]";

  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        Especie{" "}
        <span className="text-[var(--color-ln-seal)]" aria-hidden="true">
          *
        </span>
      </p>

      {/* Hidden input for dog/cat — avoids double submit on the "other" path */}
      {picked !== null && picked !== "other" && (
        <input type="hidden" name="species" value={picked} />
      )}

      <div className="grid grid-cols-3 gap-2">
        {(
          [
            // Etiquetas desde speciesLabel — ver OTHER_SPECIES arriba.
            { value: "dog", icon: "perro", label: speciesLabel("dog") },
            { value: "cat", icon: "gato", label: speciesLabel("cat") },
            { value: "other", icon: "huella", label: speciesLabel("other") },
          ] as const
        ).map(({ value, icon, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={picked === value}
            onClick={() => onPick(value)}
            className={[chipBase, picked === value ? chipActive : chipIdle]
              .filter(Boolean)
              .join(" ")}
          >
            <Icon name={icon} size={24} decorative />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Sub-select rendered only when "Otra" is picked */}
      {picked === "other" && (
        <LnField label="¿Cuál?" required>
          {({ id, describedBy, invalid }) => (
            <LnSelect
              key={`other-species-${kept("species")}`}
              id={id}
              name="species"
              required
              aria-describedby={describedBy}
              invalid={invalid}
              defaultValue={kept("species") || otherSpecies}
              onChange={(e) => onOtherSpeciesChange(e.target.value)}
            >
              <option value="" disabled>
                Seleccioná la especie…
              </option>
              {OTHER_SPECIES.map(({ value, label }) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PhotoField — prominent uploader; camera AND gallery; preview + removable.
// ---------------------------------------------------------------------------

function PhotoField({
  file,
  onFileChange,
}: {
  /** The picked File — lifted to the form as the reset-safe source of truth
   *  (React 19 clears the uncontrolled file input after every action return;
   *  the form re-attaches this File to the posted FormData when that happens). */
  file: File | null;
  onFileChange: (file: File | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Preview derived from the lifted File; the object-URL lifecycle stays local.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    onFileChange(e.target.files?.[0] ?? null);
  }

  function removePhoto() {
    onFileChange(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-ln-mono text-xs font-semibold uppercase tracking-[.1em] text-[var(--color-ln-mute)]">
        Foto{" "}
        <span className="font-normal lowercase tracking-[.04em] text-[var(--color-ln-faint)]">
          opcional
        </span>
      </p>
      {/* No `capture` attribute: on mobile the OS picker offers BOTH the camera
          and the photo gallery, instead of forcing the camera. */}
      <label
        htmlFor="photo"
        className="flex cursor-pointer items-center gap-3.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--color-ln-line-strong)] p-3 transition-colors hover:bg-[var(--color-ln-stripe)]"
      >
        {preview ? (
          <img
            src={preview}
            alt="Vista previa de la mascota"
            className="h-[84px] w-[84px] flex-shrink-0 rounded-[var(--radius-md)] object-cover"
          />
        ) : (
          <div className="flex h-[84px] w-[84px] flex-shrink-0 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-ln-stripe)] text-sm text-[var(--color-ln-mute)]">
            Sin foto
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-md font-medium text-[var(--color-ln-ink-2)]">
            {preview ? "Cambiar foto" : "Tomar o elegir una foto"}
          </p>
          <p className="mt-0.5 font-ln-mono text-sm text-[var(--color-ln-mute)]">
            Cámara o galería. JPG o PNG, hasta 5 MB.
          </p>
        </div>
      </label>
      <input
        ref={inputRef}
        id="photo"
        name="photo"
        type="file"
        accept="image/*"
        onChange={handleChange}
        className="sr-only"
      />
      {preview && (
        <button
          type="button"
          onClick={removePhoto}
          className="self-start font-ln-mono text-sm tracking-[.04em] text-[var(--color-ln-azul)] underline underline-offset-2"
        >
          Quitar foto
        </button>
      )}
    </div>
  );
}
