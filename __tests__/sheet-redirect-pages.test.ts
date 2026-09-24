/**
 * A11 — Sheet-redirect page tests.
 *
 * Verifies that the 4 sheet-first event routes (medicacion-inicio, peso,
 * sintoma, nota) now redirect to the parent pet-profile page with the
 * correct ?sheet= param instead of 404-ing on direct navigation.
 *
 * Pattern: mock next/navigation.redirect, call the page component directly,
 * assert on the URL passed to redirect. No jsdom / network needed.
 */

import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Stable fixture
// ---------------------------------------------------------------------------

const TOKEN = "DIM-TEST-ABCD";

// ---------------------------------------------------------------------------
// Mock: next/navigation
// redirect() throws a special error in Next.js; capture the URL instead.
// ---------------------------------------------------------------------------

const captured: { url: string | null } = { url: null };

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    captured.url = url;
    throw new Error(`REDIRECT:${url}`);
  }),
}));

// ---------------------------------------------------------------------------
// Helper: call page component and capture the redirect target
// ---------------------------------------------------------------------------

async function callPage(
  importPath: string,
  params: Record<string, string>,
  searchParams: Record<string, string> = {},
): Promise<string> {
  captured.url = null;
  const mod = await import(importPath);
  const Page = mod.default as (props: {
    params: Promise<Record<string, string>>;
    searchParams: Promise<Record<string, string>>;
  }) => Promise<unknown>;

  try {
    await Page({
      params: Promise.resolve(params),
      searchParams: Promise.resolve(searchParams),
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("REDIRECT:")) {
      return captured.url!;
    }
    throw err;
  }
  throw new Error("Expected redirect was not called");
}

// ---------------------------------------------------------------------------
// medicacion-inicio → ?sheet=medicacion
// ---------------------------------------------------------------------------

describe("medicacion-inicio redirect page (A11)", () => {
  it("redirects to ?sheet=medicacion without extra params", async () => {
    const url = await callPage(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-inicio/page",
      { publicToken: TOKEN },
    );
    expect(url).toBe(`/mis-mascotas/${TOKEN}?sheet=medicacion`);
  });

  it("forwards notes and occurredAt to the sheet URL", async () => {
    const url = await callPage(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/medicacion-inicio/page",
      { publicToken: TOKEN },
      { notes: "Amoxicilina", occurredAt: "2026-06-24" },
    );
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("sheet")).toBe("medicacion");
    expect(parsed.searchParams.get("notes")).toBe("Amoxicilina");
    expect(parsed.searchParams.get("occurredAt")).toBe("2026-06-24");
  });
});

// ---------------------------------------------------------------------------
// peso → ?sheet=peso
// ---------------------------------------------------------------------------

describe("peso redirect page (A11)", () => {
  it("redirects to ?sheet=peso without extra params", async () => {
    const url = await callPage("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/page", {
      publicToken: TOKEN,
    });
    expect(url).toBe(`/mis-mascotas/${TOKEN}?sheet=peso`);
  });

  it("forwards kg, occurredAt, notes to the sheet URL", async () => {
    const url = await callPage(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/peso/page",
      { publicToken: TOKEN },
      { kg: "12.5", occurredAt: "2026-06-24", notes: "post-dieta" },
    );
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("sheet")).toBe("peso");
    expect(parsed.searchParams.get("kg")).toBe("12.5");
    expect(parsed.searchParams.get("occurredAt")).toBe("2026-06-24");
    expect(parsed.searchParams.get("notes")).toBe("post-dieta");
  });
});

// ---------------------------------------------------------------------------
// sintoma → ?sheet=sintoma
// ---------------------------------------------------------------------------

describe("sintoma redirect page (A11)", () => {
  it("redirects to ?sheet=sintoma without extra params", async () => {
    const url = await callPage(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/page",
      { publicToken: TOKEN },
    );
    expect(url).toBe(`/mis-mascotas/${TOKEN}?sheet=sintoma`);
  });

  it("forwards freeText and onsetAt to the sheet URL", async () => {
    const url = await callPage(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/sintoma/page",
      { publicToken: TOKEN },
      { freeText: "vomita mucho", onsetAt: "2026-06-20" },
    );
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("sheet")).toBe("sintoma");
    expect(parsed.searchParams.get("freeText")).toBe("vomita mucho");
    expect(parsed.searchParams.get("onsetAt")).toBe("2026-06-20");
  });
});

// ---------------------------------------------------------------------------
// nota → ?sheet=nota
// ---------------------------------------------------------------------------

describe("nota redirect page (A11)", () => {
  it("redirects to ?sheet=nota without extra params", async () => {
    const url = await callPage("@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/nota/page", {
      publicToken: TOKEN,
    });
    expect(url).toBe(`/mis-mascotas/${TOKEN}?sheet=nota`);
  });

  it("forwards text and occurredAt to the sheet URL", async () => {
    const url = await callPage(
      "@/app/(app)/mis-mascotas/[publicToken]/eventos/nuevo/nota/page",
      { publicToken: TOKEN },
      { text: "Se portó bien", occurredAt: "2026-06-24" },
    );
    const parsed = new URL(url, "http://x");
    expect(parsed.searchParams.get("sheet")).toBe("nota");
    expect(parsed.searchParams.get("text")).toBe("Se portó bien");
    expect(parsed.searchParams.get("occurredAt")).toBe("2026-06-24");
  });
});
