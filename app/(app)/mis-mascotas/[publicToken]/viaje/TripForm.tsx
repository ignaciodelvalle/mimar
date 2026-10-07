"use client";

// Record a trip (viajes-fase-2, task 5.3). Posts to recordTripAction
// (src/modules/pets/travel-actions.ts) — the same use-case
// `POST /api/v1/pets/{publicToken}/travel` `record_trip` runs.
//
// v14 ("Viaje en pasos", design part 1): THE SAME FORM, CHAINED. Each answer
// narrows the next one, from the same option objects the native screen reads
// (`options` of the v1 payload, built by travel-options.ts):
//   · the destination decides which ways of going are offered (CORRIDOR_MODES;
//     one only → the question is skipped);
//   · going by air shows the airlines, the destination's suggested ones first
//     and every other one a search away ("Buscar otra aerolínea") — a
//     SUGGESTED ORDER, never a rule (PO 2026-10-07);
//   · the airline decides which of cabin, hold and cargo are offered, with the
//     weight it publishes;
//   · the date comes last, with the destination's deadlines beside it, worded
//     by the server and about the rules only, never about the animal.
// "Otro país" records nothing: the contract carries five destinations (spec
// R3.3), so it says what miMAR does not check and where to look instead.
// The step-by-step WizardShell is the next version's.
//
// IDEMPOTENCY. The hidden `idempotencyKey` is minted by the page (server) for
// the first submit and renewed here after each success, so a double submit of
// one filled form is ONE trip — the replay answers the first write.
//
// React 19 resets the form when the action settles, error included, so every
// field re-seeds from useKeptFields (each select with a changing `key`); after
// a SUCCESS it re-seeds from nothing, which is what clears the form for the
// next trip. The filters' own state re-seeds from the same values.

import { type ReactNode, useActionState, useEffect, useMemo, useState } from "react";

import { LnButton } from "@/components/ui/Button";
import { DateInputAr } from "@/components/ui/DateInputAr";
import { LN_CONTROL_MONO_CLASS, LnField, LnInput, LnSelect } from "@/components/ui/Field";
import { useActionRedirect } from "@/lib/ui/use-action-redirect";
import { useKeptFields } from "@/lib/ui/use-kept-fields";
import type { TravelFormState } from "@/src/modules/pets/application/travel/types";
import {
  CORRIDOR_MODES,
  PET_TRAVEL_MODALITY_LABELS,
  PET_TRAVEL_MODE_LABELS,
  type PetTravelAirlineModalityV1,
  type PetTravelAirlineOptionV1,
  type PetTravelCorridorOptionV1,
  type PetTravelModeV1,
} from "@dim/contract/api";
import type { TravelCorridorId } from "@dim/contract/input";

const initialState: TravelFormState = { error: null };

type FormAction = (prev: TravelFormState, formData: FormData) => Promise<TravelFormState>;

/** The "Otro país" choice: not a destination, never posted as one. */
export const OTHER_COUNTRY = "otro";

/** Where the owner looks for a destination miMAR does not check. */
export const DESTINATION_REQUIREMENTS_URL =
  "https://www.argentina.gob.ar/senasa/requisitos-particulares-por-destino";

const ALL_MODES: readonly PetTravelModeV1[] = ["air", "land", "sea"];

/** The modes a destination offers; every mode before one is chosen. */
export function modesFor(corridorId: string): readonly PetTravelModeV1[] {
  return (CORRIDOR_MODES as Record<string, readonly PetTravelModeV1[]>)[corridorId] ?? ALL_MODES;
}

/** Suggested airlines for the destination first, then the rest — never fewer. */
export function airlinesFor(
  airlines: readonly PetTravelAirlineOptionV1[],
  corridorId: string,
  search: string,
): { suggested: PetTravelAirlineOptionV1[]; others: PetTravelAirlineOptionV1[] } {
  const isSuggested = (a: PetTravelAirlineOptionV1) =>
    corridorId !== "" && (a.corridors ?? []).includes(corridorId);
  const needle = search.trim().toLocaleLowerCase("es-AR");
  return {
    suggested: airlines.filter(isSuggested),
    others: airlines.filter(
      (a) =>
        !isSuggested(a) && (needle === "" || a.name.toLocaleLowerCase("es-AR").includes(needle)),
    ),
  };
}

/** "En cabina · hasta 7 kg con el bolso" — what the airline publishes. */
export function modalityOptionLabel(m: PetTravelAirlineModalityV1): string {
  const parts = [PET_TRAVEL_MODALITY_LABELS[m.modality]];
  if (m.maxWeightKg !== null) {
    parts.push(`hasta ${m.maxWeightKg} kg${m.includesCarrier ? " con el bolso o canil" : ""}`);
  }
  if (m.offered === "restricted") parts.push("con restricciones");
  return parts.join(" · ");
}

const DAY_MS = 86_400_000;

/**
 * The callout look with BLOCK content: LnCallout wraps its children in a <p>,
 * and a list inside a paragraph is invalid HTML that breaks hydration.
 */
function TripCallout({
  tone,
  title,
  children,
}: {
  tone: "azul" | "warn";
  title: string;
  children: ReactNode;
}) {
  const colors =
    tone === "warn"
      ? "bg-[var(--color-ln-warn-025)] border-[var(--color-ln-warn-100)] [border-left-color:var(--color-ln-warn)]"
      : "bg-[var(--color-ln-celeste-050)] border-[var(--color-ln-celeste-100)] [border-left-color:var(--color-ln-azul)]";
  return (
    <div className={`rounded-[var(--radius-sm)] border border-l-[3px] px-3.5 py-3 ${colors}`}>
      <p className="mb-1 text-md font-semibold text-[var(--color-ln-ink)]">{title}</p>
      <div className="text-sm leading-[1.5] text-[var(--color-ln-ink-2)]">{children}</div>
    </div>
  );
}

/** Days from today (AR) to an ISO day; null when not a full date. */
function daysUntil(iso: string, todayIso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return Math.round(
    (Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${todayIso}T12:00:00Z`)) / DAY_MS,
  );
}

function LeadHints({
  corridor,
  travelIso,
  todayIso,
}: {
  corridor: PetTravelCorridorOptionV1;
  travelIso: string;
  todayIso: string;
}) {
  const hints = corridor.leadHints ?? [];
  if (hints.length === 0) return null;
  const days = daysUntil(travelIso, todayIso);
  const lead = corridor.leadDays ?? null;
  const tight = days !== null && lead !== null && days >= 0 && days < lead;
  return (
    <TripCallout
      tone={tight ? "warn" : "azul"}
      title={
        tight
          ? `Faltan ${days} ${days === 1 ? "día" : "días"}: algunos plazos de ${corridor.label} piden más tiempo`
          : `Para ${corridor.label}, con tiempo`
      }
    >
      <ul className="list-disc space-y-1 pl-4">
        {hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
    </TripCallout>
  );
}

export function TripForm({
  action,
  corridors,
  airlines,
  initialIdempotencyKey,
  initialCorridorId = "",
  todayIso,
}: {
  action: FormAction;
  corridors: PetTravelCorridorOptionV1[];
  airlines: PetTravelAirlineOptionV1[];
  initialIdempotencyKey: string;
  /** A destination shortcut ("?destino=chile") picks it in advance. */
  initialCorridorId?: string;
  /** Today's Argentine day, `YYYY-MM-DD`, from the server. */
  todayIso: string;
}) {
  const { boundAction, kept } = useKeptFields<TravelFormState>(action);
  const [state, formAction, isPending] = useActionState(boundAction, initialState);
  const [idempotencyKey, setIdempotencyKey] = useState(initialIdempotencyKey);
  // The page reloads as a full document onto the new trip (N3 contract).
  const navigating = useActionRedirect(state.redirectTo, state);
  const busy = isPending || navigating;

  // After a success nothing is kept — the form clears for the next trip.
  const seed = (name: string) => (state.ok ? "" : kept(name));

  // The filters. Each select is uncontrolled (defaultValue + key, the
  // kept-fields contract); these mirror what it shows, to narrow the next one.
  const [corridorId, setCorridorId] = useState(initialCorridorId);
  const [mode, setMode] = useState("");
  const [airlineId, setAirlineId] = useState("");
  const [travelIso, setTravelIso] = useState("");
  const [search, setSearch] = useState("");

  // A settled action re-seeds every field; the filters follow the same values.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seed` reads the ref useKeptFields fills at submit; `state` is the settle signal.
  useEffect(() => {
    if (state === initialState) return;
    if (state.ok) setIdempotencyKey(crypto.randomUUID());
    setCorridorId(seed("corridorId"));
    setMode(seed("mode"));
    setAirlineId(seed("airlineId"));
    setTravelIso(seed("travelDate"));
    setSearch("");
  }, [state]);

  const corridor = corridors.find((c) => c.id === corridorId) ?? null;
  const other = corridorId === OTHER_COUNTRY;
  const modes = modesFor(corridorId);
  const onlyMode = corridor && modes.length === 1 ? modes[0] : null;
  const effectiveMode = onlyMode ?? mode;
  const { suggested, others } = useMemo(
    () => airlinesFor(airlines, corridor ? corridorId : "", search),
    [airlines, corridor, corridorId, search],
  );
  const airline = airlines.find((a) => a.id === airlineId) ?? null;
  const offered = airline?.modalities ?? null;

  // A select keyed by what it holds remounts when a filter above it changes.
  const fieldKey = (name: string) => `${name}-${seed(name)}-${idempotencyKey}-${corridorId}`;

  return (
    <form action={formAction} className="flex flex-col gap-3.5">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <LnField label="Destino" required>
        {({ id, describedBy }) => (
          <LnSelect
            id={id}
            name="corridorId"
            key={`corridorId-${seed("corridorId") || initialCorridorId}-${idempotencyKey}`}
            defaultValue={seed("corridorId") || initialCorridorId}
            required
            aria-describedby={describedBy}
            onChange={(e) => {
              setCorridorId(e.currentTarget.value);
              setMode("");
              setAirlineId("");
              setSearch("");
            }}
          >
            <option value="">Elegí el país</option>
            {corridors.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
            <option value={OTHER_COUNTRY}>Otro país</option>
          </LnSelect>
        )}
      </LnField>

      {other && (
        <TripCallout tone="azul" title="Ese destino no está entre los que miMAR revisa">
          <p>
            Por ahora miMAR compara la libreta con los requisitos de{" "}
            {corridors.map((c) => c.label).join(", ")}. Para otro país, revisá los requisitos por
            destino en el sitio oficial antes de sacar el pasaje.
          </p>
          <p className="mt-1.5">
            <a
              href={DESTINATION_REQUIREMENTS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[var(--color-ln-azul)] underline"
            >
              Ver requisitos por país
            </a>
          </p>
        </TripCallout>
      )}

      {!other && onlyMode && corridor && (
        <>
          <input type="hidden" name="mode" value={onlyMode} />
          <p className="text-sm text-[var(--color-ln-ink-2)]">
            A {corridor.label}, {PET_TRAVEL_MODE_LABELS[onlyMode].toLowerCase()}: es la única forma
            de viajar que miMAR revisa para ese destino.
          </p>
        </>
      )}

      {!other && !onlyMode && (
        <LnField
          label="Cómo viajan"
          hint={
            corridor
              ? `Solo las formas de llegar a ${corridor.label}.`
              : "Elegí el destino para ver las formas de llegar."
          }
        >
          {({ id, describedBy }) => (
            <LnSelect
              id={id}
              name="mode"
              key={`${fieldKey("mode")}`}
              defaultValue={modes.includes(seed("mode") as PetTravelModeV1) ? seed("mode") : ""}
              aria-describedby={describedBy}
              onChange={(e) => {
                setMode(e.currentTarget.value);
                setAirlineId("");
              }}
            >
              <option value="">Todavía no sé</option>
              {modes.map((m) => (
                <option key={m} value={m}>
                  {PET_TRAVEL_MODE_LABELS[m]}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>
      )}

      {!other && effectiveMode === "air" && (
        <>
          <LnField
            label="Buscar otra aerolínea"
            hint="Busca entre todas las aerolíneas que miMAR conoce."
          >
            {({ id, describedBy }) => (
              <LnInput
                id={id}
                type="search"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                aria-describedby={describedBy}
                autoComplete="off"
              />
            )}
          </LnField>
          <LnField
            label="Aerolínea"
            hint={
              corridor
                ? `Primero, las que suelen volar a ${corridor.label}: es un orden sugerido, verificá con tu aerolínea.`
                : undefined
            }
          >
            {({ id, describedBy }) => (
              <LnSelect
                id={id}
                name="airlineId"
                key={`${fieldKey("airlineId")}-${search}`}
                defaultValue={airlineId || seed("airlineId")}
                aria-describedby={describedBy}
                onChange={(e) => setAirlineId(e.currentTarget.value)}
              >
                <option value="">Todavía no sé</option>
                {suggested.length > 0 && (
                  <optgroup label={`Vuelan a ${corridor?.label ?? "este destino"}`}>
                    {suggested.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label={suggested.length > 0 ? "Otras aerolíneas" : "Aerolíneas"}>
                  {others.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                  {/* The chosen one never disappears behind a search. */}
                  {airline && !suggested.includes(airline) && !others.includes(airline) && (
                    <option value={airline.id}>{airline.name}</option>
                  )}
                </optgroup>
              </LnSelect>
            )}
          </LnField>
        </>
      )}

      {!other && effectiveMode === "air" && airline && (
        <LnField
          label="Dónde viaja la mascota"
          hint={
            offered && offered.length > 0
              ? `Lo que ${airline.name} publica. Puede cambiar: verificá con tu aerolínea.`
              : `${airline.name} no publica cabina, bodega ni carga para mascotas.`
          }
        >
          {({ id, describedBy }) => (
            <LnSelect
              id={id}
              name="intendedModality"
              key={`${fieldKey("intendedModality")}-${airlineId}`}
              defaultValue={seed("intendedModality")}
              aria-describedby={describedBy}
            >
              <option value="">Todavía no sé</option>
              {(offered ?? []).map((m) => (
                <option key={m.modality} value={m.modality}>
                  {modalityOptionLabel(m)}
                </option>
              ))}
            </LnSelect>
          )}
        </LnField>
      )}

      {!other && (
        <LnField label="Fecha de salida" required>
          {({ id, describedBy, invalid }) => (
            <DateInputAr
              key={`travelDate-${seed("travelDate")}-${idempotencyKey}`}
              id={id}
              name="travelDate"
              defaultValue={seed("travelDate")}
              required
              ariaDescribedBy={describedBy}
              aria-invalid={invalid}
              className={LN_CONTROL_MONO_CLASS}
              onHiddenValueChange={setTravelIso}
            />
          )}
        </LnField>
      )}

      {!other && corridor && (
        <LeadHints corridor={corridor} travelIso={travelIso} todayIso={todayIso} />
      )}

      {state.error && (
        <p className="font-ln-mono text-sm text-[var(--color-ln-err)]" role="alert">
          {state.error}
        </p>
      )}
      {state.ok && (
        <output className="block text-sm text-[var(--color-ln-ok)]">Viaje creado.</output>
      )}

      <LnButton type="submit" variant="primary" size="lg" block loading={busy} disabled={other}>
        {busy ? "Creando…" : "Crear viaje"}
      </LnButton>
    </form>
  );
}

/** The destination ids a shortcut may preselect. */
export function isShortcutCorridor(value: unknown): value is TravelCorridorId {
  return typeof value === "string" && Object.hasOwn(CORRIDOR_MODES, value);
}
