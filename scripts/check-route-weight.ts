// ---------------------------------------------------------------------------
// check-route-weight — el peso de una ruta no puede crecer sin que alguien lo vea
// ---------------------------------------------------------------------------
//
// QUÉ MIDE, Y POR QUÉ ESTO Y NO INP
//
// El backlog pedía una reja de INP antes de tocar la hidratación de Panorama
// ("el riesgo real no es partir el archivo sino partirlo sin medir"). La
// refutación del diseño descartó INP y tenía razón: no es reproducible entre
// corridas, depende de la máquina y de la interacción, y este repo ya tiene
// escrito que **un gate que cría lobo es peor que ningún gate** — entrena a
// todos a ignorarlo, y entonces la única vez que tiene razón también se ignora.
//
// El proxy correcto es determinístico: los BYTES EXCLUSIVOS de la ruta, leídos
// del manifiesto que el propio build escribe. Mismo árbol, mismo número, todas
// las veces.
//
// "Exclusivo" = archivos del manifiesto de la ruta que aparecen en 3 rutas o
// menos. El framework y el chrome compartido quedan afuera a propósito: un salto
// de Next no debe enrojecer Panorama, y un panel que Panorama deja de cargar
// ansiosamente SÍ debe verse. `totalBytes` y `sharedBytes` se imprimen y NO
// gatean, para que el contexto esté a la vista sin ensuciar la señal.
//
// LOS DOS GEMELOS. Se baselinean /admin/panorama Y /gob/panorama. Medidos el
// 2026-08-10: 242.526 B y 243.142 B — el de gobierno pesa MÁS. Cubrir sólo el de
// admin habría sido, otra vez, "el gemelo se escapa": la categoría de defecto
// más repetida de este repo.
//
// ANTI-VACUIDAD (cuatro pisos). Una reja que puede pasar en verde habiendo
// medido cero es peor que no tenerla, y esta semana tres fences de este repo
// hicieron exactamente eso.
//
//   1. Sin manifiesto → skip RUIDOSO que dice que no probó nada. `--require-build`
//      lo vuelve exit 1 (para CI, donde el build siempre precede).
//   2. Manifiesto con menos de MIN_ROUTES rutas, o un archivo listado que no
//      existe o pesa 0 → exit 1. Es un `.next` a medio escribir, no un árbol sano.
//   3. Cero rutas baselineadas parseadas → exit 1.
//   4. Una ruta baselineada ausente del manifiesto → exit 1. Renombrar es el
//      evento esperado, no la excepción.
//
// USO
//   pnpm lint:route-weight
//   pnpm exec tsx scripts/check-route-weight.ts --write-baseline
//   pnpm exec tsx scripts/check-route-weight.ts --require-build   (CI)

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const MANIFEST = ".next/app-build-manifest.json";
const BASELINE_FILE = "scripts/route-weight-baseline.json";

/** Un archivo en más rutas que esto es chrome compartido, no peso de la ruta. */
export const EXCLUSIVE_SHARE_MAX = 3;

/** Banda de tolerancia sobre los bytes exclusivos. */
export const TOLERANCE = 0.02;

/**
 * Piso de rutas en el manifiesto. El build real tiene ~501; muy por debajo
 * significa un `.next` truncado, no una app más chica.
 */
export const MIN_ROUTES = 400;

type Manifest = { pages?: Record<string, string[]> };
type BaselineEntry = { exclusiveBytes: number; reason: string };
type Baseline = Record<string, BaselineEntry>;

export type RouteWeight = {
  files: number;
  totalBytes: number;
  exclusiveBytes: number;
  sharedBytes: number;
};

export function readManifest(path = MANIFEST): Manifest | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** route-share por archivo: en cuántas rutas del manifiesto aparece. */
export function routeShare(pages: Record<string, string[]>): Map<string, number> {
  const share = new Map<string, number>();
  for (const files of Object.values(pages)) {
    for (const f of files) share.set(f, (share.get(f) ?? 0) + 1);
  }
  return share;
}

export function weighRoute(
  route: string,
  pages: Record<string, string[]>,
  share: Map<string, number>,
  buildDir = ".next",
): RouteWeight | { error: string } {
  const files = pages[route];
  if (!files) return { error: "la ruta no está en el manifiesto" };

  let totalBytes = 0;
  let exclusiveBytes = 0;
  for (const f of files) {
    let size: number;
    try {
      size = statSync(`${buildDir}/${f}`).size;
    } catch {
      return { error: `el manifiesto lista ${f}, que no existe en ${buildDir}` };
    }
    // Piso 2: un archivo de 0 bytes es un build a medio escribir, y su peso
    // "mejoraría" el número mintiendo.
    if (size === 0) return { error: `${f} pesa 0 bytes — build incompleto` };
    totalBytes += size;
    if ((share.get(f) ?? 0) <= EXCLUSIVE_SHARE_MAX) exclusiveBytes += size;
  }
  return {
    files: files.length,
    totalBytes,
    exclusiveBytes,
    sharedBytes: totalBytes - exclusiveBytes,
  };
}

export function readBaseline(path = BASELINE_FILE): Baseline {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Baseline;
}

const fmt = (n: number) => n.toLocaleString("es-AR");

function writeBaseline(pages: Record<string, string[]>, share: Map<string, number>): void {
  const existing = readBaseline();
  const routes = Object.keys(existing).length > 0 ? Object.keys(existing) : Object.keys(pages);
  const next: Baseline = {};
  for (const route of routes) {
    const w = weighRoute(route, pages, share);
    if ("error" in w) {
      console.error(`✗ ${route}: ${w.error}`);
      process.exit(1);
    }
    next[route] = {
      exclusiveBytes: w.exclusiveBytes,
      reason: existing[route]?.reason ?? "TODO: por qué esta ruta se vigila",
    };
  }
  writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`✓ baseline escrito — ${Object.keys(next).length} ruta(s)`);
}

function runCheck(): void {
  const requireBuild = process.argv.includes("--require-build");
  const manifest = readManifest();

  // Piso 1 — sin build no se midió nada, y hay que decirlo con todas las letras.
  if (!manifest?.pages) {
    const msg = `check-route-weight: no encontré ${MANIFEST}.\n  NO SE MIDIÓ NADA. El peso de las rutas no fue verificado en esta corrida.\n  Corré \`pnpm build\` primero (en \`pnpm verify\` el build ya va antes que este fence).`;
    if (requireBuild) {
      console.error(`✗ ${msg}`);
      process.exit(1);
    }
    console.warn(`[skip] ${msg}`);
    return;
  }

  const pages = manifest.pages;
  const routeCount = Object.keys(pages).length;

  // Piso 2 — un manifiesto raquítico es un build truncado.
  if (routeCount < MIN_ROUTES) {
    console.error(
      `✗ check-route-weight: el manifiesto declara ${routeCount} ruta(s), menos de ${MIN_ROUTES}. Eso es un .next a medio escribir, no una app más chica. No se juzga sobre un build parcial.`,
    );
    process.exit(1);
  }

  const share = routeShare(pages);

  if (process.argv.includes("--write-baseline")) {
    writeBaseline(pages, share);
    return;
  }

  const baseline = readBaseline();
  const routes = Object.keys(baseline);

  // Piso 3 — sin rutas baselineadas no hay nada que comparar.
  if (routes.length === 0) {
    console.error(
      `✗ check-route-weight: ${BASELINE_FILE} no tiene ninguna ruta. Este check no puede pasar habiendo comparado nada — generalo con --write-baseline.`,
    );
    process.exit(1);
  }

  let hits = 0;
  for (const route of routes) {
    const entry = baseline[route];
    const w = weighRoute(route, pages, share);

    // Piso 4 — una ruta baselineada que ya no está en el build.
    if ("error" in w) {
      console.error(
        `✗ ${route}: ${w.error}. Si la ruta se renombró, actualizá ${BASELINE_FILE}; una entrada muerta deja de vigilar sin avisar.`,
      );
      hits += 1;
      continue;
    }

    const band = Math.round(entry.exclusiveBytes * TOLERANCE);
    const delta = w.exclusiveBytes - entry.exclusiveBytes;

    if (delta > band) {
      console.error(
        `✗ ${route}: bytes exclusivos ${fmt(w.exclusiveBytes)} B, ` +
          `${fmt(delta)} B por encima del baseline (${fmt(entry.exclusiveBytes)} B, banda ±${fmt(band)}). ` +
          `Algo entró al bundle de esta ruta. Si es deliberado, actualizá ${BASELINE_FILE} con --write-baseline y decí por qué.`,
      );
      hits += 1;
    } else if (delta < -band) {
      console.error(
        `✗ ${route}: bytes exclusivos ${fmt(w.exclusiveBytes)} B, ${fmt(-delta)} B por DEBAJO del baseline (${fmt(entry.exclusiveBytes)} B). La mejora hay que fijarla: corré --write-baseline. Un baseline holgado deja lugar libre para la próxima regresión.`,
      );
      hits += 1;
    } else {
      console.log(
        `  ${route}: exclusivos ${fmt(w.exclusiveBytes)} B (baseline ${fmt(entry.exclusiveBytes)} B, ±${fmt(band)}) ` +
          `· total ${fmt(w.totalBytes)} B · compartidos ${fmt(w.sharedBytes)} B`,
      );
    }
  }

  if (hits > 0) {
    console.error(`\n✗ ${hits} violación(es) de peso de ruta.`);
    process.exit(1);
  }

  console.log(
    `✓ route-weight clean — ${routes.length} ruta(s) vigilada(s) sobre un manifiesto de ${routeCount}, ` +
      `todas dentro de ±${TOLERANCE * 100}% de sus bytes exclusivos.`,
  );
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("check-route-weight.ts");
if (isMain) runCheck();
