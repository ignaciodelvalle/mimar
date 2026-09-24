"use client";

// TimeScrubberDynamic — la frontera perezosa del TimeScrubber (Lote E, paso 3).
//
// POR QUÉ ESTE. PENDIENTES.md lo nombra como el mejor rendimiento por byte del
// lote: el scrubber (~1000 líneas + histograma + marcadores) vive en el tab
// "Línea de tiempo" del dock, que NO es el default (`dockTab` arranca en
// "stats") — diferirlo no le cuesta latencia a la primera interacción. Su costo
// era de tests, pagado en el commit previo: `openTimeline()` en
// `PanoramaConsole.test.tsx` ya espera el contenido real del pane. Los tests
// directos del scrubber (`time-scrubber*.test.tsx`, `timeline-two-step`)
// importan el componente sin pasar por esta frontera.
//
// `ssr: false` porque el scrubber reproduce capas que sólo existen en el
// cliente (el mapa es cliente): no hay nada honesto que prerenderizar.

import dynamic from "next/dynamic";

import type { ComponentProps } from "react";

import type { TimeScrubber as TimeScrubberType } from "./TimeScrubber";

const LazyTimeScrubber = dynamic(
  () => import("./TimeScrubber").then((m) => ({ default: m.TimeScrubber })),
  {
    ssr: false,
    // `min-height`, no altura fija: el alto real depende del modo (configurar
    // alto, reproducir mínimo — two-step). El piso reserva lo mínimo y deja
    // crecer al resolver.
    loading: () => (
      <div
        aria-busy="true"
        aria-label="Cargando línea de tiempo"
        className="min-h-24 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card"
      />
    ),
  },
);

export function TimeScrubberDynamic(props: ComponentProps<typeof TimeScrubberType>) {
  return <LazyTimeScrubber {...props} />;
}
