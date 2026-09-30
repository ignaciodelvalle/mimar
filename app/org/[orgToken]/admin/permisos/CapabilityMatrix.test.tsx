// @vitest-environment jsdom
//
// CapabilityMatrix — a vet_individual's clinical capabilities, while their own
// matrícula is not verified, render as an inert "Requiere matrícula verificada"
// cell instead of a grant "+" (portal-vet-p0 D12).

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/src/modules/organizations/actions", () => ({
  decideCapabilityAction: vi.fn(),
  grantCapabilityAction: vi.fn(),
}));
vi.mock("@/lib/ui/action-feedback", () => ({ notifySaved: vi.fn() }));

import { CapabilityMatrix, type MatrixMember } from "./CapabilityMatrix";

afterEach(cleanup);

const COLUMNS = [
  { capability: "event.write", label: "Registrar eventos clínicos" },
  { capability: "appointment.manage", label: "Gestionar turnos" },
  { capability: "foster.assign", label: "Asignar tránsito" },
];

function vet(overrides: Partial<MatrixMember> = {}): MatrixMember {
  return {
    membershipId: "mem-vet",
    displayName: "Vet sin matrícula",
    role: "vet_individual",
    explicitGrants: {},
    implicitCaps: new Set(["appointment.manage"]),
    credentialGatedCaps: new Set(["event.write"]),
    ...overrides,
  };
}

function renderMatrix(members: MatrixMember[]) {
  return render(
    <CapabilityMatrix
      members={members}
      columns={COLUMNS}
      organizationId="org-1"
      orgToken="ORG-1"
      callerMembershipId="mem-admin"
    />,
  );
}

describe("<CapabilityMatrix> — credential-gated cells", () => {
  it("renders the gated cell inert with the shared label, and no grant button", () => {
    renderMatrix([vet()]);
    const cells = screen.getAllByTestId("matrix-needs-matricula");
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveTextContent("Requiere matrícula verificada");
    // One "+" only: foster.assign. event.write offers none; appointment.manage is implicit.
    expect(screen.getAllByRole("button", { name: "Conceder" })).toHaveLength(1);
  });

  it("wins over a legacy explicit grant row (no revocable check that claims a permission)", () => {
    renderMatrix([vet({ explicitGrants: { "event.write": "grant-legacy" } })]);
    expect(screen.getByTestId("matrix-needs-matricula")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revocar" })).not.toBeInTheDocument();
  });

  it("a member without the field keeps the grant cell", () => {
    renderMatrix([
      {
        membershipId: "mem-m",
        displayName: "Miembro",
        role: "member",
        explicitGrants: {},
        implicitCaps: new Set(),
      },
    ]);
    expect(screen.queryByTestId("matrix-needs-matricula")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Conceder" })).toHaveLength(3);
  });
});
