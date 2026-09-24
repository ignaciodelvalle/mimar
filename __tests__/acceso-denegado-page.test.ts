// A4: the explained access-denied landing renders portal-aware copy so a
// personal-role user bounced out of /gob learns WHY, instead of a silent
// redirect. The page is a server component that returns a <BrandedNotFound>
// element; we call it directly and inspect the resolved element props.

import { describe, expect, it } from "vitest";

import AccesoDenegadoPage from "@/app/acceso-denegado/page";

describe("AccesoDenegadoPage — A4 explained no-access", () => {
  it("names the gobierno portal and offers a link home", async () => {
    const el = await AccesoDenegadoPage({ searchParams: Promise.resolve({ portal: "gob" }) });
    expect(el.props.title).toBe("No tenés acceso al portal de gobierno");
    expect(el.props.body).toContain("de gobierno");
    expect(el.props.primary).toEqual({ href: "/", label: "Volver al inicio" });
  });

  it("falls back to a generic message when no portal is given", async () => {
    const el = await AccesoDenegadoPage({ searchParams: Promise.resolve({}) });
    expect(el.props.title).toBe("No tenés acceso a esta sección");
    expect(el.props.primary.href).toBe("/");
  });
});
