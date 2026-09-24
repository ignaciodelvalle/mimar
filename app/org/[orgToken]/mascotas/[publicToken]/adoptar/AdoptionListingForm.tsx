"use client";

// AdoptionListingForm — 2-step wizard for adoption listing edit + publish.
// Trilogy unification handoff §4 PR-032 (scoped to 2 steps; the original
// 3-step plan included a photo carousel + drag-drop reorder which is
// parked — no pet_photos table exists today, see docs/superpowers/plans/
// 2026-05-27-spec-later-tracker.md for the deferred work).
//
// Steps:
//   1. Historia y atributos — story + requirements + age/size/energy +
//      convivencia tri-state + fee. CTA Guardar y continuar (calls
//      updateAdoptionListingContentAction; on success → step 2).
//   2. Visibilidad pública — status controls (Publicar adopción / Pausar /
//      Despublicar) + summary recap. CTA per current state.

import { useState } from "react";

import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton, OpInput, OpSelect, OpTextarea } from "@/components/ui/dashboard";
import {
  ADOPTION_AGE_BUCKETS,
  ADOPTION_ENERGY_LEVELS,
  ADOPTION_SIZE_ESTIMATES,
  type AgeBucket,
  type EnergyLevel,
  type SizeEstimate,
  ageBucketLabel,
  energyLabel,
  sizeLabel,
} from "@/lib/infra/adoption-listing";
import { navigateAfterActionSuccess } from "@/lib/ui/full-page-action-nav";
import {
  setAdoptionListingStatusAction,
  updateAdoptionListingContentAction,
} from "@/src/modules/adoption/actions";

type Initial = {
  isPublished: boolean;
  isPaused: boolean;
  story: string | null;
  requirements: string | null;
  ageBucket: AgeBucket | null;
  sizeEstimate: SizeEstimate | null;
  energyLevel: EnergyLevel | null;
  goodWithKids: boolean | null;
  goodWithDogs: boolean | null;
  goodWithCats: boolean | null;
  needsYard: boolean | null;
  feeArs: number | null;
};

const TOTAL_STEPS = 2;
const STEP_LABELS = ["Historia y atributos", "Visibilidad pública"];

export function AdoptionListingForm({
  orgToken,
  petPublicToken,
  initial,
  canPublish,
  petSex,
}: {
  /** Pins the listing actions to the org in the URL — see the actions' docs. */
  orgToken: string;
  petPublicToken: string;
  initial: Initial;
  canPublish: boolean;
  petSex: string;
}) {
  // NOT useTransition: these actions call revalidatePath, and a revalidate
  // that rides the useTransition machinery inherits Next 15.5.x's dropped-
  // refresh defect — the transition never commits, so isPending would stay
  // true forever and permanently disable the step-2 "Publicar adopción"
  // button after a step-1 save (bug #66). A plain boolean clears the moment
  // the action's fetch response resolves, which is defect-free (see
  // lib/ui/full-page-action-nav.ts for the full mechanism).
  const [pending, setPending] = useState(false);
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  const [story, setStory] = useState(initial.story ?? "");
  const [requirements, setRequirements] = useState(initial.requirements ?? "");
  const [ageBucket, setAgeBucket] = useState<AgeBucket | "">(initial.ageBucket ?? "");
  const [sizeEstimate, setSizeEstimate] = useState<SizeEstimate | "">(initial.sizeEstimate ?? "");
  const [energyLevel, setEnergyLevel] = useState<EnergyLevel | "">(initial.energyLevel ?? "");
  const [goodWithKids, setGoodWithKids] = useState<boolean | null>(initial.goodWithKids);
  const [goodWithDogs, setGoodWithDogs] = useState<boolean | null>(initial.goodWithDogs);
  const [goodWithCats, setGoodWithCats] = useState<boolean | null>(initial.goodWithCats);
  const [needsYard, setNeedsYard] = useState<boolean | null>(initial.needsYard);
  const [feeArs, setFeeArs] = useState<string>(
    initial.feeArs != null ? String(initial.feeArs) : "",
  );

  async function runStatus(action: "publish" | "pause" | "unpause" | "unpublish") {
    // Every runStatus button lives in the step-2 section, which is `inert`
    // while step 1 is active. That is one a11y attribute holding a publish
    // action shut — guard the handler too, so the gate survives a new step, a
    // forgotten attribute, or a client that ignores `inert`.
    if (step !== TOTAL_STEPS) return;
    setError(null);
    setOkMessage(null);
    setPending(true);
    // orgToken pins the action to the org in the URL; without it the action
    // resolves the session-default org — see setAdoptionListingStatusAction.
    const result = await setAdoptionListingStatusAction({ orgToken, petPublicToken, action });
    if ("error" in result) {
      setError(result.error);
      setPending(false);
      return;
    }
    setOkMessage("Listo.");
    // Status changes drive the public listing's SSR state — full document
    // reload (router.refresh() is banned; see lib/ui/full-page-action-nav.ts).
    // Leave pending true: the buttons stay disabled while the page reloads.
    navigateAfterActionSuccess(window.location.href);
  }

  async function saveContent(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMessage(null);
    const feeNumber = feeArs.trim() ? Number.parseInt(feeArs, 10) : null;
    setPending(true);
    try {
      const result = await updateAdoptionListingContentAction({
        orgToken,
        petPublicToken,
        story: story.trim() || null,
        requirements: requirements.trim() || null,
        ageBucket: ageBucket || null,
        sizeEstimate: sizeEstimate || null,
        energyLevel: energyLevel || null,
        goodWithKids,
        goodWithDogs,
        goodWithCats,
        needsYard,
        feeArs: feeNumber,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOkMessage("Datos guardados.");
      // No reload here: a full navigation would reset the wizard to step 1,
      // and the step-2 recap reads this component's local state (already
      // fresh). The banned router.refresh() added nothing but the drop risk.
      setStep(2);
    } finally {
      // Clears reliably: the action's fetch resolves even though its
      // revalidatePath refresh is dropped. This is what re-enables the
      // step-2 "Publicar adopción" button in the same session (bug #66).
      setPending(false);
    }
  }

  return (
    <LnWizardShell
      currentStep={step}
      totalSteps={TOTAL_STEPS}
      stepLabels={STEP_LABELS}
      onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
    >
      {/* Step 1 — Content edit */}
      <section
        className={step === 1 ? "space-y-4" : "sr-only"}
        aria-hidden={step !== 1}
        inert={step !== 1 ? true : undefined}
      >
        <form onSubmit={saveContent} className="space-y-4">
          <div>
            <label htmlFor="story" className="block text-sm font-medium text-ln-op-ink mb-1">
              Historia
            </label>
            <OpTextarea
              id="story"
              value={story}
              onChange={(e) => setStory(e.target.value)}
              rows={5}
              placeholder="Contá quién es esta mascota, cómo llegó al refugio, qué la hace especial."
            />
            <p className="text-sm text-ln-op-mute mt-1 tabular-nums">{story.length} / 5000</p>
          </div>

          <div>
            <label htmlFor="requirements" className="block text-sm font-medium text-ln-op-ink mb-1">
              Requisitos para adoptar
            </label>
            <OpTextarea
              id="requirements"
              value={requirements}
              onChange={(e) => setRequirements(e.target.value)}
              rows={3}
              placeholder="Mayores de edad, entrevista previa, compromiso de castración, etc."
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label htmlFor="age" className="block text-sm text-ln-op-mute mb-1">
                Edad
              </label>
              <OpSelect
                id="age"
                value={ageBucket}
                onChange={(e) => setAgeBucket(e.target.value as AgeBucket | "")}
              >
                <option value="">Sin definir</option>
                {ADOPTION_AGE_BUCKETS.map((b) => (
                  <option key={b} value={b}>
                    {ageBucketLabel(b, petSex)}
                  </option>
                ))}
              </OpSelect>
            </div>
            <div>
              <label htmlFor="size" className="block text-sm text-ln-op-mute mb-1">
                Talle
              </label>
              <OpSelect
                id="size"
                value={sizeEstimate}
                onChange={(e) => setSizeEstimate(e.target.value as SizeEstimate | "")}
              >
                <option value="">Sin definir</option>
                {ADOPTION_SIZE_ESTIMATES.map((s) => (
                  <option key={s} value={s}>
                    {sizeLabel(s)}
                  </option>
                ))}
              </OpSelect>
            </div>
            <div>
              <label htmlFor="energy" className="block text-sm text-ln-op-mute mb-1">
                Energía
              </label>
              <OpSelect
                id="energy"
                value={energyLevel}
                onChange={(e) => setEnergyLevel(e.target.value as EnergyLevel | "")}
              >
                <option value="">Sin definir</option>
                {ADOPTION_ENERGY_LEVELS.map((e) => (
                  <option key={e} value={e}>
                    {energyLabel(e, petSex)}
                  </option>
                ))}
              </OpSelect>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ln-op-ink">Convivencia</legend>
            <TriState
              label="¿Se lleva bien con chicos?"
              value={goodWithKids}
              onChange={setGoodWithKids}
            />
            <TriState
              label="¿Se lleva bien con otros perros?"
              value={goodWithDogs}
              onChange={setGoodWithDogs}
            />
            <TriState
              label="¿Se lleva bien con gatos?"
              value={goodWithCats}
              onChange={setGoodWithCats}
            />
            <TriState label="¿Necesita patio?" value={needsYard} onChange={setNeedsYard} />
          </fieldset>

          <div>
            <label htmlFor="fee" className="block text-sm text-ln-op-mute mb-1">
              Aporte de adopción (ARS, opcional)
            </label>
            <OpInput
              id="fee"
              type="number"
              min={0}
              value={feeArs}
              onChange={(e) => setFeeArs(e.target.value)}
              placeholder="Ej: 15000"
              className="w-40"
              block={false}
            />
            <p className="text-sm text-ln-op-mute mt-1">
              Para cubrir vacunas, castración, traslado. Dejá vacío si no aplica.
            </p>
          </div>

          {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
          {okMessage && <output className="block text-sm text-ln-op-ok">{okMessage}</output>}

          <OpButton type="submit" disabled={pending} block>
            {pending ? "Guardando..." : "Guardar y continuar"}
          </OpButton>
        </form>
      </section>

      {/* Step 2 — Status / publish */}
      <section
        className={step === 2 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 2}
        inert={step !== 2 ? true : undefined}
      >
        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-2 text-md">
          <p className="font-semibold text-ln-op-ink">Lo que vas a publicar</p>
          <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
            <dt className="text-ln-op-mute">Historia</dt>
            <dd className="col-span-2 text-ln-op-ink-2">
              {story ? `${story.slice(0, 80)}${story.length > 80 ? "…" : ""}` : "Sin definir"}
            </dd>
            <dt className="text-ln-op-mute">Edad</dt>
            <dd className="col-span-2 text-ln-op-ink-2">
              {ageBucket ? ageBucketLabel(ageBucket as AgeBucket, petSex) : "—"}
            </dd>
            <dt className="text-ln-op-mute">Talle</dt>
            <dd className="col-span-2 text-ln-op-ink-2">
              {sizeEstimate ? sizeLabel(sizeEstimate as SizeEstimate) : "—"}
            </dd>
            <dt className="text-ln-op-mute">Energía</dt>
            <dd className="col-span-2 text-ln-op-ink-2">
              {energyLevel ? energyLabel(energyLevel as EnergyLevel, petSex) : "—"}
            </dd>
            <dt className="text-ln-op-mute">Aporte</dt>
            <dd className="col-span-2 text-ln-op-ink-2">{feeArs || "—"}</dd>
          </dl>
        </div>

        <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-card p-4 space-y-3">
          <p className="text-md font-medium text-ln-op-ink">Visibilidad pública</p>
          <div className="flex flex-wrap gap-2">
            {!initial.isPublished && (
              <OpButton
                type="button"
                size="sm"
                variant="ok"
                onClick={() => runStatus("publish")}
                disabled={pending || !canPublish}
                title={canPublish ? undefined : "Resolvé los bloqueos antes de publicar."}
              >
                Publicar adopción
              </OpButton>
            )}
            {initial.isPublished && !initial.isPaused && (
              <>
                <OpButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => runStatus("pause")}
                  disabled={pending}
                >
                  Pausar
                </OpButton>
                <OpButton
                  type="button"
                  size="sm"
                  variant="danger"
                  onClick={() => runStatus("unpublish")}
                  disabled={pending}
                >
                  Despublicar
                </OpButton>
              </>
            )}
            {initial.isPaused && (
              <>
                <OpButton
                  type="button"
                  size="sm"
                  variant="ok"
                  onClick={() => runStatus("unpause")}
                  disabled={pending}
                >
                  Reanudar
                </OpButton>
                <OpButton
                  type="button"
                  size="sm"
                  variant="danger"
                  onClick={() => runStatus("unpublish")}
                  disabled={pending}
                >
                  Despublicar
                </OpButton>
              </>
            )}
          </div>
          <p className="text-sm text-ln-op-mute">
            Pausar conserva la historia y el contenido. Despublicar borra el timestamp de
            publicación (los textos siguen guardados para una futura republicación).
          </p>
          {!canPublish && !initial.isPublished && (
            <p className="text-sm text-ln-op-warn">
              Hay bloqueos pendientes (mascota perdida, fallecida, no eligible, en disputa o
              observación antirrábica). Resolvé antes de publicar.
            </p>
          )}
        </div>

        {error && <output className="block text-sm text-ln-op-danger">{error}</output>}
        {okMessage && <output className="block text-sm text-ln-op-ok">{okMessage}</output>}
      </section>
    </LnWizardShell>
  );
}

function TriState({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex-1 text-ln-op-ink-2">{label}</span>
      <div className="flex gap-1">
        {(
          [
            { v: true, l: "Sí" },
            { v: false, l: "No" },
            { v: null, l: "No sé" },
          ] as const
        ).map((opt) => (
          <button
            key={opt.l}
            type="button"
            onClick={() => onChange(opt.v)}
            className={`px-2 py-1 rounded-[var(--radius-sm)] border text-sm ${
              value === opt.v
                ? "bg-ln-op-azul text-white border-ln-op-azul"
                : "border-ln-op-line text-ln-op-ink-2 hover:bg-ln-op-stripe"
            }`}
          >
            {opt.l}
          </button>
        ))}
      </div>
    </div>
  );
}
