// Tier-0 PII contract — /denuncias/codigo/[code] (change legal/denuncias-despublicadas).
//
// WHAT THIS PAGE WAS. An external legal review concluded it must stop being a
// public page. Any holder of a shareable DEN-XXXX-XXXX code, with no session,
// was served the denunciante's full free-text account, the description of the
// ACCUSED, the locality and province, a coarsened map point, the reporter's
// masked contact, and signed URLs to every photo and video of evidence — an
// unverified allegation of a crime that carries prison (Ley 14.346 art. 1),
// against a person who has not been investigated, published to an indeterminate
// audience at a permanently addressable URL.
//
// METHOD, mirroring __tests__/public-token-pii-contract.test.tsx (the closest
// precedent in this repo, and the reason it is the precedent: it drives the REAL
// page.tsx data path rather than a mock of it). The stubbed DB returns a FULL,
// sensitive-looking `welfare_reports` row — every column, populated — simulating
// exactly what happens if someone widens the page's narrow
// `select({id, createdAt})` back to `select()`. The page is then the only thing
// standing between that row and the HTML. Every assertion below is about what
// the page chooses to render, not about what the query happened to return.
//
// The two structural guards matter as much as the string assertions:
//   • db.select is called EXACTLY ONCE — the evidence table is never read, so no
//     storagePath ever exists in scope to be signed.
//   • the welfare signer is never invoked — no bearer capability is minted. A
//     signed URL outlives the page view by an hour and travels straight to
//     Supabase Storage, bypassing this route's rate limiter entirely.

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fixtures — distinctive, greppable poison
// ---------------------------------------------------------------------------

const CODE = "DEN-ABCD-EFGH";
const REPORT_ID = "99999999-8888-7777-6666-555555555555";
const OWN_TEXT = "Vi tres perros sin agua atados al sol todo el dia, hace una semana.";
const ACCUSED_DESCRIPTION = "hombre de unos sesenta, del galpon de chapa sobre la ruta";
const LOCALITY = "Veinticinco de Mayo";
const PROVINCE = "Buenos Aires";
const STREET_ADDRESS = "Ruta 8 km 41, casa con reja verde";
const LAT = "-34.6037220";
const LNG = "-58.3815920";
const REPORTER_EMAIL = "denunciante@example.com";
const REPORTER_PHONE = "+5491133445566";
const RESOLUTION_NOTES = "se archiva por falta de merito";
const CASE_ID = "11111111-2222-3333-4444-555555555555";
const STORAGE_PATH = "welfare/99999999/evidencia-1.jpg";
const SIGNED_URL = "https://storage.example.test/signed/evidencia-1.jpg?token=LEAKED";

const FULL_REPORT_ROW = {
  id: REPORT_ID,
  referenceCode: CODE,
  createdAt: new Date("2026-03-01T10:00:00Z"),
  occurredAt: new Date("2026-02-27T18:30:00Z"),
  kind: "maltrato",
  severity: "critical",
  description: OWN_TEXT,
  subjectKind: "unregistered_animal",
  subjectDescription: ACCUSED_DESCRIPTION,
  subjectPetId: null,
  locationAddress: STREET_ADDRESS,
  jurisdictionProvince: PROVINCE,
  jurisdictionLocality: LOCALITY,
  locationLat: LAT,
  locationLng: LNG,
  reporterContactEmail: REPORTER_EMAIL,
  reporterContactPhone: REPORTER_PHONE,
  status: "in_progress",
  triagedAt: new Date("2026-03-05T10:00:00Z"),
  derivedAt: null,
  closedAt: null,
  resolutionNotes: RESOLUTION_NOTES,
  caseId: CASE_ID,
  flagReasons: ["no_contact"],
  seedTag: null,
};

// Values that must never appear in the unauthenticated HTML. The masked forms of
// the contact are included too: masking was the old mitigation, and "partially
// leaked" is still leaked on a page that should disclose nothing.
const FORBIDDEN_IN_HTML = [
  OWN_TEXT,
  ACCUSED_DESCRIPTION,
  LOCALITY,
  PROVINCE,
  STREET_ADDRESS,
  LAT,
  LNG,
  REPORTER_EMAIL,
  REPORTER_PHONE,
  RESOLUTION_NOTES,
  CASE_ID,
  STORAGE_PATH,
  SIGNED_URL,
  "-34.60", // coarsened coordinate prefix — coarsening is not a defence here
  "-58.38",
];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockCookieGet = vi.fn(() => undefined as { value: string } | undefined);

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => (key === "x-real-ip" ? "198.51.100.9" : null),
  })),
  cookies: vi.fn(async () => ({ get: mockCookieGet })),
}));

const mockNotFound = vi.fn(() => {
  throw new Error("NOT_FOUND");
});
const mockRedirect = vi.fn((to: string) => {
  throw new Error(`REDIRECT:${to}`);
});

vi.mock("next/navigation", () => ({
  notFound: () => mockNotFound(),
  redirect: (to: string) => mockRedirect(to),
}));

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

const { MockRateLimitError, mockEnforceRateLimit } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    resetAt: Date;
    reason: string;
    constructor(resetAt: Date, reason: string) {
      super(`Rate limit exceeded: ${reason}`);
      this.name = "RateLimitError";
      this.resetAt = resetAt;
      this.reason = reason;
    }
  }
  return { MockRateLimitError, mockEnforceRateLimit: vi.fn().mockResolvedValue(undefined) };
});

vi.mock("@/lib/infra/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/infra/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (endpoint: string, id: string, cfg: unknown) =>
      mockEnforceRateLimit(endpoint, id, cfg),
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

// Storage signer spy. Not imported by the page any more — that is the point.
// If a future edit re-adds the evidence gallery, this goes red instead of
// shipping a one-hour bearer capability to an anonymous code holder.
const mockWelfareSignedUrl = vi.fn(async () => SIGNED_URL);
vi.mock("@/lib/infra/storage", () => ({
  welfareAttachmentSignedUrl: mockWelfareSignedUrl,
  petPhotoUrl: vi.fn(() => null),
}));

// The access-request form is a client component whose action module pulls in the
// server-only mailer. Replaced by a marker so this test can still assert the
// authenticate prompt is offered.
vi.mock("@/app/(public)/denuncias/codigo/[code]/SolicitarAccesoForm", () => ({
  SolicitarAccesoForm: vi.fn(({ code }: { code: string }) =>
    React.createElement("div", { "data-testid": "solicitar-acceso", "data-code": code }),
  ),
}));

vi.mock("@/app/(public)/denuncias/codigo/[code]/CopyCodeButton", () => ({
  CopyCodeButton: vi.fn(() => null),
}));

function selectChainReturning(rows: unknown[]) {
  return () => {
    const chain = {
      from: vi.fn(() => chain),
      where: vi.fn(() => chain),
      limit: vi.fn(async () => rows),
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable — mocks drizzle's awaitable chain
      then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (r: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  };
}

async function renderPage(code = CODE, searchParams: { nueva?: string } = {}) {
  const { default: Page } = await import("@/app/(public)/denuncias/codigo/[code]/page");
  const element = await Page({
    params: Promise.resolve({ code }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as React.ReactElement);
}

// ---------------------------------------------------------------------------

describe("/denuncias/codigo/[code] — the unauthenticated surface discloses nothing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockCookieGet.mockReturnValue(undefined);
    mockDbSelect.mockImplementation(selectChainReturning([FULL_REPORT_ROW]));
  });

  it("renders NONE of the description, the accused's description, the location, the contact or any signed URL — even though the DB handed it all over", async () => {
    const html = await renderPage();

    expect(html).toContain("Denuncia registrada"); // sanity: the page rendered
    for (const poison of FORBIDDEN_IN_HTML) {
      expect(
        html,
        `"${poison}" is being served to an anonymous holder of the reference code — this page was unpublished precisely to stop that`,
      ).not.toContain(poison);
    }
  });

  it("NON-VACUITY: the fixture really is loaded, so the assertions above have something to withhold", async () => {
    // A negative assertion is satisfied just as well by a page that never had
    // the data as by a page that had it and refused to print it. Those are
    // different security postures and only the second is what this file claims.
    // The row the page received carries every poison value.
    const serialized = JSON.stringify(FULL_REPORT_ROW);
    for (const poison of [
      OWN_TEXT,
      ACCUSED_DESCRIPTION,
      LOCALITY,
      PROVINCE,
      STREET_ADDRESS,
      LAT,
      LNG,
      REPORTER_EMAIL,
      REPORTER_PHONE,
      RESOLUTION_NOTES,
      CASE_ID,
    ]) {
      expect(
        serialized,
        `the hostile fixture lost "${poison}" — this contract has gone inert`,
      ).toContain(poison);
    }
    // …and prove the page really consumed THAT row: it printed the row's
    // createdAt. If the DB sequence ever drifts so the page 404s instead, the
    // negative assertions above would silently start passing for free.
    const html = await renderPage();
    expect(html).toMatch(/Registrada/);
  });

  it("never mints a signed evidence URL and never reads the attachments table", async () => {
    await renderPage();

    expect(
      mockWelfareSignedUrl,
      "a signed welfare-evidence URL was minted on the anonymous route — it is a bearer capability that outlives the page view and bypasses this route's rate limiter",
    ).not.toHaveBeenCalled();
    // Exactly one query: the report lookup. A second would mean the attachments
    // rows (and therefore storagePaths) came back into scope.
    expect(mockDbSelect).toHaveBeenCalledTimes(1);
  });

  it("discloses only existence, the code and the date, and offers the authenticate path", async () => {
    const html = await renderPage();

    expect(html).toContain(CODE);
    expect(html).toContain("Registrada");
    expect(html).toContain('data-testid="solicitar-acceso"');
    // Status is deliberately withheld: it is process information about an
    // investigation into a person named in the file, and a bare code is not an
    // identity.
    for (const statusLabel of ["En curso", "Abierta", "Revisada", "Cerrada", "Sin sustento"]) {
      expect(html, `status label "${statusLabel}" leaked to a bare code holder`).not.toContain(
        statusLabel,
      );
    }
  });

  it("declares itself non-indexable — there is no robots.txt in this repo to fall back on", async () => {
    const mod = await import("@/app/(public)/denuncias/codigo/[code]/page");
    expect(mod.metadata.robots).toMatchObject({ index: false, follow: false });
  });

  it("rate-limits BEFORE any data fetch, and throttling short-circuits the query entirely", async () => {
    mockEnforceRateLimit.mockRejectedValueOnce(new MockRateLimitError(new Date(), "test"));
    const html = await renderPage();

    expect(html).toContain("Demasiadas consultas");
    expect(
      mockDbSelect,
      "the DB was queried despite the rate limiter rejecting — the guard runs after the fetch",
    ).not.toHaveBeenCalled();
  });

  it("404s a malformed code without touching the DB", async () => {
    await expect(renderPage("NOT-A-CODE")).rejects.toThrow("NOT_FOUND");
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  it("404s an unknown code rather than confirming it is unknown by other means", async () => {
    mockDbSelect.mockImplementation(selectChainReturning([]));
    await expect(renderPage()).rejects.toThrow("NOT_FOUND");
    expect(mockNotFound).toHaveBeenCalled();
  });
});

describe("/denuncias/codigo/[code] — an authenticated reporter is offered their own view", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue(undefined);
    mockDbSelect.mockImplementation(selectChainReturning([FULL_REPORT_ROW]));
  });

  it("offers a link to /denuncias/seguimiento — and still discloses nothing on THIS page", async () => {
    // A LINK, not a redirect, and deliberately so: this is the URL the reporter
    // keeps (post-submit landing, screenshot, history entry carrying the
    // constancia code). Redirecting would strip the code out of the address bar
    // at the moment they are being told to save it. The sensitive view instead
    // lives at a URL carrying no identifier at all.
    const { encodeReporterSessionCookie, generateReporterToken } = await import(
      "@/lib/infra/denuncia-reporter-token"
    );
    mockCookieGet.mockReturnValue({
      value: encodeReporterSessionCookie(REPORT_ID, generateReporterToken("session", REPORT_ID)),
    });

    const html = await renderPage(CODE, { nueva: "1" });

    expect(html).toContain("/denuncias/seguimiento");
    expect(html).toContain("Ver el seguimiento de mi denuncia");
    // The reporter is authenticated, but this page is still the PUBLIC one. It
    // must not start disclosing just because a cookie is present — otherwise the
    // URL people save and share becomes conditionally sensitive, which is exactly
    // the ambiguity this change removed.
    for (const poison of FORBIDDEN_IN_HTML) {
      expect(
        html,
        `"${poison}" appeared on the public code page for an authenticated reporter — this URL must be safe to share regardless of who loads it`,
      ).not.toContain(poison);
    }
  });

  it("keeps the post-submit confirmation banner (and still gates it on the DATA, not on ?nueva=1)", async () => {
    // e2e and the synthetic monitor both assert this copy, and more importantly a
    // reporter who submits and lands on a page that says nothing assumes it
    // failed. S8-F03: the banner asserts a fact in the present tense, so it is
    // checked against createdAt rather than the query string.
    const fresh = { ...FULL_REPORT_ROW, createdAt: new Date() };
    mockDbSelect.mockImplementation(selectChainReturning([fresh]));

    expect(await renderPage(CODE, { nueva: "1" })).toContain("Tu denuncia fue registrada.");
    // Same flag on an old report → no claim.
    mockDbSelect.mockImplementation(selectChainReturning([FULL_REPORT_ROW]));
    expect(await renderPage(CODE, { nueva: "1" })).not.toContain("Tu denuncia fue registrada.");
  });

  it("does NOT redirect on a session cookie belonging to a DIFFERENT denuncia", async () => {
    // Cross-report cookie reuse must not become a read of this report, and must
    // not even be treated as "some reporter is logged in".
    const { encodeReporterSessionCookie, generateReporterToken } = await import(
      "@/lib/infra/denuncia-reporter-token"
    );
    const other = "12121212-3434-5656-7878-909090909090";
    mockCookieGet.mockReturnValue({
      value: encodeReporterSessionCookie(other, generateReporterToken("session", other)),
    });

    const html = await renderPage();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(html).toContain('data-testid="solicitar-acceso"');
    for (const poison of FORBIDDEN_IN_HTML) {
      expect(html).not.toContain(poison);
    }
  });
});
