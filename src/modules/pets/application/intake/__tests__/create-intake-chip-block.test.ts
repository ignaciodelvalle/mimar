// QA B1 — chip-collision hard-block copy varies by custody shape.
//
// lookupByChip exposes ownerUserId: string | null (null = the active pet has
// no individual owner → it sits under another organization's custody). The
// with-family guidance ("la familia inicia la transferencia de titularidad")
// is wrong advice for that case, so chipMatchActiveBlockMessage picks:
//   - ownerUserId set  → the original with-family message (unchanged);
//   - ownerUserId null → the org-to-org custody message (no "familia").

import { describe, expect, it } from "vitest";

import { chipMatchActiveBlockMessage } from "../create-intake";

describe("chipMatchActiveBlockMessage (QA B1)", () => {
  it("with an individual owner: keeps the with-family transfer guidance", () => {
    const msg = chipMatchActiveBlockMessage("user-123");
    expect(msg).toContain("familia");
    expect(msg).toContain("transferencia de titularidad");
    expect(msg).not.toContain("otra organización");
  });

  it("with org custody (ownerUserId null): points to the org-to-org path, no family guidance", () => {
    const msg = chipMatchActiveBlockMessage(null);
    expect(msg).toContain("custodia de otra organización");
    expect(msg).toContain("Coordiná el traspaso directamente con esa organización");
    expect(msg).not.toContain("familia");
    // The lost-pet match circuit still applies — same reunification path.
    expect(msg).toContain("confirmar la coincidencia");
  });

  it("both variants stay hard blocks over the same chip-uniqueness fact", () => {
    for (const msg of [
      chipMatchActiveBlockMessage("user-123"),
      chipMatchActiveBlockMessage(null),
    ]) {
      expect(msg).toContain("No se puede crear un segundo ingreso con el mismo chip");
    }
  });
});
