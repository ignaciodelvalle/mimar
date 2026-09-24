"use client";

// MapLegendsDynamic — la frontera perezosa de MapLegends (Lote E, paso 1).
//
// POR QUÉ ESTE Y NO OTRO. De los cinco candidatos a diferir en la consola de
// Panorama, éste es el único que no toca un solo `it` de los 103 tests de
// `PanoramaConsole.test.tsx` — medido: cero menciones a `MapLegends` en ese
// archivo. Su red viva (`MapLegends.test.tsx`,
// `__tests__/legend-suppression-parity.test.tsx`) importa el componente
// directo, así que esta frontera no la toca tampoco.
//
// Y vive en el tab "Referencias" del dock, que NO es el default (`dockTab`
// arranca en "stats"). Diferir algo del tab por defecto regalaría latencia en la
// primera interacción del operador a cambio de bytes — un trueque que la reja de
// peso no puede juzgar, porque sólo ve los bytes. Éste no tiene ese problema.
//
// `ssr: false` porque las leyendas describen lo que el mapa PINTA, y el mapa es
// cliente: no hay nada honesto que prerenderizar antes de que exista.

import dynamic from "next/dynamic";

import type { ComponentProps } from "react";

import type { MapLegends as MapLegendsType } from "./MapLegends";

const LazyMapLegends = dynamic(
  () => import("./MapLegends").then((m) => ({ default: m.MapLegends })),
  {
    ssr: false,
    // `min-height`, no altura fija: una altura fija sobre un componente cuyo
    // alto real depende de cuántas capas estén activas produce un salto al
    // resolver. El piso reserva lo mínimo y deja crecer.
    loading: () => (
      <div
        aria-busy="true"
        aria-label="Cargando referencias del mapa"
        className="min-h-24 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card"
      />
    ),
  },
);

export function MapLegendsDynamic(props: ComponentProps<typeof MapLegendsType>) {
  return <LazyMapLegends {...props} />;
}
