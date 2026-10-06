// @vitest-environment jsdom
//
// /admin/localidades/pendientes — the queue shows, next to each resolve button,
// what the admin needs to decide; it degrades without a pin or a pet; and a
// resolved place is confirmed on the list the admin lands on.
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
  unstable_rethrow: vi.fn(),
}));
vi.mock("@/lib/infra/auth-guards", () => ({
  requireAdminOrRedirect: vi.fn(async () => ({ user: { id: "admin-1" } })),
}));
vi.mock("@/app/actions/resolve-place", () => ({ resolvePlaceFromQueueAction: vi.fn() }));
vi.mock("@/components/maps/StaticFirstMap", () => ({
  StaticFirstMap: (p: { lat: number; lng: number; precision?: string }) => (
    <div data-testid="static-map" data-lat={p.lat} data-lng={p.lng} data-precision={p.precision} />
  ),
}));
vi.mock("@/lib/place/unresolved-queue", () => ({
  listUnresolvedPlaces: vi.fn(),
  resolvedPlaceLabel: vi.fn(),
}));

import {
  type QueueItem,
  listUnresolvedPlaces,
  resolvedPlaceLabel,
} from "@/lib/place/unresolved-queue";

import UnresolvedPlacesPage from "./page";

function item(over: Partial<QueueItem["context"]>): QueueItem {
  return {
    subjectTable: "cases",
    subjectId: "00000000-0000-4000-8000-000000000001",
    province: "Buenos Aires",
    enteredLocality: "Mechita",
    createdAt: new Date("2026-10-01T15:00:00Z"),
    candidates: [
      {
        localityId: "a",
        name: "Mechita",
        department: "Alberti",
        latitude: -35.0,
        longitude: -60.3,
      },
      {
        localityId: "b",
        name: "Mechita",
        department: "Bragado",
        latitude: -35.2,
        longitude: -60.5,
      },
    ],
    context: {
      code: "CAS-ABCD-1234",
      kind: "bite_incident",
      caseCode: "CAS-ABCD-1234",
      welfareReportId: null,
      creatorRole: "vet",
      creatorViaOrganization: false,
      lat: null,
      lng: null,
      address: null,
      petLocality: null,
      linkedPlace: null,
      ...over,
    },
  };
}

async function render(searchParams: Record<string, string> = {}) {
  const node = await UnresolvedPlacesPage({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(node);
}

describe("/admin/localidades/pendientes", () => {
  beforeEach(() => {
    vi.mocked(listUnresolvedPlaces).mockReset();
    vi.mocked(resolvedPlaceLabel).mockReset();
    vi.mocked(resolvedPlaceLabel).mockResolvedValue(null);
  });

  it("puts the decision context next to the button, candidates nearest first", async () => {
    vi.mocked(listUnresolvedPlaces).mockResolvedValue([
      item({
        lat: -35.19,
        lng: -60.49,
        petLocality: { name: "Bragado", department: "Bragado" },
        linkedPlace: "Calle 9 123, Mechita, Buenos Aires",
      }),
    ]);
    const html = await render();
    expect(html).toContain("«Mechita», Buenos Aires");
    expect(html).toContain("Mordedura");
    expect(html).toContain('href="/admin/casos/CAS-ABCD-1234"');
    expect(html).toContain("Veterinario/a");
    expect(html).toContain("Localidad de la mascota");
    expect(html).toContain("Calle 9 123, Mechita, Buenos Aires");
    expect(html).toContain('data-testid="static-map"');
    expect(html).toMatch(/Bragado\)[^<]*<span[^>]*> · a [\d,]+ (km|m) del punto/);
    // Nearest first: Bragado precedes Alberti in the visible list.
    const list = html.slice(html.indexOf("de la más cercana al punto"));
    expect(list.indexOf("(Bragado)")).toBeLessThan(list.indexOf("(Alberti)"));
    expect(html).toContain("Resolver el lugar");
    expect(html).not.toMatch(/DNI|dni/);
  });

  it("degrades without a pin or a pet", async () => {
    vi.mocked(listUnresolvedPlaces).mockResolvedValue([item({})]);
    const html = await render();
    expect(html).not.toContain('data-testid="static-map"');
    expect(html).toContain("Sin punto en el mapa");
    expect(html).not.toContain("Localidad de la mascota");
    expect(html).toContain("(Alberti)");
    expect(html).not.toContain("del punto");
    expect(html).toContain("Resolver el lugar");
  });

  it("confirms the resolved place from a server-side lookup, never from the URL text", async () => {
    vi.mocked(listUnresolvedPlaces).mockResolvedValue([]);
    vi.mocked(resolvedPlaceLabel).mockResolvedValue("Mechita (Bragado)");
    const id = "11111111-1111-4111-8111-111111111111";
    const html = await render({ provincia: "AR-B", resuelto: id });
    expect(html).toContain("Lugar resuelto: Mechita (Bragado)");
    expect(resolvedPlaceLabel).toHaveBeenCalledWith(expect.anything(), id);
  });

  it("renders no banner when the id resolves to nothing (a forged label)", async () => {
    vi.mocked(listUnresolvedPlaces).mockResolvedValue([]);
    const html = await render({ provincia: "AR-B", resuelto: "Sitio oficial: llamá al 0800" });
    expect(html).not.toContain("Lugar resuelto");
    expect(html).not.toContain("0800");
  });

  it("never discloses a denunciante's role or exact point, and flags candidates without centroid", async () => {
    vi.mocked(listUnresolvedPlaces).mockResolvedValue([
      {
        ...item({
          code: "DEN-ABCD-1234",
          kind: "neglect",
          caseCode: null,
          welfareReportId: "00000000-0000-4000-8000-0000000000aa",
          creatorRole: "vet",
          lat: -35.19412,
          lng: -60.49488,
          address: "Calle 9 123",
        }),
        subjectTable: "welfare_reports",
        candidates: [
          {
            localityId: "a",
            name: "Mechita",
            department: "Alberti",
            latitude: null,
            longitude: null,
          },
          {
            localityId: "b",
            name: "Mechita",
            department: "Bragado",
            latitude: -35.2,
            longitude: -60.5,
          },
        ],
      } as QueueItem,
    ]);
    const html = await render();
    expect(html).toContain("Con cuenta");
    expect(html).not.toContain("Veterinario/a");
    expect(html).not.toContain("Calle 9 123");
    expect(html).toContain('data-lat="-35.19"');
    expect(html).not.toContain("-35.19412");
    expect(html).toContain('data-precision="approx"');
    expect(html).toContain("sin ubicación registrada");
  });
});
