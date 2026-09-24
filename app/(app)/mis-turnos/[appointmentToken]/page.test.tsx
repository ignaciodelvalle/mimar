/**
 * /mis-turnos/[appointmentToken] — cancelled-by-owner confirmation (QA fix 5).
 *
 * The cancel sheet closes via full reload (action-feedback mechanism #1 —
 * no toast may stack on a reload), so the reloaded page IS the confirmation
 * surface. These tests pin that a cancelled_by_owner appointment renders the
 * prominent "Turno cancelado" callout, and that a confirmed one does not.
 *
 * Pattern: chainable thenable @/db stub (see lib/infra/__tests__/
 * gob-pet-subview.test.ts) + renderToStaticMarkup (repo convention, no jsdom).
 */

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const dbState = { queue: [] as unknown[] };
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "from", "where", "limit", "orderBy", "innerJoin", "leftJoin"]) {
    builder[m] = () => builder;
  }
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable query-builder stub for the @/db mock
  (builder as { then: unknown }).then = (
    resolve: (v: unknown) => unknown,
    reject: (e: unknown) => unknown,
  ) => Promise.resolve(dbState.queue.length ? dbState.queue.shift() : []).then(resolve, reject);
  return { dbState, builder };
});

vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, db: h.builder };
});

vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn(async () => ({ user: { id: "user-1" } })),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  usePathname: () => "/mis-turnos/TURN-0001",
  useSearchParams: () => ({ get: () => null, toString: () => "" }),
  notFound: () => {
    throw new Error("notFound");
  },
}));

import AppointmentDetailPage from "./page";

function makeRow(status: string) {
  const startsAt = new Date(Date.now() - 86400000);
  return {
    appointment: {
      id: "appt-1",
      status,
      ownerUserId: "user-1",
      organizationId: null,
    },
    slot: { startsAt, endsAt: new Date(startsAt.getTime() + 1800000) },
    offering: {
      displayName: "Vacunación antirrábica",
      serviceKind: "vaccination_rabies",
      durationMinutes: 30,
      priceArs: null,
    },
    pet: { name: "Firulais", publicToken: "DIM-TEST-0001" },
    org: null,
    provider: null,
  };
}

beforeEach(() => {
  h.dbState.queue = [];
});

describe("/mis-turnos/[appointmentToken] — cancel confirmation callout", () => {
  it("cancelled_by_owner: renders the prominent 'Turno cancelado' callout with rebook link", async () => {
    h.dbState.queue = [[makeRow("cancelled_by_owner")]];
    const node = await AppointmentDetailPage({
      params: Promise.resolve({ appointmentToken: "TURN-0001" }),
    });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Turno cancelado");
    expect(html).toContain("el horario quedó liberado");
    expect(html).toContain("/turnos/buscar");
    // The header badge still tells the same story.
    expect(html).toContain("Cancelado por vos");
  });

  it("confirmed: no cancellation callout", async () => {
    h.dbState.queue = [[makeRow("confirmed")]];
    const node = await AppointmentDetailPage({
      params: Promise.resolve({ appointmentToken: "TURN-0001" }),
    });
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain("Turno cancelado");
  });
});
