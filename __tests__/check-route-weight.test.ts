/**
 * Tests para scripts/check-route-weight.ts.
 *
 * La reja del Lote E mide BYTES EXCLUSIVOS por ruta, leídos del manifiesto que
 * escribe el build. El diseño puso una condición antes de tocar la hidratación
 * de Panorama: **verificarla en rojo** antes de confiar en su verde. Estos tests
 * son esa verificación, hecha permanente.
 *
 * Se ejercita la lógica pura contra manifiestos sintéticos y contra el
 * manifiesto REAL cuando existe. Ninguno reimplementa la regla que guarda: le
 * dan entradas y miran la salida.
 */

import { describe, expect, it } from "vitest";

import {
  EXCLUSIVE_SHARE_MAX,
  MIN_ROUTES,
  TOLERANCE,
  readBaseline,
  readManifest,
  routeShare,
  weighRoute,
} from "@/scripts/check-route-weight";

// Un manifiesto sintético no puede usar statSync sobre archivos reales, así que
// los casos de pesaje usan el manifiesto REAL. Lo sintético prueba routeShare,
// que es aritmética pura.
describe("routeShare", () => {
  it("cuenta en cuántas rutas aparece cada archivo", () => {
    const share = routeShare({
      "/a/page": ["static/chunks/shared.js", "static/chunks/a.js"],
      "/b/page": ["static/chunks/shared.js", "static/chunks/b.js"],
      "/c/page": ["static/chunks/shared.js"],
    });

    expect(share.get("static/chunks/shared.js")).toBe(3);
    expect(share.get("static/chunks/a.js")).toBe(1);
  });

  it("devuelve un mapa vacío para un manifiesto sin rutas", () => {
    expect(routeShare({}).size).toBe(0);
  });
});

describe("constantes de la reja", () => {
  // El umbral separa "peso de esta ruta" de "chrome que comparte medio
  // producto". Si sube demasiado, un salto del framework enrojece Panorama; si
  // baja a 1, un panel compartido entre las dos consolas deja de contarse.
  it("el umbral de exclusividad es 3", () => {
    expect(EXCLUSIVE_SHARE_MAX).toBe(3);
  });

  it("la banda es del 2% — ancha para el ruido del bundler, angosta para un panel", () => {
    expect(TOLERANCE).toBe(0.02);
  });

  it("el piso de rutas está muy por debajo del build real pero lejos de cero", () => {
    expect(MIN_ROUTES).toBeGreaterThan(100);
    expect(MIN_ROUTES).toBeLessThan(501);
  });
});

describe("el baseline es documentado, no sólo numérico", () => {
  const baseline = readBaseline();

  it("vigila las DOS consolas de panorama, no sólo la de admin", () => {
    // "El gemelo se escapa" es la categoría de defecto más repetida de este
    // repo, y el gemelo de gobierno pesa MÁS que el de admin.
    expect(Object.keys(baseline).sort()).toEqual(["/admin/panorama/page", "/gob/panorama/page"]);
  });

  it("cada entrada dice por qué se vigila, y con qué número", () => {
    for (const [route, entry] of Object.entries(baseline)) {
      expect(entry.exclusiveBytes, `${route} sin número`).toBeGreaterThan(0);
      expect(entry.reason.length, `${route} sin razón escrita`).toBeGreaterThan(40);
      expect(entry.reason, `${route} sigue con la razón TODO`).not.toMatch(/^TODO/);
    }
  });
});

// Estos sólo corren cuando hay build. Se saltean con ruido en vez de en
// silencio: un test que se auto-jubila sin decirlo es la trampa que
// e2e/README.md documenta para los gates por fixture.
describe("pesaje contra el manifiesto real", () => {
  const manifest = readManifest();
  const pages = manifest?.pages;

  it.runIf(pages)("mide la ruta y separa exclusivos de compartidos", () => {
    if (!pages) return;
    const share = routeShare(pages);
    const w = weighRoute("/admin/panorama/page", pages, share);

    expect("error" in w, JSON.stringify(w)).toBe(false);
    if ("error" in w) return;

    expect(w.files).toBeGreaterThan(0);
    expect(w.exclusiveBytes).toBeGreaterThan(0);
    // La separación tiene que ser real: si los compartidos fueran 0, el número
    // que gatea sería el bundle entero y un salto del framework lo movería.
    expect(w.sharedBytes).toBeGreaterThan(0);
    expect(w.exclusiveBytes + w.sharedBytes).toBe(w.totalBytes);
  });

  it.runIf(pages)("no encuentra una ruta que no existe, y lo dice", () => {
    if (!pages) return;
    const w = weighRoute("/ruta/que/no/existe/page", pages, routeShare(pages));
    expect("error" in w).toBe(true);
  });

  it.runIf(pages)("el baseline coincide con el árbol dentro de la banda", () => {
    if (!pages) return;
    const share = routeShare(pages);
    for (const [route, entry] of Object.entries(readBaseline())) {
      const w = weighRoute(route, pages, share);
      if ("error" in w) throw new Error(`${route}: ${w.error}`);
      const band = Math.round(entry.exclusiveBytes * TOLERANCE);
      expect(
        Math.abs(w.exclusiveBytes - entry.exclusiveBytes),
        `${route}: ${w.exclusiveBytes} B contra baseline ${entry.exclusiveBytes} B`,
      ).toBeLessThanOrEqual(band);
    }
  });

  it("dice en voz alta cuando no hay build que medir", () => {
    // No es decoración: sin esta línea, una corrida sin build se lee igual que
    // una corrida limpia.
    if (!pages) {
      console.warn(
        "[check-route-weight.test] sin .next/app-build-manifest.json — los casos de pesaje NO corrieron.",
      );
    }
    expect(true).toBe(true);
  });
});
