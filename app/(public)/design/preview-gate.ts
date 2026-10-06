import { redirect } from "next/navigation";

/**
 * Design previews (`/design`, `/design/p-niveles`, `/design/ficha-estados`,
 * `/design/credencial`)
 * are local-only. Production sends the visitor home — the same redirect
 * the system page has always used.
 *
 * Their fixture tokens are `DIM-MUES-*` (muestra) on purpose: no seed writes
 * them, so a preview never leans on demo furniture a real deployment does not
 * have (seed-precondition-contract.test.ts). The pet names stay; only the
 * printed token is a sample.
 */
export function gateDesignPreview(): void {
  if (process.env.NODE_ENV === "production") redirect("/");
}
