"use client";

// Step 1 — Qué pasó: single-select kind cards.
// Tap a card → immediately advances to the next step.

import { Icon } from "@/components/Icon";
import {
  WELFARE_REPORT_KINDS,
  type WelfareReportKind,
  welfareReportKindLabel,
} from "@/src/modules/welfare/domain/types";

// Sober lucide icons (via the Icon registry) — one per welfare-report kind.
// The category picker keeps a glanceable icon column, but the tone stays
// gov-grade: no emoji on a cruelty-report flow.
const KIND_ICONS: Record<WelfareReportKind, string> = {
  abandonment: "door-open",
  neglect: "droplets",
  physical_abuse: "shield-alert",
  chained: "cadena",
  no_shelter: "cloud-rain",
  hoarding: "warehouse",
  dog_fighting: "espadas",
  trafficking: "package",
  other: "help-circle",
};

const KIND_DESCRIPTIONS: Record<WelfareReportKind, string> = {
  abandonment: "Animal dejado solo, sin cuidado ni dueño",
  neglect: "Sin agua, comida o atención veterinaria",
  physical_abuse: "Golpes, heridas o lesiones visibles",
  chained: "Encadenado o sin posibilidad de moverse",
  no_shelter: "Expuesto al frío, calor o lluvia sin refugio",
  hoarding: "Muchos animales en malas condiciones",
  dog_fighting: "Evidencia de peleas organizadas",
  trafficking: "Venta o transporte clandestino",
  other: "Otra situación que te preocupa",
};

type Step1KindProps = {
  selected: WelfareReportKind | null;
  onSelect: (kind: WelfareReportKind) => void;
};

export function Step1Kind({ selected, onSelect }: Step1KindProps) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h1
          className="text-2xl font-semibold tracking-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          ¿Qué pasó?
        </h1>
        <p className="text-sm text-[var(--color-ln-mute)]">
          Elegí lo que más se parece a lo que viste. Después podés contar el detalle.
        </p>
      </div>

      <fieldset className="border-0 m-0 p-0">
        <legend className="sr-only">Tipo de situación (obligatorio)</legend>
        <ul className="space-y-2">
          {WELFARE_REPORT_KINDS.map((kind) => {
            const isSelected = selected === kind;
            return (
              <li key={kind}>
                <label
                  className={`flex items-center gap-3 rounded-[var(--radius-md)] border px-4 py-3.5 cursor-pointer transition-colors ${
                    isSelected
                      ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] shadow-[inset_0_0_0_1px_var(--color-ln-azul)]"
                      : "border-[var(--color-ln-line)] bg-[var(--color-ln-card)] hover:border-[var(--color-ln-line-strong)]"
                  }`}
                >
                  {/* Visually hidden radio — semantics carried by the label */}
                  <input
                    type="radio"
                    name="kindCard"
                    value={kind}
                    checked={isSelected}
                    onChange={() => onSelect(kind)}
                    className="sr-only"
                  />
                  <span className="flex-shrink-0 w-6 flex items-center justify-center text-[var(--color-ln-mute)]">
                    <Icon name={KIND_ICONS[kind]} size="md" decorative />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-[var(--color-ln-ink)]">
                      {welfareReportKindLabel(kind)}
                    </span>
                    <span className="block text-xs text-[var(--color-ln-mute)] mt-0.5">
                      {KIND_DESCRIPTIONS[kind]}
                    </span>
                  </span>
                  <span
                    className={`flex-shrink-0 w-[18px] h-[18px] rounded-full border-2 ml-auto ${
                      isSelected
                        ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] shadow-[inset_0_0_0_3px_white]"
                        : "border-[var(--color-ln-line-strong)]"
                    }`}
                    aria-hidden="true"
                  />
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>
    </section>
  );
}
