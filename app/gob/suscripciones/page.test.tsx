// @vitest-environment jsdom
//
// /gob/suscripciones — render smoke test (page promotion out of /gob/programa
// and /admin/programa, 2026-07-21).
//
// Pins:
//   - the canonical space-y-6 shell (no centered <main>/mx-auto wrapper —
//     matches the item-4 fix already applied to /gob/cola etc.)
//   - the card-list presentation actually renders: breaching-alert banner,
//     "Mis suscripciones" rows with toggle + delete wired, and the create form
//   - the Métrica/Estado OpFilterBar axes actually filter the subscriptions
//     LIST, while the "Alertas activas" banner stays unfiltered (it's a
//     current-state banner, not a browsable view)
//   - the govt "Sin acceso" gate is preserved (unassigned govt operator)
import "@testing-library/jest-dom/vitest";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));

vi.mock("@/lib/infra/auth-guards", () => ({
  requireGobReadAccessOrRedirect: vi.fn(async () => ({
    user: { id: "govt-1", email: "govt@dim.test" },
    profile: { id: "govt-1", role: "govt" },
    jurisdictions: [{ province: "Buenos Aires", locality: "La Plata" }],
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "govt-1" } } })),
    },
  })),
}));

// sub-1: active + currently breaching (shows in the "Alertas activas" banner
// AND the list, with the "Pausar" toggle). sub-2: inactive + not breaching
// (list only, with "Activar" + the "(inactiva)" marker).
vi.mock("@/lib/metrics/alert-evaluation", () => ({
  evaluateAlertSubscriptions: vi.fn(async () => [
    {
      id: "sub-1",
      actorUserId: "govt-1",
      metricKey: "sterilization_coverage_pct",
      direction: "below",
      threshold: 70,
      jurisdictionProvince: "Buenos Aires",
      jurisdictionLocality: null,
      label: null,
      isActive: true,
      currentValue: 38,
      breaching: true,
    },
    {
      id: "sub-2",
      actorUserId: "govt-1",
      metricKey: "microchip_penetration_pct",
      direction: "below",
      threshold: 50,
      jurisdictionProvince: null,
      jurisdictionLocality: null,
      label: null,
      isActive: false,
      currentValue: 60,
      breaching: false,
    },
  ]),
}));

import SuscripcionesPage from "./page";

describe("/gob/suscripciones — render smoke test", () => {
  it("uses the canonical space-y-6 shell, not a centered <main>/mx-auto wrapper", async () => {
    const node = await SuscripcionesPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Alertas y suscripciones");
    expect(html).not.toContain("<main");
    expect(html).not.toContain("mx-auto");
    expect(html).not.toContain("max-w-5xl");
  });

  // A10-G2: the evaluator intersects each subscription with the caller's own
  // mandate, so the page must hand it the caller's assignments — not drop them.
  it("hands the govt caller's own assignments to the evaluator", async () => {
    const { evaluateAlertSubscriptions } = await import("@/lib/metrics/alert-evaluation");
    vi.mocked(evaluateAlertSubscriptions).mockClear();
    await SuscripcionesPage({ searchParams: Promise.resolve({}) });
    expect(evaluateAlertSubscriptions).toHaveBeenCalledWith("govt-1", { role: "govt" }, [
      { province: "Buenos Aires", locality: "La Plata" },
    ]);
  });

  it("renders the breaching-alert banner and both subscription rows", async () => {
    const node = await SuscripcionesPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    // Alertas activas — the breaching row only.
    expect(html).toContain("Alertas activas");
    expect(html).toContain("Cobertura de esterilización");
    // Mis suscripciones — both rows.
    expect(html).toContain("Mis suscripciones");
    expect(html).toContain("Penetración de microchip");
    expect(html).toContain("(inactiva)"); // sub-2 state marker
  });

  // RA-2 F7. These three used to assert that a govt operator SAW "Pausar" /
  // "Activar" / "Eliminar" / "Crear suscripción". All three write actions are
  // gated by requireAdminOrRedirect (app/actions/alert-subscriptions.ts:52,72,
  // 83), which ends in redirect("/") with no try/catch — so every one of those
  // controls bounced a govt operator to the home page, silently, with their
  // input gone. The tests were pinning the defect in place: the fix that
  // removed the dead controls is what turned them red.
  it("gives a govt operator NO write controls — the actions are admin-only", async () => {
    const node = await SuscripcionesPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    expect(html).not.toContain("Pausar");
    expect(html).not.toContain("Activar");
    expect(html).not.toContain("Eliminar");
    expect(html).not.toContain("Crear suscripción");
  });

  it("gives an admin ALL of them", async () => {
    // The control group. Without this, deleting the canManage branch entirely
    // and rendering read-only for everyone would still pass the test above.
    const { requireGobReadAccessOrRedirect } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValueOnce({
      user: { id: "admin-1", email: "admin@dim.test" },
      profile: { id: "admin-1", role: "admin" },
      jurisdictions: [{ province: "Buenos Aires" }],
    } as unknown as Awaited<ReturnType<typeof requireGobReadAccessOrRedirect>>);
    const node = await SuscripcionesPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Pausar"); // sub-1 (active) toggle
    expect(html).toContain("Activar"); // sub-2 (inactive) toggle
    expect(html).toContain("Eliminar"); // DeleteAlertSubscriptionButton idle state
    expect(html).toContain("Crear suscripción de alerta");
  });

  // The filters are scoped to the "Mis suscripciones" list. Asserting on the
  // whole document cannot show that: the breaching metric ALSO appears in the
  // unfiltered Alertas activas banner above. These used to use the "Pausar"
  // button label as a list-only proxy, which is why an authz change broke a
  // pair of filter tests. Slice the list instead — it says what it means, and
  // it survives changes to which controls the list happens to carry.
  // Bounded at the list's own </ul>, NOT at the end of the document: the create
  // form below it carries a <select> naming every metric, so an unbounded slice
  // would find the filtered-out metric again and only pass for roles that do
  // not get the form. Caught by mutating canManage to true.
  const listSection = (html: string) => {
    const from = html.indexOf("suscripciones-lista-titulo");
    const to = html.indexOf("</ul>", from);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return html.slice(from, to);
  };

  it("Estado=inactive filters the list to the inactive row only, without touching the Alertas activas banner", async () => {
    const node = await SuscripcionesPage({ searchParams: Promise.resolve({ state: "inactive" }) });
    const html = renderToStaticMarkup(node);
    // Banner is UNFILTERED — the breaching (active) row still shows there.
    expect(html).toContain("Alertas activas");
    expect(html).toContain("Cobertura de esterilización");
    // List IS filtered — sub-1 (active) dropped out of it.
    const list = listSection(html);
    expect(list).toContain("1 de 2");
    expect(list).toContain("Penetración de microchip");
    expect(list).not.toContain("Cobertura de esterilización");
  });

  it("Métrica filter narrows the list to the matching subscription only", async () => {
    const node = await SuscripcionesPage({
      searchParams: Promise.resolve({ metricKey: "microchip_penetration_pct" }),
    });
    const list = listSection(renderToStaticMarkup(node));
    expect(list).toContain("1 de 2");
    expect(list).toContain("Penetración de microchip");
    expect(list).not.toContain("Cobertura de esterilización");
  });
});

describe("/gob/suscripciones — access gate", () => {
  it("shows Sin acceso for a govt operator with no jurisdiction assignments", async () => {
    const { requireGobReadAccessOrRedirect } = await import("@/lib/infra/auth-guards");
    vi.mocked(requireGobReadAccessOrRedirect).mockResolvedValueOnce({
      user: { id: "govt-2", email: "govt2@dim.test" },
      profile: { id: "govt-2", role: "govt" },
      jurisdictions: [],
    } as unknown as Awaited<ReturnType<typeof requireGobReadAccessOrRedirect>>);
    const node = await SuscripcionesPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(node);
    expect(html).toContain("Sin acceso");
  });
});
