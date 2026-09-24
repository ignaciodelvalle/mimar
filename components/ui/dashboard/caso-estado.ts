// caso-estado — pure Estado (status) parsing/options for the casos queue
// twins (/gob/casos, /admin/casos).
//
// Split out of CasoEstadoFilter.tsx (ROOT-CAUSE FIX, opfilterbar-sweep R1):
// that file is "use client", and Next's server/client module boundary treats
// EVERY export of a "use client" file as a client reference — including a
// plain, hook-free pure function like parseCasoEstado. Calling such an
// export directly from a Server Component (as opposed to rendering it as
// JSX) throws at runtime:
//   "Attempted to call parseCasoEstado() from the server but parseCasoEstado
//    is on the client. It's not possible to invoke a client function from
//    the server…"
// tsc does NOT catch this — it's a bundler/RSC-boundary constraint, invisible
// to the type system, which is why `pnpm exec tsc --noEmit` stayed clean
// while /gob/casos and /admin/casos crashed at runtime (both call
// parseCasoEstado from their server-side data-loading function). Any pure
// helper a Server Component needs to CALL must live in a module WITHOUT
// "use client" — only JSX-renderable components belong in the client file.

/** The 3 genuine states of the casos Estado filter. "open" is the default. */
export type CasoEstado = "open" | "all" | "closed";

/** Parses the raw `status` searchParam into the 3-way Estado value. Unknown/absent → "open" (default). */
export function parseCasoEstado(raw: string | undefined): CasoEstado {
  if (raw === "all") return "all";
  if (raw === "closed") return "closed";
  return "open";
}

export const CASO_ESTADO_OPTIONS: ReadonlyArray<{ value: CasoEstado; label: string }> = [
  { value: "open", label: "Abiertos" },
  { value: "all", label: "Todos los estados" },
  { value: "closed", label: "Cerrados" },
];
