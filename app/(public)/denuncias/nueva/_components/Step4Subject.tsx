"use client";

// Step 4 — Sobre quién (opcional pero recomendado).
// Two main cards: "Una mascota" / "Animal sin dueño / no lo sé".
// Tertiary option: "Edificio / persona / lugar" → subjectKind='location'.
//
// Chip / token lookup vivo (handoff P4-2a): debounced call to
// lookupPetForDenunciaAction. On match shows a small preview "Esta
// mascota está registrada como {nombre} ({estado}). Dueño:
// {iniciales}." — non-leaky projection from the public action.

import { useEffect, useState, useTransition } from "react";

import {
  type PublicLookupResult,
  lookupPetForDenunciaAction,
} from "@/app/actions/pet-lookup-public";
import { Icon } from "@/components/Icon";
import { LnInput, LnTextarea } from "@/components/ui/Field";

const LOOKUP_DEBOUNCE_MS = 300;
const LOOKUP_MIN_LEN = 8;

export type SubjectKindWizard = "registered_pet" | "unowned_animal" | "location";

const SUBJECT_CARDS = [
  {
    value: "registered_pet" as SubjectKindWizard,
    label: "Una mascota",
    description: "El animal tiene o puede tener dueño",
    icon: "huella",
  },
  {
    value: "unowned_animal" as SubjectKindWizard,
    label: "Animal sin dueño / no lo sé",
    description: "Callejero, abandonado, o no sé si tiene dueño",
    icon: "huella",
  },
];

type Step4SubjectProps = {
  subjectKind: SubjectKindWizard | null;
  subjectPetToken: string;
  subjectDescription: string;
  onSubjectKindChange: (kind: SubjectKindWizard) => void;
  onSubjectPetTokenChange: (token: string) => void;
  onSubjectDescriptionChange: (desc: string) => void;
  error?: string | null;
};

export function Step4Subject({
  subjectKind,
  subjectPetToken,
  subjectDescription,
  onSubjectKindChange,
  onSubjectPetTokenChange,
  onSubjectDescriptionChange,
  error,
}: Step4SubjectProps) {
  return (
    <section className="space-y-5">
      <div className="space-y-1">
        <h1
          className="text-2xl font-semibold tracking-tight text-[var(--color-ln-ink)]"
          style={{ fontFamily: "var(--font-ln-serif)" }}
        >
          ¿Sobre quién?
        </h1>
        <p className="text-sm text-[var(--color-ln-mute)]">
          Esto es opcional, pero ayuda a la investigación. Si no sabés, podés saltearlo.
        </p>
      </div>

      {/* Main two cards */}
      <ul className="space-y-2">
        {SUBJECT_CARDS.map((card) => {
          const isSelected = subjectKind === card.value;
          return (
            <li key={card.value}>
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
                  name="subjectKindCard"
                  value={card.value}
                  checked={isSelected}
                  onChange={() => onSubjectKindChange(card.value)}
                  className="sr-only"
                />
                <span className="flex-shrink-0 w-6 flex items-center justify-center text-[var(--color-ln-mute)]">
                  <Icon name={card.icon} size="md" decorative />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-semibold text-[var(--color-ln-ink)]">
                    {card.label}
                  </span>
                  <span className="block text-xs text-[var(--color-ln-mute)] mt-0.5">
                    {card.description}
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

      {/* Tertiary: location / building */}
      <button
        type="button"
        onClick={() => onSubjectKindChange("location")}
        className={`w-full text-left rounded-[var(--radius-md)] border px-4 py-3 text-sm transition-colors ${
          subjectKind === "location"
            ? "border-[var(--color-ln-azul)] bg-[var(--color-ln-celeste-050)] shadow-[inset_0_0_0_1px_var(--color-ln-azul)] font-semibold text-[var(--color-ln-ink)]"
            : "border-dashed border-[var(--color-ln-line-strong)] text-[var(--color-ln-mute)] hover:border-[var(--color-ln-line-strong)] bg-[var(--color-ln-card)]"
        }`}
      >
        <span className="flex items-center gap-1.5">
          <Icon name="edificio" size="sm" decorative />
          Edificio / persona / lugar específico
        </span>
      </button>

      {/* Conditional fields */}
      {subjectKind === "registered_pet" && (
        <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-stripe)] p-4">
          <div className="space-y-1.5">
            <label
              htmlFor="subjectPetToken"
              className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              {/* S1-F09 — sin "(opcional)" por campo. TODO este paso lo es, y
                  su encabezado ya lo dice ("Esto es opcional, pero ayuda a la
                  investigación"). Marcarlo acá y no en los tres campos de
                  descripción sugería que esos SÍ eran obligatorios. Una sola
                  declaración, a nivel de paso. */}
              Código miMAR o microchip
            </label>
            <LnInput
              id="subjectPetToken"
              name="subjectPetToken"
              type="text"
              placeholder="Ej: DIM-XXXX-XXXX o 15 dígitos del chip"
              value={subjectPetToken}
              onChange={(e) => onSubjectPetTokenChange(e.target.value)}
              className="font-ln-mono uppercase"
              autoCapitalize="characters"
            />
            <p className="text-xs text-[var(--color-ln-mute)]">
              Si no lo sabés, no es obligatorio. Dejalo vacío.
            </p>
            <PetLookupPreview query={subjectPetToken} />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="subjectDescription"
              className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
              style={{ fontFamily: "var(--font-ln-mono)" }}
            >
              Descripción del animal
            </label>
            <LnTextarea
              id="subjectDescription"
              name="subjectDescription"
              rows={3}
              placeholder="Especie, color, tamaño, señas particulares…"
              value={subjectDescription}
              onChange={(e) => onSubjectDescriptionChange(e.target.value)}
            />
          </div>
        </div>
      )}

      {subjectKind === "unowned_animal" && (
        <div className="space-y-1.5">
          <label
            htmlFor="subjectDescription"
            className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            Describí al animal
          </label>
          <LnTextarea
            id="subjectDescription"
            name="subjectDescription"
            rows={3}
            placeholder="Especie, color, tamaño, señas particulares…"
            value={subjectDescription}
            onChange={(e) => onSubjectDescriptionChange(e.target.value)}
          />
        </div>
      )}

      {subjectKind === "location" && (
        <div className="space-y-1.5">
          <label
            htmlFor="subjectDescription"
            className="block text-xs font-semibold uppercase tracking-[.08em] text-[var(--color-ln-mute)]"
            style={{ fontFamily: "var(--font-ln-mono)" }}
          >
            Describí el lugar o situación
          </label>
          <LnTextarea
            id="subjectDescription"
            name="subjectDescription"
            rows={3}
            placeholder="Dirección, edificio, características…"
            value={subjectDescription}
            onChange={(e) => onSubjectDescriptionChange(e.target.value)}
          />
        </div>
      )}

      {error && (
        <p
          className="text-sm text-[var(--color-ln-seal)] rounded-[var(--radius-sm)] bg-[var(--color-ln-err-050)] border border-[var(--color-ln-err-100)] px-3 py-2"
          role="alert"
        >
          {error}
        </p>
      )}

      <p className="text-xs text-[var(--color-ln-mute)] text-center">
        Podés saltear este paso. Tus datos anteriores ya son suficientes.
      </p>
    </section>
  );
}

// Debounced lookup against lookupPetForDenunciaAction. Renders a small
// preview chip when the query matches a registered pet; silent on misses
// (no "not found" copy — that's noisy when the user is mid-typing).
function PetLookupPreview({ query }: { query: string }) {
  const [result, setResult] = useState<PublicLookupResult | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < LOOKUP_MIN_LEN) {
      setResult(null);
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const r = await lookupPetForDenunciaAction(trimmed);
        setResult(r);
      });
    }, LOOKUP_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  if (pending) {
    return <p className="text-xs text-[var(--color-ln-mute)]">Buscando…</p>;
  }
  if (!result || !result.found) return null;

  const statusLabel =
    result.petStatus === "lost"
      ? "perdida"
      : result.petStatus === "deceased"
        ? "fallecida"
        : "activa";

  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--color-ln-ok-100)] bg-[var(--color-ln-ok-050)] px-3 py-2 text-xs text-[var(--color-ln-ink)]">
      <p>
        <Icon name="check" size="sm" decorative className="inline align-text-bottom mr-1" />
        {/* Confirms the CODE matched a registered pet — nothing about who owns
            it. The owner's initials used to render here; see types.ts for why
            they are gone. This box is read by an anonymous person filing a
            mistreatment complaint, holding a tag they can read off the animal. */}
        Esta mascota está registrada como <span className="font-semibold">{result.petName}</span>{" "}
        <span className="text-[var(--color-ln-mute)]">({statusLabel})</span>
      </p>
    </div>
  );
}
