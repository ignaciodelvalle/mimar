// @vitest-environment jsdom
//
// D1 (PO 2026-08-23). The PO ruled OUT an in-product dispute channel for a
// rabies observation opened in error: the owner's complaint travels outside the
// system, to the organization that opened it or to the municipality. That
// decision only holds if the owner can SEE, from the surface that shows the
// observation, (a) that they cannot close it themselves and who can, and
// (b) who opened it — otherwise the notice at open time is the only copy that
// ever says so, and it scrolls away.
//
// Until this test, the banner said "no podés cerrarlo vos" ONLY once the window
// had already elapsed (`periodClosed`) — i.e. the owner learned where they stood
// on day 11, never on day 1, which is exactly the day someone disputes an
// erroneous observation. And it never named the reporting organization at all.

import "@testing-library/jest-dom/vitest";

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RabiesObservationBanner } from "./PetProfileBanners";

afterEach(cleanup);

const PET = { name: "Max", publicToken: "DIM-TEST-0001" };

/** An observation whose window is still running (opened today, closes in 10 days). */
function openEvents(): Array<{
  id: string;
  eventType: string;
  occurredAt: Date;
  payload: unknown;
}> {
  const now = Date.now();
  return [
    {
      id: "ev-bite",
      eventType: "incident_reported",
      occurredAt: new Date(now - 86_400_000),
      payload: { incident_type: "bite_inflicted" },
    },
    {
      id: "ev-obs",
      eventType: "rabies_observation_started",
      occurredAt: new Date(now - 86_400_000),
      payload: {
        observation_until: new Date(now + 9 * 86_400_000).toISOString(),
        observation_days: 10,
      },
    },
  ];
}

describe("RabiesObservationBanner — where the owner stands (D1)", () => {
  it("says the owner cannot close it, and who can, WHILE the window is still running", () => {
    render(<RabiesObservationBanner pet={PET} events={openEvents()} />);
    expect(screen.getByText(/no pod[eé]s cerrarla vos/i)).toBeInTheDocument();
    expect(
      screen.getByText(/veterinario matriculado o la autoridad sanitaria/i),
    ).toBeInTheDocument();
  });

  it("names the organization that opened the observation when one did", () => {
    render(
      <RabiesObservationBanner pet={PET} events={openEvents()} openedByOrgName="Refugio Patitas" />,
    );
    expect(screen.getByText(/Refugio Patitas/)).toBeInTheDocument();
  });

  it("does not invent an opener when the bite was reported by the owner", () => {
    render(<RabiesObservationBanner pet={PET} events={openEvents()} />);
    expect(screen.queryByText(/Reportada por/i)).not.toBeInTheDocument();
  });
});
