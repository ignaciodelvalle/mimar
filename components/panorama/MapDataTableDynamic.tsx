"use client";

// MapDataTableDynamic — la frontera perezosa de MapDataTable (Lote E, paso 2).
//
// POR QUÉ SE PUEDE DIFERIR. El pane "Registros" del dock se monta sólo cuando
// está activo: `PanoramaDock` renderiza `{open ? panes[tab] : null}`, un único
// pane a la vez, y el tab por defecto es "stats" (`PanoramaConsole`
// `useState<PanoramaDockTab>("stats")`). Crear el elemento JSX del pane no lo
// renderiza, así que la tabla no se pide hasta que el operador abre Registros.
//
// PRECONDICIÓN, y es la mitad del trabajo de este paso: el hook del CSV
// (`useMapTableCsvHref`) tuvo que salir antes a `map-table-csv.ts`. La consola
// lo usa para el botón "Exportar CSV" de la barra del dock, que SÍ está siempre
// montada; mientras el hook vivía en `MapDataTable.tsx`, este `dynamic` no
// habría bajado un byte porque el módulo seguía enganchado por esa otra punta.
//
// `ssr: false` porque la tabla es el espejo accesible de lo que el mapa PINTA, y
// el mapa es cliente. Prerenderizar la tabla contra un estado que el mapa
// todavía no tiene sería publicar números que nadie está viendo.

import dynamic from "next/dynamic";

import type { ComponentProps } from "react";

import type { MapDataTable as MapDataTableType } from "./MapDataTable";

const LazyMapDataTable = dynamic(
  () => import("./MapDataTable").then((m) => ({ default: m.MapDataTable })),
  {
    ssr: false,
    // `min-height`, no altura fija: el alto real depende de cuántas filas
    // devuelva el alcance actual, y una altura fija produciría un salto al
    // resolver. El piso reserva lo mínimo y deja crecer.
    loading: () => (
      <div
        aria-busy="true"
        aria-label="Cargando la tabla de registros"
        className="min-h-32 rounded-[var(--radius-sm)] border border-ln-op-line bg-ln-op-card"
      />
    ),
  },
);

export function MapDataTableDynamic(props: ComponentProps<typeof MapDataTableType>) {
  return <LazyMapDataTable {...props} />;
}
