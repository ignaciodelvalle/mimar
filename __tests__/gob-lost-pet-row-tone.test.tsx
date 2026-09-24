// pet-state-header R7.1 — listing tone alignment audit (gob side).
//
// A LOST pet's status pill on /gob/perdidas must use the same tone family as
// the perdida situation everywhere else (alerta → err/red). It was mapped to
// `open` (st-warn, AMBER — "needs action" case semantics), so the same pet
// read amber on the gob row and red on its credential band / owner row.
//
// Render via react-dom/server (repo convention), next/link mocked.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

import { LostPetRow } from "@/app/gob/perdidas/_components/LostPetRow";
import { lostTimeLabel } from "@/lib/infra/lost-listing";

function renderRow(
  petStatus: string,
  markedLostAt: Date = new Date("2026-07-01T12:00:00Z"),
): string {
  return renderToStaticMarkup(
    <LostPetRow
      pet={{
        petId: "pet-1",
        petPublicToken: "DIM-GOBT-0001",
        petName: "Firulais",
        species: "dog",
        petStatus,
        province: "Buenos Aires",
        locality: "La Plata",
        markedLostAt,
        lastSeenLat: null,
        lastSeenLng: null,
        ownerDisplayName: null,
      }}
      // Full-detail row (narrowed-view path) — these tests cover status-pill
      // tone and the shared lost-time vocabulary, unrelated to the PO
      // decision 4b owner-detail redaction (see
      // gob-perdidas-owner-detail-scope.test.tsx for that behavior).
      showOwnerDetail={true}
    />,
  );
}

describe("gob LostPetRow — situation tone alignment (R7.1)", () => {
  it("LOST pill uses the err (alerta) family — never the amber case-workflow tone", () => {
    const html = renderRow("lost");
    expect(html).toContain("Perdida");
    expect(html).toContain("st-err");
    expect(html).not.toContain("st-warn");
  });

  it("active pill keeps the ok family", () => {
    const html = renderRow("active");
    expect(html).toContain("st-ok");
  });
});

// Cowork B2 (consistency) — the row's "hace X" recency copy must come from the
// single shared vocabulary (lostTimeLabel), not a third inline formatter. The old
// local formatter said "hace minutos" under one hour and bucketed differently;
// the shared one says "recién" / "hace N min". Lock the shared output so the row
// can't drift back to a private formatter.
describe("gob LostPetRow — shared lost-time vocabulary (Cowork B2)", () => {
  it("renders lostTimeLabel output, not the retired 'hace minutos' copy", () => {
    const fortyFiveMinAgo = new Date(Date.now() - 45 * 60 * 1000);
    const html = renderRow("lost", fortyFiveMinAgo);
    expect(html).toContain(lostTimeLabel(fortyFiveMinAgo));
    expect(html).toContain("hace 45 min");
    expect(html).not.toContain("hace minutos");
  });

  it("uses 'recién' for a just-lost pet (shared helper), never 'hace minutos'", () => {
    const justNow = new Date(Date.now() - 30 * 1000);
    const html = renderRow("lost", justNow);
    expect(html).toContain("recién");
    expect(html).not.toContain("hace minutos");
  });
});
