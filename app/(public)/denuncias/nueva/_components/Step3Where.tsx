"use client";

// Step 3 — Dónde y cuándo + qué viste.
// - LocationFields (mode="l2") for address autocomplete + map pin + derived jurisdiction.
// - Three radio options for "cuándo" that resolve to an ISO date string for occurredAt.
// - Textarea for description (maps to welfareReports.description).

import { useState } from "react";

import {
  LocationFields,
  type LocationFieldsChange,
  type LocationFieldsValue,
} from "@/components/LocationFields";
import { LnRadioGroup, LnTextarea } from "@/components/ui/Field";
import { parseDateInput, todayIsoInAr } from "@/lib/utils/format";

export type WhenOption = "now" | "today_yesterday" | "several_days_ago";

// Anchors on the Argentine calendar day, not the UTC day (a UTC anchor is
// silently off by one near midnight in Argentina — see todayIsoInAr in
// lib/utils/format.ts). todayAr is parsed back into a Date pinned at noon
// UTC of that AR calendar day (parseDateInput), so the day-arithmetic below
// stays correct in any timezone the code happens to run in.
function resolveOccurredAt(when: WhenOption): string {
  if (when === "now") return todayIsoInAr();

  const todayAr = parseDateInput(todayIsoInAr());
  if (!todayAr) return todayIsoInAr(); // unreachable: todayIsoInAr() is always well-formed

  switch (when) {
    case "today_yesterday": {
      const yesterday = new Date(todayAr);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      return yesterday.toISOString().slice(0, 10);
    }
    case "several_days_ago": {
      const fiveDaysAgo = new Date(todayAr);
      fiveDaysAgo.setUTCDate(fiveDaysAgo.getUTCDate() - 5);
      return fiveDaysAgo.toISOString().slice(0, 10);
    }
  }
}

export { resolveOccurredAt };

const WHEN_OPTIONS: { value: WhenOption; label: string; sublabel: string }[] = [
  { value: "now", label: "Ahora mismo", sublabel: "Estoy viendo la situación en este momento" },
  {
    value: "today_yesterday",
    label: "Hoy o ayer",
    sublabel: "Lo vi en las últimas 24-48 horas",
  },
  {
    value: "several_days_ago",
    label: "Hace varios días",
    sublabel: "Lo vi hace más de dos días",
  },
];

type Step3WhereProps = {
  when: WhenOption | null;
  description: string;
  onWhenChange: (when: WhenOption) => void;
  onDescriptionChange: (description: string) => void;
  // Notifies the wizard whether an exact map point is marked. The wizard gates
  // advancing on it — a denuncia must carry an exact location so the canonical
  // locality can be inferred from the point (FIX #3A).
  onPointPresenceChange: (hasPoint: boolean) => void;
  // Lifts LocationFields' derived value into the wizard so it owns the location
  // data (M-followup) instead of reading uncontrolled hidden inputs at submit.
  onLocationChange: (value: LocationFieldsChange) => void;
  // Restored draft location, if any. Seeds the picker so a reload shows the
  // point it says it kept — see the note on `locationKey` below.
  defaultLocation?: LocationFieldsValue | null;
  // Bumped once when a draft with coordinates is restored. LocationFields reads
  // `defaultValue` only in its useState initialisers, and the wizard restores
  // from localStorage in an effect that necessarily runs AFTER this child has
  // mounted — so without a remount the picker would keep its empty initial
  // state while the wizard believed a point existed.
  locationKey?: string | number;
  // We pass the error so the parent can show step-level validation.
  error?: string | null;
};

const DESCRIPTION_MAX = 2000;
const DESCRIPTION_TARGET = 500;

export function Step3Where({
  when,
  description,
  onWhenChange,
  onDescriptionChange,
  onPointPresenceChange,
  onLocationChange,
  defaultLocation,
  locationKey,
  error,
}: Step3WhereProps) {
  // The exact map point is REQUIRED (FIX #3A): a denuncia can only be routed to
  // the right authority when it carries a precise location, and the canonical
  // locality is inferred from that point. Track it locally to show the inline
  // requirement, and forward it so the wizard can block advancing.
  const [hasPoint, setHasPoint] = useState(false);

  function handlePointPresence(present: boolean) {
    setHasPoint(present);
    onPointPresenceChange(present);
  }

  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1
          className="text-2xl font-semibold tracking-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          ¿Dónde y cuándo?
        </h1>
        <p className="text-sm text-[var(--color-ln-mute)]">Contanos lo que viste y dónde pasó.</p>
      </div>

      {/* Description first — most important field */}
      <div className="space-y-1.5">
        <label
          htmlFor="description"
          className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
          style={{ fontFamily: "var(--font-ln-mono)" }}
        >
          {/* S1-F09 — SIN ASTERISCO. Era `aria-hidden`, o sea decoración pura:
              la obligatoriedad ya viaja a lectores de pantalla por el sr-only
              "(obligatorio)". Visualmente, en cambio, los pasos 1 y 2 no
              mostraban nada y el 3 mostraba asteriscos sin leyenda en ningún
              lado — y en "¿Cuándo pasó?" convivían las DOS marcas.
              Una sola convención: lo obligatorio no se marca, lo OPCIONAL sí.
              Es el conjunto chico y se explica solo, sin leyenda. */}
          Contanos lo que viste
        </label>
        <LnTextarea
          id="description"
          name="description"
          rows={5}
          maxLength={DESCRIPTION_MAX}
          placeholder="Describí la situación: qué pasó, cómo estaba el animal, dónde exactamente…"
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          aria-required="true"
          aria-describedby="description-hint"
        />
        {/* S1-F10 — EL CONTADOR CAMBIA DE ESTADO EN EL TECHO.
            Medido: el mismo gris en 100/2000, 1990/2000 y 2000/2000. Con el
            `maxLength` nativo, al llegar al límite las letras simplemente dejan
            de aparecer y NADA en pantalla lo explica. Este campo invita a un
            relato largo ("qué pasó, cómo estaba el animal, dónde exactamente")
            y lo escribe alguien que acaba de ver un animal maltratado: que se
            le corte el texto sin aviso es lo peor que puede hacer la pantalla.
            `aria-live="polite"` para que el aviso llegue también a quien no lo
            ve — el <p> ya es el `aria-describedby` del textarea. */}
        <p
          id="description-hint"
          aria-live="polite"
          className={`text-sm text-right ${
            description.length >= DESCRIPTION_MAX
              ? "font-semibold text-[var(--color-ln-warn)]"
              : "text-[var(--color-ln-faint)]"
          }`}
          style={{ fontFamily: "var(--font-ln-mono)" }}
        >
          {description.length} / {DESCRIPTION_MAX}
          {/* Two states, not one. ">= max" showed the SAME "llegaste al máximo"
              whether you were exactly at the limit or 50 characters past it
              (master test CIU, X1-a). The browser's maxlength stops normal
              typing and pasting, so the over state is only reachable by forcing
              the value — but a counter that reads "2050 / 2000 · llegaste al
              máximo" is telling the writer their text fits when it does not. */}
          {description.length === DESCRIPTION_MAX && (
            <span className="ml-1">· llegaste al máximo</span>
          )}
          {description.length > DESCRIPTION_MAX && (
            <span className="text-[var(--color-ln-err)] ml-1">
              · te pasaste por {description.length - DESCRIPTION_MAX}
            </span>
          )}
          {description.length < 20 && description.length > 0 && (
            <span className="text-[var(--color-ln-warn)] ml-1">(mínimo 20)</span>
          )}
        </p>
      </div>

      {/* When — RA-9 BR-6: requiredness reaches assistive tech via LnRadioGroup
          (role="radiogroup" + aria-required + sr-only "(obligatorio)") instead of
          an aria-hidden asterisk. */}
      <LnRadioGroup
        legend="¿Cuándo pasó?"
        required
        legendClassName="block font-ln-mono text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)] mb-2"
        optionsClassName="space-y-2"
      >
        {WHEN_OPTIONS.map((opt) => {
          const isSelected = when === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex items-center gap-3 rounded-[var(--radius-md)] border px-4 py-2.5 cursor-pointer transition-colors ${
                isSelected
                  ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)]"
                  : "border-[var(--color-ln-line)] bg-[var(--color-ln-card)] hover:border-[var(--color-ln-line-strong)]"
              }`}
            >
              <span
                className={`flex-shrink-0 w-4 h-4 rounded-full border-2 ${
                  isSelected
                    ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-azul)] shadow-[inset_0_0_0_3px_white]"
                    : "border-[var(--color-ln-line-strong)]"
                }`}
                aria-hidden="true"
              />
              <input
                type="radio"
                name="occurredAtOption"
                value={opt.value}
                checked={isSelected}
                onChange={() => onWhenChange(opt.value)}
                className="sr-only"
              />
              <span>
                <span className="block text-sm font-semibold text-[var(--color-ln-ink)]">
                  {opt.label}
                </span>
                <span className="block text-xs text-[var(--color-ln-mute)] mt-0.5">
                  {opt.sublabel}
                </span>
              </span>
            </label>
          );
        })}
      </LnRadioGroup>

      {/* Location — uses the shared LocationFields component in L2 mode
          (jurisdiction + postal address + map; see AGENTS.md "Design rules"
          rule #1). Fields are uncontrolled; the wizard reads them via
          FormData at submit. */}
      <div className="space-y-1.5">
        <p
          className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)] mb-2"
          style={{ fontFamily: "var(--font-ln-mono)" }}
        >
          {/* Sin asterisco — ver S1-F09 arriba. */}
          Marcá el lugar exacto en el mapa
        </p>
        <LocationFields
          key={locationKey}
          mode="l2"
          allowAnonymous
          useMyLocationVariant="primary"
          defaultValue={defaultLocation ?? undefined}
          onPointPresenceChange={handlePointPresence}
          onChange={onLocationChange}
        />
        {!hasPoint && (
          <output className="mt-2 block rounded-[var(--radius-sm)] border border-[var(--color-ln-warn-100)] bg-[var(--color-ln-warn-025)] px-3 py-2 text-md text-[var(--color-ln-warn)] leading-snug">
            Marcá el lugar exacto tocando el mapa, arrastrando el pin o con “Usar mi ubicación”. La
            denuncia necesita un punto preciso para llegar a la autoridad de esa zona.
          </output>
        )}
      </div>

      {error && (
        <p
          className="text-sm text-[var(--color-ln-seal)] rounded-[var(--radius-sm)] bg-[var(--color-ln-err-050)] border border-[var(--color-ln-err-100)] px-3 py-2"
          role="alert"
        >
          {error}
        </p>
      )}
    </section>
  );
}
