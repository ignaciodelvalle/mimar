"use client";

// PanoramaBoardNotices — what the console must CONFESS about the board on
// screen, before the operator reads a number off it.
//
// Both notices exist because a Panorama surface can look complete while being
// something else, and the operator has no way to tell from the map:
//
//  - `staleFrame`: the caption advanced to a date whose data never landed, so
//    the map is painting the PREVIOUS frame under the new label.
//  - `droppedLayerIds`: the opened link named layers that no longer exist, so
//    the board silently reopened smaller than the one that was shared.
//
// Grouped here (rather than inline in a 5100-line console) because they answer
// the same question — "is what I'm looking at what I think it is?" — and
// because the console is past its size budget.

/** A frame whose layers did not all load. Null when the frame is complete. */
export type StaleFrameNotice = { layers: string[]; rateLimited: boolean };

export function PanoramaBoardNotices({
  staleFrame,
  droppedLayerIds,
}: {
  staleFrame: StaleFrameNotice | null;
  droppedLayerIds: string[];
}) {
  if (staleFrame === null && droppedLayerIds.length === 0) return null;

  return (
    <>
      {droppedLayerIds.length > 0 && (
        <output className="block px-3 pb-1 text-xs leading-snug text-ln-op-warn">
          Este enlace pedía{" "}
          {droppedLayerIds.length === 1 ? "una capa que ya no existe" : "capas que ya no existen"} (
          {droppedLayerIds.join(", ")}). La vista que estás viendo no es completa.
        </output>
      )}
      {staleFrame !== null && (
        <output className="block px-3 pb-1 text-xs leading-snug text-ln-op-warn">
          {staleFrame.rateLimited
            ? "Se alcanzó el límite de consultas: "
            : "No se pudieron cargar los datos de esta fecha: "}
          el mapa sigue mostrando el último cuadro cargado de {staleFrame.layers.join(", ")}.
        </output>
      )}
    </>
  );
}
