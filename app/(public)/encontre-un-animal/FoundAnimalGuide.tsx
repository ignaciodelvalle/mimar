"use client";

// The three blocks of /encontre-un-animal, driven by ONE input: the locality
// where the animal was found, picked from the catalogue (W8 — never the
// device's location). The pick is sent once, in a server action's body; the
// page's URL never carries it and nothing stores it.

import Link from "next/link";
import { useRef, useState, useTransition } from "react";

import { searchLocalitiesPublicAction } from "@/app/actions/localities";
import { LocalityPickerAcross } from "@/components/LocalityPickerAcross";
import { NearbyFallbackNotice, NearbyOrgList } from "@/components/found-help/NearbyOrgList";
import type { LocalitySearchResult } from "@/lib/infra/ar-localidades";
import type { NearbyHelp } from "@/src/modules/organizations/domain/nearby-help";
import { findNearbyHelpAction } from "@/src/modules/organizations/found-animal-actions";

type Lookup =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "done"; help: NearbyHelp }
  | { state: "error"; message: string };

const ERROR_COPY = {
  rate_limited: "Hiciste muchas búsquedas seguidas. Esperá un minuto y volvé a intentarlo.",
  invalid_place: "No reconocemos esa localidad. Elegila de la lista.",
  unavailable: "No pudimos buscar en este momento. Probá de nuevo en unos segundos.",
} as const;

const PICK_FIRST = "Elegí arriba la localidad donde lo encontraste.";

function perdidasHref(pick: LocalitySearchResult | null): string {
  if (!pick) return "/perdidas";
  const params = new URLSearchParams();
  params.set("provincia", pick.provinceName);
  params.set("localidad", pick.localityName);
  return `/perdidas?${params.toString()}`;
}

function Step({
  n,
  title,
  testId,
  children,
}: {
  n: number;
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className="space-y-3 rounded-[var(--radius-md)] border border-[var(--color-ln-line)] bg-[var(--color-ln-card)] p-4 sm:p-5"
      aria-labelledby={`${testId}-title`}
      data-testid={testId}
    >
      <h2
        id={`${testId}-title`}
        className="flex items-baseline gap-2 text-lg font-semibold text-[var(--color-ln-ink)]"
      >
        <span className="font-ln-mono text-sm text-[var(--color-ln-mute)]">{n}.</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function FoundAnimalGuide() {
  const [pick, setPick] = useState<LocalitySearchResult | null>(null);
  const [lookup, setLookup] = useState<Lookup>({ state: "idle" });
  const [, startTransition] = useTransition();
  // Only the LATEST pick may fill the blocks: a slower answer for an earlier
  // pick must not land under the later pick's /perdidas link.
  const latestRequest = useRef(0);

  function handleSelect(selected: LocalitySearchResult | null) {
    setPick(selected);
    if (!selected) {
      latestRequest.current += 1;
      setLookup({ state: "idle" });
      return;
    }
    setLookup({ state: "loading" });
    latestRequest.current += 1;
    const request = latestRequest.current;
    startTransition(async () => {
      const result = await findNearbyHelpAction({ localityId: selected.id, includeVets: true });
      if (request !== latestRequest.current) return;
      setLookup(
        result.ok
          ? { state: "done", help: result.help }
          : { state: "error", message: ERROR_COPY[result.error] },
      );
    });
  }

  const help = lookup.state === "done" ? lookup.help : null;

  function pending(): React.ReactNode {
    if (lookup.state === "loading") {
      return (
        <p className="text-sm text-[var(--color-ln-mute)]" aria-live="polite">
          Buscando…
        </p>
      );
    }
    if (lookup.state === "error") {
      return (
        <p className="text-sm text-[var(--color-ln-seal)]" role="alert">
          {lookup.message}
        </p>
      );
    }
    return <p className="text-sm text-[var(--color-ln-mute)]">{PICK_FIRST}</p>;
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <label
          htmlFor="lugar-encontrado-input"
          className="block text-sm font-medium text-[var(--color-ln-ink-2)]"
        >
          ¿Dónde lo encontraste?
        </label>
        <LocalityPickerAcross
          id="lugar-encontrado"
          name="lugarEncontrado"
          searchAction={searchLocalitiesPublicAction}
          onSelect={handleSelect}
          onDeselect={() => handleSelect(null)}
        />
        <p className="text-xs text-[var(--color-ln-faint)]">
          Solo la localidad o el barrio. No guardamos dónde estás.
        </p>
      </div>

      <Step n={1} title="Fijate si tiene chip" testId="found-step-chip">
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Cualquier veterinaria lo lee gratis: es un lector que se pasa por el lomo, no duele y
          tarda segundos. Con el número del chip se puede buscar a su familia.
        </p>
        {help ? (
          help.vets.length > 0 ? (
            <NearbyOrgList cards={help.vets} label="Veterinarias cercanas" />
          ) : (
            <p className="text-sm text-[var(--color-ln-mute)]">
              No encontramos veterinarias del directorio cerca de esa localidad. Cualquier
              veterinaria de la zona puede leer el chip.
            </p>
          )
        ) : (
          pending()
        )}
      </Step>

      <Step n={2} title="Buscá a su familia" testId="found-step-perdidas">
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Mirá si alguien lo está buscando: las familias publican a sus mascotas perdidas con foto y
          zona.
        </p>
        <Link
          href={perdidasHref(pick)}
          className="inline-block text-sm font-medium text-[var(--color-ln-azul)] underline underline-offset-4"
        >
          {pick ? `Ver mascotas perdidas en ${pick.localityName}` : "Ver mascotas perdidas"}
        </Link>
      </Step>

      <Step n={3} title="Si no podés tenerlo hasta que lo busquen" testId="found-step-receivers">
        <p className="text-sm text-[var(--color-ln-ink-2)]">
          Estas organizaciones cercanas reciben animales encontrados. Escribiles antes de llevarlo:
          su lugar cambia día a día.
        </p>
        {help ? (
          help.receivers.length > 0 ? (
            <NearbyOrgList cards={help.receivers} label="Organizaciones que reciben" />
          ) : (
            help.fallback && <NearbyFallbackNotice fallback={help.fallback} />
          )
        ) : (
          pending()
        )}
      </Step>
    </div>
  );
}
