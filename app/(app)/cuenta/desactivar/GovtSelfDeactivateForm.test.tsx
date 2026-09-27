// jurisdiction-admin final review (INFO, resignation): a jurisdiction
// administrator's appointment implies a whole-province grant, and the coverage
// rule keeps them from deactivating unless ANOTHER whole-province funcionario
// exists. Behaviour is unchanged on purpose; the block banner must say who can
// end the appointment (the platform admin) instead of sending them to
// "tu administrador" — which is themself.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

vi.mock("@/app/actions/profile-self-service", () => ({
  govtSelfDeactivateAction: vi.fn(async () => ({ ok: true })),
}));

import { GovtSelfDeactivateForm } from "./GovtSelfDeactivateForm";

const WHOLE_PROVINCE_ALONE = [{ province: "Mendoza", locality: "", otherActiveGovtCount: 0 }];

describe("GovtSelfDeactivateForm — the coverage block", () => {
  it("tells a jurisdiction admin that the platform admin ends the appointment", () => {
    const html = renderToStaticMarkup(
      <GovtSelfDeactivateForm localities={WHOLE_PROVINCE_ALONE} jurisdictionAdminOf="Mendoza" />,
    );
    expect(html).toContain("No podés desactivarte todavía.");
    expect(html).toContain("Sos administrador de jurisdicción de Mendoza");
    expect(html).toContain("administrador de la plataforma");
    expect(html).not.toContain("Pedile a tu administrador");
    // A whole-province grant is named, never rendered as an empty locality.
    expect(html).toContain("Mendoza / Toda la provincia");
    expect(html).not.toContain("Desactivar cuenta");
  });

  it("keeps the plain funcionario's copy", () => {
    const html = renderToStaticMarkup(
      <GovtSelfDeactivateForm
        localities={[{ province: "Mendoza", locality: "Godoy Cruz", otherActiveGovtCount: 0 }]}
      />,
    );
    expect(html).toContain("Pedile a tu administrador");
    expect(html).not.toContain("administrador de jurisdicción");
  });

  it("names the end of the appointment among the consequences when coverage is fine", () => {
    const covered = [{ province: "Mendoza", locality: "", otherActiveGovtCount: 1 }];
    expect(
      renderToStaticMarkup(
        <GovtSelfDeactivateForm localities={covered} jurisdictionAdminOf="Mendoza" />,
      ),
    ).toContain("Tu designación como administrador de jurisdicción de Mendoza termina");
    expect(renderToStaticMarkup(<GovtSelfDeactivateForm localities={covered} />)).not.toContain(
      "Tu designación",
    );
  });
});
