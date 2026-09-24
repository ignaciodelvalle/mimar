"use client";

// Step 2 — Qué tan grave: three stacked severity cards.
// Maps wizard-friendly labels to the welfareReports.severity enum:
//   "grave_urgente"  → "critical"
//   "moderado"       → "medium"
//   "sospecha"       → "low"
// Per plan: the three buttons use human language, not the enum labels.
//
// UX 3.2 item 1: when "grave_urgente" is selected, an emergency off-ramp
// callout is shown directing the reporter to call 911 for immediate danger.
// The async report flow still proceeds — this is a safety net, not a blocker.

import { Icon } from "@/components/Icon";
import { WELFARE_SEVERITY_CITIZEN_LABEL } from "@/src/modules/welfare/domain/types";

export type WizardSeverity = "grave_urgente" | "moderado" | "sospecha";

// Maps wizard value → DB enum value. The CARD LABELS below are read back out
// of WELFARE_SEVERITY_CITIZEN_LABEL through this same map, so the words the
// reporter picks here are by construction the words every later citizen
// surface quotes back at them (blind QA 2026-08-19, O2: the wizard said
// "Grave / urgente" and the follow-up said "Crítica — peligro inmediato").
export const WIZARD_SEVERITY_TO_DB: Record<WizardSeverity, "critical" | "medium" | "low"> = {
  grave_urgente: "critical",
  moderado: "medium",
  sospecha: "low",
};

type SeverityCard = {
  value: WizardSeverity;
  label: string;
  description: string;
  icon: string;
  // Base (unselected) classes
  baseClass: string;
  // Selected classes
  selectedClass: string;
};

const SEVERITY_CARDS: SeverityCard[] = [
  {
    value: "grave_urgente",
    label: WELFARE_SEVERITY_CITIZEN_LABEL.critical,
    description: "El animal está en peligro inmediato o hay heridas visibles",
    icon: "sirena",
    baseClass:
      "border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-050)] text-[var(--color-ln-seal)]",
    selectedClass:
      "border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-050)] text-[var(--color-ln-seal)] shadow-[0_0_0_3px_rgba(162,58,44,.16)]",
  },
  {
    value: "moderado",
    label: WELFARE_SEVERITY_CITIZEN_LABEL.medium,
    description: "Condiciones de vida malas, abandono, descuido sostenido",
    icon: "alerta",
    baseClass:
      "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] text-[var(--color-ln-warn)]",
    selectedClass:
      "border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] text-[var(--color-ln-warn)] shadow-[0_0_0_3px_rgba(176,119,26,.16)]",
  },
  {
    value: "sospecha",
    label: WELFARE_SEVERITY_CITIZEN_LABEL.low,
    description: "Creo que algo no está bien, pero no estoy seguro/a",
    icon: "lupa",
    baseClass:
      "border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink)]",
    selectedClass:
      "border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] text-[var(--color-ln-ink)] shadow-[0_0_0_3px_rgba(14,90,153,.12)]",
  },
];

type Step2SeverityProps = {
  selected: WizardSeverity | null;
  onSelect: (severity: WizardSeverity) => void;
};

export function Step2Severity({ selected, onSelect }: Step2SeverityProps) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1
          className="text-2xl font-semibold tracking-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          ¿Qué tan grave es?
        </h1>
        <p className="text-sm text-[var(--color-ln-mute)]">
          Es tu mejor estimación. El equipo prioriza y verifica.
        </p>
      </div>

      <fieldset className="border-0 m-0 p-0">
        <legend className="sr-only">Gravedad de la situación (obligatorio)</legend>
        <ul className="space-y-3">
          {SEVERITY_CARDS.map((card) => {
            const isSelected = selected === card.value;
            return (
              <li key={card.value}>
                <label
                  className={`block rounded-[7px] border-2 px-4 py-3.5 cursor-pointer transition-shadow ${
                    isSelected ? card.selectedClass : card.baseClass
                  }`}
                >
                  {/* Visually hidden radio — semantics carried by the label */}
                  <input
                    type="radio"
                    name="severityCard"
                    value={card.value}
                    checked={isSelected}
                    onChange={() => onSelect(card.value)}
                    className="sr-only"
                  />
                  <span className="block" aria-hidden="true">
                    <Icon name={card.icon} size={22} decorative />
                  </span>
                  <span className="block mt-1 text-sm font-semibold">{card.label}</span>
                  <span className="block text-xs mt-0.5 leading-relaxed opacity-80">
                    {card.description}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      {/* UX 3.2 item 1 — Emergency off-ramp for grave/urgent severity.
          Shown ONLY when the reporter selects "grave_urgente". The async
          report flow still proceeds — this callout is an additional safety
          net so the reporter does not wait passively for an async system
          when an animal is in immediate danger.
          911 is the AR-wide emergency number (police + ambulance + fire). */}
      {selected === "grave_urgente" && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-[var(--radius-md)] border-2 border-[var(--color-ln-err-100)] bg-[var(--color-ln-err-050)] px-4 py-4 space-y-2"
        >
          <p className="text-sm font-bold text-[var(--color-ln-seal)]">
            Si el animal está en peligro inmediato, llamá al{" "}
            <strong className="text-[var(--color-ln-seal)]">911</strong> ahora.
          </p>
          <p className="text-xs text-[var(--color-ln-seal)] leading-relaxed">
            El 911 (emergencias) puede intervenir de forma inmediata. También podés comunicarte con
            el organismo de bienestar animal de tu municipio o provincia. Esta denuncia digital
            queda registrada como respaldo, pero no reemplaza la intervención urgente presencial.
          </p>
        </div>
      )}

      <p className="text-xs text-[var(--color-ln-mute)] text-center pt-2">
        No importa cuál elijas — todas las denuncias son revisadas por el equipo.
      </p>
    </section>
  );
}
