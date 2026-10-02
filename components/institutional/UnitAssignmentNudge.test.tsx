// @vitest-environment jsdom
//
// The "Falta asignarlo a su unidad" nudge (localidades CABA + Córdoba, 2026-10,
// change C4): after a govt grant in CABA or Córdoba, the success state says the
// second step — with the link to that province's units for the platform admin,
// and with who to ask for a jurisdiction admin. Nothing anywhere else.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { UnitAssignmentNudge } from "./UnitAssignmentNudge";

const html = (provinces: (string | null)[], canConfirmUnits: boolean) =>
  renderToStaticMarkup(
    <UnitAssignmentNudge provinces={provinces} canConfirmUnits={canConfirmUnits} />,
  );

describe("UnitAssignmentNudge", () => {
  it("links the platform admin to the units of each CABA/Córdoba province granted", () => {
    const out = html(["Córdoba", "CABA", "Córdoba"], true);
    expect(out.match(/Falta asignarlo a su unidad/g)).toHaveLength(2);
    expect(out).toContain('href="/admin/localidades?provincia=AR-X"');
    expect(out).toContain('href="/admin/localidades?provincia=AR-C"');
  });

  it("tells a jurisdiction admin who can do it, with no link it cannot follow", () => {
    const out = html(["Córdoba"], false);
    expect(out).toContain("Falta asignarlo a su unidad");
    expect(out).toContain("Pedile a un administrador de la plataforma");
    expect(out).not.toContain("/admin/localidades");
  });

  it("says nothing for a province still on the name path, or for no province", () => {
    expect(html(["Buenos Aires", null], true)).toBe("");
    expect(html([], true)).toBe("");
  });
});
