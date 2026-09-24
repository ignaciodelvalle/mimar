// caso-estado — value tests + the module-BOUNDARY guard for R1
// (opfilterbar-sweep-2026-07-21).
//
// THE BUG: parseCasoEstado used to be defined/exported INSIDE
// CasoEstadoFilter.tsx, a "use client" module. Both /gob/casos and
// /admin/casos call parseCasoEstado from their server-side data-loading
// function — but Next's RSC bundler treats EVERY export of a "use client"
// module as a client reference, so calling (not rendering) it from a Server
// Component crashed at runtime: "Attempted to call parseCasoEstado() from
// the server but parseCasoEstado is on the client." tsc did NOT catch this
// (bundler-level constraint, invisible to the type system), and this
// project's Vitest config does not enforce the RSC boundary either (plain
// @vitejs/plugin-react, no `react-server` condition — see vitest.config.ts),
// so a plain value/behavior test of parseCasoEstado would pass identically
// whether it lives in a "use client" file or not.
//
// This file pins the ACTUAL invariant that fixes R1: parseCasoEstado (and its
// options) must live in a module WITHOUT "use client", so any future edit
// that moves it back into a client file — or adds "use client" to this file
// — fails a fast, static check instead of only surfacing as a runtime 500 on
// the deployed server.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { CASO_ESTADO_OPTIONS, parseCasoEstado } from "./caso-estado";

describe("caso-estado module boundary (R1 guard)", () => {
  it("this module has NO 'use client' directive — a Server Component must be able to call parseCasoEstado directly", () => {
    const source = readFileSync(join(__dirname, "caso-estado.ts"), "utf8");
    expect(source).not.toMatch(/^\s*["']use client["'];?\s*$/m);
  });

  it("CasoEstadoFilter.tsx no longer DEFINES parseCasoEstado (it only imports the component)", () => {
    const source = readFileSync(join(__dirname, "CasoEstadoFilter.tsx"), "utf8");
    expect(source).not.toMatch(/export function parseCasoEstado/);
  });
});

describe("parseCasoEstado", () => {
  it("defaults to 'open' for an absent/garbage status param", () => {
    expect(parseCasoEstado(undefined)).toBe("open");
    expect(parseCasoEstado("bogus")).toBe("open");
  });

  it("recognizes 'all' and 'closed' explicitly", () => {
    expect(parseCasoEstado("all")).toBe("all");
    expect(parseCasoEstado("closed")).toBe("closed");
  });

  it("exposes exactly 3 options: open/all/closed", () => {
    expect(CASO_ESTADO_OPTIONS.map((o) => o.value)).toEqual(["open", "all", "closed"]);
  });
});
