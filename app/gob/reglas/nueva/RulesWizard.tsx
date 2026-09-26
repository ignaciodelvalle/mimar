"use client";

// RulesWizard — the ONE "Crear regla" entry point for the admin rules
// console (PO verdict 2026-07-23: replaces drilling through a 24-provincia
// grid, each with its own locality search box — "muchísimas cajitas para
// buscar localidad" — with a single linear step-by-step flow). Uses the
// SAME LnWizardShell chrome (step indicator, inert inactive steps) every
// other multi-step flow in the app already uses, and — critically — reuses
// the EXISTING per-kind rule forms (MicrochipRequiredForm, NumericWindowRuleForm,
// etc., from ../[country]/[province]/[locality]/nueva/forms) verbatim as step
// 4's body. This wizard owns none of the persistence logic: step 4 mounts the
// same form component the old provincia->localidad drill-down used, which
// submits via the same createBusinessRuleAction and redirects to the
// jurisdiction detail page on success — every existing authz check, validator,
// and audit-log write stays exactly as it was.
//
// Steps: 1 Provincia -> 2 Localidad (o "toda la provincia", the system's
// existing null-locality = province-wide convention) -> 3 Tipo de regla ->
// 4 Configuración específica (el form del tipo elegido).

import { useRouter } from "next/navigation";
import { useState } from "react";

import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { LnWizardShell } from "@/components/ui/WizardShell";
import { OpButton, OpCheckbox, OpField, OpSelect } from "@/components/ui/dashboard";
// Value import from "@/db/schema" (NOT "@/db"): this is a "use client"
// component and @/db carries `import "server-only"` — a value import through
// the barrel breaks the webpack build (type-only imports would be erased,
// but GOVT_BUSINESS_RULE_TYPES is a runtime const).
import { GOVT_BUSINESS_RULE_TYPES, type GovtBusinessRuleType } from "@/db/schema";
import { jurisdictionLabel } from "@/lib/domain/jurisdiction-rules-href";
import { RULE_TYPE_REGISTRY } from "@/lib/domain/rule-types-registry";
import { PROVINCES, provinceByCode } from "@/lib/reference/ar-provincias";

import { RulePlaceContext } from "../[country]/[province]/[locality]/nueva/RulePlaceField";
import {
  RULE_FORM_REGISTRY,
  buildCreateFormExtraProps,
} from "../[country]/[province]/[locality]/nueva/forms";

const TOTAL_STEPS = 4;
const STEP_LABELS = ["Provincia", "Localidad", "Tipo de regla", "Configuración"];

// Same "has a form" test the jurisdiction detail page's "missing types"
// section uses (design ADR-2) — a rule type only appears as a wizard option
// once it has a real config form, never a dead end.
const RULE_TYPE_OPTIONS = GOVT_BUSINESS_RULE_TYPES.filter(
  (t): t is GovtBusinessRuleType => t in RULE_FORM_REGISTRY,
);

type Props = {
  /** Portal prefix (portal-follows-viewer, 2026-07-02) — threaded down to the
   * per-kind form so its post-submit redirect stays inside the right portal. */
  base: "/admin" | "/gob";
};

export function RulesWizard({ base }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [provinceCode, setProvinceCode] = useState("");
  const [provinceName, setProvinceName] = useState("");
  const [wholeProvince, setWholeProvince] = useState(false);
  const [localityName, setLocalityName] = useState("");
  // The picked row's INDEC id: tells a homonym apart (localidades-por-id D4).
  const [localityIndecId, setLocalityIndecId] = useState<string | null>(null);
  const [ruleType, setRuleType] = useState<GovtBusinessRuleType | null>(null);

  const effectiveLocality = wholeProvince ? null : localityName.trim() || null;
  const RuleForm = ruleType ? RULE_FORM_REGISTRY[ruleType] : undefined;

  return (
    <LnWizardShell
      currentStep={step}
      totalSteps={TOTAL_STEPS}
      stepLabels={STEP_LABELS}
      onBack={step > 1 ? () => setStep((s) => s - 1) : undefined}
      onCancel={() => router.push(`${base}/reglas`)}
    >
      {/* Step 1 — Provincia */}
      <section
        className={step === 1 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 1}
        inert={step !== 1 ? true : undefined}
      >
        <p className="text-md text-ln-op-ink-2">¿A qué provincia se aplica la nueva regla?</p>
        <OpField label="Provincia" required>
          {({ id, describedBy, invalid }) => (
            <OpSelect
              id={id}
              value={provinceCode}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                const code = e.target.value;
                setProvinceCode(code);
                setProvinceName(provinceByCode(code)?.name ?? "");
              }}
            >
              <option value="">Elegí una provincia…</option>
              {PROVINCES.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}
                </option>
              ))}
            </OpSelect>
          )}
        </OpField>
        <OpButton
          type="button"
          variant="primary"
          block
          disabled={!provinceName}
          onClick={() => setStep(2)}
        >
          Continuar
        </OpButton>
      </section>

      {/* Step 2 — Localidad, o "toda la provincia" (null-locality convention
          this console already uses everywhere — buildJurisdictionRulesHref,
          JurisdictionReglasPage's "(toda la provincia)" placeholder). */}
      <section
        className={step === 2 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 2}
        inert={step !== 2 ? true : undefined}
      >
        <p className="text-md text-ln-op-ink-2">
          ¿La regla aplica a toda {provinceName || "la provincia"} o solo a una localidad?
        </p>
        <OpCheckbox
          checked={wholeProvince}
          onChange={(e) => {
            setWholeProvince(e.target.checked);
            if (e.target.checked) {
              setLocalityName("");
              setLocalityIndecId(null);
            }
          }}
        >
          Aplica a toda la provincia (sin localidad específica)
        </OpCheckbox>
        {!wholeProvince && (
          <div className="space-y-1.5">
            <label
              htmlFor="rw-locality-input"
              className="block text-xs font-medium text-ln-op-ink-2"
            >
              Localidad
            </label>
            <LocalityPickerAcross
              id="rw-locality"
              scopeProvinceCode={provinceCode || null}
              disabled={!provinceCode}
              onSelect={(result) => {
                setLocalityName(result?.localityName ?? "");
                setLocalityIndecId(result?.indecId ?? null);
              }}
              onDeselect={() => {
                setLocalityName("");
                setLocalityIndecId(null);
              }}
              placeholder={`Buscar localidad en ${provinceName || "la provincia elegida"}…`}
            />
          </div>
        )}
        <OpButton
          type="button"
          variant="primary"
          block
          disabled={!wholeProvince && !localityName.trim()}
          onClick={() => setStep(3)}
        >
          Continuar
        </OpButton>
      </section>

      {/* Step 3 — Tipo de regla, desde el registro de tipos (design ADR-2),
          cada uno con su propósito en una línea. */}
      <section
        className={step === 3 ? "space-y-4" : "sr-only"}
        aria-hidden={step !== 3}
        inert={step !== 3 ? true : undefined}
      >
        <fieldset className="m-0 space-y-2 border-0 p-0">
          <legend className="mb-1 block text-md text-ln-op-ink-2">
            ¿Qué tipo de regla querés configurar?
          </legend>
          {RULE_TYPE_OPTIONS.map((t) => {
            const def = RULE_TYPE_REGISTRY[t];
            return (
              <label
                key={t}
                className={`block cursor-pointer rounded-[var(--radius-md)] border px-3 py-2.5 transition-colors ${
                  ruleType === t
                    ? "border-ln-op-azul bg-ln-op-azul/10"
                    : "border-ln-op-line hover:bg-ln-op-stripe"
                }`}
              >
                <input
                  type="radio"
                  name="ruleType"
                  value={t}
                  checked={ruleType === t}
                  onChange={() => setRuleType(t)}
                  className="sr-only"
                />
                <span className="block text-md font-medium text-ln-op-ink">{def.label}</span>
                <span className="block text-sm text-ln-op-ink-2">{def.description}</span>
              </label>
            );
          })}
        </fieldset>
        <OpButton
          type="button"
          variant="primary"
          block
          disabled={!ruleType}
          onClick={() => setStep(4)}
        >
          Continuar
        </OpButton>
      </section>

      {/* Step 4 — Configuración específica: reuses the existing per-kind form
          verbatim (design ADR-2's RULE_FORM_REGISTRY) — this wizard never
          reimplements any rule-type-specific config UI, and never touches
          persistence: the form's own action + redirect are unchanged. */}
      <section
        className={step === 4 ? "space-y-5" : "sr-only"}
        aria-hidden={step !== 4}
        inert={step !== 4 ? true : undefined}
      >
        {ruleType && RuleForm ? (
          <>
            <p className="text-md text-ln-op-ink-2">
              {jurisdictionLabel("AR", provinceName || null, effectiveLocality)} {"·"}{" "}
              {RULE_TYPE_REGISTRY[ruleType].label}
            </p>
            <RulePlaceContext.Provider
              value={{ localityIndecId: effectiveLocality ? localityIndecId : null }}
            >
              <RuleForm
                mode="create"
                country="AR"
                province={provinceName || null}
                locality={effectiveLocality}
                base={base}
                {...buildCreateFormExtraProps(ruleType, RULE_TYPE_REGISTRY[ruleType].default)}
              />
            </RulePlaceContext.Provider>
          </>
        ) : null}
      </section>
    </LnWizardShell>
  );
}
