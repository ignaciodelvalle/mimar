// /gob/observaciones — la cola de observaciones antirrábicas para el portal de
// gobierno.
//
// POR QUÉ EXISTE (decisión del PO, 2026-08-10). La pantalla ya existía bajo
// /admin/observaciones y su guard —`requireAdminOrGovtOrRedirect`— siempre
// admitió rol gobierno. Lo que la volvía inalcanzable era el LAYOUT:
// app/admin/layout.tsx llama `requireAdminOrRedirect()`, que sólo permite
// `admin` y rebota a la home ANTES de que la página corra.
//
// El efecto era un callejón sin salida con señal cero: `/gob/acciones` emite
// para un usuario govt un botón "Cerrar" que apunta a
// `/admin/observaciones/[token]` (worklist-core.ts:148), y el funcionario que lo
// tocaba terminaba en `/` sin explicación. La observación antirrábica es
// competencia sanitaria, no administrativa — el rol correspondía, la puerta no.
//
// Se re-exporta el mismo componente en vez de duplicarlo: una copia derivaría, y
// este repo ya tiene escrito lo que pasa cuando dos gemelos divergen. Lo único
// que cambia entre los dos portales es el chrome que pone cada layout.

export { default } from "@/app/admin/observaciones/page";
