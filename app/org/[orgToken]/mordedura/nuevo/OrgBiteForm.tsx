"use client";

// OrgBiteForm — 4-step wizard for org-side bite reporting.
// Trilogy unification handoff §5 PR-045.
//
// Steps:
//   1. Mascota — petPublicToken. CTA Continuar.
//   2. Cuándo — occurredAt. CTA Continuar.
//   3. Víctima + contexto + ubicación — kind, contact, severity, injuries,
//      vet involvement, context, location text. CTA Continuar.
//   4. Confirmar — confirmObservation checkbox + submit. CTA Confirmar mordedura.
//
// Cierre: SuccessScreen "Incidente registrado. Mascota en observación
// antirrábica por 10 días" — replaces the previous redirect.

import dynamic from "next/dynamic";
import { useRef, useState, useTransition } from "react";

import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnCheckbox, LnInput, LnRadioGroup, LnSelect, LnTextarea } from "@/components/ui/Field";
import { LnSuccessScreen } from "@/components/ui/SuccessScreen";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton, OpField } from "@/components/ui/dashboard";
import { useIdempotencyKey } from "@/lib/ui/use-idempotency-key";
import { formatDate, todayIsoInAr } from "@/lib/utils/format";
import type { ReportBiteFromOrgFormState } from "@/src/modules/surveillance/actions";

import { buildOrgBiteFormData } from "./org-bite-form-data";

type FormAction = (
  prev: ReportBiteFromOrgFormState,
  formData: FormData,
) => Promise<ReportBiteFromOrgFormState>;

// panorama-event-points Slice 2: reuse the standard map-pin component (the same
// LocationPicker LocationFields uses for sightings). The org wizard builds its
// FormData imperatively, so a controlled point + hidden-input-free wiring is
// cleaner than embedding LocationFields (whose hidden inputs the wizard's manual
// FormData would not capture).
const LocationPicker = dynamic(() => import("@/components/LocationPicker"), {
  loading: () => (
    <div className="h-64 w-full animate-pulse rounded-lg border border-ln-op-line bg-ln-op-stripe" />
  ),
});

const TOTAL_STEPS = 4;
const STEP_LABELS = ["Mascota", "Cuándo", "Víctima y contexto", "Confirmar"];

function computeObservationEndIso(occurredAtIso: string): string | null {
  if (!occurredAtIso) return null;
  const d = new Date(occurredAtIso);
  if (!Number.isFinite(d.getTime())) return null;
  d.setDate(d.getDate() + 10);
  return d.toISOString().slice(0, 10);
}

export function OrgBiteForm({ action, orgToken }: { action: FormAction; orgToken: string }) {
  const today = todayIsoInAr();
  const [step, setStep] = useState(1);
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<ReportBiteFromOrgFormState>({ error: null });
  const { key: idempotencyKey, reset: resetIdempotencyKey } = useIdempotencyKey();
  // Stable ref so the submit closure always reads the current key without
  // capturing a stale value from the initial render.
  const idempotencyKeyRef = useRef(idempotencyKey);
  idempotencyKeyRef.current = idempotencyKey;

  // Controlled fields. Reuse FormData on submit.
  const [petPublicToken, setPetPublicToken] = useState("");
  const [occurredAt, setOccurredAt] = useState(today);
  const [locationDescription, setLocationDescription] = useState("");
  const [provinceCode, setProvinceCode] = useState("");
  const [provinceName, setProvinceName] = useState("");
  const [localityName, setLocalityName] = useState("");
  // The INDEC id of the row picked — what tells two same-named localities apart.
  const [localityIndecId, setLocalityIndecId] = useState("");
  const [victimKind, setVictimKind] = useState<"human" | "animal" | "unknown">("human");
  const [victimContactName, setVictimContactName] = useState("");
  const [victimContactPhone, setVictimContactPhone] = useState("");
  const [victimAgeEstimate, setVictimAgeEstimate] = useState("");
  const [severity, setSeverity] = useState("");
  const [injuriesSummary, setInjuriesSummary] = useState("");
  const [vetInvolved, setVetInvolved] = useState(false);
  const [context, setContext] = useState("");
  const [confirmObservation, setConfirmObservation] = useState(false);
  // panorama-event-points Slice 2: the optional incident map pin + how it was set.
  // W8 (PO, 2026-09-24): no device GPS anywhere on the web — the pin is always
  // placed by hand, never prefilled from navigator.geolocation. "gps" stays a
  // valid value in lib/events/event-schemas.ts for OLD events (append-only),
  // but no writer emits it any more.
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [locationSource, setLocationSource] = useState<"pin_manual" | null>(null);

  function submit() {
    setState({ error: null });
    const fd = buildOrgBiteFormData({
      clientIdempotencyKey: idempotencyKeyRef.current,
      petPublicToken,
      occurredAt,
      locationDescription,
      provinceCode,
      provinceName,
      localityName,
      localityIndecId,
      victimKind,
      victimContactName,
      victimContactPhone,
      victimAgeEstimate,
      severity,
      injuriesSummary,
      vetInvolved,
      context,
      confirmObservation,
      point,
      locationSource,
    });
    startTransition(async () => {
      const result = await action({ error: null }, fd);
      if (result.ok) {
        // Reset the key so a subsequent use of this form (unlikely but safe)
        // generates a new event rather than a no-op.
        resetIdempotencyKey();
      }
      setState(result);
    });
  }

  if (state.ok && state.petToken) {
    const obsEnd = computeObservationEndIso(occurredAt);
    return (
      <LnSuccessScreen
        title="Incidente registrado"
        code={state.casePublicCode}
        codeLabel="Caso registrado"
        official
        description={
          obsEnd
            ? // obsEnd is a bare YYYY-MM-DD; formatDate anchors date-only
              // strings at noon UTC itself. The old manual "T12:00:00" suffix
              // (no Z) parsed in the BROWSER's zone in this client component,
              // so a viewer far from AR could still see the previous day.
              `Mascota en observación antirrábica por 10 días. Próxima revisión: ${formatDate(obsEnd)}.`
            : "Mascota en observación antirrábica por 10 días."
        }
        next={[
          {
            // Public credential — always reachable by the reporter. A clinic can
            // report a bite by a pet it does NOT hold, so the org custody route
            // (/org/{org}/mascotas/{token}) 404s for them. The public credential
            // works for any reporter and now surfaces the observation banner.
            label: "Ver credencial de la mascota",
            href: `/p/${state.petToken}`,
          },
          {
            label: "Volver al panel de la organización",
            href: `/org/${orgToken}`,
            variant: "secondary",
          },
        ]}
      />
    );
  }

  return (
    <LnWizardShell
      currentStep={step}
      totalSteps={TOTAL_STEPS}
      stepLabels={STEP_LABELS}
      onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
    >
      {/* Step 1 — Mascota */}
      <section
        className={step === 1 ? "space-y-4" : "sr-only"}
        aria-hidden={step !== 1}
        inert={step !== 1 ? true : undefined}
      >
        <OpField
          label="Token público de la mascota"
          required
          hint="El dueño tiene este token en la credencial pública (escaneable o en su perfil)."
        >
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              type="text"
              required
              value={petPublicToken}
              onChange={(e) => setPetPublicToken(e.target.value)}
              placeholder="DIM-XXXX-XXXX"
              className="font-ln-mono uppercase tracking-wider"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </OpField>
        <OpButton
          variant="primary"
          block
          onClick={() => setStep(2)}
          disabled={!petPublicToken.trim()}
        >
          Continuar
        </OpButton>
      </section>

      {/* Step 2 — Cuándo */}
      <section
        className={step === 2 ? "space-y-4" : "sr-only"}
        aria-hidden={step !== 2}
        inert={step !== 2 ? true : undefined}
      >
        <OpField label="Fecha del incidente" required>
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              type="date"
              required
              max={today}
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </OpField>
        <OpButton variant="primary" block onClick={() => setStep(3)} disabled={!occurredAt}>
          Continuar
        </OpButton>
      </section>

      {/* Step 3 — Víctima + contexto */}
      <section
        className={step === 3 ? "space-y-4" : "sr-only"}
        aria-hidden={step !== 3}
        inert={step !== 3 ? true : undefined}
      >
        <OpField label="Lugar">
          {({ id, describedBy, invalid }) => (
            <LnInput
              id={id}
              type="text"
              value={locationDescription}
              onChange={(e) => setLocationDescription(e.target.value)}
              placeholder="Ej: Plaza Italia, esquina Cerviño"
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
            />
          )}
        </OpField>

        <div className="space-y-1.5">
          <label htmlFor="bite-locality" className="block text-xs font-medium text-ln-op-ink-2">
            Jurisdicción del incidente
          </label>
          <LocalityPickerAcross
            id="bite-locality"
            placeholder="Localidad o barrio del incidente…"
            onSelect={(result) => {
              setProvinceCode(result?.provinceCode ?? "");
              setProvinceName(result?.provinceName ?? "");
              setLocalityName(result?.localityName ?? "");
              setLocalityIndecId(result?.indecId ?? "");
            }}
            onDeselect={() => {
              setProvinceCode("");
              setProvinceName("");
              setLocalityName("");
              setLocalityIndecId("");
            }}
          />
          <p className="mt-1 text-sm text-ln-op-mute">
            Para enrutar el reporte a la autoridad sanitaria correspondiente. Si no la elegís,
            usamos la jurisdicción registrada de la mascota.
          </p>
        </div>

        {/* panorama-event-points Slice 2: optional incident map pin. When set,
            the coordinate is persisted so the mordeduras near-zoom dot can plot
            the incident inside the operator's jurisdiction. */}
        <div className="space-y-1.5">
          <p className="block text-xs font-medium text-ln-op-ink-2">
            Ubicación en el mapa (opcional)
          </p>
          <p className="text-sm text-ln-op-mute">
            Tocá el mapa para marcar dónde ocurrió. Ubica el incidente en el panorama de vigilancia.
          </p>
          <LocationPicker
            value={point}
            onChange={(p) => {
              setPoint(p);
              setLocationSource("pin_manual");
            }}
          />
          {point && (
            <p className="font-ln-mono text-xs text-ln-op-mute">
              {point.lat.toFixed(6)}, {point.lng.toFixed(6)}
            </p>
          )}
        </div>

        {/* RA-9 BR-6: requiredness reaches assistive tech via LnRadioGroup
            (role="radiogroup" + aria-required + sr-only "(obligatorio)") instead
            of an aria-hidden asterisk. */}
        <LnRadioGroup
          legend="Tipo de víctima"
          required
          className="space-y-1.5 border-0 m-0 p-0"
          legendClassName="block text-xs font-medium text-ln-op-ink-2 p-0"
          optionsClassName="grid grid-cols-3 gap-2"
        >
          {(
            [
              { value: "human", label: "Persona" },
              { value: "animal", label: "Otro animal" },
              { value: "unknown", label: "No sé" },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              className={`flex items-center justify-center gap-2 rounded-[var(--radius-md)] border px-3 py-2 text-md cursor-pointer transition-colors ${
                victimKind === opt.value
                  ? "border-ln-op-azul bg-ln-op-azul/10 text-ln-op-ink"
                  : "border-ln-op-line text-ln-op-ink hover:bg-ln-op-stripe"
              }`}
            >
              <input
                type="radio"
                name="victimKind"
                value={opt.value}
                checked={victimKind === opt.value}
                onChange={() => setVictimKind(opt.value)}
                className="sr-only"
              />
              {opt.label}
            </label>
          ))}
        </LnRadioGroup>

        {victimKind === "human" && (
          <div className="rounded-[var(--radius-md)] border border-ln-op-line bg-ln-op-stripe p-4 space-y-3">
            <p className="text-sm text-ln-op-mute">
              Datos de contacto opcionales — para denuncia obligatoria a autoridad sanitaria si
              corresponde.
            </p>
            <OpField label="Nombre">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  type="text"
                  value={victimContactName}
                  onChange={(e) => setVictimContactName(e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </OpField>
            <OpField label="Teléfono">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  type="tel"
                  value={victimContactPhone}
                  onChange={(e) => setVictimContactPhone(e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </OpField>
            <OpField label="Edad aproximada">
              {({ id, describedBy, invalid }) => (
                <LnInput
                  id={id}
                  type="text"
                  value={victimAgeEstimate}
                  onChange={(e) => setVictimAgeEstimate(e.target.value)}
                  placeholder="Ej: niño, adulto, mayor"
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </OpField>
          </div>
        )}

        <OpField label="Severidad" required>
          {({ id, describedBy, invalid }) => (
            <LnSelect
              id={id}
              value={severity}
              onChange={(e) => setSeverity(e.target.value)}
              required
              aria-describedby={describedBy}
              invalid={invalid}
            >
              <option value="" disabled>
                Elegí una opción
              </option>
              <option value="minor">Leve — sin sangrado, rasguño</option>
              <option value="moderate">Moderada — sangrado, requiere atención</option>
              <option value="severe">Grave — heridas profundas, hospital</option>
            </LnSelect>
          )}
        </OpField>

        <OpField label="Resumen clínico de las heridas">
          {({ id, describedBy, invalid }) => (
            <LnTextarea
              id={id}
              value={injuriesSummary}
              onChange={(e) => setInjuriesSummary(e.target.value)}
              rows={2}
              placeholder="Ej: laceración profunda en antebrazo izquierdo, requirió sutura."
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </OpField>

        <div className="space-y-1.5">
          <LnCheckbox checked={vetInvolved} onChange={(e) => setVetInvolved(e.target.checked)}>
            Intervino un profesional veterinario en el incidente o atención posterior.
          </LnCheckbox>
        </div>

        <OpField label="Contexto adicional">
          {({ id, describedBy, invalid }) => (
            <LnTextarea
              id={id}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={3}
              placeholder="Ej: el animal estaba suelto sin correa en plaza pública."
              aria-describedby={describedBy}
              invalid={invalid}
            />
          )}
        </OpField>

        <OpButton variant="primary" block onClick={() => setStep(4)} disabled={!severity}>
          Continuar
        </OpButton>
      </section>

      {/* Step 4 — Confirmar + submit */}
      <section
        className={step === 4 ? "space-y-4" : "sr-only"}
        aria-hidden={step !== 4}
        inert={step !== 4 ? true : undefined}
      >
        <div className="rounded-[var(--radius-md)] border border-ln-op-warn bg-ln-op-warn/10 p-4 space-y-2">
          <LnCheckbox
            checked={confirmObservation}
            onChange={(e) => setConfirmObservation(e.target.checked)}
            labelClassName="text-ln-op-ink-2!"
          >
            Entiendo que esto inicia un período de observación antirrábica obligatorio de 10 días
            (Decreto 4669/1973 PBA, Ord. CABA 41.831/1987) y se notifica al dueño y a la autoridad
            sanitaria correspondiente.
          </LnCheckbox>
        </div>

        {state.error && (
          <p className="text-md text-ln-op-danger" role="alert">
            {state.error}
          </p>
        )}

        <OpButton
          variant="primary"
          block
          onClick={submit}
          disabled={pending || !confirmObservation}
        >
          {pending ? "Reportando..." : "Confirmar mordedura"}
        </OpButton>
      </section>
    </LnWizardShell>
  );
}
