// Tests for the bulk-intake template route (org-pilot-pack A3): capability
// gate + download headers + BOM/delimiter/example-row contract. The authz
// resolver is mocked (the capability semantics themselves are covered by the
// resolver's own tests and the live-DB import suite).

import { beforeEach, describe, expect, it, vi } from "vitest";

const requireCapabilityMock = vi.fn();
vi.mock("@/src/modules/organizations/infrastructure/authz-resolver", () => ({
  requireCapabilityForOrgToken: (...args: unknown[]) => requireCapabilityMock(...args),
}));

import { GET } from "./route";

function templateRequest() {
  return new Request("http://test.local/org/ORG-1/intake/importar/template");
}

const routeParams = { params: Promise.resolve({ orgToken: "ORG-1" }) };

beforeEach(() => {
  requireCapabilityMock.mockReset();
});

describe("GET /org/[orgToken]/intake/importar/template", () => {
  it("is gated on intake.create for the URL org", async () => {
    requireCapabilityMock.mockResolvedValue({ error: "No autorizado" });
    const res = await GET(templateRequest(), routeParams);
    expect(res.status).toBe(403);
    // `access: "read"` — a template download is a READ, which a deactivated
    // institutional account keeps (lib/infra/auth-guards.ts:60-70).
    expect(requireCapabilityMock).toHaveBeenCalledWith("intake.create", "ORG-1", {
      access: "read",
    });
  });

  it("downloads the CSV template: attachment, BOM, semicolons, CRLF, example row", async () => {
    requireCapabilityMock.mockResolvedValue({
      error: null,
      user: { id: "u1" },
      organization: { id: "o1" },
    });
    const res = await GET(templateRequest(), routeParams);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="plantilla-ingreso.csv"',
    );

    // BOM check on the RAW bytes — Response.text() strips a leading BOM
    // during UTF-8 decode, so the string view can't see it.
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = await res.text();
    const [header, example] = text.replace(/^﻿/, "").split("\r\n");
    // es-AR headers, semicolon-delimited, required columns starred.
    expect(header).toContain("nombre*");
    expect(header).toContain("motivo_ingreso*");
    expect(header).toContain("fecha_ingreso*");
    expect(header.split(";").length).toBeGreaterThanOrEqual(16);
    // One illustrative example row.
    expect(example).toContain("Negrita");
  });
});
