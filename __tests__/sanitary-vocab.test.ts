// Sanity tests for lib/sanitary-vocab (compliance handoff PR 3).
//
// Three contracts:
//  1. The TS const mirror matches the DB seed in ref.tipo_evento_sanitario
//     row-for-row (codes, requiere_lote, requiere_via, notificable_eno).
//  2. requiresLote / requiresVia / notificableEno helpers return the right
//     flag for each code.
//  3. Lookup helpers (tipoEventoLabel, tipoEventoNorma) return the seed
//     values for known codes and null for unknown.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { db, refTipoEventoSanitario } from "@/db";
import {
  TIPO_EVENTO_SANITARIO,
  notificableEno,
  requiresLote,
  requiresVia,
  tipoEventoLabel,
  tipoEventoNorma,
} from "@/lib/reference/sanitary-vocab";

describe("sanitary-vocab — TS const ↔ DB seed parity", () => {
  it("every seed row has a matching TS entry with identical flags", async () => {
    const rows = await db.select().from(refTipoEventoSanitario);
    expect(rows.length).toBe(TIPO_EVENTO_SANITARIO.length);

    const tsByCode = new Map(TIPO_EVENTO_SANITARIO.map((t) => [t.code, t]));
    for (const r of rows) {
      const tsEntry = tsByCode.get(r.code as (typeof TIPO_EVENTO_SANITARIO)[number]["code"]);
      expect(tsEntry, `seed row ${r.code} missing in TS mirror`).toBeDefined();
      if (!tsEntry) continue;
      expect(tsEntry.requiereLote).toBe(r.requiereLote);
      expect(tsEntry.requiereVia).toBe(r.requiereVia);
      expect(tsEntry.notificableEno).toBe(r.notificableEno);
    }
  });

  it("rabies-related codes are flagged ENO-notifiable", async () => {
    expect(notificableEno("vacunacion_antirrabica")).toBe(true);
    expect(notificableEno("observacion_antirrabica")).toBe(true);
    expect(notificableEno("mordedura_notificada")).toBe(true);
    expect(notificableEno("consulta_clinica")).toBe(false);
    expect(notificableEno("esterilizacion_quirurgica")).toBe(false);
  });

  it("vaccinations + deworming require a biologic lot", async () => {
    expect(requiresLote("vacunacion_antirrabica")).toBe(true);
    expect(requiresLote("vacunacion_quintuple")).toBe(true);
    expect(requiresLote("desparasitacion_interna")).toBe(true);
    expect(requiresLote("cirugia_general")).toBe(false);
    expect(requiresLote("consulta_clinica")).toBe(false);
  });

  it("vaccines require a via_aplicacion code; surgeries and clinical visits don't", async () => {
    expect(requiresVia("vacunacion_antirrabica")).toBe(true);
    expect(requiresVia("vacunacion_octuple")).toBe(true);
    expect(requiresVia("cirugia_general")).toBe(false);
    expect(requiresVia("defuncion")).toBe(false);
  });

  it("lookup helpers return label + norma for known codes, null otherwise", () => {
    expect(tipoEventoLabel("vacunacion_antirrabica")).toBe("Vacunación antirrábica");
    expect(tipoEventoLabel("nonexistent_code")).toBeNull();
    expect(tipoEventoLabel(null)).toBeNull();
    expect(tipoEventoLabel(undefined)).toBeNull();
    expect(tipoEventoNorma("vacunacion_antirrabica")).toContain("Ley 22.953");
    expect(tipoEventoNorma(null)).toBeNull();
  });

  it("DB unit row for vacunacion_antirrabica matches the TS mirror exactly", async () => {
    const [row] = await db
      .select()
      .from(refTipoEventoSanitario)
      .where(eq(refTipoEventoSanitario.code, "vacunacion_antirrabica"));
    expect(row).toBeDefined();
    expect(row.labelEs).toBe("Vacunación antirrábica");
    expect(row.requiereLote).toBe(true);
    expect(row.requiereVia).toBe(true);
    expect(row.notificableEno).toBe(true);
  });
});
