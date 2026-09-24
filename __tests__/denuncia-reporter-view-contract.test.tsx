// Boundary contract — /denuncias/seguimiento (change legal/denuncias-despublicadas).
//
// The reporter view is the surface that let the public code page be unpublished:
// a person can report cruelty and follow their case without creating an account.
// Its value depends entirely on the boundary holding, because the reporter is NOT
// a party to the proceeding. They are entitled to their own submission, their own
// text, the contact we retain, a coarse timeline, the organism, and a constancia
// number. They are not entitled to the identity of the accused, internal notes,
// the substantive content of the investigation, or the grounds of any resolution.
//
// lib/domain/denuncia-reporter-view.test.ts pins the projection. THIS file pins
// the page: the stubbed DB hands over a full, populated row (as a widened
// `select()` would) and the assertions are about the rendered HTML.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const REPORT_ID = "99999999-8888-7777-6666-555555555555";
const CODE = "DEN-ABCD-EFGH";
const OWN_TEXT = "Vi tres perros sin agua atados al sol todo el dia.";
const ACCUSED_DESCRIPTION = "hombre de unos sesenta, del galpon de chapa sobre la ruta";
const RESOLUTION_NOTES = "se archiva por falta de merito tras inspeccion";
const STREET_ADDRESS = "Ruta 8 km 41, casa con reja verde";
const LAT = "-34.6037220";
const LNG = "-58.3815920";
const CASE_ID = "11111111-2222-3333-4444-555555555555";
const OPERATOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REPORTER_EMAIL = "denunciante@example.com";
const SIGNED_URL = "https://storage.example.test/signed/evidencia-1.jpg?token=LEAKED";

// Dates are RELATIVE to now, deliberately. Access to a closed denuncia is
// revoked once it ages past REPORTER_ACCESS_POST_CLOSE_GRACE_MS (30 days), so a
// fixture pinned to absolute dates is a time bomb: it passes the week it is
// written and then starts rendering the no-access screen, at which point every
// negative assertion in this file passes for free and the contract goes silently
// inert. (That is not hypothetical — it is exactly what the first run of this
// file did.) `closedAt` sits INSIDE the grace window so the entitled path is the
// one under test; the revocation case overrides it explicitly.
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const REPORT_ROW = {
  id: REPORT_ID,
  referenceCode: CODE,
  createdAt: new Date(NOW - 40 * DAY_MS),
  occurredAt: new Date(NOW - 42 * DAY_MS),
  kind: "maltrato",
  severity: "critical",
  description: OWN_TEXT,
  subjectDescription: ACCUSED_DESCRIPTION,
  resolutionNotes: RESOLUTION_NOTES,
  locationAddress: STREET_ADDRESS,
  locationLat: LAT,
  locationLng: LNG,
  reporterContactEmail: REPORTER_EMAIL,
  reporterContactPhone: null,
  status: "invalid",
  triagedAt: new Date(NOW - 35 * DAY_MS),
  derivedAt: null,
  closedAt: new Date(NOW - 5 * DAY_MS),
  caseId: CASE_ID,
  assignedToUserId: OPERATOR_ID,
  flagReasons: ["no_contact"],
  derivedToOrganizationId: null,
  jurisdictionProvince: "Buenos Aires",
  jurisdictionLocality: "Veinticinco de Mayo",
};

const FORBIDDEN_IN_HTML = [
  ACCUSED_DESCRIPTION,
  RESOLUTION_NOTES,
  STREET_ADDRESS,
  LAT,
  LNG,
  CASE_ID,
  OPERATOR_ID,
  SIGNED_URL,
  "no_contact",
  "-34.60",
  "-58.38",
  // Terminal statuses are coarsened to "Cerrada": "Sin sustento" would hand the
  // good-faith reporter the grounds of the resolution, in the most discouraging
  // phrasing available.
  "Sin sustento",
  "Duplicada",
];

const mockCookieGet = vi.fn(() => undefined as { value: string } | undefined);

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.9" : null),
  })),
  cookies: vi.fn(async () => ({ get: mockCookieGet })),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    React.createElement("a", { href }, children),
}));

const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "RateLimitError";
    }
  }
  return { MockRateLimitError, mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (e: string, i: string, c: unknown) => mockEnforceRateLimit(e, i, c),
    RateLimitError: MockRateLimitError,
  };
});

const mockDbSelect = vi.fn();
vi.mock("@/db", () => ({
  db: { select: mockDbSelect },
  welfareReports: {},
  welfareReportAttachments: {},
  organizations: {},
}));

vi.mock("drizzle-orm", async (importOriginal) => (await importOriginal()) as object);

const mockWelfareSignedUrl = vi.fn(async () => SIGNED_URL);
vi.mock("@/lib/infra/storage", () => ({
  welfareAttachmentSignedUrl: mockWelfareSignedUrl,
  petPhotoUrl: vi.fn(() => null),
}));

vi.mock("@/app/(public)/denuncias/codigo/[code]/DescargarComprobante", () => ({
  DescargarComprobante: vi.fn(() => null),
}));
vi.mock("@/app/(public)/denuncias/seguimiento/SalirDelSeguimiento", () => ({
  SalirDelSeguimiento: vi.fn(() => null),
}));

// Sequenced chain: index 0 = report, index 1 = attachment rows (2 files).
function buildSequencedSelectChain(sequence: unknown[][]) {
  let callIndex = 0;
  return () => {
    const idx = callIndex++;
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () => sequence[idx] ?? []),
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mocks drizzle's awaitable chain
      then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
        Promise.resolve(sequence[idx] ?? []).then(onFulfilled, onRejected),
    };
    return chain;
  };
}

async function validSessionCookie(reportId = REPORT_ID) {
  const { encodeReporterSessionCookie, generateReporterToken } = await import(
    "@/lib/infra/denuncia-reporter-token"
  );
  return encodeReporterSessionCookie(reportId, generateReporterToken("session", reportId));
}

async function renderPage(searchParams: { nueva?: string } = {}) {
  const { default: Page } = await import("@/app/(public)/denuncias/seguimiento/page");
  const element = await Page({ searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element as React.ReactElement);
}

describe("/denuncias/seguimiento — the reporter's entitlement, and its ceiling", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(
      buildSequencedSelectChain([[REPORT_ROW], [{ id: "att-1" }, { id: "att-2" }]]),
    );
    mockCookieGet.mockReturnValue({ value: await validSessionCookie() });
  });

  it("shows the reporter their own text, constancia and retained contact", async () => {
    const html = await renderPage();

    expect(html).toContain("Seguimiento de tu denuncia"); // sanity
    expect(html).toContain(OWN_TEXT);
    expect(html).toContain(CODE);
    // Shown in FULL, not masked: the reader proved control of the channel, and a
    // Ley 25.326 access answer that hides half the datum answers nothing.
    expect(html).toContain(REPORTER_EMAIL);
  });

  it("never shows the accused's identity, internal notes, coordinates, the expediente or any signed URL", async () => {
    const html = await renderPage();

    for (const poison of FORBIDDEN_IN_HTML) {
      expect(
        html,
        `"${poison}" reached the reporter view — the reporter is not a party to the proceeding`,
      ).not.toContain(poison);
    }
    expect(
      mockWelfareSignedUrl,
      "the reporter view minted a signed evidence URL; the reporter already holds their own files",
    ).not.toHaveBeenCalled();
  });

  it("NON-VACUITY: the row handed to the page really carries the poison", async () => {
    const serialized = JSON.stringify(REPORT_ROW);
    for (const poison of [
      ACCUSED_DESCRIPTION,
      RESOLUTION_NOTES,
      STREET_ADDRESS,
      LAT,
      LNG,
      CASE_ID,
      OPERATOR_ID,
    ]) {
      expect(serialized, `fixture lost "${poison}" — this contract is inert`).toContain(poison);
    }
    // …and the page consumed THAT row, not an empty one.
    const html = await renderPage();
    expect(html).toContain(OWN_TEXT);
  });

  it("counts attachments instead of serving them", async () => {
    const html = await renderPage();
    expect(html).toContain("2 archivos");
    expect(html).not.toContain("storagePath");
  });

  it("coarsens the terminal status: an 'invalid' report reads 'Cerrada' with its date", async () => {
    const html = await renderPage();
    expect(html).toContain("Cerrada");
    expect(html).not.toContain("Sin sustento");
  });

  it("states the boundary out loud, so missing sections do not read as a malfunction", async () => {
    const html = await renderPage();
    expect(html).toContain("Qué no podemos mostrarte");
  });

  it("declares itself non-indexable", async () => {
    const mod = await import("@/app/(public)/denuncias/seguimiento/page");
    expect(mod.metadata.robots).toMatchObject({ index: false, follow: false });
  });

  // UI-7 B7, re-pinned behaviourally. This guard used to be asserted by a source
  // scan of the public code page (welfare-integration-banner-gating.test.ts); the
  // banner lives here now, gated on the coarse timeline rather than on the raw
  // status enum the reporter projection does not expose. Rendering the real page
  // is a stronger test than grepping it.
  describe("integration-pending banner", () => {
    const UNROUTED = "aún no fue enviada a la herramienta gubernamental";
    const IN_REVIEW = "En revisión por la autoridad.";

    it("shows 'not sent to the government yet' ONLY while nothing has been dated but the submission", async () => {
      mockDbSelect.mockImplementation(
        buildSequencedSelectChain([
          [{ ...REPORT_ROW, status: "open", triagedAt: null, derivedAt: null, closedAt: null }],
          [],
        ]),
      );
      const html = await renderPage();
      expect(html).toContain(UNROUTED);
      expect(html).not.toContain(IN_REVIEW);
    });

    it("never claims 'not sent yet' once the report was triaged — that would contradict the timeline", async () => {
      // The original UI-7 B7 bug: the banner showed for ANY non-terminal status,
      // so a reporter whose case a funcionario was already working was told
      // nothing had been sent.
      mockDbSelect.mockImplementation(
        buildSequencedSelectChain([[{ ...REPORT_ROW, closedAt: null }], []]),
      );
      const html = await renderPage();
      expect(html).not.toContain(UNROUTED);
      expect(html).toContain(IN_REVIEW);
    });

    it("shows NEITHER notice on a closed report — both would contradict the 'Cerrada' stage", async () => {
      // Covers all three terminal statuses at once: the timeline coarsens
      // closed/invalid/duplicate into one dated "cerrada", so a single closedAt
      // is the guard for all of them. REPORT_ROW carries status 'invalid'.
      const html = await renderPage();
      expect(html).toContain("Cerrada");
      expect(html).not.toContain(UNROUTED);
      expect(html).not.toContain(IN_REVIEW);
    });
  });
});

describe("/denuncias/seguimiento — no session, no view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(buildSequencedSelectChain([[REPORT_ROW], [{ id: "att-1" }]]));
  });

  it("with NO cookie: renders the no-access screen and never queries the denuncia", async () => {
    mockCookieGet.mockReturnValue(undefined);
    const html = await renderPage();

    expect(html).toContain("No podemos mostrar el seguimiento");
    expect(html).not.toContain(OWN_TEXT);
    expect(
      mockDbSelect,
      "the denuncia was read before the session was verified",
    ).not.toHaveBeenCalled();
  });

  it("with a FORGED cookie (reportId swapped under a valid MAC): no view, no query", async () => {
    const { encodeReporterSessionCookie, generateReporterToken } = await import(
      "@/lib/infra/denuncia-reporter-token"
    );
    const other = "12121212-3434-5656-7878-909090909090";
    mockCookieGet.mockReturnValue({
      value: encodeReporterSessionCookie(REPORT_ID, generateReporterToken("session", other)),
    });

    const html = await renderPage();
    expect(html).toContain("No podemos mostrar el seguimiento");
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("with an EXPIRED cookie: no view", async () => {
    const { encodeReporterSessionCookie, generateReporterToken } = await import(
      "@/lib/infra/denuncia-reporter-token"
    );
    const stale = generateReporterToken("session", REPORT_ID, Date.now() - 61 * 60 * 1000);
    mockCookieGet.mockReturnValue({
      value: encodeReporterSessionCookie(REPORT_ID, stale),
    });

    const html = await renderPage();
    expect(html).toContain("No podemos mostrar el seguimiento");
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("revokes access once a closed denuncia ages past the grace period", async () => {
    // Deliberate deviation from a literal revoke-on-close, documented in
    // denuncia-reporter-token.ts: the reporter keeps access for 30 days after
    // the close so they can actually learn the outcome, then loses it.
    mockCookieGet.mockReturnValue({ value: await validSessionCookie() });
    const longClosed = {
      ...REPORT_ROW,
      closedAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    };
    mockDbSelect.mockImplementation(buildSequencedSelectChain([[longClosed], []]));

    const html = await renderPage();
    expect(html).toContain("No podemos mostrar el seguimiento");
    expect(html).not.toContain(OWN_TEXT);
  });
});
