import { redirect } from "next/navigation";

/**
 * Design previews (`/design`, `/design/p-niveles`, `/design/ficha-estados`,
 * `/design/credencial`)
 * are local-only. Production sends the visitor home — the same redirect
 * the system page has always used.
 *
 * Their fixture tokens are static sample strings — some `DIM-MUES-*`
 * (muestra), others named after the fixture pet (`DIM-LUNA-0002`,
 * `DIM-NEGR-0003`, the ficha-estados set). None is written by any seed and no
 * preview reads one from the database: they are only printed or QR-encoded, so
 * a preview never leans on demo furniture a real deployment does not have
 * (seed-precondition-contract.test.ts).
 */
export function gateDesignPreview(): void {
  if (process.env.NODE_ENV === "production") redirect("/");
}
