// Regression test — /turnos/buscar never echoes an unknown ?service_kind=.
//
// Bug (adversarial review 2026-08-08, S3-F07): the page read
// `service_kind` straight from the URL and rendered it as the <h1>, with only
// a `kindDef?.label ?? serviceKind` fallback behind it. Loading
// /turnos/buscar?service_kind=spay_female_dog answered 200 with a page whose
// first line was "spay_female_dog".
//
// React escapes the markup, so this was never injection. It is the page
// asserting a service that does not exist — whoever writes the link chooses
// the heading. An unknown service is "no service chosen yet", so the page now
// falls through to the same picker it shows when the param is missing.
//
// The invalid path returns BEFORE any query, so this needs no DB fixture: the
// jurisdiction lookup and the offerings query are both gated on a non-empty
// serviceKind.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The id is a well-formed UUID that owns nothing: the VALID-kind case below
// reaches the jurisdiction lookup, and ownerships.owner_user_id is a uuid
// column — a descriptive string id fails at the driver with 22P02 before the
// assertion runs. Inlined because vi.mock is hoisted above any const.
vi.mock("@/lib/infra/auth-guards", () => ({
  requireUserOrRedirect: vi.fn().mockResolvedValue({
    supabase: {},
    user: { id: "00000000-0000-4000-8000-00000000ab01" },
  }),
}));

import TurnosBuscarPage from "@/app/(app)/turnos/buscar/page";

const BOGUS = "spay_female_dog";

async function renderWith(searchParams: Record<string, string>): Promise<string> {
  const element = await TurnosBuscarPage({
    searchParams: Promise.resolve(searchParams),
  } as never);
  return renderToStaticMarkup(element as React.ReactElement);
}

describe("/turnos/buscar — service_kind validation", () => {
  it("does not print an unknown service_kind anywhere on the page", async () => {
    const html = await renderWith({ service_kind: BOGUS });
    expect(html).not.toContain(BOGUS);
  });

  it("shows the service picker for an unknown service_kind, same as for none", async () => {
    // Asserting the picker (not merely the absence of the token) is what makes
    // this a behaviour test: a page that 500'd or rendered blank would also
    // "not contain" the bogus value.
    const unknown = await renderWith({ service_kind: BOGUS });
    const missing = await renderWith({});
    expect(unknown).toContain("Buscar turno");
    expect(missing).toContain("Buscar turno");
  });

  it("still accepts a real service kind", async () => {
    // Non-vacuity: without this, breaking findServiceKind so that EVERY kind
    // is rejected would leave the two tests above passing.
    const { SERVICE_KINDS } = await import("@/lib/reference/service-kinds");
    const real = SERVICE_KINDS[0];
    const html = await renderWith({ service_kind: real.code });
    expect(html).toContain(real.label);
  });
});
