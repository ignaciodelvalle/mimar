// @vitest-environment jsdom
//
// MergedShareSheet — each duration control is unambiguously bound to its share
// type (adversarial-citizen C2, 2026-07-06). The sheet fuses two share types
// that each carry a duration:
//   1. the private libreta link      → "Vencimiento" radios (always visible)
//   2. the Tier-2 public medical view → "Duración" radios (progressive
//      disclosure: only shown once the owner opens the Tier-2 expander)
// Before the fix the two duration blocks were stacked in one panel, easy to
// confuse which window applied to which share. These tests pin the binding.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The action module pulls in server-only deps (supabase server client, db).
// isOwner={false} keeps SharesManager (the only consumer that runs it) out of
// the tree, but the import still loads — mock it so the module resolves.
vi.mock("@/app/actions/libreta-share", () => ({
  getActiveLibretaSharesAction: vi.fn().mockResolvedValue({ ok: true, shares: [] }),
}));

import { MergedShareSheet } from "./MergedShareSheet";

function renderSheet(tier2Active: boolean) {
  return render(
    <MergedShareSheet
      petPublicToken="abc123"
      petName="Firulais"
      petSex="male"
      createShareAction={vi.fn().mockResolvedValue({ shareToken: "t" })}
      tier2={{
        isActive: tier2Active,
        isPermanent: false,
        activeUntil: tier2Active ? new Date("2026-08-01T00:00:00Z") : null,
        enableAction: vi.fn(),
        revokeAction: vi.fn(),
      }}
      isOwner={false}
      isLost={false}
    />,
  );
}

afterEach(cleanup);

describe("MergedShareSheet — duration controls bound to their share type (C2)", () => {
  it("the libreta-link duration ('Vencimiento') is NOT behind an expander", () => {
    renderSheet(false);
    const legend = screen.getByText("Vencimiento");
    expect(legend.closest("section")?.textContent).toContain("Compartir con vencimiento");
    // Libreta duration is a peer of its heading, never inside a <details>.
    expect(legend.closest("details")).toBeNull();
  });

  it("the Tier-2 duration ('Duración') is gated behind progressive disclosure", () => {
    renderSheet(false);
    // The Tier-2 duration radios live inside the collapsed <details> so they
    // never sit stacked next to the libreta-link "Vencimiento" block.
    const legend = screen.getByText("Duración");
    const details = legend.closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Mostrar libreta médica (Tier 2)");
  });

  it("when Tier 2 is already active, the status/revoke card renders directly (no hidden expander)", () => {
    renderSheet(true);
    // Owner must see + revoke an active exposure without an extra click.
    expect(screen.getByText("Tier 2 activo")).toBeInTheDocument();
    expect(screen.getByText("Tier 2 activo").closest("details")).toBeNull();
    expect(screen.getByRole("button", { name: "Revocar ahora" })).toBeInTheDocument();
  });
});
