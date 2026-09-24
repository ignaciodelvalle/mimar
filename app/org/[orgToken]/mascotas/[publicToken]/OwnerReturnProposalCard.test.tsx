// @vitest-environment jsdom
//
// OwnerReturnProposalCard — timezone hydration-mismatch fix (QA wave-2 item
// 8b, adjacent debt from de45cb85). "Propuesta el" used
// toLocaleDateString("es-AR") with no timeZone, so it formatted in the
// server's runtime zone (UTC in production) during SSR but the browser's
// local zone (America/Argentina/Buenos_Aires) during hydration — any
// proposedAt near local midnight could render a different calendar day
// server vs client (React hydration mismatch #418), same root cause already
// fixed for OrgMascotasBulkList.tsx's ingreso date and
// DashboardFreshnessFooter.tsx's stamps.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/app/actions/return-to-owner", () => ({
  orgAcceptOwnerReturnAction: vi.fn(),
  orgRejectOwnerReturnAction: vi.fn(),
}));

import { OwnerReturnProposalCard } from "./OwnerReturnProposalCard";

afterEach(() => {
  cleanup();
});

// 2026-01-15T02:30 UTC = 2026-01-14 23:30 in America/Argentina/Buenos_Aires
// (UTC-3) — a date that lands on a DIFFERENT calendar day in each zone, so
// this is a real regression guard for the timeZone pin, not a coincidence.
const BOUNDARY_PROPOSED_AT = "2026-01-15T02:30:00.000Z";

describe("OwnerReturnProposalCard — 'Propuesta el' date is timezone-pinned", () => {
  it("formats proposedAt in America/Argentina/Buenos_Aires, not the ambient/UTC zone", () => {
    const expectedArt = new Date(BOUNDARY_PROPOSED_AT).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "America/Argentina/Buenos_Aires",
    });
    const utcFormatted = new Date(BOUNDARY_PROPOSED_AT).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    // Sanity check: the boundary date must actually straddle a calendar-day
    // change between the two zones, otherwise this test would pass
    // vacuously even without the fix.
    expect(expectedArt).not.toBe(utcFormatted);

    render(
      <OwnerReturnProposalCard
        orgToken="org-1"
        petPublicToken="pet-1"
        petName="Firulais"
        ownerDisplayName="Lucía F."
        proposedAt={BOUNDARY_PROPOSED_AT}
        proposalNotes={null}
      />,
    );

    expect(screen.getByText(expectedArt)).toBeInTheDocument();
    expect(screen.queryByText(utcFormatted)).not.toBeInTheDocument();
  });
});
